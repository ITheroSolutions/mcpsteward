import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discover } from '../../src/discovery/index.js';
import type { ClientDefinition } from '../../src/discovery/clients.js';
import {
  deduplicate,
  identityOf,
  isInlineCredential,
  parseClientConfig,
} from '../../src/discovery/parse.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpsteward-discovery-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(relativePath: string, contents: unknown): Promise<string> {
  const full = join(root, relativePath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(
    full,
    typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
    'utf8',
  );
  return full;
}

function client(
  id: ClientDefinition['id'],
  shape: ClientDefinition['shape'],
  paths: string[],
): ClientDefinition {
  return { id, displayName: id, shape, confidence: 'confirmed', paths };
}

describe('parsing each client format', () => {
  it('parses the mcpServers shape used by Claude Desktop, Claude Code and Cursor', () => {
    const text = JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/dev'],
        },
      },
    });

    const parsed = parseClientConfig(text, client('claude-desktop', 'mcpServers', []), '/c.json');

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('filesystem');
    expect(parsed[0]?.endpoint).toMatchObject({ transport: 'stdio', command: 'npx' });
  });

  it('parses the servers shape used by VS Code', () => {
    const text = JSON.stringify({ servers: { github: { url: 'https://mcp.example.com/mcp' } } });
    const parsed = parseClientConfig(text, client('vscode', 'servers', []), '/c.json');

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.endpoint).toMatchObject({ transport: 'http' });
  });

  it('parses the context_servers shape used by Zed', () => {
    const text = JSON.stringify({
      context_servers: { local: { command: 'my-server', args: [] } },
    });
    const parsed = parseClientConfig(text, client('zed', 'context_servers', []), '/c.json');

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('local');
  });

  it('returns nothing for a file with no server map, without erroring', () => {
    // Claude Code's .claude.json holds a great deal besides MCP configuration,
    // so "no servers here" is the common case rather than a failure.
    const text = JSON.stringify({ theme: 'dark', someOtherSetting: true });
    expect(parseClientConfig(text, client('claude-code', 'mcpServers', []), '/c.json')).toEqual([]);
  });

  it('records unknown fields rather than discarding them silently', () => {
    const text = JSON.stringify({
      mcpServers: { s: { command: 'x', someNewField: 1, anotherOne: 'y' } },
    });
    const parsed = parseClientConfig(text, client('cursor', 'mcpServers', []), '/c.json');

    expect(parsed[0]?.unknownFields).toEqual(['someNewField', 'anotherOne']);
  });

  it('includes a disabled server, because it is still configured', () => {
    // An inventory that hid disabled servers would understate the surface: they
    // can be re-enabled without any review.
    const text = JSON.stringify({ mcpServers: { s: { command: 'x', disabled: true } } });
    expect(parseClientConfig(text, client('cursor', 'mcpServers', []), '/c.json')).toHaveLength(1);
  });
});

describe('malformed configuration', () => {
  it('rejects invalid JSON, naming the path', () => {
    expect(() => parseClientConfig('{oops', client('cursor', 'mcpServers', []), '/bad.json')).toThrow(
      /\/bad\.json is not valid JSON/,
    );
  });

  it('rejects a document that is not an object', () => {
    expect(() => parseClientConfig('[1,2]', client('cursor', 'mcpServers', []), '/c.json')).toThrow(
      /does not contain a JSON object/,
    );
  });

  it('rejects a server entry that is not an object', () => {
    const text = JSON.stringify({ mcpServers: { s: 'just a string' } });
    expect(() => parseClientConfig(text, client('cursor', 'mcpServers', []), '/c.json')).toThrow(
      /is not an object/,
    );
  });

  it('rejects a server with neither a command nor a url', () => {
    const text = JSON.stringify({ mcpServers: { s: { args: ['x'] } } });
    expect(() => parseClientConfig(text, client('cursor', 'mcpServers', []), '/c.json')).toThrow(
      /neither a command nor a url/,
    );
  });
});

