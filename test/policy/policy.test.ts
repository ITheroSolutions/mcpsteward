import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Grade, Policy, PolicyViolationKind, ServerRef } from '../../src/core/types.js';
import type { DriftReport, RiskTier } from '../../src/core/types.js';
import type { Inventory } from '../../src/discovery/index.js';
import {
  checkPolicy,
  describeViolationKind,
  EXIT_CODES,
  exceeds,
  exitCodeFor,
  initPolicy,
  isBelow,
  loadPolicy,
  parsePolicy,
  savePolicy,
} from '../../src/policy/index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpsteward-policy-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function server(
  name: string,
  overrides: Partial<ServerRef> = {},
  inlineCredential = false,
): ServerRef {
  return {
    id: `id-${name}`,
    name,
    endpoint: { transport: 'stdio', command: name, args: [], envNames: [] },
    authPosture: inlineCredential ? 'inline' : 'none',
    registrations: [
      {
        client: 'cursor',
        configPath: '/home/dev/.cursor/mcp.json',
        hasInlineCredential: inlineCredential,
      },
    ],
    ...overrides,
  };
}

function inventory(servers: readonly ServerRef[]): Inventory {
  return {
    servers,
    scannedPaths: [],
    problems: [],
    absentPaths: [],
    summary: {
      totalServers: servers.length,
      byTransport: { stdio: servers.length, http: 0 },
      byAuthPosture: {},
      withInlineCredentials: 0,
      remote: 0,
      local: servers.length,
      multiplyRegistered: 0,
      unknownToPolicy: 0,
      clientsFound: [],
    },
  };
}

function grade(letter: Grade['letter'], mustFailed = 0): Grade {
  return {
    status: letter === null ? 'not-graded' : 'graded',
    letter,
    score: letter === 'A' ? 100 : 50,
    mustPassed: 5,
    mustFailed,
    shouldPassed: 2,
    shouldFailed: 0,
    unverifiedReported: 0,
    notApplicable: 0,
  };
}

function driftAt(risk: RiskTier): DriftReport {
  return {
    server: server('drifty'),
    pinnedAt: '2026-07-01T00:00:00.000Z',
    comparedAt: '2026-08-04T00:00:00.000Z',
    pinnedRoot: `sha256:${'a'.repeat(64)}`,
    currentRoot: `sha256:${'b'.repeat(64)}`,
    events: [
      {
        kind: 'description-changed',
        category: 'tool',
        identity: 'run',
        summary: 'description changed',
        risk,
        riskFactors: [],
      },
    ],
    unchanged: 0,
  };
}

