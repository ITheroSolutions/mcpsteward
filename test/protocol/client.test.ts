import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { TransportError } from '../../src/core/errors.js';
import type { JsonValue } from '../../src/core/json-parse.js';
import type { ServerRef } from '../../src/core/types.js';
import { McpClient, type Transport } from '../../src/protocol/client.js';
import { StdioTransport } from '../../src/protocol/stdio-transport.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/servers/conforming.mjs', import.meta.url));

const open: { dispose(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.dispose()));
});

const SERVER: ServerRef = {
  id: 'test-server',
  name: 'fixture',
  endpoint: { transport: 'stdio', command: 'node', args: [FIXTURE], envNames: [] },
  authPosture: 'none',
  registrations: [],
};

function client(mode = 'conforming'): McpClient {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [FIXTURE],
    env: { MCPSTEWARD_FIXTURE_MODE: mode },
  });
  transport.start();

  const c = new McpClient(transport, { timeoutMs: 5000, retries: 0 });
  open.push(c);
  return c;
}

describe('server/discover', () => {
  it('reads supported versions, capabilities and identity', async () => {
    const outcome = await client().discover('2026-07-28');

    expect(outcome.implemented).toBe(true);
    expect(outcome.supportedVersions).toEqual(['2026-07-28']);
    expect(outcome.capabilities).toHaveProperty('tools');
    expect(outcome.serverInfo).toMatchObject({ name: 'fixture-server' });
    expect(outcome.instructions).toContain('fixture server');
  });

  it('reports a server that does not implement it, without failing the capture', async () => {
    // MS-LIFE-001 makes this a MUST, so not implementing it is a conformance
    // finding. Refusing to inspect the server would defeat the purpose of a tool
    // that exists to find non conforming servers.
    const outcome = await client('no-discover').discover('2026-07-28');
    expect(outcome.implemented).toBe(false);
  });

  it('treats a version rejection as a real answer carrying the supported list', async () => {
    // MS-ERR-006: UnsupportedProtocolVersionError carries data.supported and
    // data.requested. That is not a failure to discover, it is the server
    // telling us which version to use, and negotiation depends on reading it.
    //
    // Driven through a mock rather than the fixture because the fixture only
    // speaks one modern revision, so it cannot reject one modern version while
    // advertising another.
    const transport: Transport = {
      request: (message) =>
        Promise.resolve({
          jsonrpc: '2.0',
          id: (message as { id: string }).id,
          error: {
            code: { __jsonNumber: true, token: '-32022' },
            message: 'Unsupported protocol version',
            data: { supported: ['2025-11-25'], requested: '2026-07-28' },
          },
        }),
      dispose: () => Promise.resolve(),
    };

    const outcome = await new McpClient(transport).discover('2026-07-28');

    expect(outcome.implemented).toBe(true);
    expect(outcome.supportedVersions).toEqual(['2025-11-25']);
  });
});

describe('version negotiation', () => {
  it('uses the preferred revision when the server supports it', async () => {
    const result = await client().negotiateRevision();

    expect(result.requested).toBe('2026-07-28');
    expect(result.used).toBe('2026-07-28');
    expect(result.downgraded).toBe(false);
  });

  it('proceeds as requested when the server implements no discover', async () => {
    const result = await client('no-discover').negotiateRevision();
    expect(result.used).toBe('2026-07-28');
    expect(result.downgraded).toBe(false);
  });

  it('downgrades when the server only supports an older revision, and says so', async () => {
    const c = new McpClient(rejectingTransport(['2025-11-25']));
    const result = await c.negotiateRevision();

    expect(result.requested).toBe('2026-07-28');
    expect(result.used).toBe('2025-11-25');
    expect(result.downgraded).toBe(true);
  });

  it('refuses to downgrade when downgrade is disabled', async () => {
    const c = new McpClient(rejectingTransport(['2025-11-25']), { allowDowngrade: false });
    await expect(c.negotiateRevision()).rejects.toThrow(/downgrade is disabled/);
  });

  it('fails when there is no mutually supported revision', async () => {
    // Silently proceeding here would produce a capture against a protocol we do
    // not actually speak.
    const c = new McpClient(rejectingTransport(['1999-01-01']));
    await expect(c.negotiateRevision()).rejects.toThrow(/No mutually supported/);
  });
});

/** A transport that rejects every version and advertises the given list. */
function rejectingTransport(supported: readonly string[]): Transport {
  return {
    request: (message) =>
      Promise.resolve({
        jsonrpc: '2.0',
        id: (message as { id: string }).id,
        error: {
          code: { __jsonNumber: true, token: '-32022' },
          message: 'Unsupported protocol version',
          data: { supported: [...supported], requested: '2026-07-28' },
        },
      }),
    dispose: () => Promise.resolve(),
  };
}