describe('inline credential detection', () => {
  it('flags a literal secret under a secret shaped key', () => {
    expect(isInlineCredential('GITHUB_TOKEN', 'ghp_abcdefghijklmnopqrstuvwxyz01')).toBe(true);
    expect(isInlineCredential('API_KEY', 'sk-abcdefghijklmnopqrstuvwxyz')).toBe(true);
  });

  it('does not flag an environment reference', () => {
    // This is the correct pattern and must never be reported as a finding, or
    // people will stop believing the finding.
    expect(isInlineCredential('GITHUB_TOKEN', '${GITHUB_TOKEN}')).toBe(false);
    expect(isInlineCredential('GITHUB_TOKEN', '$GITHUB_TOKEN')).toBe(false);
    expect(isInlineCredential('GITHUB_TOKEN', '%GITHUB_TOKEN%')).toBe(false);
    expect(isInlineCredential('GITHUB_TOKEN', '')).toBe(false);
  });

  it('does not flag a short value under a secret shaped key', () => {
    // A flag like "1" under AUTH_MODE is not a credential.
    expect(isInlineCredential('AUTH_MODE', '1')).toBe(false);
    expect(isInlineCredential('TOKEN_TYPE', 'jwt')).toBe(false);
  });

  it('flags an Authorization header value regardless of key naming', () => {
    expect(isInlineCredential('X-Custom', 'Bearer abcdefghijklmnop')).toBe(true);
  });

  it('does not flag an ordinary configuration value', () => {
    expect(isInlineCredential('MODE', 'production')).toBe(false);
    expect(isInlineCredential('PATH', '/usr/local/bin')).toBe(false);
  });

  it('never stores the credential itself, only a fingerprint', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const text = JSON.stringify({ mcpServers: { s: { command: 'x', env: { GH_TOKEN: secret } } } });

    const parsed = parseClientConfig(text, client('cursor', 'mcpServers', []), '/c.json');

    expect(JSON.stringify(parsed)).not.toContain(secret);
    expect(parsed[0]?.inlineCredentialFingerprints).toHaveLength(1);
    expect(parsed[0]?.site.hasInlineCredential).toBe(true);
    expect(parsed[0]?.authPosture).toBe('inline');
  });

  it('flags a credential sitting in an HTTP endpoint URL query string', () => {
    // Found by running discover against a real machine: a server was configured as
    // https://host/mcp/stream?userToken=<a live JWT>, and was reported as auth: none,
    // because the credential scan only ever looked at env and headers. A token in a
    // query string is the same risk as a token in a header, and worse in one respect:
    // URLs end up in proxy logs and browser history.
    //
    // Unlike env or header credentials, the raw endpoint.url is kept on the parsed
    // server (it is needed for connecting, deduplication, and hashing), so this test
    // checks the guarantee that actually holds here: detection fires and a fingerprint
    // is recorded. Redaction of the URL itself happens downstream, at report render
    // time in buildReport(), not at parse time. See SECURITY.md for that boundary.
    const fakeJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.dGVzdHNpZ25hdHVyZQ';
    const text = JSON.stringify({
      mcpServers: { s: { url: `https://mcp.example.com/stream?userToken=${fakeJwt}` } },
    });

    const parsed = parseClientConfig(text, client('cursor', 'mcpServers', []), '/c.json');

    expect(parsed[0]?.site.hasInlineCredential).toBe(true);
    expect(parsed[0]?.authPosture).toBe('inline');
    expect(parsed[0]?.inlineCredentialFingerprints).toHaveLength(1);
    expect(parsed[0]?.inlineCredentialFingerprints?.[0]).not.toBe(fakeJwt);
  });

  it('does not flag an ordinary URL query parameter that is not credential shaped', () => {
    const text = JSON.stringify({
      mcpServers: { s: { url: 'https://mcp.example.com/stream?region=us-east&limit=10' } },
    });

    const parsed = parseClientConfig(text, client('cursor', 'mcpServers', []), '/c.json');

    expect(parsed[0]?.site.hasInlineCredential).toBe(false);
    expect(parsed[0]?.authPosture).not.toBe('inline');
  });
});

describe('auth posture classification', () => {
  const cases: readonly (readonly [string, unknown, string])[] = [
    ['no credentials at all', { command: 'x' }, 'none'],
    ['env reference', { command: 'x', env: { API_KEY: '${API_KEY}' } }, 'env'],
    ['inline secret', { command: 'x', env: { API_KEY: 'sk-abcdefghijklmnopqrst' } }, 'inline'],
    ['oauth endpoint', { url: 'https://example.com/oauth/mcp' }, 'oauth'],
    ['non secret env only', { command: 'x', env: { LOG_LEVEL: 'debug' } }, 'unknown'],
  ];

  for (const [name, entry, expected] of cases) {
    it(`classifies ${name} as ${expected}`, () => {
      const text = JSON.stringify({ mcpServers: { s: entry } });
      const parsed = parseClientConfig(text, client('cursor', 'mcpServers', []), '/c.json');
      expect(parsed[0]?.authPosture).toBe(expected);
    });
  }
});

