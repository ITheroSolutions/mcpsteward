import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildRequest } from '../../src/protocol/messages.js';
import { StdioTransport } from '../../src/protocol/stdio-transport.js';
import { countFixtureProcesses, waitForFixtureProcesses } from '../fixtures/processes.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/servers/conforming.mjs', import.meta.url));

const open: StdioTransport[] = [];

function start(mode = 'conforming'): StdioTransport {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [FIXTURE],
    env: { MCPSTEWARD_FIXTURE_MODE: mode },
  });
  transport.start();
  open.push(transport);
  return transport;
}

afterEach(async () => {
  // Every test disposes its own transport, but a failing test may not reach that
  // line. Leaking a child process here would poison later tests on Windows,
  // where the port or file lock survives the test run.
  await Promise.all(open.splice(0).map((t) => t.dispose()));
});

function req(id: number, method: string): Record<string, unknown> {
  return buildRequest({ id, method, revision: '2026-07-28' });
}

/**
 * Read a response id as a number.
 *
 * Responses are parsed with number fidelity preserved, so a numeric id arrives as
 * a JsonNumber carrying its source token rather than as a JavaScript number. That
 * is the point of the parser, so the tests unwrap rather than asking the
 * transport to degrade its output.
 */
function idOf(response: unknown): number {
  const id = (response as Record<string, unknown>)['id'];
  if (typeof id === 'number') return id;
  return Number((id as { token: string }).token);
}

describe('stdio transport, happy path', () => {
  it('completes a request and response exchange', async () => {
    const transport = start();
    const result = (await transport.request(req(1, 'server/discover'), 5000)) as Record<
      string,
      unknown
    >;

    expect(result['jsonrpc']).toBe('2.0');
    expect(idOf(result)).toBe(1);

    const body = result['result'] as Record<string, unknown>;
    expect(body['supportedVersions']).toEqual(['2026-07-28']);
    expect(body['resultType']).toBe('complete');
  });

  it('captures a tool list', async () => {
    const transport = start();
    const response = (await transport.request(req(2, 'tools/list'), 5000)) as Record<
      string,
      unknown
    >;

    const tools = (response['result'] as Record<string, unknown>)['tools'];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(2);
  });

  it('handles several sequential requests on one process', async () => {
    const transport = start();

    for (let i = 1; i <= 5; i += 1) {
      const response = (await transport.request(req(i, 'tools/list'), 5000)) as Record<
        string,
        unknown
      >;
      expect(idOf(response)).toBe(i);
    }
  });

  it('correlates concurrent requests by id', async () => {
    // All messages share one channel on stdio, so correlation is the transport's
    // job and getting it wrong would silently pair responses with the wrong
    // request.
    const transport = start();

    const [a, b, c] = await Promise.all([
      transport.request(req(10, 'tools/list'), 5000),
      transport.request(req(11, 'prompts/list'), 5000),
      transport.request(req(12, 'resources/list'), 5000),
    ]);

    expect(idOf(a)).toBe(10);
    expect(idOf(b)).toBe(11);
    expect(idOf(c)).toBe(12);

    expect((b as Record<string, unknown>)['result']).toHaveProperty('prompts');
    expect((c as Record<string, unknown>)['result']).toHaveProperty('resources');
  });

  it('preserves number fidelity through the transport', async () => {
    // JSON.parse would round this. The transport must not be the place where
    // precision is lost, or canonicalization never gets a chance.
    const transport = start();
    const response = (await transport.request(req(3, 'tools/list'), 5000)) as Record<
      string,
      unknown
    >;

    const body = response['result'] as Record<string, unknown>;
    const tools = body['tools'] as Record<string, unknown>[];
    const schema = tools[1]?.['inputSchema'] as Record<string, unknown>;
    const limit = (schema['properties'] as Record<string, unknown>)['limit'] as Record<
      string,
      unknown
    >;

    // Numbers arrive as preserved tokens rather than JavaScript numbers.
    expect(limit['maximum']).toMatchObject({ __jsonNumber: true, token: '100' });
  });
});

describe('stderr handling', () => {
  it('keeps stderr out of the message stream', async () => {
    // MS-STDIO-003: a client SHOULD NOT assume stderr output indicates an error.
    // A server logging steadily to stderr must not disturb the exchange at all.
    const transport = start('noisy-stderr');

    const response = (await transport.request(req(1, 'tools/list'), 5000)) as Record<
      string,
      unknown
    >;

    expect(idOf(response)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.stderr).toContain('still alive');
  });

  it('does not treat a server writing to stderr as a failure', async () => {
    const transport = start('noisy-stderr');
    await expect(transport.request(req(1, 'server/discover'), 5000)).resolves.toBeDefined();
  });
});

describe('malformed server output', () => {
  it('ignores a non MCP line on stdout rather than tearing down', async () => {
    // Writing this is a MS-STDIO-002 violation, which the conformance engine
    // reports as a finding. It is not a reason to abandon the capture.
    const transport = start('writes-junk-to-stdout');

    const response = (await transport.request(req(1, 'tools/list'), 5000)) as Record<
      string,
      unknown
    >;
    expect(idOf(response)).toBe(1);
  });

  it('times out when the server answers with invalid JSON', async () => {
    const transport = start('invalid-json-response');

    await expect(transport.request(req(1, 'tools/list'), 300)).rejects.toThrow(/timed out/);
  });
});

