/**
 * Conformance grading.
 *
 * Runs the rule registry against a capture and produces a reproducible grade.
 *
 * ## Reproducibility
 *
 * The same server plus the same tool version must yield the same grade. Nothing
 * here reads a clock, a random source, or the network. A grade that drifts between
 * runs cannot be used as evidence, and evidence is the point.
 *
 * ## What counts
 *
 * MUST rules dominate. A single MUST failure caps the grade below a pass, because
 * "mostly implements a mandatory requirement" is not a thing.
 *
 * UNVERIFIED rules report but never affect the score. That is the mechanism that
 * lets the package include a plausible but ungrounded rule without that rule
 * silently changing anyone's grade, and it is why the registry can be honest about
 * uncertainty instead of quietly omitting it.
 *
 * `not-applicable` and `inconclusive` never count against a server either. A rule
 * that could not be tested is not a rule the server failed.
 */

import type {
  ConformanceRule,
  Finding,
  Grade,
  GradeLetter,
  RuleResult,
} from '../core/types.js';
import { TARGET_REVISION, type ProtocolRevision } from '../core/revisions.js';
import { redact } from '../core/redaction.js';
import { RULES, type RuleContext } from './rules.js';

export * from './rules.js';

export interface ConformanceReport {
  readonly revision: ProtocolRevision;
  readonly results: readonly RuleResult[];
  readonly findings: readonly Finding[];
  readonly grade: Grade;
  /** Rules that reported but were excluded from the score. */
  readonly unverified: readonly RuleResult[];
}

/** Weight per normative level. MUST dominates by an order of magnitude. */
const LEVEL_WEIGHT: Readonly<Record<string, number>> = {
  MUST: 10,
  'MUST NOT': 10,
  SHOULD: 2,
  'SHOULD NOT': 2,
  MAY: 0,
};

/**
 * Grade a capture.
 *
 * Rules whose `applicableRevisions` do not include the revision actually used are
 * skipped entirely rather than reported as not applicable, because a rule from a
 * different revision is not a fact about this server at all.
 */
export function grade(context: RuleContext): ConformanceReport {
  const revision = context.surface.revisionUsed;

  const results: RuleResult[] = [];
  const unverified: RuleResult[] = [];
  const findings: Finding[] = [];

  let earned = 0;
  let possible = 0;

  let mustPassed = 0;
  let mustFailed = 0;
  let shouldPassed = 0;
  let shouldFailed = 0;
  let notApplicable = 0;

  for (const registered of RULES) {
    const rule = registered.rule;

    if (!(rule.applicableRevisions as readonly string[]).includes(revision)) continue;

    const outcome = registered.check(context);
    const result: RuleResult = {
      ruleId: rule.id,
      outcome: outcome.outcome,
      // Rule details can quote a server supplied string, so they pass through
      // redaction like every other outbound string.
      detail: redact(outcome.detail),
      ...(outcome.locus === undefined ? {} : { locus: redact(outcome.locus) }),
    };

    results.push(result);

    if (rule.confidence === 'UNVERIFIED') {
      unverified.push(result);
      if (result.outcome === 'fail') findings.push(toFinding(rule, result));
      continue;
    }

    const weight = LEVEL_WEIGHT[rule.level] ?? 0;
    const isMust = rule.level === 'MUST' || rule.level === 'MUST NOT';

    switch (result.outcome) {
      case 'pass':
        earned += weight;
        possible += weight;
        if (isMust) mustPassed += 1;
        else if (weight > 0) shouldPassed += 1;
        break;

      case 'fail':
        possible += weight;
        if (isMust) mustFailed += 1;
        else if (weight > 0) shouldFailed += 1;
        findings.push(toFinding(rule, result));
        break;

      case 'not-applicable':
      case 'inconclusive':
        // Neither earned nor possible. A rule that could not be tested must not
        // quietly lower a score, and must not quietly raise one either.
        notApplicable += 1;
        break;
    }
  }

  const counts = {
    mustPassed,
    mustFailed,
    shouldPassed,
    shouldFailed,
    unverifiedReported: unverified.length,
    notApplicable,
  };

  // Refuse to grade rather than grade an empty set. Previously `possible === 0`
  // scored as 100, so a server speaking 2025-11-25, to which no rule applies,
  // received an A and passed any grade gate. DECISIONS.md D-003: that revision
  // is captured, never graded.
  const reason =
    revision !== TARGET_REVISION
      ? `This server speaks ${revision}. mcpsteward grades conformance to ${TARGET_REVISION} only, ` +
        `so the server does not implement the revision being graded. Its surface was still ` +
        `captured and can be pinned and diffed.`
      : possible === 0
        ? `No graded rule produced a result for this server, so there is nothing to score. ` +
          `Every applicable rule was inconclusive or not applicable.`
        : undefined;

  if (reason !== undefined) {
    return {
      revision,
      results,
      findings: findings.sort(bySeverity),
      unverified,
      grade: { status: 'not-graded', reason, letter: null, score: null, ...counts },
    };
  }

  const score = Math.round((earned / possible) * 100);

  return {
    revision,
    results,
    findings: findings.sort(bySeverity),
    unverified,
    grade: {
      status: 'graded',
      letter: toLetter(score, mustFailed),
      score,
      mustPassed,
      mustFailed,
      shouldPassed,
      shouldFailed,
      unverifiedReported: unverified.length,
      notApplicable,
    },
  };
}

/**
 * Map a score to a letter.
 *
 * A MUST failure caps the grade regardless of score. A server can satisfy every
 * SHOULD in the specification and still be unusable if it does not implement
 * `server/discover`, so letting a high percentage paper over a mandatory failure
 * would make the letter meaningless.
 */
function toLetter(score: number, mustFailed: number): GradeLetter {
  if (mustFailed > 0) {
    if (mustFailed >= 3) return 'F';
    return mustFailed >= 2 ? 'D' : 'C';
  }

  if (score >= 95) return 'A';
  if (score >= 85) return 'B';
  if (score >= 70) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

function toFinding(rule: ConformanceRule, result: RuleResult): Finding {
  return {
    ruleId: rule.id,
    severity: rule.severity,
    title: rule.title,
    detail: result.detail,
    remediation: rule.remediation,
    citation: rule.citation,
    confidence: rule.confidence,
    ...(result.locus === undefined ? {} : { locus: result.locus }),
  };
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

function bySeverity(a: Finding, b: Finding): number {
  const rank = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  return rank !== 0 ? rank : a.ruleId.localeCompare(b.ruleId);
}

/** Every rule in the registry, for documentation generation. */
export function allRules(): readonly ConformanceRule[] {
  return RULES.map((r) => r.rule);
}