describe('surface capture', () => {
  it('captures every category the server declares', async () => {
    const surface = await client().captureSurface(SERVER, 'stdio');

    const categories = new Set(surface.descriptors.map((d) => d.category));
    expect(categories).toContain('tool');
    expect(categories).toContain('prompt');
    expect(categories).toContain('resource');
  });

  it('records which revision was actually used, separately from the request', async () => {
    // A downgraded capture presented as a current one would make the ledger lie.
    const surface = await client().captureSurface(SERVER, 'stdio');

    expect(surface.revisionRequested).toBe('2026-07-28');
    expect(surface.revisionUsed).toBe('2026-07-28');
  });

  it('computes all three hash levels', async () => {
    const surface = await client().captureSurface(SERVER, 'stdio');

    expect(surface.hashes.root).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(surface.hashes.byCategory.tool).toBeDefined();
    expect(Object.keys(surface.hashes.byDescriptor).length).toBeGreaterThan(0);
  });

  it('produces the same root for two captures of an unchanged server', async () => {
    // Without this, every capture would look like drift and the trust half of
    // the package would be useless.
    const a = await client().captureSurface(SERVER, 'stdio');
    const b = await client().captureSurface(SERVER, 'stdio');

    expect(b.hashes.root).toBe(a.hashes.root);
  });

  it('records capture metadata', async () => {
    const surface = await client().captureSurface(SERVER, 'stdio');

    expect(surface.transport).toBe('stdio');
    expect(Date.parse(surface.capturedAt)).not.toBeNaN();
    expect(surface.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports progress as it goes', async () => {
    const stages: string[] = [];
    const transport = new StdioTransport({
      command: process.execPath,
      args: [FIXTURE],
      env: { MCPSTEWARD_FIXTURE_MODE: 'conforming' },
    });
    transport.start();

    const c = new McpClient(transport, {
      timeoutMs: 5000,
      onProgress: (event) => stages.push(event.stage),
    });
    open.push(c);

    await c.captureSurface(SERVER, 'stdio');

    expect(stages).toContain('discover');
    expect(stages).toContain('tools');
  });

  it('refuses a surface where the server advertised the same tool twice', async () => {
    // Which of the two is authoritative is undefined, so there is no honest hash.
    await expect(client('duplicate-tool').captureSurface(SERVER, 'stdio')).rejects.toThrow(
      /Duplicate descriptor identity/,
    );
  });
});

describe('failure handling', () => {
  it('surfaces a transport failure when the server dies', async () => {
    await expect(client('crashes-immediately').captureSurface(SERVER, 'stdio')).rejects.toThrow();
  });

  it('times out against a server that never answers', async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: [FIXTURE],
      env: { MCPSTEWARD_FIXTURE_MODE: 'hangs' },
    });
    transport.start();

    const c = new McpClient(transport, { timeoutMs: 200, retries: 0 });
    open.push(c);

    await expect(c.captureSurface(SERVER, 'stdio')).rejects.toThrow(/timed out/);
  });

  it('cancels through an AbortSignal', async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: [FIXTURE],
      env: { MCPSTEWARD_FIXTURE_MODE: 'hangs' },
    });
    transport.start();

    const controller = new AbortController();
    const c = new McpClient(transport, { timeoutMs: 5000, signal: controller.signal });
    open.push(c);

    const pending = c.captureSurface(SERVER, 'stdio');
    setTimeout(() => { controller.abort(); }, 30);

    await expect(pending).rejects.toThrow(/cancelled/i);
  });
});

