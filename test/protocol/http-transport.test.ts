import { afterEach, describe, expect, it } from 'vitest';

import type { ServerRef } from '../../src/core/types.js';
import { McpClient } from '../../src/protocol/client.js';
import { HttpTransport, lastSseData } from '../../src/protocol/http-transport.js';
import { buildRequest } from '../../src/protocol/messages.js';
import { startHttpFixture, type HttpFixture } from '../fixtures/servers/http-server.mjs';

const running: HttpFixture[] = [];

async function fixture(mode = 'conforming'): Promise<HttpFixture> {
  const started = await startHttpFixture({ mode });
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((f) => f.close()));
});

function req(id: number, method: string, params?: Record<string, never>): Record<string, unknown> {
  return buildRequest({
    id,
    method,
    revision: '2026-07-28',
    ...(params === undefined ? {} : { params }),
  });
}

const SERVER: ServerRef = {
  id: 'http-test',
  name: 'http fixture',
  endpoint: { transport: 'http', url: 'http://127.0.0.1/mcp', headerNames: [] },
  authPosture: 'none',
  registrations: [],
};

describe('happy path', () => {
  it('completes a JSON request and response exchange', async () => {
    const server = await fixture();
    const transport = new HttpTransport({ url: server.url });

    const response = (await transport.request(req(1, 'server/discover'), 5000)) as Record<
      string,
      unknown
    >;

    const result = response['result'] as Record<string, unknown>;
    expect(result['supportedVersions']).toEqual(['2026-07-28']);
    expect(result['resultType']).toBe('complete');
  });

  it('captures a full surface through the client', async () => {
    const server = await fixture();
    const transport = new HttpTransport({ url: server.url });
    const client = new McpClient(transport, { timeoutMs: 5000 });

    const surface = await client.captureSurface(SERVER, 'http');

    expect(surface.transport).toBe('http');
    expect(surface.descriptors.map((d) => d.identity)).toEqual(['get_weather']);
    expect(surface.hashes.root).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('required request headers', () => {
  it('sends the protocol version, method and accept headers', async () => {
    const server = await fixture();
    const transport = new HttpTransport({ url: server.url });

    await transport.request(req(1, 'tools/list'), 5000);

    const sent = server.received[0];
    expect(sent?.headers['mcp-protocol-version']).toBe('2026-07-28');
    expect(sent?.headers['mcp-method']).toBe('tools/list');
    expect(sent?.headers['accept']).toContain('application/json');
    expect(sent?.headers['accept']).toContain('text/event-stream');
  });

  it('sends a header value that matches the body, so the server accepts it', async () => {
    // MS-HTTP-002 and MS-HTTP-004: the fixture rejects a mismatch with 400 and
    // -32020, so a successful exchange is itself the assertion.
    const server = await fixture();
    const transport = new HttpTransport({ url: server.url });

    const response = (await transport.request(req(1, 'tools/list'), 5000)) as Record<
      string,
      unknown
    >;
    expect(response['error']).toBeUndefined();
  });

  it('never sends a session header, because sessions were removed', async () => {
    // MS-HTTP-012. Sending one would be harmless but would signal that the
    // client still believes in session state.
    const server = await fixture();
    const transport = new HttpTransport({ url: server.url });

    await transport.request(req(1, 'tools/list'), 5000);

    expect(server.received[0]?.headers['mcp-session-id']).toBeUndefined();
    expect(server.received[0]?.headers['last-event-id']).toBeUndefined();
  });
});

describe('SSE responses', () => {
  it('reads the final response from a streamed answer', async () => {
    // MS-HTTP-007: the client MUST support both content types. The fixture emits
    // a progress notification and a keep-alive comment before the response.
    const server = await fixture('streams-response');
    const transport = new HttpTransport({ url: server.url });

    const response = (await transport.request(req(1, 'server/discover'), 5000)) as Record<
      string,
      unknown
    >;

    const result = response['result'] as Record<string, unknown>;
    expect(result['supportedVersions']).toEqual(['2026-07-28']);
  });

  it('captures a surface over a streamed transport', async () => {
    const server = await fixture('streams-response');
    const client = new McpClient(new HttpTransport({ url: server.url }), { timeoutMs: 5000 });

    const surface = await client.captureSurface(SERVER, 'http');
    expect(surface.descriptors).toHaveLength(1);
  });
});

describe('lastSseData', () => {
  it('returns the final data payload', () => {
    const body = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
    expect(lastSseData(body)).toBe('{"b":2}');
  });

  it('ignores keep-alive comment lines', () => {
    // Servers are encouraged to emit these on long lived streams, and the SSE
    // specification requires clients to ignore them rather than treat them as
    // malformed input.
    expect(lastSseData(':\n\ndata: {"a":1}\n\n')).toBe('{"a":1}');
    expect(lastSseData(': keep alive\n\ndata: {"a":1}\n\n')).toBe('{"a":1}');
  });

  it('joins a multi line data payload', () => {
    expect(lastSseData('data: {"a":\ndata: 1}\n\n')).toBe('{"a":\n1}');
  });

  it('tolerates the optional space after the colon being absent', () => {
    expect(lastSseData('data:{"a":1}\n\n')).toBe('{"a":1}');
  });

  it('handles CRLF line endings', () => {
    expect(lastSseData('data: {"a":1}\r\n\r\n')).toBe('{"a":1}');
  });

  it('returns undefined for a body with no data lines', () => {
    expect(lastSseData('')).toBeUndefined();
    expect(lastSseData(': just a comment\n\n')).toBeUndefined();
  });

  it('handles a stream that does not end with a blank line', () => {
    expect(lastSseData('data: {"a":1}')).toBe('{"a":1}');
  });
});

describe('raw exchanges, which conformance rules grade', () => {
  it('preserves the status and headers of an error response', async () => {
    // A 400 with -32020 is a correct answer to a malformed request, not a
    // transport failure. Swallowing it would throw away the evidence the
    // conformance engine needs.
    const server = await fixture();
    const transport = new HttpTransport({ url: server.url });

    const response = await transport.rawRequest(
      buildRequest({ id: 1, method: 'tools/list', revision: '2026-07-28', omitMeta: true }),
      { timeoutMs: 5000 },
    );

    expect(response.status).toBe(400);
    expect(response.message).toBeDefined();
  });

  it('reports 404 with method not found for an unimplemented method', async () => {
    // MS-HTTP-005.
    const server = await fixture();
    const transport = new HttpTransport({ url: server.url });

    const response = await transport.rawRequest(req(1, 'prompts/list'), { timeoutMs: 5000 });

    expect(response.status).toBe(404);
    const message = response.message as Record<string, unknown>;
    const error = message['error'] as Record<string, unknown>;
    expect(Number((error['code'] as { token: string }).token)).toBe(-32601);
  });

  it('reports 405 for a GET, since the GET stream endpoint was removed', async () => {
    // MS-HTTP-011.
    const server = await fixture();
    const transport = new HttpTransport({ url: server.url });

    const response = await transport.rawRequest(req(1, 'tools/list'), {
      timeoutMs: 5000,
      httpMethod: 'GET',
    });

    expect(response.status).toBe(405);
  });

  it('records the content type so a streamed answer is distinguishable', async () => {
    const server = await fixture('streams-response');
    const transport = new HttpTransport({ url: server.url });

    const response = await transport.rawRequest(req(1, 'tools/list'), { timeoutMs: 5000 });

    expect(response.streamed).toBe(true);
    expect(response.contentType).toContain('text/event-stream');
  });

  it('reports a version rejection with its supported list intact', async () => {
    const server = await fixture();
    const transport = new HttpTransport({ url: server.url, revision: '2025-11-25' });

    const response = await transport.rawRequest(
      buildRequest({ id: 1, method: 'tools/list', revision: '2025-11-25' }),
      { timeoutMs: 5000 },
    );

    expect(response.status).toBe(400);
    const message = response.message as Record<string, unknown>;
    const error = message['error'] as Record<string, unknown>;
    expect(Number((error['code'] as { token: string }).token)).toBe(-32022);
  });
});

describe('failure handling', () => {
  it('times out against an unreachable endpoint', async () => {
    // A reserved documentation address that will not answer.
    const transport = new HttpTransport({ url: 'http://192.0.2.1:9/mcp' });

    await expect(transport.request(req(1, 'tools/list'), 300)).rejects.toThrow(
      /timed out|Could not reach/,
    );
  });

  it('reports a connection refusal as a transport failure', async () => {
    const server = await fixture();
    await server.close();
    running.length = 0;

    const transport = new HttpTransport({ url: server.url });
    await expect(transport.request(req(1, 'tools/list'), 3000)).rejects.toThrow();
  });

  it('cancels a request that is genuinely in flight', async () => {
    // Against a server that accepts the connection and then never answers, so
    // the abort lands mid request rather than racing a connection failure.
    const server = await fixture('never-responds');
    const transport = new HttpTransport({ url: server.url });
    const controller = new AbortController();

    const pending = transport.request(req(1, 'tools/list'), 5000, controller.signal);
    setTimeout(() => { controller.abort(); }, 50);

    await expect(pending).rejects.toThrow(/cancelled/i);
  });

  it('times out a request that is in flight, distinctly from cancelling it', async () => {
    // A CLI reports one of these as a failure and the other as a normal exit.
    const server = await fixture('never-responds');
    const transport = new HttpTransport({ url: server.url });

    try {
      await transport.request(req(1, 'tools/list'), 200);
      expect.unreachable('should have timed out');
    } catch (error) {
      expect((error as { code: string }).code).toBe('TIMEOUT');
    }
  });

  it('refuses to send after disposal', async () => {
    const server = await fixture();
    const transport = new HttpTransport({ url: server.url });
    await transport.dispose();

    await expect(transport.request(req(1, 'tools/list'), 5000)).rejects.toThrow(/disposed/);
  });
});
