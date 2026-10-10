import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { grade } from '../../src/conformance/index.js';
import type { ServerRef } from '../../src/core/types.js';
import { McpClient } from '../../src/protocol/client.js';
import { StdioTransport } from '../../src/protocol/stdio-transport.js';

/**
 * Era detection against a genuine 2025-11-25 server.
 *
 * The fixture is built on the official SDK rather than hand written, which is the
 * whole point. A legacy fixture we wrote ourselves would only prove our client
 * agrees with our own reading of the old specification. Built on somebody else's
 * implementation, these tests prove the era probe and the downgrade path work
 * against the real thing.
 *
 * Building this fixture immediately exposed a real bug: the client captured three
 * tools from a legacy server while recording `revisionUsed: 2026-07-28`, because a
 * legacy server happily answers an era ambiguous method like `tools/list` while
 * ignoring the modern `_meta` it does not understand. That is exactly the "never
 * silently present a downgraded capture as a current one" failure, and it is why
 * there is one fixture per revision.
 */

const LEGACY = fileURLToPath(new URL('../fixtures/servers/legacy-2025-11-25.mjs', import.meta.url));
const MODERN = fileURLToPath(new URL('../fixtures/servers/conforming.mjs', import.meta.url));

const open: McpClient[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.dispose()));
});

function serverRef(path: string, id: string): ServerRef {
  return {
    id,
    name: id,
    endpoint: { transport: 'stdio', command: 'node', args: [path], envNames: [] },
    authPosture: 'none',
    registrations: [],
  };
}

function connect(path: string, env: Record<string, string> = {}): McpClient {
  const transport = new StdioTransport({ command: process.execPath, args: [path], env });
  transport.start();

  const client = new McpClient(transport, { timeoutMs: 10_000, retries: 0 });
  open.push(client);
  return client;
}

describe('era probe', () => {
  it('identifies a real SDK legacy server as handshake era', async () => {
    const outcome = await connect(LEGACY).discover('2026-07-28');

    expect(outcome.era).toBe('legacy');
    expect(outcome.implemented).toBe(false);
  }, 30_000);

  it('identifies a modern server as modern', async () => {
    const outcome = await connect(MODERN, { MCPSTEWARD_FIXTURE_MODE: 'conforming' }).discover(
      '2026-07-28',
    );

    expect(outcome.era).toBe('modern');
    expect(outcome.implemented).toBe(true);
  }, 30_000);

  it('cannot tell a legacy server from a modern one missing server/discover', async () => {
    // Both answer -32601, and the specification says the error code alone cannot
    // distinguish them. The probe reports what it saw rather than guessing; the
    // ambiguity is resolved later by attempting the handshake.
    const outcome = await connect(MODERN, { MCPSTEWARD_FIXTURE_MODE: 'no-discover' }).discover(
      '2026-07-28',
    );

    expect(outcome.implemented).toBe(false);
    expect(outcome.probeErrorCode).toBe(-32601);
    expect(outcome.era).toBe('legacy');
  }, 30_000);

  it('does not key the fallback to one specific error code', async () => {
    // The specification is explicit that legacy servers answer an unknown
    // pre-initialize request with whatever their implementation happens to use,
    // commonly -32601 or -32602 but not reliably either. The test is inverted:
    // a recognised modern code means modern, anything else means legacy.
    const outcome = await connect(LEGACY).discover('2026-07-28');

    expect(outcome.era).toBe('legacy');
    expect([-32601, -32602, -32600]).toContain(outcome.probeErrorCode);
  }, 30_000);
});

describe('capturing a legacy server', () => {
  it('records the revision it actually spoke, not the one requested', async () => {
    // The bug this file exists to prevent. Before era detection, this recorded
    // 2026-07-28 for a server that does not implement it.
    const captured = await connect(LEGACY).capture(serverRef(LEGACY, 'legacy'), 'stdio');

    expect(captured.surface.revisionRequested).toBe('2026-07-28');
    expect(captured.surface.revisionUsed).toBe('2025-11-25');
  }, 30_000);

  it('marks the capture as downgraded', async () => {
    const captured = await connect(LEGACY).capture(serverRef(LEGACY, 'legacy'), 'stdio');
    expect(captured.evidence.negotiation.downgraded).toBe(true);
  }, 30_000);

  it('still captures the surface, because an old server is worth inventorying', async () => {
    // Refusing to look would make the inventory lie by omission. Most machines
    // have servers on both eras during a migration window.
    const captured = await connect(LEGACY).capture(serverRef(LEGACY, 'legacy'), 'stdio');

    const names = captured.surface.descriptors.map((d) => d.identity);
    expect(names).toContain('legacy_lookup');
  }, 30_000);

  it('produces a stable surface root across captures', async () => {
    const first = await connect(LEGACY).capture(serverRef(LEGACY, 'legacy'), 'stdio');
    const second = await connect(LEGACY).capture(serverRef(LEGACY, 'legacy'), 'stdio');

    expect(second.surface.hashes.root).toBe(first.surface.hashes.root);
  }, 40_000);

  it('refuses to downgrade when downgrade is disabled', async () => {
    // A caller who needs a current capture must be told they cannot have one,
    // rather than handed an older one wearing the newer label.
    const transport = new StdioTransport({
      command: process.execPath,
      args: [LEGACY],
      env: {},
    });
    transport.start();

    const client = new McpClient(transport, {
      timeoutMs: 10_000,
      retries: 0,
      allowDowngrade: false,
    });
    open.push(client);

    await expect(client.capture(serverRef(LEGACY, 'legacy'), 'stdio')).rejects.toThrow(
      /downgrade is disabled/,
    );
  }, 30_000);
});