describe('timeouts and cancellation', () => {
  it('times out a server that never answers', async () => {
    const transport = start('hangs');

    await expect(transport.request(req(1, 'tools/list'), 200)).rejects.toThrow(/timed out/);
  });

  it('reports a timeout as TIMEOUT, not as a cancellation', async () => {
    const transport = start('hangs');

    try {
      await transport.request(req(1, 'tools/list'), 200);
      expect.unreachable('should have timed out');
    } catch (error) {
      expect((error as { code: string }).code).toBe('TIMEOUT');
    }
  });

  it('cancels through an AbortSignal', async () => {
    const transport = start('hangs');
    const controller = new AbortController();

    const pending = transport.request(req(1, 'tools/list'), 5000, controller.signal);
    setTimeout(() => { controller.abort(); }, 20);

    await expect(pending).rejects.toThrow(/cancelled/i);
  });

  it('reports a cancellation as CANCELLED, distinct from a timeout', async () => {
    // A CLI reports one of these as a failure and the other as a normal exit,
    // so conflating them would be a real behavioural bug.
    const transport = start('hangs');
    const controller = new AbortController();

    const pending = transport.request(req(1, 'tools/list'), 5000, controller.signal);
    setTimeout(() => { controller.abort(); }, 20);

    try {
      await pending;
      expect.unreachable('should have been cancelled');
    } catch (error) {
      expect((error as { code: string }).code).toBe('CANCELLED');
    }
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const transport = start();

    await expect(
      transport.request(req(1, 'tools/list'), 5000, AbortSignal.abort()),
    ).rejects.toThrow(/cancelled/i);
  });

  it('leaves the transport usable after a timeout', async () => {
    const transport = start();

    // A one millisecond budget guarantees a timeout. What matters is that the
    // late response does not corrupt the pending map and strand the next call.
    await transport.request(req(1, 'tools/list'), 1).catch(() => undefined);

    const response = (await transport.request(req(2, 'tools/list'), 5000)) as Record<
      string,
      unknown
    >;
    expect(idOf(response)).toBe(2);
  });
});

describe('process lifecycle', () => {
  it('rejects in flight requests when the server exits mid capture', async () => {
    const transport = start('exits-mid-capture');

    await expect(transport.request(req(1, 'tools/list'), 5000)).rejects.toThrow(
      /Server process exited/,
    );
  });

  it('refuses to send once the server has exited', async () => {
    const transport = start('exits-mid-capture');
    await transport.request(req(1, 'tools/list'), 5000).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(transport.request(req(2, 'tools/list'), 5000)).rejects.toThrow(
      /not running/,
    );
  });

  it('handles a server that dies before answering anything', async () => {
    const transport = start('crashes-immediately');

    await expect(transport.request(req(1, 'server/discover'), 2000)).rejects.toThrow();
  });

  it('refuses to start twice', () => {
    const transport = start();
    expect(() => { transport.start(); }).toThrow(/already started/);
  });
});

describe('shutdown', () => {
  it('exits the server by closing stdin', async () => {
    // MS-STDIO-006 and MS-STDIO-007: closing stdin is the primary graceful
    // shutdown signal and the only portable one.
    const transport = start();
    await transport.request(req(1, 'tools/list'), 5000);

    expect(transport.isRunning).toBe(true);
    await transport.dispose();
    expect(transport.isRunning).toBe(false);
  });

  it('terminates a server that ignores stdin close', async () => {
    const transport = start('ignores-stdin-close');
    await transport.request(req(1, 'tools/list'), 5000);

    await transport.dispose();
    expect(transport.isRunning).toBe(false);
  }, 15_000);

  it('is idempotent', async () => {
    const transport = start();
    await transport.dispose();
    await expect(transport.dispose()).resolves.toBeUndefined();
  });

  it('rejects requests that were in flight when disposed', async () => {
    const transport = start('hangs');
    const pending = transport.request(req(1, 'tools/list'), 5000);
    const assertion = expect(pending).rejects.toThrow(/disposed/);

    await transport.dispose();
    await assertion;
  });

  it('refuses to start after disposal', async () => {
    const transport = new StdioTransport({ command: process.execPath, args: [FIXTURE] });
    transport.start();
    await transport.dispose();

    expect(() => { transport.start(); }).toThrow(/disposed/);
  });
});

describe('no orphaned processes', () => {
  it('leaves no fixture process behind after a normal dispose', async () => {
    const before = await countFixtureProcesses();

    const transport = start();
    await transport.request(req(1, 'tools/list'), 5000);
    await transport.dispose();
    expect(await waitForFixtureProcesses(before)).toBeLessThanOrEqual(before);
  }, 20_000);

  it('leaves no fixture process behind after a timeout and dispose', async () => {
    const before = await countFixtureProcesses();

    const transport = start('hangs');
    await transport.request(req(1, 'tools/list'), 150).catch(() => undefined);
    await transport.dispose();
    expect(await waitForFixtureProcesses(before)).toBeLessThanOrEqual(before);
  }, 20_000);

  it('leaves no fixture process behind when the server ignores stdin close', async () => {
    // This is the case that exercises the process tree kill. On Windows a plain
    // kill would leave the child alive.
    const before = await countFixtureProcesses();

    const transport = start('ignores-stdin-close');
    await transport.request(req(1, 'tools/list'), 5000);
    await transport.dispose();
    expect(await waitForFixtureProcesses(before)).toBeLessThanOrEqual(before);
  }, 25_000);
});

/**
 * Count running processes whose command line mentions the fixture server.
 *
 * Deliberately tolerant: the assertion is "no more than before", not an exact
 * number, because a parallel test file may legitimately have one running. The
 * failure this catches is a leak that accumulates.
 */
