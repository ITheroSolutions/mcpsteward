import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countFixtureProcesses, waitForFixtureProcesses } from '../fixtures/processes.js';
import { startHttpFixture } from '../fixtures/servers/http-server.mjs';

import { callApprovedTool, trustServer, withServer, type ServerRef } from '../../src/api.js';
import {
  CancellationError,
  ConfigurationError,
  ServerChangedError,
  TimeoutError,
  ToolCallError,
  ToolNotApprovedError,
} from '../../src/core/errors.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/servers/conforming.mjs', import.meta.url));
const LEGACY = fileURLToPath(new URL('../fixtures/servers/legacy-2025-11-25.mjs', import.meta.url));

let root: string;
let callLog: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpsteward-tools-'));
  callLog = join(root, 'calls.log');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function stdioServer(id = 'fixture-tools', script = FIXTURE): ServerRef {
  return {
    id,
    name: 'fixture',
    endpoint: { transport: 'stdio', command: process.execPath, args: [script], envNames: [] },
    authPosture: 'none',
    registrations: [],
  };
}

function envFor(mode: string): Record<string, string> {
  return { MCPSTEWARD_FIXTURE_MODE: mode, MCPSTEWARD_FIXTURE_CALL_LOG: callLog };
}

/** How many tools/call requests the fixture actually received. */
async function callsReceived(): Promise<number> {
  if (!existsSync(callLog)) return 0;
  return (await readFile(callLog, 'utf8')).split('\n').filter((line) => line.length > 0).length;
}

