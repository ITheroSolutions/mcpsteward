/**
 * The built in MCP server, used the way real clients use it.
 *
 * The dogfood test grades this server with mcpsteward's own client, which numbers
 * its requests with strings and speaks only 2026-07-28. Real clients do neither.
 * Sending the server one request with a numeric id showed the id echoed back as
 * an internal token object, which no client could match to its request. It also
 * answered notifications, and refused the handshake every client in use when
 * this was released opens with.
 *
 * So this file drives the server with raw messages, and with the official SDK's
 * client, which is the library real clients are built on.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../../dist/mcp/index.js', import.meta.url));
const PROJECT = fileURLToPath(new URL('../..', import.meta.url));

beforeAll(async () => {
  if (existsSync(SERVER)) return;

  await promisify(execFile)('npm', ['run', 'build'], {
    cwd: PROJECT,
    shell: process.platform === 'win32',
  });
}, 180_000);

const MODERN_META = {
  _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
  },
};

/** Send raw lines to a fresh server and collect every line it writes back. */
async function exchange(lines: readonly string[], settleMs = 700): Promise<string[]> {
  // The test runner marks its environment, and the server declines to start
  // itself under a test runner, so the marker must not reach the child.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'VITEST'));
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'ignore'], env });
  const exited = new Promise((resolve) => child.once('exit', resolve));

  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });

  for (const line of lines) child.stdin.write(`${line}\n`);
  await new Promise((resolve) => setTimeout(resolve, settleMs));

  child.stdin.end();
  await exited;

  return out.split('\n').filter((line) => line.length > 0);
}

describe('request ids are echoed exactly', () => {
  it('echoes a numeric id as the same number', async () => {
    const [reply] = await exchange([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: MODERN_META }),
    ]);

    expect(reply).toContain('"id":1,');
    expect((JSON.parse(reply ?? '{}') as { id: unknown }).id).toBe(1);
  });

  it('echoes an id beyond double precision digit for digit', async () => {
    const [reply] = await exchange([
      `{"jsonrpc":"2.0","id":12345678901234567890,"method":"server/discover","params":${JSON.stringify(MODERN_META)}}`,
    ]);

    expect(reply).toContain('"id":12345678901234567890,');
  });

  it('echoes a string id as the same string', async () => {
    const [reply] = await exchange([
      JSON.stringify({ jsonrpc: '2.0', id: 'abc-1', method: 'server/discover', params: MODERN_META }),
    ]);

    expect((JSON.parse(reply ?? '{}') as { id: unknown }).id).toBe('abc-1');
  });
});

describe('notifications', () => {
  it('are never answered', async () => {
    const replies = await exchange([
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'server/discover', params: MODERN_META }),
    ]);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('"id":7,');
  });
});

describe('a 2026-07-28 request is still handled statelessly', () => {
  it('rejects a request with no protocol version when no handshake happened', async () => {
    const [reply] = await exchange([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    ]);

    expect((JSON.parse(reply ?? '{}') as { error?: { code: number } }).error?.code).toBe(-32602);
  });

  it('answers ping with method not found, since that revision removed it', async () => {
    const [reply] = await exchange([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: MODERN_META }),
    ]);

    expect((JSON.parse(reply ?? '{}') as { error?: { code: number } }).error?.code).toBe(-32601);
  });
});

describe('the official SDK client, which opens with the handshake', () => {
  it('connects, lists the six tools and calls one', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
    const client = new Client({ name: 'real-client-test', version: '1.0.0' });

    try {
      await client.connect(transport);

      expect(client.getServerVersion()?.name).toBe('mcpsteward');

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'capture_surface',
        'check_conformance',
        'check_policy',
        'diff_against_trust',
        'discover_servers',
        'verify_ledger',
      ]);

      const result = await client.callTool({ name: 'discover_servers', arguments: {} });
      expect(result.isError).toBe(false);
      expect(Array.isArray(result.content)).toBe(true);

      await expect(client.ping()).resolves.toBeDefined();
    } finally {
      await client.close();
    }
  }, 60_000);
});