describe('deduplication', () => {
  it('treats the same command in four clients as one server', () => {
    const entry = { command: 'npx', args: ['-y', 'server-filesystem'] };
    const registrations = (['claude-desktop', 'cursor', 'vscode', 'zed'] as const).flatMap((id) =>
      parseClientConfig(
        JSON.stringify({ mcpServers: { fs: entry } }),
        client(id, 'mcpServers', []),
        `/${id}.json`,
      ),
    );

    const servers = deduplicate(registrations);

    expect(servers).toHaveLength(1);
    expect(servers[0]?.registrations).toHaveLength(4);
  });

  it('does not merge servers registered under the same name but different commands', () => {
    const a = parseClientConfig(
      JSON.stringify({ mcpServers: { s: { command: 'server-a' } } }),
      client('cursor', 'mcpServers', []),
      '/a.json',
    );
    const b = parseClientConfig(
      JSON.stringify({ mcpServers: { s: { command: 'server-b' } } }),
      client('vscode', 'mcpServers', []),
      '/b.json',
    );

    expect(deduplicate([...a, ...b])).toHaveLength(2);
  });

  it('merges servers registered under different names but the same command', () => {
    // The same server is routinely registered under different names in
    // different clients. Splitting those would inflate the inventory and split
    // one server's history across several pins.
    const a = parseClientConfig(
      JSON.stringify({ mcpServers: { 'my-fs': { command: 'npx', args: ['fs'] } } }),
      client('cursor', 'mcpServers', []),
      '/a.json',
    );
    const b = parseClientConfig(
      JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['fs'] } } }),
      client('vscode', 'mcpServers', []),
      '/b.json',
    );

    expect(deduplicate([...a, ...b])).toHaveLength(1);
  });

  it('escalates to the worst auth posture across registrations', () => {
    // A server holding an inline credential in one client is an inline
    // credential problem, however clean the other three registrations are.
    const clean = parseClientConfig(
      JSON.stringify({ mcpServers: { s: { command: 'x', env: { API_KEY: '${API_KEY}' } } } }),
      client('cursor', 'mcpServers', []),
      '/a.json',
    );
    const dirty = parseClientConfig(
      JSON.stringify({ mcpServers: { s: { command: 'x', env: { API_KEY: 'sk-abcdefghijklmnop' } } } }),
      client('vscode', 'mcpServers', []),
      '/b.json',
    );

    const servers = deduplicate([...clean, ...dirty]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.authPosture).toBe('inline');
  });

  it('normalises a trailing slash so one endpoint is not counted twice', () => {
    expect(identityOf({ transport: 'http', url: 'https://a.example/mcp', headerNames: [] })).toBe(
      identityOf({ transport: 'http', url: 'https://a.example/mcp/', headerNames: [] }),
    );
  });

  it('keeps different paths on the same host distinct', () => {
    expect(identityOf({ transport: 'http', url: 'https://a.example/one', headerNames: [] })).not.toBe(
      identityOf({ transport: 'http', url: 'https://a.example/two', headerNames: [] }),
    );
  });

  it('gives a server a stable id across runs', () => {
    const registrations = parseClientConfig(
      JSON.stringify({ mcpServers: { s: { command: 'x', args: ['y'] } } }),
      client('cursor', 'mcpServers', []),
      '/a.json',
    );

    const first = deduplicate(registrations)[0]?.id;
    const second = deduplicate(registrations)[0]?.id;

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{8}$/);
  });
});