describe('calling a tool', () => {
  it('returns what the tool said, as text and as structured content', async () => {
    const result = await withServer(
      stdioServer(),
      async (session) => await session.callTool('get_weather', { location: 'Sarnia' }),
      { env: envFor('conforming') },
    );

    expect(result.isError).toBe(false);
    expect(result.text).toBe('Sunny in Sarnia');
    expect(result.structuredContent?.['location']).toBe('Sarnia');
    expect(result.content).toHaveLength(1);
    expect(await callsReceived()).toBe(1);
  });

  it('sends the arguments exactly as given', async () => {
    const args = { query: 'mcp', limit: 5, nested: { list: [1, 2.5, true, null, 'x'] } };

    const result = await withServer(
      stdioServer(),
      async (session) => await session.callTool('search_documents', args),
      { env: envFor('conforming') },
    );

    expect(JSON.parse(result.text)).toEqual(args);
  });

  it('works after a capture on the same connection', async () => {
    const result = await withServer(
      stdioServer(),
      async (session) => {
        await session.capture();
        return await session.callTool('get_weather', { location: 'Sarnia' });
      },
      { env: envFor('conforming') },
    );

    expect(result.text).toBe('Sunny in Sarnia');
  });

  it('returns a tool reporting its own failure rather than throwing', async () => {
    const result = await withServer(
      stdioServer(),
      async (session) => await session.callTool('get_weather', { location: 'Sarnia' }),
      { env: envFor('tool-reports-error') },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toBe('The weather service is down.');
  });

  it('throws ToolCallError when the server answers with an error', async () => {
    const pending = withServer(
      stdioServer(),
      async (session) => await session.callTool('no_such_tool', {}),
      { env: envFor('conforming') },
    );

    await expect(pending).rejects.toBeInstanceOf(ToolCallError);
    await expect(pending).rejects.toMatchObject({ code: 'TOOL_CALL_FAILED' });
  });

  it('throws ToolCallError rather than returning an interim result as the answer', async () => {
    const pending = withServer(
      stdioServer(),
      async (session) => await session.callTool('get_weather', { location: 'Sarnia' }),
      { env: envFor('tool-input-required') },
    );

    await expect(pending).rejects.toBeInstanceOf(ToolCallError);
  });

  it('refuses arguments that are not plain JSON, and sends nothing', async () => {
    const bad: unknown[] = [
      [],
      null,
      { a: undefined },
      { a: BigInt(10) },
      { a: Number.NaN },
      { a: new Date(0) },
      { a: () => 1 },
    ];

    await withServer(
      stdioServer(),
      async (session) => {
        for (const args of bad) {
          await expect(
            session.callTool('get_weather', args as Record<string, unknown>),
          ).rejects.toBeInstanceOf(ConfigurationError);
        }
      },
      { env: envFor('conforming') },
    );

    expect(await callsReceived()).toBe(0);
  });

  it('refuses an empty tool name', async () => {
    await withServer(
      stdioServer(),
      async (session) => {
        await expect(session.callTool('', {})).rejects.toBeInstanceOf(ConfigurationError);
      },
      { env: envFor('conforming') },
    );
  });

  it('sends a call once and does not retry it after a timeout', async () => {
    const pending = withServer(
      stdioServer(),
      async (session) =>
        await session.callTool('get_weather', { location: 'Sarnia' }, { timeoutMs: 500 }),
      { env: envFor('tool-hangs') },
    );

    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    // A retried call would have reached the fixture a second time well within
    // the backoff the list requests use.
    expect(await callsReceived()).toBe(1);
  }, 15_000);

  it('can be cancelled while the tool is running', async () => {
    const controller = new AbortController();

    const pending = withServer(
      stdioServer(),
      async (session) =>
        await session.callTool(
          'get_weather',
          { location: 'Sarnia' },
          { signal: controller.signal, timeoutMs: 10_000 },
        ),
      { env: envFor('tool-hangs') },
    );

    setTimeout(() => {
      controller.abort();
    }, 300);

    await expect(pending).rejects.toBeInstanceOf(CancellationError);
  }, 15_000);
});

describe('calling only what was approved', () => {
  it('calls the tool when the server still matches its approval', async () => {
    const server = stdioServer();
    const pin = await trustServer(server, 'reviewer', { env: envFor('conforming') });

    const { result, report } = await callApprovedTool(
      server,
      pin,
      'get_weather',
      { location: 'Sarnia' },
      { env: envFor('conforming') },
    );

    expect(result.text).toBe('Sunny in Sarnia');
    expect(report.events).toHaveLength(0);
    expect(await callsReceived()).toBe(1);
  });

  it('refuses, and sends nothing, when the server changed since approval', async () => {
    const server = stdioServer();
    const pin = await trustServer(server, 'reviewer', { env: envFor('conforming') });

    // The same server, now advertising one more tool than was approved.
    const pending = callApprovedTool(
      server,
      pin,
      'get_weather',
      { location: 'Sarnia' },
      { env: envFor('bad-header-number') },
    );

    await expect(pending).rejects.toBeInstanceOf(ServerChangedError);
    const error = (await pending.catch((caught: unknown) => caught)) as ServerChangedError;
    expect(error.code).toBe('SERVER_CHANGED');
    expect(Array.isArray(error.details['changes'])).toBe(true);
    expect((error.details['changes'] as unknown[]).length).toBeGreaterThan(0);
    expect(await callsReceived()).toBe(0);
  });

  it('refuses a tool the approval does not include, and sends nothing', async () => {
    const server = stdioServer();
    const pin = await trustServer(server, 'reviewer', { env: envFor('conforming') });

    const pending = callApprovedTool(
      server,
      pin,
      'delete_everything',
      {},
      {
        env: envFor('conforming'),
      },
    );

    await expect(pending).rejects.toBeInstanceOf(ToolNotApprovedError);
    expect(await callsReceived()).toBe(0);
  });

  it('refuses an approval that belongs to another server', async () => {
    const pin = await trustServer(stdioServer('server-a'), 'reviewer', {
      env: envFor('conforming'),
    });

    const pending = callApprovedTool(
      stdioServer('server-b'),
      pin,
      'get_weather',
      {},
      {
        env: envFor('conforming'),
      },
    );

    await expect(pending).rejects.toBeInstanceOf(ConfigurationError);
    expect(await callsReceived()).toBe(0);
  });

  it('bounds the tool call by callTimeoutMs, separately from the check', async () => {
    const server = stdioServer();
    // tool-hangs advertises exactly what conforming does, so the check passes
    // and only the call itself hangs.
    const pin = await trustServer(server, 'reviewer', { env: envFor('conforming') });

    const pending = callApprovedTool(
      server,
      pin,
      'get_weather',
      { location: 'Sarnia' },
      { env: envFor('tool-hangs'), callTimeoutMs: 500 },
    );

    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    expect(await callsReceived()).toBe(1);
  }, 15_000);

  it('works against a handshake era server', async () => {
    const server = stdioServer('legacy-tools', LEGACY);
    const pin = await trustServer(server, 'reviewer');

    const { result } = await callApprovedTool(server, pin, 'legacy_lookup', { term: 'mcp' });

    expect(result.text).toBe('Definition of mcp');
  }, 20_000);

  it('works over HTTP and names the tool in Mcp-Name', async () => {
    const fixture = await startHttpFixture();

    try {
      const server: ServerRef = {
        id: 'http-tools',
        name: 'http fixture',
        endpoint: { transport: 'http', url: fixture.url, headerNames: [] },
        authPosture: 'none',
        registrations: [],
      };

      const pin = await trustServer(server, 'reviewer');
      const { result } = await callApprovedTool(server, pin, 'get_weather', {
        location: 'Sarnia',
      });

      expect(result.text).toBe('Sunny in Sarnia');

      const call = fixture.received.find((entry) => entry.body.includes('"tools/call"'));
      expect(call?.headers['mcp-name']).toBe('get_weather');
    } finally {
      await fixture.close();
    }
  });
});

describe('no orphaned processes', () => {
  it('leaves nothing running after approved and refused calls', async () => {
    const before = await countFixtureProcesses();

    const server = stdioServer();
    const pin = await trustServer(server, 'reviewer', { env: envFor('conforming') });
    await callApprovedTool(
      server,
      pin,
      'get_weather',
      { location: 'Sarnia' },
      {
        env: envFor('conforming'),
      },
    );
    await callApprovedTool(
      server,
      pin,
      'get_weather',
      {},
      {
        env: envFor('bad-header-number'),
      },
    ).catch(() => undefined);

    expect(await waitForFixtureProcesses(before)).toBeLessThanOrEqual(before);
  }, 25_000);
});
