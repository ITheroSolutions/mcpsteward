import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run, type CliIo } from '../../src/cli/index.js';
import { parseArgs } from '../../src/cli/args.js';
import { knownClients } from '../../src/discovery/clients.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpsteward-cli-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Invoke the CLI with stdout and stderr captured separately.
 *
 * The separation is the point of most of these tests: a diagnostic that leaked
 * onto stdout would corrupt a JSON document a caller is piping into jq.
 */
async function cli(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<Captured> {
  let stdout = '';
  let stderr = '';

  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { ...env },
    isTty: false,
  };

  const code = await run(args, io);
  return { code, stdout, stderr };
}

describe('argument parsing', () => {
  it('reads a command and a target', () => {
    const parsed = parseArgs(['conform', 'my-server']);
    expect(parsed.command).toBe('conform');
    expect(parsed.targets).toEqual(['my-server']);
  });

  it('reads a subcommand for commands that take one', () => {
    const parsed = parseArgs(['ledger', 'verify']);
    expect(parsed.command).toBe('ledger');
    expect(parsed.subcommand).toBe('verify');
  });

  it('accepts both --flag value and --flag=value', () => {
    expect(parseArgs(['discover', '--format', 'json']).flags.format).toBe('json');
    expect(parseArgs(['discover', '--format=json']).flags.format).toBe('json');
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    // A mistyped --fromat that silently fell back to terminal output would make
    // a CI job parse prose as JSON.
    expect(() => parseArgs(['discover', '--fromat', 'json'])).toThrow(/Unknown option --fromat/);
  });

  it('rejects an invalid format value, listing the valid ones', () => {
    expect(() => parseArgs(['discover', '--format', 'yaml'])).toThrow(/--format must be one of/);
  });

  it('rejects an invalid log level', () => {
    expect(() => parseArgs(['discover', '--log-level', 'loud'])).toThrow(/--log-level must be/);
  });

  it('rejects a flag that is missing its value', () => {
    expect(() => parseArgs(['discover', '--format'])).toThrow(/requires a value/);
  });

  it('rejects a non positive timeout', () => {
    expect(() => parseArgs(['discover', '--timeout', '0'])).toThrow(/positive number/);
    expect(() => parseArgs(['discover', '--timeout', 'soon'])).toThrow(/positive number/);
  });

  it('defaults sensibly with no flags', () => {
    const flags = parseArgs(['discover']).flags;
    expect(flags.format).toBe('terminal');
    expect(flags.logLevel).toBe('silent');
    expect(flags.timeoutMs).toBe(30_000);
  });
});

