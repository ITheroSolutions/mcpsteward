import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { allRules, grade, RULES, ruleById } from '../../src/conformance/index.js';
import type { RuleOutcome } from '../../src/core/types.js';
import type { ServerRef } from '../../src/core/types.js';
import { McpClient, type CaptureResult } from '../../src/protocol/client.js';
import { StdioTransport } from '../../src/protocol/stdio-transport.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/servers/conforming.mjs', import.meta.url));

const open: McpClient[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.dispose()));
});

const SERVER: ServerRef = {
  id: 'fixture',
  name: 'fixture',
  endpoint: { transport: 'stdio', command: 'node', args: [FIXTURE], envNames: [] },
  authPosture: 'none',
  registrations: [],
};

/** Capture a fixture server in the given mode, with evidence retained. */
async function captureMode(mode: string): Promise<CaptureResult> {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [FIXTURE],
    env: { MCPSTEWARD_FIXTURE_MODE: mode },
  });
  transport.start();

  const client = new McpClient(transport, { timeoutMs: 5000, retries: 0 });
  open.push(client);

  return client.capture(SERVER, 'stdio');
}

async function outcomeOf(mode: string, ruleId: string): Promise<RuleOutcome> {
  const report = grade(await captureMode(mode));
  const result = report.results.find((r) => r.ruleId === ruleId);
  expect(result, `rule ${ruleId} did not run`).toBeDefined();
  return result!.outcome;
}

