/**
 * Launching configured servers, and in particular launching them on Windows.
 *
 * Before this existed, every server configured as `npx some-package` was
 * impossible to capture on Windows: npx is a batch file, batch files cannot be
 * spawned without cmd.exe, and the failure surfaced as a timeout. Running a
 * config supplied command line through cmd.exe is exactly the thing the stdio
 * transport otherwise refuses to do, so the injection tests below are the point
 * of this file. They run a batch file shaped like npx.cmd, which re-parses its
 * arguments, and try to break out of both parses.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  childEnvironment,
  escapeArgument,
  planLaunch,
  resolveOnPath,
} from '../../src/protocol/launch.js';
import { StdioTransport } from '../../src/protocol/stdio-transport.js';

const SHIM_DIR = fileURLToPath(new URL('../fixtures/shim/', import.meta.url));
const onWindows = process.platform === 'win32';

describe('planLaunch on POSIX', () => {
  it('spawns the command exactly as configured', () => {
    const plan = planLaunch('npx', ['-y', 'a&b'], { platform: 'linux', env: {} });
    expect(plan).toEqual({
      file: 'npx',
      args: ['-y', 'a&b'],
      windowsVerbatimArguments: false,
      resolved: undefined,
    });
  });
});

describe('planLaunch on Windows, with a simulated filesystem', () => {
  const files = new Set([
    'C:\\Program Files\\nodejs\\npx.cmd',
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\tools\\uvx.exe',
  ]);
  const host = {
    platform: 'win32' as const,
    env: {
      Path: 'C:\\Program Files\\nodejs;C:\\tools',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    },
    // Windows file names are case insensitive, and PATHEXT lists extensions in
    // upper case, so the simulated filesystem has to be too.
    isFile: (path: string) => [...files].some((f) => f.toLowerCase() === path.toLowerCase()),
  };

  it('runs a batch file through cmd.exe with verbatim arguments', () => {
    const plan = planLaunch('npx', ['-y', 'pkg'], host);

    expect(plan.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan.args[3]?.toLowerCase()).toContain('"c:\\program files\\nodejs\\npx.cmd"');
  });

  it('spawns a real executable directly, by absolute path', () => {
    const plan = planLaunch('uvx', ['some-server'], host);
    expect(plan.file.toLowerCase()).toBe('c:\\tools\\uvx.exe');
    expect(plan.args).toEqual(['some-server']);
    expect(plan.windowsVerbatimArguments).toBe(false);
  });

  it('leaves an unknown command for the loader to reject', () => {
    const plan = planLaunch('nope', [], host);
    expect(plan.file).toBe('nope');
    expect(plan.resolved).toBeUndefined();
  });

  it('refuses a batch file whose path contains a percent sign', () => {
    files.add('C:\\odd%PATH%\\x.cmd');
    expect(() => planLaunch('C:\\odd%PATH%\\x.cmd', [], host)).toThrow(/contains %/);
  });

  it('resolves a relative command from the server working directory', () => {
    files.add('C:\\proj\\node_modules\\.bin\\srv.cmd');
    const plan = planLaunch('node_modules\\.bin\\srv', [], { ...host, cwd: 'C:\\proj' });
    expect(plan.resolved?.toLowerCase()).toBe('c:\\proj\\node_modules\\.bin\\srv.cmd');
  });

  it('never searches the current directory', () => {
    // Only PATH entries are consulted, so a planted npx.cmd in the working
    // directory cannot shadow the real one.
    const seen: string[] = [];
    resolveOnPath('npx', { PATH: 'C:\\bin' }, (path) => {
      seen.push(path);
      return false;
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((path) => path.startsWith('C:\\bin\\'))).toBe(true);
  });

  it('reads PATH case insensitively, as Windows does', () => {
    const found = resolveOnPath(
      'uvx',
      { pAtH: 'C:\\tools' },
      (path) => path.toLowerCase() === 'c:\\tools\\uvx.exe',
    );
    expect(found?.toLowerCase()).toBe('c:\\tools\\uvx.exe');
  });
});

describe('escapeArgument', () => {
  it('escapes metacharacters twice for a batch file', () => {
    expect(escapeArgument('a&b', false)).toBe('^"a^&b^"');
    expect(escapeArgument('a&b', true)).toBe('^^^"a^^^&b^^^"');
  });

  it('doubles backslashes only where the C runtime would read them as escapes', () => {
    expect(escapeArgument('a\\b', false)).toBe('^"a\\b^"');
    expect(escapeArgument('a\\', false)).toBe('^"a\\\\^"');
    expect(escapeArgument('a\\"b', false)).toBe('^"a\\\\\\^"b^"');
  });
});

describe('childEnvironment', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
    AWS_SECRET_ACCESS_KEY: 'x'.repeat(40),
    SHELL: '() { echo; }',
  };

  it('passes the layout allowlist and nothing else from the parent', () => {
    expect(childEnvironment(parent, {}, 'linux')).toEqual({ PATH: '/usr/bin', HOME: '/home/dev' });
  });

  it('lets a named variable through, and lets it override the baseline', () => {
    const env = childEnvironment(parent, { MODE: 'x', PATH: '/opt/bin' }, 'linux');
    expect(env['MODE']).toBe('x');
    expect(env['PATH']).toBe('/opt/bin');
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  });

  it('matches Windows names case insensitively', () => {
    const env = childEnvironment(
      { Path: 'C:\\x', SystemRoot: 'C:\\Windows', Token: 'y' },
      {},
      'win32',
    );
    expect(env).toEqual({ Path: 'C:\\x', SystemRoot: 'C:\\Windows' });
  });

  it('never passes an exported shell function', () => {
    expect(childEnvironment(parent, {}, 'linux')['SHELL']).toBeUndefined();
  });
});

describe('a batch file that re-parses its arguments', () => {
  let dir: string;

  beforeEach(async () => {
    // A directory name containing a space, an ampersand and parentheses, so the
    // quoted command path is exercised along with the arguments.
    dir = join(await mkdtemp(join(tmpdir(), 'mcpsteward-shim-')), 'dir with space & (parens)');
    await cp(SHIM_DIR, dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  async function run(args: readonly string[]): Promise<unknown> {
    const plan = planLaunch(join(dir, 'echo-args.cmd'), args, {
      platform: process.platform,
      env: process.env,
    });

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        plan.file,
        [...plan.args],
        {
          cwd: dir,
          env: childEnvironment(process.env, {}, process.platform),
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
          windowsHide: true,
          timeout: 30_000,
        },
        (error, out) => {
          if (error === null) resolve(out);
          else reject(new Error(error.message, { cause: error }));
        },
      );
    });

    return JSON.parse(stdout) as unknown;
  }

  const canary = 'CANARY_CREATED';

  const hostile = [
    '',
    ' ',
    'two words',
    'a&b',
    'a|b',
    'a>b',
    'a<b',
    'a^b',
    '^',
    '^^',
    '(x)',
    'a;b',
    'a,b',
    'a=b',
    '*',
    '?',
    '`',
    '%PATH%',
    '%%',
    '%',
    '!PATH!',
    '"',
    '""',
    'a"b',
    'a\\',
    'a\\\\',
    'a\\"b',
    'C:\\Program Files\\x',
    '@scope/some-mcp@1.2.3',
    '--registry',
    'https://registry.npmjs.org',
    'caf\u00e9',
    `&type nul > ${canary}`,
    `a"&type nul > ${canary}&"b`,
    `a" & type nul > ${canary} & "b`,
    `"&type nul>${canary}&"`,
    `^"&type nul>${canary}&^"`,
    `\\"&type nul>${canary}&\\"`,
    `|type nul>${canary}`,
    `%COMSPEC% /c type nul>${canary}`,
  ];

  it.runIf(onWindows)('delivers every argument byte for byte and runs nothing else', async () => {
    expect(await run(hostile)).toEqual(hostile);
    expect(existsSync(join(dir, canary)), 'an injected command ran').toBe(false);
  }, 60_000);

  it.runIf(onWindows)('delivers each hostile argument correctly on its own', async () => {
    // One at a time as well, since an argument can be neutralised by its
    // neighbours in a combined run and still be dangerous alone.
    for (const arg of hostile) {
      expect(await run([arg]), `argument ${JSON.stringify(arg)}`).toEqual([arg]);
    }
    expect(existsSync(join(dir, canary)), 'an injected command ran').toBe(false);
  }, 180_000);
});

describe('a command that does not exist', () => {
  it('fails immediately, naming the command, rather than timing out', async () => {
    const transport = new StdioTransport({ command: 'mcpsteward-no-such-command-xyz', args: [] });
    transport.start();

    const started = Date.now();
    await expect(
      transport.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 20_000),
    ).rejects.toThrow(/mcpsteward-no-such-command-xyz" was not found/);
    expect(Date.now() - started).toBeLessThan(5_000);

    await transport.dispose();
  }, 30_000);
});

describe('a server that exits on start', () => {
  it('reports what the server said, not only its exit code', async () => {
    // "exited with code 1" alone sent people off to reproduce the failure by
    // hand; the reason is almost always on stderr.
    const dead = fileURLToPath(new URL('../fixtures/servers/exits-immediately.mjs', import.meta.url));
    const transport = new StdioTransport({ command: process.execPath, args: [dead] });
    transport.start();

    await new Promise((resolve) => setTimeout(resolve, 1_000));

    await expect(
      transport.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 5_000),
    ).rejects.toThrow(/exited with code 1\. Its last output was: fatal: missing required argument --dsn/);

    await transport.dispose();
  }, 30_000);
});
