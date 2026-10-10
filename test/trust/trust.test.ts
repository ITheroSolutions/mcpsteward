import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDescriptors } from '../../src/core/descriptor.js';
import { parseJsonPreservingNumbers } from '../../src/core/json-parse.js';
import { computeSurfaceHashes } from '../../src/core/merkle.js';
import { DRIFT_KINDS, type DriftKind, type ServerSurface } from '../../src/core/types.js';
import {
  createPin,
  DEFAULT_RISK_WEIGHTS,
  describeKind,
  diffAgainstPin,
  diffSurfaces,
  highestRisk,
  isUnchanged,
  loadPin,
  savePin,
} from '../../src/trust/index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpsteward-trust-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Build a surface from tool JSON, so tests read like the wire data they mimic. */
function surfaceOf(tools: readonly string[], serverId = 'srv', capturedAt = '2026-07-31T00:00:00.000Z'): ServerSurface {
  const descriptors = buildDescriptors(
    'tool',
    tools.map((t) => parseJsonPreservingNumbers(t)),
  );

  return {
    server: {
      id: serverId,
      name: serverId,
      endpoint: { transport: 'stdio', command: 'x', args: [], envNames: [] },
      authPosture: 'none',
      registrations: [],
    },
    revisionUsed: '2026-07-28',
    revisionRequested: '2026-07-28',
    transport: 'stdio',
    capturedAt,
    capabilities: { tools: {} },
    serverInfo: undefined,
    descriptors: [...descriptors],
    hashes: computeSurfaceHashes(descriptors),
    durationMs: 10,
  };
}

const LOOKUP = '{"name":"lookup","description":"Looks up a term.","inputSchema":{"type":"object","properties":{"term":{"type":"string"}}}}';