describe('scanning a fixture filesystem', () => {
  it('finds servers across several clients and reports which were found', async () => {
    const a = await writeConfig('claude/claude_desktop_config.json', {
      mcpServers: { fs: { command: 'npx', args: ['fs'] } },
    });
    const b = await writeConfig('cursor/mcp.json', {
      mcpServers: { remote: { url: 'https://mcp.example.com/mcp' } },
    });

    const inventory = await discover({
      clients: [
        client('claude-desktop', 'mcpServers', [a]),
        client('cursor', 'mcpServers', [b]),
      ],
    });

    expect(inventory.summary.totalServers).toBe(2);
    expect(inventory.summary.byTransport).toEqual({ stdio: 1, http: 1 });
    expect(inventory.summary.clientsFound).toEqual(['claude-desktop', 'cursor']);
    expect(inventory.scannedPaths).toHaveLength(2);
  });

  it('distinguishes an absent file from a corrupt one', async () => {
    // "You have no MCP servers" and "your config is corrupt so I could not tell"
    // are very different answers.
    const bad = await writeConfig('cursor/mcp.json', '{ not json');

    const inventory = await discover({
      clients: [
        client('cursor', 'mcpServers', [bad]),
        client('zed', 'context_servers', [join(root, 'nothing-here.json')]),
      ],
    });

    expect(inventory.problems).toHaveLength(1);
    expect(inventory.problems[0]?.reason).toMatch(/not valid JSON/);
    expect(inventory.absentPaths).toHaveLength(1);
  });

  it('continues past one malformed file and still reports the rest', async () => {
    const bad = await writeConfig('cursor/mcp.json', '{ not json');
    const good = await writeConfig('claude/config.json', {
      mcpServers: { fs: { command: 'npx' } },
    });

    const inventory = await discover({
      clients: [
        client('cursor', 'mcpServers', [bad]),
        client('claude-desktop', 'mcpServers', [good]),
      ],
    });

    expect(inventory.problems).toHaveLength(1);
    expect(inventory.summary.totalServers).toBe(1);
  });

  it('counts a server registered in two clients once, and marks it', async () => {
    const entry = { mcpServers: { fs: { command: 'npx', args: ['fs'] } } };
    const a = await writeConfig('claude/config.json', entry);
    const b = await writeConfig('cursor/mcp.json', entry);

    const inventory = await discover({
      clients: [
        client('claude-desktop', 'mcpServers', [a]),
        client('cursor', 'mcpServers', [b]),
      ],
    });

    expect(inventory.summary.totalServers).toBe(1);
    expect(inventory.summary.multiplyRegistered).toBe(1);
    expect(inventory.servers[0]?.registrations.map((r) => r.client).sort()).toEqual([
      'claude-desktop',
      'cursor',
    ]);
  });

  it('reports inline credentials without ever emitting the value', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const path = await writeConfig('cursor/mcp.json', {
      mcpServers: { gh: { command: 'gh-server', env: { GITHUB_TOKEN: secret } } },
    });

    const inventory = await discover({ clients: [client('cursor', 'mcpServers', [path])] });

    expect(inventory.summary.withInlineCredentials).toBe(1);
    expect(JSON.stringify(inventory)).not.toContain(secret);
  });

  it('answers the operations question in one summary', async () => {
    const path = await writeConfig('cursor/mcp.json', {
      mcpServers: {
        local: { command: 'a' },
        remote: { url: 'https://x.example/mcp' },
        leaky: { command: 'b', env: { API_KEY: 'sk-abcdefghijklmnopqrstuv' } },
      },
    });

    const inventory = await discover({ clients: [client('cursor', 'mcpServers', [path])] });

    expect(inventory.summary.totalServers).toBe(3);
    expect(inventory.summary.local).toBe(2);
    expect(inventory.summary.remote).toBe(1);
    expect(inventory.summary.withInlineCredentials).toBe(1);
  });

  it('marks servers unknown to policy when an allowlist is supplied', async () => {
    const path = await writeConfig('cursor/mcp.json', {
      mcpServers: { known: { command: 'a' }, unknown: { command: 'b' } },
    });

    const inventory = await discover({
      clients: [client('cursor', 'mcpServers', [path])],
      policyAllowlist: ['known'],
    });

    expect(inventory.summary.unknownToPolicy).toBe(1);
  });

  it('returns an empty inventory rather than failing when nothing is configured', async () => {
    const inventory = await discover({
      clients: [client('cursor', 'mcpServers', [join(root, 'absent.json')])],
    });

    expect(inventory.summary.totalServers).toBe(0);
    expect(inventory.problems).toHaveLength(0);
    expect(inventory.absentPaths).toHaveLength(1);
  });

  it('scans project local configuration when directories are supplied', async () => {
    await writeConfig('project/.vscode/mcp.json', {
      servers: { proj: { command: 'project-server' } },
    });

    const inventory = await discover({
      clients: [],
      projectDirectories: [join(root, 'project')],
    });

    expect(inventory.summary.totalServers).toBe(1);
  });
});

describe('paths with spaces and Windows shapes', () => {
  it('handles a config path containing spaces', async () => {
    const path = await writeConfig('a directory with spaces/mcp.json', {
      mcpServers: { s: { command: 'x' } },
    });

    const inventory = await discover({ clients: [client('cursor', 'mcpServers', [path])] });
    expect(inventory.summary.totalServers).toBe(1);
  });

  it('preserves a Windows style command with a drive letter', () => {
    const text = JSON.stringify({
      mcpServers: { s: { command: 'C:\\Program Files\\srv\\server.exe', args: ['--flag'] } },
    });

    const parsed = parseClientConfig(text, client('cursor', 'mcpServers', []), 'C:\\c.json');

    expect(parsed[0]?.endpoint).toMatchObject({
      transport: 'stdio',
      command: 'C:\\Program Files\\srv\\server.exe',
    });
  });

  it('gives a UNC path server a distinct identity', () => {
    const unc = identityOf({
      transport: 'stdio',
      command: '\\\\fileserver\\share\\server.exe',
      args: [],
      envNames: [],
    });
    const local = identityOf({
      transport: 'stdio',
      command: 'C:\\server.exe',
      args: [],
      envNames: [],
    });

    expect(unc).not.toBe(local);
  });
});