describe('retries', () => {
  it('does not retry a protocol level error, which is a real answer', async () => {
    // Retrying a -32601 asks the same question and gets the same answer, while
    // making the capture take three times as long.
    let calls = 0;

    const transport: Transport = {
      request: (message) => {
        calls += 1;
        return Promise.resolve({
          jsonrpc: '2.0',
          id: (message as { id: string }).id,
          error: { code: { __jsonNumber: true, token: '-32601' }, message: 'Method not found' },
        });
      },
      dispose: () => Promise.resolve(),
    };

    const c = new McpClient(transport, { retries: 3 });
    await c.discover('2026-07-28');

    expect(calls).toBe(1);
  });

  it('retries a typed transport failure and succeeds on a later attempt', async () => {
    let calls = 0;

    const transport: Transport = {
      request: (message) => {
        calls += 1;
        if (calls < 3) return Promise.reject(new TransportError('connection reset'));

        return Promise.resolve({
          jsonrpc: '2.0',
          id: (message as { id: string }).id,
          result: { resultType: 'complete', supportedVersions: ['2026-07-28'] },
        });
      },
      dispose: () => Promise.resolve(),
    };

    const c = new McpClient(transport, { retries: 3, retryBackoffMs: 1 });
    const outcome = await c.discover('2026-07-28');

    expect(outcome.supportedVersions).toEqual(['2026-07-28']);
    expect(calls).toBe(3);
  });

  it('gives up after the configured number of retries', async () => {
    let calls = 0;

    const transport: Transport = {
      request: () => {
        calls += 1;
        return Promise.reject(new TransportError('connection reset'));
      },
      dispose: () => Promise.resolve(),
    };

    const c = new McpClient(transport, { retries: 2, retryBackoffMs: 1 });
    await expect(c.discover('2026-07-28')).rejects.toThrow(/connection reset/);

    // The initial attempt plus two retries.
    expect(calls).toBe(3);
  });

  it('does not retry an error that is not a transport failure', async () => {
    // A bug in this package is not made better by running it three times.
    let calls = 0;

    const transport: Transport = {
      request: () => {
        calls += 1;
        return Promise.reject(new TypeError('a defect, not a network problem'));
      },
      dispose: () => Promise.resolve(),
    };

    const c = new McpClient(transport, { retries: 3, retryBackoffMs: 1 });
    await expect(c.discover('2026-07-28')).rejects.toThrow(/a defect/);
    expect(calls).toBe(1);
  });
});

describe('pagination', () => {
  function pagingTransport(
    pages: readonly { items: JsonValue[]; nextCursor?: string }[],
  ): Transport {
    let index = 0;

    return {
      request: (message) => {
        const request = message as { id: string; method: string };

        if (request.method === 'server/discover') {
          return Promise.resolve({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {} },
            },
          });
        }

        if (request.method !== 'tools/list') {
          return Promise.resolve({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: { __jsonNumber: true, token: '-32601' }, message: 'not found' },
          });
        }

        const page = pages[Math.min(index, pages.length - 1)];
        index += 1;

        return Promise.resolve({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            resultType: 'complete',
            tools: page?.items ?? [],
            ...(page?.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          },
        });
      },
      dispose: () => Promise.resolve(),
    };
  }

  it('follows cursors to exhaustion', async () => {
    const transport = pagingTransport([
      { items: [{ name: 'a' }], nextCursor: 'p2' },
      { items: [{ name: 'b' }], nextCursor: 'p3' },
      { items: [{ name: 'c' }] },
    ]);

    const surface = await new McpClient(transport).captureSurface(SERVER, 'stdio');
    expect(surface.descriptors.map((d) => d.identity)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a repeating cursor rather than looping forever', async () => {
    // A server that points a cursor at itself, whether broken or hostile, must
    // not be able to hang the capture.
    const transport = pagingTransport([{ items: [{ name: 'a' }], nextCursor: 'same' }]);

    await expect(new McpClient(transport).captureSurface(SERVER, 'stdio')).rejects.toThrow(
      /repeating pagination cursor/,
    );
  });

  it('handles a single unpaginated page', async () => {
    const transport = pagingTransport([{ items: [{ name: 'only' }] }]);
    const surface = await new McpClient(transport).captureSurface(SERVER, 'stdio');
    expect(surface.descriptors).toHaveLength(1);
  });

  it('stops at the descriptor limit', async () => {
    const transport = pagingTransport([
      { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], nextCursor: 'more' },
    ]);

    const surface = await new McpClient(transport, { maxDescriptors: 2 }).captureSurface(
      SERVER,
      'stdio',
    );

    expect(surface.descriptors).toHaveLength(2);
  });
});

describe('capability driven capture', () => {
  it('does not ask for a category the server never declared', async () => {
    // Rules are capability driven: a server that does not declare prompts is not
    // failed for prompt rules, and should not even be asked.
    const asked: string[] = [];

    const transport: Transport = {
      request: (message) => {
        const request = message as { id: string; method: string };
        asked.push(request.method);

        if (request.method === 'server/discover') {
          return Promise.resolve({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {} },
            },
          });
        }

        return Promise.resolve({
          jsonrpc: '2.0',
          id: request.id,
          result: { resultType: 'complete', tools: [] },
        });
      },
      dispose: () => Promise.resolve(),
    };

    await new McpClient(transport).captureSurface(SERVER, 'stdio');

    expect(asked).toContain('tools/list');
    expect(asked).not.toContain('prompts/list');
    expect(asked).not.toContain('resources/list');
  });
});