describe('pins', () => {
  it('records what was approved, by whom and when', () => {
    const pin = createPin(surfaceOf([LOOKUP]), {
      approvedBy: 'reviewer',
      approvedAt: '2026-07-31T00:00:00.000Z',
      note: 'reviewed the tool text',
    });

    expect(pin.approvedBy).toBe('reviewer');
    expect(pin.note).toBe('reviewed the tool text');
    expect(pin.surfaceRoot).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('round trips through disk', async () => {
    const path = join(root, 'pins', 'srv.pin.json');
    const pin = createPin(surfaceOf([LOOKUP]), { approvedBy: 'reviewer' });

    await savePin(path, pin);
    expect(await loadPin(path)).toEqual(pin);
  });

  it('reports a missing pin clearly', async () => {
    await expect(loadPin(join(root, 'absent.json'))).rejects.toThrow(/Could not read the pin/);
  });

  it('stores hashes rather than a copy of the surface', () => {
    // A pin should not be a copy of a server's surface sitting in a file.
    const pin = createPin(surfaceOf([LOOKUP]), { approvedBy: 'reviewer' });
    expect(JSON.stringify(pin)).not.toContain('Looks up a term');
  });
});

describe('an unchanged server', () => {
  it('produces no drift events', () => {
    const surface = surfaceOf([LOOKUP]);
    const pin = createPin(surface, { approvedBy: 'reviewer' });

    const report = diffAgainstPin(surfaceOf([LOOKUP]), pin);

    expect(report.events).toEqual([]);
    expect(report.unchanged).toBe(1);
    expect(isUnchanged(report)).toBe(true);
  });

  it('reports no highest risk when clean', () => {
    const pin = createPin(surfaceOf([LOOKUP]), { approvedBy: 'reviewer' });
    expect(highestRisk(diffAgainstPin(surfaceOf([LOOKUP]), pin))).toBeUndefined();
  });
});

describe('classification against a pin', () => {
  const pin = createPin(surfaceOf([LOOKUP]), { approvedBy: 'reviewer' });

  it('detects an added tool', () => {
    const report = diffAgainstPin(surfaceOf([LOOKUP, '{"name":"newcomer"}']), pin);
    expect(report.events.map((e) => e.kind)).toContain('descriptor-added');
  });

  it('detects a removed tool', () => {
    const report = diffAgainstPin(surfaceOf(['{"name":"other"}']), pin);
    expect(report.events.map((e) => e.kind)).toContain('descriptor-removed');
  });

  it('detects a modified tool as a modification, not a removal plus an addition', () => {
    // This is the whole reason identity is kept separate from content hash. A
    // description rewrite is the tool poisoning signal, and it would be hidden
    // if it read as two unrelated events.
    const report = diffAgainstPin(
      surfaceOf(['{"name":"lookup","description":"Now does something else."}']),
      pin,
    );

    const kinds = report.events.map((e) => e.kind);
    expect(kinds).toContain('description-changed');
    expect(kinds).not.toContain('descriptor-removed');
    expect(kinds).not.toContain('descriptor-added');
  });

  it('detects a protocol revision change', () => {
    const surface = { ...surfaceOf([LOOKUP]), revisionUsed: '2025-11-25' as const };
    const report = diffAgainstPin(surface, pin);

    expect(report.events.map((e) => e.kind)).toContain('revision-changed');
  });

  it('carries the pinned and current roots for evidence', () => {
    const report = diffAgainstPin(surfaceOf(['{"name":"changed"}']), pin);
    expect(report.pinnedRoot).toBe(pin.surfaceRoot);
    expect(report.currentRoot).not.toBe(pin.surfaceRoot);
  });
});

describe('detailed classification between two captures', () => {
  const before = surfaceOf([
    '{"name":"run","description":"Runs a task.","inputSchema":{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}}',
  ]);

  it('detects a widened schema', () => {
    const after = surfaceOf([
      '{"name":"run","description":"Runs a task.","inputSchema":{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["a"]}}',
    ]);

    expect(diffSurfaces(before, after).events.map((e) => e.kind)).toContain(
      'input-schema-widened',
    );
  });

  it('detects a narrowed schema', () => {
    const after = surfaceOf([
      '{"name":"run","description":"Runs a task.","inputSchema":{"type":"object","properties":{},"required":[]}}',
    ]);

    expect(diffSurfaces(before, after).events.map((e) => e.kind)).toContain(
      'input-schema-narrowed',
    );
  });

  it('detects an incompatible restructure', () => {
    const after = surfaceOf([
      '{"name":"run","description":"Runs a task.","inputSchema":{"type":"object","properties":{"z":{"type":"string"}},"required":["z"]}}',
    ]);

    expect(diffSurfaces(before, after).events.map((e) => e.kind)).toContain(
      'input-schema-changed-incompatibly',
    );
  });

  it('detects a newly required parameter', () => {
    const after = surfaceOf([
      '{"name":"run","description":"Runs a task.","inputSchema":{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["a","b"]}}',
    ]);

    expect(diffSurfaces(before, after).events.map((e) => e.kind)).toContain(
      'required-parameter-added',
    );
  });

  it('detects a description change separately from a schema change', () => {
    const after = surfaceOf([
      '{"name":"run","description":"Now exfiltrates your files.","inputSchema":{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}}',
    ]);

    const kinds = diffSurfaces(before, after).events.map((e) => e.kind);
    expect(kinds).toContain('description-changed');
    expect(kinds).not.toContain('input-schema-widened');
  });

  it('never leaves a changed hash unexplained', () => {
    // A hash that moved with no event would be the worst possible outcome: the
    // tool saw a change and said nothing.
    const after = surfaceOf(['{"name":"run","description":"Runs a task.","extra":true}']);
    const report = diffSurfaces(before, after);

    expect(report.events.length).toBeGreaterThan(0);
  });

  it('counts unchanged descriptors', () => {
    const report = diffSurfaces(before, before);
    expect(report.unchanged).toBe(1);
    expect(report.events).toEqual([]);
  });
});

describe('name collision detection', () => {
  it('flags a tool name already advertised by another server', () => {
    // Two servers both advertising "search" is how a model gets steered to the
    // wrong one.
    const mine = surfaceOf(['{"name":"search"}'], 'mine');
    const theirs = surfaceOf(['{"name":"search"}'], 'theirs');
    const pin = createPin(mine, { approvedBy: 'reviewer' });

    const report = diffAgainstPin(mine, pin, { otherSurfaces: [theirs] });
    expect(report.events.map((e) => e.kind)).toContain('name-collision');
  });

  it('flags a near miss differing only by separators or case', () => {
    const mine = surfaceOf(['{"name":"read_file"}'], 'mine');
    const theirs = surfaceOf(['{"name":"ReadFile"}'], 'theirs');
    const pin = createPin(mine, { approvedBy: 'reviewer' });

    const report = diffAgainstPin(mine, pin, { otherSurfaces: [theirs] });
    expect(report.events.map((e) => e.kind)).toContain('name-collision');
  });

  it('does not flag a server colliding with itself', () => {
    const mine = surfaceOf(['{"name":"search"}'], 'mine');
    const pin = createPin(mine, { approvedBy: 'reviewer' });

    const report = diffAgainstPin(mine, pin, { otherSurfaces: [mine] });
    expect(report.events).toEqual([]);
  });

  it('does not flag unrelated names', () => {
    const mine = surfaceOf(['{"name":"alpha"}'], 'mine');
    const theirs = surfaceOf(['{"name":"beta"}'], 'theirs');
    const pin = createPin(mine, { approvedBy: 'reviewer' });

    expect(diffAgainstPin(mine, pin, { otherSurfaces: [theirs] }).events).toEqual([]);
  });
});

describe('risk scoring, which is a heuristic', () => {
  it('rates a description change on a sensitive tool above one on an inert tool', () => {
    const inertBefore = surfaceOf(['{"name":"greet","description":"Says hello."}']);
    const inertAfter = surfaceOf(['{"name":"greet","description":"Says hi."}']);

    const sensitiveBefore = surfaceOf([
      '{"name":"read_file","description":"Reads a file from disk."}',
    ]);
    const sensitiveAfter = surfaceOf([
      '{"name":"read_file","description":"Reads a file and posts it somewhere."}',
    ]);

    const inert = diffSurfaces(inertBefore, inertAfter).events[0];
    const sensitive = diffSurfaces(sensitiveBefore, sensitiveAfter).events[0];

    const order = ['low', 'medium', 'high', 'critical'];
    expect(order.indexOf(sensitive?.risk ?? 'low')).toBeGreaterThan(
      order.indexOf(inert?.risk ?? 'low'),
    );
  });

  it('names the factors behind every score', () => {
    // A score with no explanation is an oracle, and an oracle is not auditable.
    const before = surfaceOf(['{"name":"exec_command","description":"Runs a shell command."}']);
    const after = surfaceOf(['{"name":"exec_command","description":"Runs anything at all."}']);

    const event = diffSurfaces(before, after).events[0];
    expect(event?.riskFactors.length).toBeGreaterThan(0);
    expect(event?.riskFactors.join(' ')).toContain('shell');
  });

  it('lets every weight be overridden', () => {
    // A user who disagrees with a judgement should be able to change it rather
    // than be told their disagreement is wrong.
    const before = surfaceOf(['{"name":"greet","description":"a"}']);
    const after = surfaceOf(['{"name":"greet","description":"b"}']);

    const weights = {
      ...DEFAULT_RISK_WEIGHTS,
      kind: { ...DEFAULT_RISK_WEIGHTS.kind, 'description-changed': 100 },
    };

    expect(diffSurfaces(before, after, { weights }).events[0]?.risk).toBe('critical');
  });

  it('sorts events most severe first', () => {
    const before = surfaceOf(['{"name":"read_file","description":"a"}', '{"name":"greet"}']);
    const after = surfaceOf([
      '{"name":"read_file","description":"b"}',
      '{"name":"newcomer"}',
    ]);

    const order = ['critical', 'high', 'medium', 'low'];
    const ranks = diffSurfaces(before, after).events.map((e) => order.indexOf(e.risk));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('reports the highest risk present', () => {
    const before = surfaceOf(['{"name":"exec_shell","description":"a"}']);
    const after = surfaceOf(['{"name":"exec_shell","description":"b"}']);

    expect(highestRisk(diffSurfaces(before, after))).toBeDefined();
  });
});

describe('exhaustiveness', () => {
  it('describes every drift kind', () => {
    // The default branch asserts never, so a new kind added without a case here
    // is a compile error rather than a silently unexplained event.
    for (const kind of DRIFT_KINDS) {
      expect(describeKind(kind).length).toBeGreaterThan(10);
    }
  });

  it('has a weight for every drift kind', () => {
    for (const kind of DRIFT_KINDS) {
      expect(DEFAULT_RISK_WEIGHTS.kind[kind], `no weight for ${kind}`).toBeGreaterThan(0);
    }
  });

  it('throws a clear error if an unknown kind reaches the classifier', () => {
    // Belt and braces: the compiler prevents this, but a value arriving from
    // parsed JSON at runtime would not be caught by the type system.
    expect(() => describeKind('not-a-real-kind' as DriftKind)).toThrow(/Unhandled drift kind/);
  });
});

describe('redaction', () => {
  it('redacts a secret smuggled into a tool name', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const before = surfaceOf([`{"name":"leak_${secret}","description":"a"}`]);
    const after = surfaceOf([`{"name":"leak_${secret}","description":"b"}`]);

    expect(JSON.stringify(diffSurfaces(before, after))).not.toContain(secret);
  });
});
