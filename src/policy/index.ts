/**
 * Policy evaluation and the CI gate.
 *
 * A policy states what an organisation will tolerate. Evaluation turns a machine's
 * actual state into a list of structured violations, and the CI gate turns that
 * list into an exit code.
 *
 * ## Output is written for the person who has to fix it
 *
 * "Policy violation" tells a developer nothing. Every violation here names the
 * server, states what the policy required, states what was actually found, and
 * says what to do about it. A gate that fails a build without explaining how to
 * pass it teaches people to bypass the gate.
 *
 * ## Absence is not compliance
 *
 * A policy key that is not set imposes no requirement, and evaluation reports
 * nothing for it. That is deliberate: a partially written policy must not silently
 * behave as though it were strict, because an operator would then believe they
 * have controls they do not have.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ConfigurationError, toMcpStewardError } from '../core/errors.js';
import { redact } from '../core/redaction.js';
import {
  assertNever,
  type AuthPosture,
  type DriftReport,
  type Grade,
  type GradeLetter,
  type Policy,
  type PolicyViolation,
  type PolicyViolationKind,
  type RiskTier,
  type ServerRef,
  type Severity,
} from '../core/types.js';

// Type only import, so this adds no runtime coupling to the discovery module.
import type { Inventory } from '../discovery/index.js';

/** Grades in order, worst first, so a minimum can be compared. */
const GRADE_ORDER: readonly GradeLetter[] = ['F', 'D', 'C', 'B', 'A'];

/** Risk tiers in order, least severe first. */
const RISK_ORDER: readonly RiskTier[] = ['low', 'medium', 'high', 'critical'];

export interface PolicyInput {
  readonly inventory: Inventory;
  /** Conformance grades by server id, for servers that were graded. */
  readonly grades?: Readonly<Record<string, Grade>>;
  /** Drift reports by server id, for servers that were diffed. */
  readonly drift?: Readonly<Record<string, DriftReport>>;
  /** Server ids that currently have a pin. */
  readonly pinnedServerIds?: readonly string[];
}

export interface PolicyResult {
  readonly violations: readonly PolicyViolation[];
  /** True when nothing was violated. */
  readonly passed: boolean;
  /** How many servers were evaluated. */
  readonly serversEvaluated: number;
  /**
   * Checks that could not run because the input did not carry the data.
   *
   * Reported rather than silently skipped, so a green gate that only checked half
   * the policy cannot be mistaken for a green gate that checked all of it.
   */
  readonly notEvaluated: readonly string[];
}