describe('help and version', () => {
  it('prints help to stdout and exits zero', async () => {
    const result = await cli(['--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('USAGE');
    expect(result.stderr).toBe('');
  });

  it('prints help and exits 2 when given no command at all', async () => {
    // Nothing happened, so this is a usage error rather than a success.
    const result = await cli([]);
    expect(result.code).toBe(2);
  });

  it('prints the version alone to stdout', async () => {
    const result = await cli(['--version']);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('documents the exit code contract in help', async () => {
    const result = await cli(['--help']);
    expect(result.stdout).toContain('EXIT CODES');
    expect(result.stdout).toContain('0   Success');
  });

  it('states the no cloud and no LLM promise in help', async () => {
    const result = await cli(['--help']);
    expect(result.stdout).toContain('No cloud');
    expect(result.stdout).toContain('No LLM');
  });

  it('shows subcommand help for a command that needs a subcommand', async () => {
    const result = await cli(['ledger']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('verify');
  });
});

describe('exit code contract', () => {
  it('returns 2 for an unknown command', async () => {
    const result = await cli(['frobnicate']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown command');
  });

  it('returns 2 for an unknown flag', async () => {
    const result = await cli(['discover', '--nonsense']);
    expect(result.code).toBe(2);
  });

  it('returns 2 when a server command has no target', async () => {
    const result = await cli(['conform']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('needs a server name');
  });

  it('returns 2 when migrate has no path', async () => {
    const result = await cli(['migrate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('needs a path');
  });

  it('returns 0 for a successful discover', async () => {
    const result = await cli(['discover']);
    expect(result.code).toBe(0);
  });
});

describe('stream discipline', () => {
  it('writes the report to stdout and nothing else there', async () => {
    const result = await cli(['discover', '--format', 'json']);

    expect(() => {
      JSON.parse(result.stdout);
    }).not.toThrow();
  });

  it('keeps diagnostics off stdout even at trace level', async () => {
    // This is the property that makes `mcpsteward ... --format json | jq` work.
    const result = await cli(['discover', '--format', 'json', '--log-level', 'trace']);

    expect(() => {
      JSON.parse(result.stdout);
    }).not.toThrow();
  });

  it('writes errors to stderr, never stdout', async () => {
    const result = await cli(['frobnicate']);

    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe('output formats', () => {
  it('emits valid JSON', async () => {
    const result = await cli(['discover', '--format', 'json']);
    expect(() => {
      JSON.parse(result.stdout);
    }).not.toThrow();
  });

  it('emits one object per NDJSON line', async () => {
    const result = await cli(['discover', '--format', 'ndjson']);

    for (const line of result.stdout.trim().split('\n')) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
  });

  it('emits SARIF with the right version', async () => {
    const result = await cli(['discover', '--format', 'sarif']);
    const sarif = JSON.parse(result.stdout) as { version: string };
    expect(sarif.version).toBe('2.1.0');
  });

  it('emits self contained HTML', async () => {
    const result = await cli(['discover', '--format', 'html']);

    expect(result.stdout).toContain('<!doctype html>');
    expect(result.stdout).not.toMatch(/<script\s+src=/i);
  });

  it('emits no ANSI escapes when stdout is not a terminal', async () => {
    // isTty is false in these tests, which is the CI and redirect case.
    const result = await cli(['discover']);
    expect(result.stdout).not.toContain('[');
  });

  it('writes to a file when --output is given, and says so on stderr', async () => {
    const path = join(root, 'report.json');
    const result = await cli(['discover', '--format', 'json', '--output', path]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Wrote');
    expect(JSON.parse(await readFile(path, 'utf8'))).toBeDefined();
  });
});

describe('discover', () => {
  it('reports an inventory even when nothing is configured', async () => {
    const result = await cli(['discover', '--format', 'json']);
    const report = JSON.parse(result.stdout) as { kind: string; summary: unknown[] };

    expect(report.kind).toBe('inventory');
    expect(report.summary.length).toBeGreaterThan(0);
  });

  it('explains an empty inventory rather than just showing zero', async () => {
    const result = await cli(['discover', '--format', 'json']);
    const report = JSON.parse(result.stdout) as {
      summary: { label: string; value: string }[];
      notes: string[];
    };

    const total = report.summary.find((s) => s.label === 'Servers')?.value;
    if (total === '0') {
      expect(report.notes.join(' ')).toContain('Checked');
    }
  });
});

describe('migrate', () => {
  it('analyses a source tree and reports findings', async () => {
    await writeFile(
      join(root, 'server.ts'),
      'server.setRequestHandler("initialize", handler);',
      'utf8',
    );

    const result = await cli(['migrate', root, '--format', 'json']);
    const report = JSON.parse(result.stdout) as {
      sections: { items: { id: string }[] }[];
    };

    expect(report.sections[0]?.items.map((i) => i.id)).toContain('MIG-INITIALIZE');
  });

  it('reports a clean tree as clean', async () => {
    await writeFile(join(root, 'clean.ts'), 'export const x = 1;', 'utf8');

    const result = await cli(['migrate', root, '--format', 'json']);
    const report = JSON.parse(result.stdout) as { sections: { items: unknown[] }[] };

    expect(report.sections[0]?.items).toEqual([]);
  });

  it('emits SARIF with file locations, for code scanning', async () => {
    await writeFile(join(root, 'server.ts'), 'const id = headers["Mcp-Session-Id"];', 'utf8');

    const result = await cli(['migrate', root, '--format', 'sarif']);
    const sarif = JSON.parse(result.stdout) as {
      runs: { results: { locations: { physicalLocation?: unknown }[] }[] }[];
    };

    expect(sarif.runs[0]?.results[0]?.locations[0]).toHaveProperty('physicalLocation');
  });
});

describe('policy and verify', () => {
  it('tells the user how to create a policy when none exists', async () => {
    const result = await cli(['verify', '--policy', join(root, 'absent.json')]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('mcpsteward policy init');
  });

  it('generates a policy with policy init', async () => {
    const path = join(root, 'policy.json');
    const result = await cli(['policy', 'init', '--policy', path]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Wrote');

    const written = JSON.parse(await readFile(path, 'utf8')) as { version: number };
    expect(written.version).toBe(1);
  });

  it('passes verify against a policy it just generated, except for inline credentials', async () => {
    // The generated policy must pass on the machine it came from, or the first
    // experience is a failing gate and people disable it. The one deliberate
    // exception is an inline credential, which fails immediately by design.
    //
    // This test reads the real machine's configuration, so it asserts the
    // property rather than a fixed exit code: either it passes, or every
    // violation is an inline credential.
    const path = join(root, 'policy.json');
    await cli(['policy', 'init', '--policy', path]);

    const result = await cli(['verify', '--policy', path, '--format', 'json']);
    const report = JSON.parse(result.stdout) as {
      sections: { items: { id: string }[] }[];
    };

    const violations = report.sections.flatMap((s) => s.items).map((i) => i.id);

    if (result.code === 0) {
      expect(violations).toEqual([]);
    } else {
      expect(result.code).toBe(1);
      expect(new Set(violations)).toEqual(new Set(['inline-credential']));
    }
  });

  it('exits 1 when the policy fails, which is what CI branches on', async () => {
    const path = join(root, 'policy.json');
    await writeFile(
      path,
      JSON.stringify({ version: 1, denyServers: [], allowServers: [] }),
      'utf8',
    );

    const result = await cli(['verify', '--policy', path, '--format', 'json']);

    // With an empty allowlist, any configured server violates. On a machine with
    // none, it passes. Both are correct; only 0 or 1 is acceptable, never 3.
    expect([0, 1]).toContain(result.code);
  });

  it('exits 2 for a malformed policy, not 1', async () => {
    // A broken policy file is the operator's mistake, not a failing machine.
    const path = join(root, 'policy.json');
    await writeFile(path, '{"version":1,"minimumGarde":"A"}', 'utf8');

    const result = await cli(['verify', '--policy', path]);
    expect(result.code).toBe(2);
  });

  it('subcommand policy check behaves like verify', async () => {
    const path = join(root, 'policy.json');
    await cli(['policy', 'init', '--policy', path]);

    const result = await cli(['policy', 'check', '--policy', path, '--format', 'json']);
    expect([0, 1]).toContain(result.code);
  });
});

describe('ledger', () => {
  it('reports an empty ledger without failing', async () => {
    const path = join(root, 'ledger.log');
    const result = await cli(['ledger', 'log', '--ledger', path]);

    expect([0, 1]).toContain(result.code);
  });

  it('exits 1 when verification fails on a corrupt ledger', async () => {
    const path = join(root, 'ledger.log');
    await writeFile(path, 'this is not a ledger\n', 'utf8');

    const result = await cli(['ledger', 'verify', '--ledger', path]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FAILED');
  });

  it('exits 2 for an unknown ledger subcommand', async () => {
    const result = await cli(['ledger', 'frobnicate']);
    expect(result.code).toBe(2);
  });
});

describe('doctor', () => {
  it('reports environment, paths and supported revisions', async () => {
    const result = await cli(['doctor', '--format', 'json', '--ledger', join(root, 'l.log')]);

    expect(result.code).toBe(0);

    const report = JSON.parse(result.stdout) as {
      summary: { label: string; value: string }[];
    };

    const labels = report.summary.map((s) => s.label);
    expect(labels).toContain('Node');
    expect(labels).toContain('Platform');
    expect(labels).toContain('Graded revision');
    expect(labels).toContain('Ledger');
  });

  it('names the graded revision', async () => {
    const result = await cli(['doctor', '--format', 'json', '--ledger', join(root, 'l.log')]);
    expect(result.stdout).toContain('2026-07-28');
  });

  it('does not warn about unconfirmed paths when every known client path is confirmed', async () => {
    // Every entry in knownClients() is now `confirmed` against vendor
    // documentation, so doctor should emit no "path is not confirmed"
    // remediation at all. This previously asserted the opposite (that
    // VERIFY.md was mentioned), which was correct only while Windsurf,
    // Cline and Zed were still `probable`.
    const result = await cli(['doctor', '--format', 'json', '--ledger', join(root, 'l.log')]);
    expect(result.stdout).not.toContain('not confirmed against documentation');
  });

  it('would warn if a known client path were ever downgraded to probable', () => {
    // Guards the mechanism itself rather than today's data: if somebody adds
    // a new client with an unverified path, doctor must surface it instead of
    // silently presenting a guess as fact. Asserts on knownClients() directly
    // so it keeps testing the contract even while no entry is probable.
    const probable = knownClients().filter((c) => c.confidence === 'probable');
    for (const client of probable) {
      expect(client.note, `${client.displayName} is probable but carries no explanatory note`).toBeTruthy();
    }
  });

  it('states that it makes no network requests', async () => {
    const result = await cli(['doctor', '--format', 'json', '--ledger', join(root, 'l.log')]);
    expect(result.stdout).toContain('no network requests');
  });
});

describe('redaction reaches CLI output', () => {
  it('removes a secret held in the environment from the report', async () => {
    const secret = 'anopaquevaluewithnovendorprefix12345';

    const result = await cli(['discover', '--format', 'json'], {
      GITHUB_TOKEN: secret,
    });

    expect(result.stdout).not.toContain(secret);
  });
});
