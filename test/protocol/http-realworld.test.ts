/**
 * HTTP behaviour against servers shaped like the real ones.
 *
 * Pointing mcpsteward at a real machine for the first time captured one HTTP server
 * out of twelve. Every failure below was observed there, and each test fails
 * against the code as it was:
 *
 * - Hosted servers refused unauthenticated requests with 401 and a vendor error
 *   body. That body was valid JSON, so it was parsed as a protocol message, and
 *   the report said the server "returned neither a result nor an error".
 * - A handshake era server issued a session id that was never sent back, so every
 *   request after the handshake was refused with "Server not initialized".
 * - The version header on legacy requests claimed 2026-07-28.
 * - A local server that was not running was reported as "fetch failed".
 */

import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { AuthenticationRequiredError, TransportError } from '../../src/core/errors.js';
import type { ServerRef } from '../../src/core/types.js';
import { McpClient } from '../../src/protocol/client.js';
import { HttpTransport } from '../../src/protocol/http-transport.js';
import {
  startRealWorldFixture,
  type RealWorldFixture,
  type RealWorldMode,
} from '../fixtures/servers/http-realworld.mjs';

const running: RealWorldFixture[] = [];

async function fixture(mode: RealWorldMode): Promise<RealWorldFixture> {
  const started = await startRealWorldFixture({ mode });
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((f) => f.close()));
});

function serverAt(url: string): ServerRef {
  return {
    id: 'rw',
    name: 'real world fixture',
    endpoint: { transport: 'http', url, headerNames: [] },
    authPosture: 'none',
    registrations: [],
  };
}

async function capture(url: string): Promise<Awaited<ReturnType<McpClient['capture']>>> {
  const client = new McpClient(new HttpTransport({ url }), { timeoutMs: 5_000 });
  try {
    return await client.capture(serverAt(url), 'http');
  } finally {
    await client.dispose();
  }
}

describe('a server that requires sign in', () => {
  for (const mode of ['auth-vendor-json', 'auth-jsonrpc', 'auth-forbidden'] as const) {
    it(`is reported as requiring sign in (${mode})`, async () => {
      const server = await fixture(mode);

      const error = await capture(server.url).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthenticationRequiredError);
      expect((error as Error).message).toMatch(/requires you to sign in/);
      expect((error as Error).message).toContain('127.0.0.1');
    });
  }

  it('is not retried, because retrying cannot change the answer', async () => {
    const server = await fixture('auth-vendor-json');
    await capture(server.url).catch(() => undefined);
    expect(server.received).toHaveLength(1);
  });

  it('records whether the server issued a sign in challenge', async () => {
    const server = await fixture('auth-vendor-json');
    const error = (await capture(server.url).catch((e: unknown) => e)) as AuthenticationRequiredError;
    expect(error.details['challenge']).toBe(true);
  });
});

describe('a handshake era server with sessions', () => {
  it('is captured, with the session carried on every request after the handshake', async () => {
    const server = await fixture('legacy-session');

    const captured = await capture(server.url);

    expect(captured.surface.revisionUsed).toBe('2025-11-25');
    expect(captured.surface.descriptors.map((d) => d.identity)).toContain('lookup');

    const afterHandshake = server.received.filter(
      (r) => r.method === 'POST' && !r.body.includes('"initialize"') && !r.body.includes('server/discover'),
    );
    expect(afterHandshake.length).toBeGreaterThan(0);
    for (const request of afterHandshake) {
      expect(request.headers['mcp-session-id']).toBe('session-7f3a');
      expect(request.headers['mcp-protocol-version']).toBe('2025-11-25');
    }
  });

  it('sends notifications/initialized before anything else', async () => {
    const server = await fixture('legacy-session');
    await capture(server.url);
    expect(server.state.initialized).toBe(true);
  });

  it('closes the session when done', async () => {
    const server = await fixture('legacy-session');
    await capture(server.url);
    expect(server.state.closed).toBe(true);
  });
});

describe('a response that is JSON but not JSON-RPC', () => {
  it('is reported as carrying no JSON-RPC message', async () => {
    const server = await fixture('json-not-jsonrpc');
    const transport = new HttpTransport({ url: server.url });

    await expect(
      transport.request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, 5_000),
    ).rejects.toThrow(/with no JSON-RPC message/);
  });
});

describe('a server that is not running', () => {
  it('says nothing is listening, and never prints the query string', async () => {
    // Find a port with nothing on it by binding one and releasing it.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });

    const transport = new HttpTransport({
      url: `http://127.0.0.1:${String(port)}/mcp?userToken=very-secret-value`,
    });

    const error = await transport
      .request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, 5_000)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toMatch(/nothing is listening/);
    expect((error as Error).message).not.toContain('very-secret-value');
  });
});