describe('every violation kind is reachable', () => {
  const kinds: readonly PolicyViolationKind[] = [
    'server-denied',
    'server-not-allowlisted',
    'auth-posture-forbidden',
    'grade-below-minimum',
    'drift-risk-exceeded',
    'server-unpinned',
    'inline-credential',
  ];

  it('describes every kind, exhaustively', () => {
    for (const kind of kinds) {
      expect(describeViolationKind(kind).length).toBeGreaterThan(10);
    }
  });

  it('detects a denied server', () => {
    const result = checkPolicy(
      { version: 1, denyServers: ['bad'] },
      { inventory: inventory([server('bad')]) },
    );
    expect(result.violations.map((v) => v.kind)).toContain('server-denied');
  });

  it('detects a server missing from the allowlist', () => {
    const result = checkPolicy(
      { version: 1, allowServers: ['good'] },
      { inventory: inventory([server('unknown')]) },
    );
    expect(result.violations.map((v) => v.kind)).toContain('server-not-allowlisted');
  });

  it('detects a forbidden auth posture', () => {
    const result = checkPolicy(
      { version: 1, requiredAuthPosture: ['env', 'oauth'] },
      { inventory: inventory([server('plain')]) },
    );
    expect(result.violations.map((v) => v.kind)).toContain('auth-posture-forbidden');
  });

  it('detects a grade below the minimum', () => {
    const result = checkPolicy(
      { version: 1, minimumGrade: 'B' },
      {
        inventory: inventory([server('weak')]),
        grades: { 'id-weak': grade('D', 2) },
      },
    );
    expect(result.violations.map((v) => v.kind)).toContain('grade-below-minimum');
  });

  it('fails a server that was not graded against any minimum grade', () => {
    // The gate an empty rule set scored as an A used to slip through. A server
    // on a revision the grader does not grade cannot meet a minimum grade.
    const result = checkPolicy(
      { version: 1, minimumGrade: 'D' },
      {
        inventory: inventory([server('legacy')]),
        grades: { 'id-legacy': grade(null) },
      },
    );
    expect(result.violations.map((v) => v.kind)).toContain('grade-below-minimum');
  });

  it('detects drift risk above the maximum', () => {
    const result = checkPolicy(
      { version: 1, maximumDriftRisk: 'low' },
      { inventory: inventory([server('drifty')]), drift: { 'id-drifty': driftAt('critical') } },
    );
    expect(result.violations.map((v) => v.kind)).toContain('drift-risk-exceeded');
  });

  it('detects an unpinned server', () => {
    const result = checkPolicy(
      { version: 1, allowUnpinnedServers: false },
      { inventory: inventory([server('fresh')]), pinnedServerIds: [] },
    );
    expect(result.violations.map((v) => v.kind)).toContain('server-unpinned');
  });

  it('detects an inline credential', () => {
    const result = checkPolicy(
      { version: 1, failOnInlineCredentials: true },
      { inventory: inventory([server('leaky', {}, true)]) },
    );
    expect(result.violations.map((v) => v.kind)).toContain('inline-credential');
  });
});