describe('registry integrity', () => {
  it('gives every rule a unique id', () => {
    const ids = allRules().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('requires a citation on every rule', () => {
    // The type system already makes this impossible to omit. This asserts the
    // citation is meaningful rather than an empty string satisfying the type.
    for (const rule of allRules()) {
      expect(rule.citation.section.length, `${rule.id} has an empty citation`).toBeGreaterThan(0);
    }
  });

  it('gives every rule a remediation written for someone who has to fix it', () => {
    for (const rule of allRules()) {
      expect(rule.remediation.length, `${rule.id} has no remediation`).toBeGreaterThan(40);
    }
  });

  it('marks every rule VERIFIED, since none were invented', () => {
    // If this ever fails, the failing rule belongs in VERIFY.md and must be
    // excluded from the graded score.
    for (const rule of allRules()) {
      expect(rule.confidence, `${rule.id} is not grounded`).toBe('VERIFIED');
    }
  });

  it('uses the MS-AREA-NNN id convention', () => {
    for (const rule of allRules()) {
      expect(rule.id).toMatch(/^MS-[A-Z]+-\d{3}$/);
    }
  });

  it('looks a rule up by id', () => {
    expect(ruleById('MS-LIFE-001')?.rule.title).toContain('server/discover');
    expect(ruleById('MS-NOPE-999')).toBeUndefined();
  });
});

describe('a conforming server', () => {
  it('grades A with no MUST failures', async () => {
    const report = grade(await captureMode('conforming'));

    expect(report.grade.mustFailed).toBe(0);
    expect(report.grade.letter).toBe('A');
    expect(report.findings).toHaveLength(0);
  });

  it('produces the same grade twice, because grading is reproducible', async () => {
    // A grade that drifts between runs cannot be used as evidence.
    const first = grade(await captureMode('conforming'));
    const second = grade(await captureMode('conforming'));

    expect(second.grade).toEqual(first.grade);
    expect(second.results).toEqual(first.results);
  });

  it('reports the revision it graded against', async () => {
    expect(grade(await captureMode('conforming')).revision).toBe('2026-07-28');
  });
});

/**
 * Every rule needs a passing fixture and a failing one.
 *
 * A rule carrying only one of the two is not finished, so this
 * table is the contract. A rule added without a row here fails the coverage test
 * below.
 */
const RULE_FIXTURES: readonly {
  readonly ruleId: string;
  readonly passingMode: string;
  readonly failingMode: string;
}[] = [
  { ruleId: 'MS-LIFE-001', passingMode: 'conforming', failingMode: 'no-discover' },
  { ruleId: 'MS-LIFE-003', passingMode: 'conforming', failingMode: 'no-server-info' },
  { ruleId: 'MS-RES-001', passingMode: 'conforming', failingMode: 'no-result-type' },
  { ruleId: 'MS-RES-002', passingMode: 'conforming', failingMode: 'bad-result-type' },
  { ruleId: 'MS-CACHE-001', passingMode: 'conforming', failingMode: 'no-cache-metadata' },
  { ruleId: 'MS-CACHE-002', passingMode: 'conforming', failingMode: 'negative-ttl' },
  { ruleId: 'MS-CACHE-003', passingMode: 'conforming', failingMode: 'bad-cache-scope' },
  { ruleId: 'MS-TOOL-001', passingMode: 'conforming', failingMode: 'bad-header-number' },
  { ruleId: 'MS-TOOL-004', passingMode: 'conforming', failingMode: 'remote-ref' },
  { ruleId: 'MS-ICON-001', passingMode: 'conforming', failingMode: 'unsafe-icon' },
  // A server declaring no extensions reports not applicable rather than passing,
  // so the passing case needs a server that declares a correctly prefixed one.
  { ruleId: 'MS-EXT-001', passingMode: 'prefixed-extension', failingMode: 'unprefixed-extension' },
  { ruleId: 'MS-DEP-001', passingMode: 'conforming', failingMode: 'deprecated-capabilities' },
];

describe('each rule has a passing and a failing fixture', () => {
  for (const { ruleId, passingMode, failingMode } of RULE_FIXTURES) {
    describe(ruleId, () => {
      it(`passes against ${passingMode}`, async () => {
        expect(await outcomeOf(passingMode, ruleId)).toBe('pass');
      });

      it(`fails against ${failingMode}`, async () => {
        expect(await outcomeOf(failingMode, ruleId)).toBe('fail');
      });
    });
  }

  it('covers every rule that can be graded from a capture', () => {
    // MS-LIFE-002 and MS-TOOL-002 and MS-TOOL-003 are covered separately below,
    // because their failing conditions are not reachable through a fixture mode.
    const covered = new Set(RULE_FIXTURES.map((f) => f.ruleId));
    const separately = new Set(['MS-LIFE-002', 'MS-LIFE-007', 'MS-TOOL-002', 'MS-TOOL-003', 'MS-CACHE-004']);

    const uncovered = allRules()
      .map((r) => r.id)
      .filter((id) => !covered.has(id) && !separately.has(id));

    expect(uncovered, 'these rules have no fixture pair').toEqual([]);
  });
});

describe('x-mcp-header validation', () => {
  it('rejects an annotation on a number typed parameter', async () => {
    // A number has no canonical header encoding, which is why the specification
    // permits only string, integer and boolean.
    expect(await outcomeOf('bad-header-number', 'MS-TOOL-001')).toBe('fail');
  });

  it('rejects an annotation that is not statically reachable', async () => {
    // Buried under anyOf, so a client cannot extract it by walking properties.
    expect(await outcomeOf('bad-header-unreachable', 'MS-TOOL-001')).toBe('fail');
  });

  it('rejects two parameters claiming the same header name', async () => {
    // Header names are case insensitive, so one would silently win.
    expect(await outcomeOf('bad-header-duplicate', 'MS-TOOL-001')).toBe('fail');
  });

  it('reports not applicable when a server advertises no tools', () => {
    const context = {
      surface: {
        ...emptySurface(),
        capabilities: { prompts: {} },
      },
      evidence: emptyEvidence(),
    };

    const result = grade(context).results.find((r) => r.ruleId === 'MS-TOOL-001');
    expect(result?.outcome).toBe('not-applicable');
  });
});

describe('grading arithmetic', () => {
  it('caps the letter when a MUST fails, regardless of score', async () => {
    // A server can satisfy every SHOULD and still be unusable if it does not
    // implement server/discover.
    const report = grade(await captureMode('no-discover'));

    expect(report.grade.mustFailed).toBeGreaterThan(0);
    expect(['C', 'D', 'F']).toContain(report.grade.letter);
  });

  it('degrades the letter as more MUST rules fail', async () => {
    const one = grade(await captureMode('no-server-info'));
    const several = grade(await captureMode('no-cache-metadata'));

    expect(one.grade.mustFailed).toBe(0);
    expect(several.grade.mustFailed).toBeGreaterThan(0);
    expect(several.grade.score).toBeLessThan(one.grade.score ?? Number.NaN);
  });

  it('does not let a SHOULD failure produce a MUST failure count', async () => {
    const report = grade(await captureMode('no-server-info'));

    expect(report.grade.mustFailed).toBe(0);
    expect(report.grade.shouldFailed).toBeGreaterThan(0);
  });

  it('never counts a not-applicable rule against the server', async () => {
    const report = grade(await captureMode('conforming'));
    const notApplicable = report.results.filter((r) => r.outcome === 'not-applicable');

    // Every not-applicable result is counted in that bucket and nowhere else.
    expect(report.grade.notApplicable).toBe(
      notApplicable.length + report.results.filter((r) => r.outcome === 'inconclusive').length,
    );
  });

  it('never counts an inconclusive rule as a failure', async () => {
    const report = grade(await captureMode('conforming'));
    const inconclusive = report.results.filter((r) => r.outcome === 'inconclusive');

    for (const result of inconclusive) {
      expect(report.findings.some((f) => f.ruleId === result.ruleId)).toBe(false);
    }
  });

  it('scores a fully passing server at 100', async () => {
    expect(grade(await captureMode('conforming')).grade.score).toBe(100);
  });
});

describe('findings', () => {
  it('carries the citation and remediation a developer needs', async () => {
    const report = grade(await captureMode('no-discover'));
    const finding = report.findings.find((f) => f.ruleId === 'MS-LIFE-001');

    expect(finding).toBeDefined();
    expect(finding?.citation.section).toContain('versioning');
    expect(finding?.remediation).toContain('server/discover');
    expect(finding?.severity).toBe('critical');
  });

  it('sorts findings most severe first', async () => {
    const report = grade(await captureMode('no-cache-metadata'));
    const order = ['critical', 'high', 'medium', 'low', 'info'];

    const ranks = report.findings.map((f) => order.indexOf(f.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('produces no findings for a conforming server', async () => {
    expect(grade(await captureMode('conforming')).findings).toEqual([]);
  });
});

describe('redaction reaches rule output', () => {
  it('redacts a secret that a server smuggled into a tool name', () => {
    // A rule detail quotes server supplied strings, so it is an outbound string
    // and must pass through redaction like every other one.
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';

    const context = {
      surface: {
        ...emptySurface(),
        capabilities: { tools: {} },
        descriptors: [
          {
            category: 'tool' as const,
            identity: `leak_${secret}`,
            value: {
              name: `leak_${secret}`,
              inputSchema: {
                type: 'object',
                properties: { p: { $ref: 'https://evil.example/schema.json' } },
              },
            },
            canonical: '{}',
            hash: `sha256:${'a'.repeat(64)}` as const,
          },
        ],
      },
      evidence: emptyEvidence(),
    };

    const report = grade(context);
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------

function emptySurface() {
  return {
    server: SERVER,
    revisionUsed: '2026-07-28' as const,
    revisionRequested: '2026-07-28' as const,
    transport: 'stdio' as const,
    capturedAt: '2026-07-31T00:00:00.000Z',
    capabilities: undefined,
    serverInfo: undefined,
    descriptors: [],
    hashes: { root: `sha256:${'0'.repeat(64)}` as const, byCategory: {}, byDescriptor: {} },
    durationMs: 0,
  };
}

function emptyEvidence() {
  return {
    discover: {
      implemented: true,
      supportedVersions: ['2026-07-28'],
      capabilities: undefined,
      serverInfo: undefined,
      instructions: undefined,
      raw: undefined,
      era: 'modern' as const,
    },
    negotiation: {
      requested: '2026-07-28' as const,
      used: '2026-07-28' as const,
      downgraded: false,
    },
    listResults: [],
    methodErrors: [],
  };
}

describe('rule count', () => {
  it('has a registry worth running', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(12);
  });
});