describe('resolving the ambiguous probe result', () => {
  it('still captures a modern server that fails to implement server/discover', async () => {
    // The over-correction this guards against. Treating every -32601 as legacy
    // made mcpsteward unable to inspect a non conforming modern server, which is
    // precisely the server it exists to inspect. The handshake is attempted and,
    // when refused, the capture proceeds as modern.
    const captured = await connect(MODERN, { MCPSTEWARD_FIXTURE_MODE: 'no-discover' }).capture(
      serverRef(MODERN, 'modern-no-discover'),
      'stdio',
    );

    expect(captured.surface.revisionUsed).toBe('2026-07-28');
    expect(captured.evidence.negotiation.downgraded).toBe(false);
    expect(captured.surface.descriptors.length).toBeGreaterThan(0);
  }, 30_000);

  it('reports the missing method as a conformance finding rather than hiding it', async () => {
    const captured = await connect(MODERN, { MCPSTEWARD_FIXTURE_MODE: 'no-discover' }).capture(
      serverRef(MODERN, 'modern-no-discover'),
      'stdio',
    );

    expect(captured.evidence.discover.implemented).toBe(false);
  }, 30_000);
});

describe('a modern capture is unaffected', () => {
  it('records no downgrade for a modern server', async () => {
    const captured = await connect(MODERN, { MCPSTEWARD_FIXTURE_MODE: 'conforming' }).capture(
      serverRef(MODERN, 'modern'),
      'stdio',
    );

    expect(captured.surface.revisionUsed).toBe('2026-07-28');
    expect(captured.evidence.negotiation.downgraded).toBe(false);
  }, 30_000);
});

describe('grading a legacy server', () => {
  // Found by running conform against a real remote server. It speaks
  // 2025-11-25, no rule applies to that revision, and the empty rule set was
  // scored as 100 out of 100, grade A, exit 0. Nearly every server in the wild
  // is still on 2025-11-25, so nearly every conform a new user ran would have
  // printed an A and passed a CI grade gate for a server that does not
  // implement the revision being graded at all. DECISIONS.md D-003 says this
  // revision is captured but never graded.
  it('is reported as not graded rather than given a letter', async () => {
    const captured = await connect(LEGACY).capture(serverRef(LEGACY, 'legacy'), 'stdio');
    const report = grade(captured);

    expect(report.grade.status).toBe('not-graded');
    expect(report.grade.letter).toBeNull();
    expect(report.grade.score).toBeNull();
    expect(report.grade.reason).toMatch(/2025-11-25/);
  }, 30_000);

  it('still grades a modern server normally', async () => {
    const captured = await connect(MODERN, { MCPSTEWARD_FIXTURE_MODE: 'conforming' }).capture(
      serverRef(MODERN, 'modern'),
      'stdio',
    );
    const report = grade(captured);

    expect(report.grade.status).toBe('graded');
    expect(report.grade.letter).toBe('A');
  }, 30_000);
});

describe('a legacy server strict about the handshake', () => {
  // Refuses every request until notifications/initialized arrives, as the Python
  // SDK does. On stdio the notification used to go through request(), which
  // refuses a message without an id, so it was never sent and this server
  // answered every list call with an error.
  const STRICT = fileURLToPath(new URL('../fixtures/servers/legacy-strict.mjs', import.meta.url));

  it('is captured, because the handshake is actually completed', async () => {
    const captured = await connect(STRICT).capture(serverRef(STRICT, 'strict'), 'stdio');

    expect(captured.surface.revisionUsed).toBe('2025-11-25');
    expect(captured.surface.descriptors.map((d) => d.identity)).toContain('strict_tool');
  }, 30_000);
});

describe('a legacy server that the era probe crashes', () => {
  // Observed on a real server built on an older Python SDK: server/discover
  // failed validation and the process exited instead of replying. Crashing on
  // the probe proves the server is not modern, so it is restarted and captured
  // down the legacy path rather than the whole capture failing.
  const STRICT = fileURLToPath(new URL('../fixtures/servers/legacy-strict.mjs', import.meta.url));

  it('is restarted and captured at the legacy revision', async () => {
    const captured = await connect(STRICT, { LEGACY_STRICT_CRASH_ON_UNKNOWN: '1' }).capture(
      serverRef(STRICT, 'crashes'),
      'stdio',
    );

    expect(captured.surface.revisionUsed).toBe('2025-11-25');
    expect(captured.surface.descriptors.map((d) => d.identity)).toContain('strict_tool');
  }, 30_000);
});