/** Evaluate a policy against a machine's state. */
export function checkPolicy(policy: Policy, input: PolicyInput): PolicyResult {
  const violations: PolicyViolation[] = [];
  const notEvaluated: string[] = [];

  const allow = policy.allowServers === undefined ? undefined : new Set(policy.allowServers);
  const deny = policy.denyServers === undefined ? undefined : new Set(policy.denyServers);
  const requiredPostures =
    policy.requiredAuthPosture === undefined ? undefined : new Set(policy.requiredAuthPosture);
  const pinned = new Set(input.pinnedServerIds ?? []);

  if (policy.minimumGrade !== undefined && input.grades === undefined) {
    notEvaluated.push(
      'minimumGrade was not evaluated because no conformance grades were supplied. ' +
        'Run a conformance check before the policy gate.',
    );
  }

  if (policy.maximumDriftRisk !== undefined && input.drift === undefined) {
    notEvaluated.push(
      'maximumDriftRisk was not evaluated because no drift reports were supplied. ' +
        'Run a diff against pins before the policy gate.',
    );
  }

  if (policy.allowUnpinnedServers === false && input.pinnedServerIds === undefined) {
    notEvaluated.push(
      'allowUnpinnedServers was not evaluated because the set of pinned servers was not supplied.',
    );
  }

  for (const server of input.inventory.servers) {
    const identifiers = [server.id, server.name];

    if (deny !== undefined && identifiers.some((id) => deny.has(id))) {
      violations.push(
        violation(
          'server-denied',
          server,
          `${describe(server)} is on the policy denylist but is configured on this machine.`,
          `Remove it from ${registrationSites(server)}, or remove it from denyServers if it is now permitted.`,
          'critical',
        ),
      );
    }

    if (allow !== undefined && !identifiers.some((id) => allow.has(id))) {
      violations.push(
        violation(
          'server-not-allowlisted',
          server,
          `${describe(server)} is not on the policy allowlist.`,
          `Add ${JSON.stringify(server.name)} to allowServers after reviewing it, or remove it from ${registrationSites(server)}.`,
          'high',
        ),
      );
    }

    if (requiredPostures !== undefined && !requiredPostures.has(server.authPosture)) {
      violations.push(
        violation(
          'auth-posture-forbidden',
          server,
          `${describe(server)} authenticates as ${server.authPosture}, which the policy does not permit. Permitted: ${[...requiredPostures].join(', ')}.`,
          server.authPosture === 'inline'
            ? 'Move the credential into an environment variable and reference it, rather than writing the value into the configuration file.'
            : 'Change the server configuration so its authentication matches an allowed posture.',
          'high',
        ),
      );
    }

    if (policy.failOnInlineCredentials === true) {
      const sites = server.registrations.filter((r) => r.hasInlineCredential);

      if (sites.length > 0) {
        violations.push(
          violation(
            'inline-credential',
            server,
            `${describe(server)} has a credential written directly into ${sites.length === 1 ? 'a configuration file' : `${String(sites.length)} configuration files`}.`,
            `Replace the literal value in ${sites.map((s) => s.configPath).join(', ')} with an environment reference such as \${TOKEN_NAME}, and rotate the exposed credential.`,
            'critical',
          ),
        );
      }
    }

    if (policy.allowUnpinnedServers === false && input.pinnedServerIds !== undefined) {
      if (!pinned.has(server.id)) {
        violations.push(
          violation(
            'server-unpinned',
            server,
            `${describe(server)} has never been approved, so there is no baseline to detect changes against.`,
            `Review what it advertises, then pin it with: mcpsteward trust ${server.name}`,
            'medium',
          ),
        );
      }
    }

    const grade = input.grades?.[server.id];
    if (policy.minimumGrade !== undefined && grade !== undefined) {
      // A server that was not graded cannot meet a minimum grade. Before the
      // grader learned to refuse, this is the gate an empty rule set scored as
      // an A slipped straight through.
      if (grade.letter === null) {
        violations.push(
          violation(
            'grade-below-minimum',
            server,
            `${describe(server)} was not graded, so it cannot meet the required minimum of ${policy.minimumGrade}. ${grade.reason ?? ''}`.trim(),
            `Run: mcpsteward conform ${server.name} to see why.`,
            'high',
          ),
        );
      } else if (isBelow(grade.letter, policy.minimumGrade)) {
        violations.push(
          violation(
            'grade-below-minimum',
            server,
            `${describe(server)} graded ${grade.letter} (${String(grade.score)} out of 100) against a required minimum of ${policy.minimumGrade}. ${String(grade.mustFailed)} mandatory requirement(s) failed.`,
            `Run: mcpsteward conform ${server.name} to see each failure with its specification citation and remediation.`,
            'high',
          ),
        );
      }
    }

    const drift = input.drift?.[server.id];
    if (policy.maximumDriftRisk !== undefined && drift !== undefined) {
      const worst = worstRisk(drift);

      if (worst !== undefined && exceeds(worst, policy.maximumDriftRisk)) {
        violations.push(
          violation(
            'drift-risk-exceeded',
            server,
            `${describe(server)} has drifted from its approved surface with ${worst} risk, above the permitted maximum of ${policy.maximumDriftRisk}. ${String(drift.events.length)} change(s) detected.`,
            `Run: mcpsteward diff ${server.name} to see every change. If the changes are expected, re-pin with: mcpsteward trust ${server.name}`,
            'critical',
          ),
        );
      }
    }
  }

  return {
    violations: violations.sort(bySeverity),
    passed: violations.length === 0,
    serversEvaluated: input.inventory.servers.length,
    notEvaluated,
  };
}