describe('absence is not compliance', () => {
  it('reports nothing for a key that is not set', () => {
    // A partially written policy must not silently behave as though it were
    // strict, or an operator believes they have controls they do not have.
    const result = checkPolicy({ version: 1 }, { inventory: inventory([server('anything')]) });

    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('reports a check it could not run rather than passing it silently', () => {
    // A green gate that only checked half the policy must not look like a green
    // gate that checked all of it.
    const result = checkPolicy(
      { version: 1, minimumGrade: 'A' },
      { inventory: inventory([server('ungraded')]) },
    );

    expect(result.passed).toBe(true);
    expect(result.notEvaluated.join(' ')).toContain('minimumGrade');
  });

  it('notes when drift could not be evaluated', () => {
    const result = checkPolicy(
      { version: 1, maximumDriftRisk: 'low' },
      { inventory: inventory([server('x')]) },
    );
    expect(result.notEvaluated.join(' ')).toContain('maximumDriftRisk');
  });

  it('notes when pin state was not supplied', () => {
    const result = checkPolicy(
      { version: 1, allowUnpinnedServers: false },
      { inventory: inventory([server('x')]) },
    );
    expect(result.notEvaluated.join(' ')).toContain('allowUnpinnedServers');
  });
});

describe('violation detail tells a developer what to do', () => {
  it('names the file to edit for an inline credential', () => {
    const result = checkPolicy(
      { version: 1, failOnInlineCredentials: true },
      { inventory: inventory([server('leaky', {}, true)]) },
    );

    const detail = result.violations[0]?.detail ?? '';
    expect(detail).toContain('/home/dev/.cursor/mcp.json');
    expect(detail).toContain('rotate');
  });

  it('names the command to run for a failing grade', () => {
    const result = checkPolicy(
      { version: 1, minimumGrade: 'A' },
      { inventory: inventory([server('weak')]), grades: { 'id-weak': grade('C', 1) } },
    );

    expect(result.violations[0]?.detail).toContain('mcpsteward conform');
  });

  it('names the command to re-pin after expected drift', () => {
    const result = checkPolicy(
      { version: 1, maximumDriftRisk: 'low' },
      { inventory: inventory([server('drifty')]), drift: { 'id-drifty': driftAt('high') } },
    );

    expect(result.violations[0]?.detail).toContain('mcpsteward trust');
  });

  it('states both what is required and what was found', () => {
    const result = checkPolicy(
      { version: 1, requiredAuthPosture: ['env'] },
      { inventory: inventory([server('plain')]) },
    );

    const detail = result.violations[0]?.detail ?? '';
    expect(detail).toContain('none');
    expect(detail).toContain('env');
  });

  it('redacts a secret that reached a server name', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const result = checkPolicy(
      { version: 1, denyServers: [] },
      { inventory: inventory([server(`leak-${secret}`)]) },
    );

    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('comparisons', () => {
  it('orders grades correctly', () => {
    expect(isBelow('D', 'B')).toBe(true);
    expect(isBelow('A', 'B')).toBe(false);
    expect(isBelow('B', 'B')).toBe(false);
    expect(isBelow('F', 'A')).toBe(true);
  });

  it('orders risk tiers correctly', () => {
    expect(exceeds('critical', 'medium')).toBe(true);
    expect(exceeds('low', 'medium')).toBe(false);
    expect(exceeds('medium', 'medium')).toBe(false);
  });

  it('passes a grade exactly at the minimum', () => {
    const result = checkPolicy(
      { version: 1, minimumGrade: 'B' },
      { inventory: inventory([server('ok')]), grades: { 'id-ok': grade('B') } },
    );
    expect(result.passed).toBe(true);
  });

  it('passes drift exactly at the maximum', () => {
    const result = checkPolicy(
      { version: 1, maximumDriftRisk: 'high' },
      { inventory: inventory([server('drifty')]), drift: { 'id-drifty': driftAt('high') } },
    );
    expect(result.passed).toBe(true);
  });
});

describe('exit code contract', () => {
  it('returns zero when the policy passes', () => {
    const result = checkPolicy({ version: 1 }, { inventory: inventory([]) });
    expect(exitCodeFor(result)).toBe(EXIT_CODES.success);
    expect(exitCodeFor(result)).toBe(0);
  });

  it('returns one when the policy fails', () => {
    const result = checkPolicy(
      { version: 1, denyServers: ['bad'] },
      { inventory: inventory([server('bad')]) },
    );
    expect(exitCodeFor(result)).toBe(EXIT_CODES.policyFailure);
    expect(exitCodeFor(result)).toBe(1);
  });

  it('pins the documented numbers, which CI jobs branch on', () => {
    expect(EXIT_CODES).toEqual({
      success: 0,
      policyFailure: 1,
      usageError: 2,
      internalError: 3,
    });
  });
});

describe('policy files', () => {
  it('parses a valid policy', () => {
    const policy = parsePolicy(
      JSON.stringify({ version: 1, minimumGrade: 'B', failOnInlineCredentials: true }),
      'p.json',
    );
    expect(policy.minimumGrade).toBe('B');
  });

  it('requires a version', () => {
    expect(() => parsePolicy('{}', 'p.json')).toThrow(/must declare "version": 1/);
  });

  it('rejects unknown keys rather than ignoring them', () => {
    // A key that does nothing is almost always a typo, which would silently
    // produce a weaker gate than the author believed they wrote.
    expect(() => parsePolicy('{"version":1,"minimumGarde":"A"}', 'p.json')).toThrow(
      /unknown policy keys: minimumGarde/,
    );
  });

  it('rejects an invalid grade', () => {
    expect(() => parsePolicy('{"version":1,"minimumGrade":"S"}', 'p.json')).toThrow(
      /minimumGrade must be one of/,
    );
  });

  it('rejects an invalid risk tier', () => {
    expect(() => parsePolicy('{"version":1,"maximumDriftRisk":"nuclear"}', 'p.json')).toThrow(
      /maximumDriftRisk must be one of/,
    );
  });

  it('rejects an invalid auth posture', () => {
    expect(() => parsePolicy('{"version":1,"requiredAuthPosture":["magic"]}', 'p.json')).toThrow(
      /not one of/,
    );
  });

  it('rejects a non array allowlist', () => {
    expect(() => parsePolicy('{"version":1,"allowServers":"one"}', 'p.json')).toThrow(
      /must be an array of strings/,
    );
  });

  it('rejects a non boolean flag', () => {
    expect(() => parsePolicy('{"version":1,"failOnInlineCredentials":"yes"}', 'p.json')).toThrow(
      /must be a boolean/,
    );
  });

  it('rejects invalid JSON, naming the path', () => {
    expect(() => parsePolicy('{oops', '/etc/policy.json')).toThrow(
      /\/etc\/policy\.json is not valid JSON/,
    );
  });

  it('round trips through disk', async () => {
    const path = join(root, 'policy.json');
    const policy: Policy = { version: 1, minimumGrade: 'A', allowServers: ['a'] };

    await savePolicy(path, policy);
    expect(await loadPolicy(path)).toEqual(policy);
  });

  it('reports a missing policy file clearly', async () => {
    await expect(loadPolicy(join(root, 'absent.json'))).rejects.toThrow();
  });
});

describe('policy init', () => {
  it('generates a policy that passes on the machine it came from', () => {
    // A policy that starts by failing teaches people to disable it.
    const state = inventory([server('alpha'), server('beta')]);
    const policy = initPolicy(state);

    const result = checkPolicy(policy, { inventory: state });
    expect(result.passed).toBe(true);
  });

  it('fails immediately on an existing inline credential', () => {
    // The one asymmetry. Accepting a credential already sitting in a config file
    // would normalise the finding that most warrants action right now.
    const state = inventory([server('clean'), server('leaky', {}, true)]);
    const policy = initPolicy(state);

    const result = checkPolicy(policy, { inventory: state });
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain('inline-credential');
  });

  it('allowlists every existing server, including one carrying a credential', () => {
    // The allowlist answers "do you know this server is here", and the operator
    // does. The credential is a separate problem, caught separately. Excluding
    // it here would report one problem twice, and fixing the credential would
    // still leave an allowlist violation, so the gate would stay red after the
    // operator did exactly what it asked.
    const state = inventory([server('clean'), server('leaky', {}, true)]);
    const policy = initPolicy(state);

    expect(policy.allowServers).toEqual(['clean', 'leaky']);
  });

  it('reports exactly one violation for a server with an inline credential', () => {
    const state = inventory([server('leaky', {}, true)]);
    const result = checkPolicy(initPolicy(state), { inventory: state });

    expect(result.violations.map((v) => v.kind)).toEqual(['inline-credential']);
  });

  it('produces a policy that parses', () => {
    const policy = initPolicy(inventory([server('a')]));
    expect(() => parsePolicy(JSON.stringify(policy), 'generated.json')).not.toThrow();
  });

  it('can generate an empty allowlist when asked', () => {
    const policy = initPolicy(inventory([server('a')]), { allowlistExisting: false });
    expect(policy.allowServers).toBeUndefined();
  });

  it('catches a server added after the policy was generated', () => {
    const before = inventory([server('alpha')]);
    const policy = initPolicy(before);

    const after = inventory([server('alpha'), server('newcomer')]);
    const result = checkPolicy(policy, { inventory: after });

    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain('server-not-allowlisted');
  });
});

describe('result shape', () => {
  it('sorts violations most severe first', () => {
    const state = inventory([server('leaky', {}, true), server('unknown')]);

    const result = checkPolicy(
      { version: 1, allowServers: [], failOnInlineCredentials: true },
      { inventory: state },
    );

    const order = ['critical', 'high', 'medium', 'low', 'info'];
    const ranks = result.violations.map((v) => order.indexOf(v.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('counts the servers it evaluated', () => {
    const result = checkPolicy({ version: 1 }, { inventory: inventory([server('a'), server('b')]) });
    expect(result.serversEvaluated).toBe(2);
  });

  it('passes cleanly on an empty machine', () => {
    const result = checkPolicy({ version: 1, allowServers: [] }, { inventory: inventory([]) });
    expect(result.passed).toBe(true);
  });
});