/** Whether a grade is worse than a required minimum. */
export function isBelow(actual: GradeLetter, minimum: GradeLetter): boolean {
  return GRADE_ORDER.indexOf(actual) < GRADE_ORDER.indexOf(minimum);
}

/** Whether a risk tier is above a permitted maximum. */
export function exceeds(actual: RiskTier, maximum: RiskTier): boolean {
  return RISK_ORDER.indexOf(actual) > RISK_ORDER.indexOf(maximum);
}

function worstRisk(report: DriftReport): RiskTier | undefined {
  let worst: RiskTier | undefined;

  for (const event of report.events) {
    if (worst === undefined || RISK_ORDER.indexOf(event.risk) > RISK_ORDER.indexOf(worst)) {
      worst = event.risk;
    }
  }

  return worst;
}

function describe(server: ServerRef): string {
  return `Server ${JSON.stringify(server.name)}`;
}

function registrationSites(server: ServerRef): string {
  return server.registrations.map((r) => r.configPath).join(', ') || 'its configuration';
}

function violation(
  kind: PolicyViolationKind,
  server: ServerRef,
  what: string,
  fix: string,
  severity: Severity,
): PolicyViolation {
  return {
    kind,
    serverId: server.id,
    // The detail is the whole value of a gate. It states what is wrong and what
    // to do, on one line, without needing the policy file open alongside it.
    detail: redact(`${what} ${fix}`),
    severity,
  };
}

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

function bySeverity(a: PolicyViolation, b: PolicyViolation): number {
  const rank = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  return rank !== 0 ? rank : a.serverId.localeCompare(b.serverId);
}

/** One line explaining what a violation kind means, exhaustive over the union. */
export function describeViolationKind(kind: PolicyViolationKind): string {
  switch (kind) {
    case 'server-denied':
      return 'a server on the denylist is configured';
    case 'server-not-allowlisted':
      return 'a server not on the allowlist is configured';
    case 'auth-posture-forbidden':
      return 'a server authenticates in a way the policy forbids';
    case 'grade-below-minimum':
      return 'a server graded below the required conformance minimum';
    case 'drift-risk-exceeded':
      return 'a server drifted further from its approved surface than permitted';
    case 'server-unpinned':
      return 'a server has never been approved';
    case 'inline-credential':
      return 'a credential is written directly into a configuration file';
    default:
      return assertNever(kind, 'policy violation kind');
  }
}

// ---------------------------------------------------------------------------
// Policy files
// ---------------------------------------------------------------------------

const KNOWN_POLICY_KEYS = new Set([
  'version',
  'allowServers',
  'denyServers',
  'requiredAuthPosture',
  'minimumGrade',
  'maximumDriftRisk',
  'allowUnpinnedServers',
  'failOnInlineCredentials',
]);

const VALID_POSTURES: readonly AuthPosture[] = ['none', 'env', 'inline', 'oauth', 'unknown'];

/**
 * Parse and validate a policy file.
 *
 * Unknown keys are rejected. A policy is written deliberately and a key that does
 * nothing is almost always a typo, which would silently produce a weaker gate than
 * the author believed they had written.
 */
export function parsePolicy(text: string, path: string): Policy {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigurationError(`${path} is not valid JSON`, { details: { path }, cause });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigurationError(`${path} must contain a JSON object`, { details: { path } });
  }

  const record = parsed as Record<string, unknown>;

  const unknown = Object.keys(record).filter((key) => !KNOWN_POLICY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ConfigurationError(`${path} has unknown policy keys: ${unknown.join(', ')}`, {
      details: { path, unknownKeys: unknown },
    });
  }

  if (record['version'] !== 1) {
    throw new ConfigurationError(
      `${path} must declare "version": 1, found ${JSON.stringify(record['version'])}`,
      { details: { path, key: 'version' } },
    );
  }

  requireStringArray(record['allowServers'], 'allowServers', path);
  requireStringArray(record['denyServers'], 'denyServers', path);

  const postures = record['requiredAuthPosture'];
  if (postures !== undefined) {
    requireStringArray(postures, 'requiredAuthPosture', path);

    for (const posture of postures as readonly string[]) {
      if (!(VALID_POSTURES as readonly string[]).includes(posture)) {
        throw new ConfigurationError(
          `${path}: requiredAuthPosture contains ${JSON.stringify(posture)}, which is not one of ${VALID_POSTURES.join(', ')}`,
          { details: { path, key: 'requiredAuthPosture' } },
        );
      }
    }
  }

  requireEnum(record['minimumGrade'], GRADE_ORDER, 'minimumGrade', path);
  requireEnum(record['maximumDriftRisk'], RISK_ORDER, 'maximumDriftRisk', path);
  requireBoolean(record['allowUnpinnedServers'], 'allowUnpinnedServers', path);
  requireBoolean(record['failOnInlineCredentials'], 'failOnInlineCredentials', path);

  return record as unknown as Policy;
}

function requireStringArray(value: unknown, key: string, path: string): void {
  if (value === undefined) return;

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigurationError(`${path}: ${key} must be an array of strings`, {
      details: { path, key },
    });
  }
}

function requireEnum(
  value: unknown,
  allowed: readonly string[],
  key: string,
  path: string,
): void {
  if (value === undefined) return;

  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ConfigurationError(
      `${path}: ${key} must be one of ${allowed.join(', ')}, found ${JSON.stringify(value)}`,
      { details: { path, key } },
    );
  }
}

function requireBoolean(value: unknown, key: string, path: string): void {
  if (value === undefined) return;

  if (typeof value !== 'boolean') {
    throw new ConfigurationError(`${path}: ${key} must be a boolean`, {
      details: { path, key },
    });
  }
}

export async function loadPolicy(path: string): Promise<Policy> {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw toMcpStewardError(error, `reading the policy at ${path}`);
  }

  return parsePolicy(text, path);
}

export async function savePolicy(path: string, policy: Policy): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
}

export interface InitPolicyOptions {
  /**
   * Whether to allowlist what is already installed.
   *
   * True produces a policy that passes today and catches anything new, which is
   * the useful starting point. False produces an empty allowlist that fails
   * everything, which nobody wants as a first experience.
   */
  readonly allowlistExisting?: boolean;
}

/**
 * Generate a starting policy from the current machine state.
 *
 * The generated policy passes on the machine it was generated from, except for
 * inline credentials, which fail immediately. That asymmetry is deliberate. A
 * policy that starts by failing teaches people to disable it; a policy that
 * accepts a credential sitting in a config file has normalised the one finding
 * that most warrants action right now.
 */
export function initPolicy(inventory: Inventory, options: InitPolicyOptions = {}): Policy {
  const allowlistExisting = options.allowlistExisting ?? true;

  // Every existing server is allowlisted, including one carrying an inline
  // credential. The allowlist answers "do you know this server is here", and the
  // operator does. The credential is a separate problem caught by
  // failOnInlineCredentials.
  //
  // Excluding it from the allowlist instead would report one problem twice, and
  // worse, fixing the credential would still leave an allowlist violation, so
  // the gate would not go green even after the operator did exactly what it
  // asked. A gate that stays red after the fix is a gate people stop trusting.
  const names = inventory.servers.map((s) => s.name).sort();

  return {
    version: 1,
    ...(allowlistExisting ? { allowServers: names } : {}),
    failOnInlineCredentials: true,
    allowUnpinnedServers: true,
    maximumDriftRisk: 'medium',
  };
}

/**
 * Exit codes, documented as a contract.
 *
 * These are public API. A CI job branches on them, so they may be added to but
 * never renumbered.
 */
export const EXIT_CODES = {
  success: 0,
  /** A policy or conformance check failed. The tool worked; the machine did not. */
  policyFailure: 1,
  /** The command was used incorrectly. */
  usageError: 2,
  /** A defect in mcpsteward. */
  internalError: 3,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** Map a policy result to the exit code a CI gate should use. */
export function exitCodeFor(result: PolicyResult): ExitCode {
  return result.passed ? EXIT_CODES.success : EXIT_CODES.policyFailure;
}
