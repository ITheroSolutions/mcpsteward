#!/usr/bin/env node
/**
 * Generate docs/rules.md from the rule registry.
 *
 * This file is generated, not hand written, and the
 * reason is that a hand written rule table drifts. Somebody adds a rule and
 * forgets the docs, or edits a remediation in one place and not the other, and
 * within a release the documentation is quietly lying about what the tool checks.
 *
 * A test asserts the committed file matches what this script produces, so drift
 * fails the build rather than shipping.
 *
 * Run with:  node scripts/generate-docs.mjs
 * Check with: node scripts/generate-docs.mjs --check
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { allRules } from '../dist/conformance/index.js';
import { allMigrationPatterns } from '../dist/migration/index.js';

const OUT = fileURLToPath(new URL('../docs/rules.md', import.meta.url));

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

function bySeverityThenId(a, b) {
  const rank = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
  return rank !== 0 ? rank : a.id.localeCompare(b.id);
}

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function specLink(citation) {
  if (citation.section.startsWith('changelog')) {
    return `https://modelcontextprotocol.io/specification/2026-07-28/${citation.section}`;
  }
  return `https://modelcontextprotocol.io/specification/2026-07-28/${citation.section}`;
}

function render() {
  const rules = [...allRules()].sort(bySeverityThenId);
  const patterns = [...allMigrationPatterns()].sort(bySeverityThenId);

  const byCategory = new Map();
  for (const rule of rules) {
    const list = byCategory.get(rule.category) ?? [];
    list.push(rule);
    byCategory.set(rule.category, list);
  }

  const lines = [];

  lines.push('# Conformance rules and migration patterns');
  lines.push('');
  lines.push(
    'This file is generated from the rule registry by `scripts/generate-docs.mjs`. ' +
      'Do not edit it by hand: a test asserts it matches the registry, so an edit here ' +
      'fails the build rather than shipping.',
  );
  lines.push('');
  lines.push('Regenerate with:');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run build && node scripts/generate-docs.mjs');
  lines.push('```');
  lines.push('');

  lines.push('## How to read this');
  lines.push('');
  lines.push(
    'Every rule carries a **citation** naming the specification section or SEP that ' +
      'justifies it. That is enforced by the type system: a rule without one does not ' +
      'compile. A finding you cannot trace to a requirement is a finding you cannot act on.',
  );
  lines.push('');
  lines.push(
    '**Confidence** is `VERIFIED` when the requirement was read in specification text ' +
      'that was actually fetched, and `UNVERIFIED` when it is plausible but ungrounded. ' +
      'An `UNVERIFIED` rule reports but is excluded from the graded score, so it can never ' +
      'silently change any grade without notice.',
  );
  lines.push('');
  lines.push(
    '**Normative level** is the wording the specification itself uses. MUST rules dominate ' +
      'the grade, and a single MUST failure caps the letter regardless of score.',
  );
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Measure | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Conformance rules | ${rules.length} |`);
  lines.push(`| MUST and MUST NOT | ${rules.filter((r) => r.level.startsWith('MUST')).length} |`);
  lines.push(
    `| SHOULD and SHOULD NOT | ${rules.filter((r) => r.level.startsWith('SHOULD')).length} |`,
  );
  lines.push(`| VERIFIED | ${rules.filter((r) => r.confidence === 'VERIFIED').length} |`);
  lines.push(`| UNVERIFIED | ${rules.filter((r) => r.confidence === 'UNVERIFIED').length} |`);
  lines.push(`| Migration patterns | ${patterns.length} |`);
  lines.push('');

  lines.push('## Conformance rules');
  lines.push('');

  for (const [category, list] of [...byCategory.entries()].sort()) {
    lines.push(`### ${category}`);
    lines.push('');

    for (const rule of list) {
      lines.push(`#### ${rule.id}: ${rule.title}`);
      lines.push('');
      lines.push('| Field | Value |');
      lines.push('| --- | --- |');
      lines.push(`| Severity | ${rule.severity} |`);
      lines.push(`| Level | ${rule.level} |`);
      lines.push(`| Confidence | ${rule.confidence} |`);
      lines.push(`| Revisions | ${rule.applicableRevisions.join(', ')} |`);
      lines.push(
        `| Specification | [${escapeCell(rule.citation.section)}](${specLink(rule.citation)})${
          rule.citation.sep === undefined ? '' : ` (${rule.citation.sep})`
        } |`,
      );
      lines.push('');
      lines.push(`**Requirement.** ${rule.requirement}`);
      lines.push('');

      if (rule.citation.quote !== undefined) {
        lines.push(`> ${rule.citation.quote}`);
        lines.push('');
      }

      lines.push(`**Remediation.** ${rule.remediation}`);
      lines.push('');
    }
  }

  lines.push('## Migration patterns');
  lines.push('');
  lines.push(
    'Patterns in MCP server source that break under 2026-07-28. Detected by ' +
      '`mcpsteward migrate <path>`. Each traces to a rule above or to the SEP that ' +
      'introduced the change.',
  );
  lines.push('');

  for (const pattern of patterns) {
    lines.push(`### ${pattern.id}: ${pattern.title}`);
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Severity | ${pattern.severity} |`);
    lines.push(`| Rule | ${pattern.rule} |`);
    lines.push(`| Safe codemod exists | ${pattern.codemodable ? 'yes' : 'no'} |`);
    lines.push('');
    lines.push(`**Why it breaks.** ${pattern.why}`);
    lines.push('');
    lines.push(`**Fix.** ${pattern.fix}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    'Generated from the registry. The rule count above is the real count: there is no ' +
      'separate list to fall out of date.',
  );
  lines.push('');

  return lines.join('\n');
}

const content = render();
const check = process.argv.includes('--check');

if (check) {
  let existing = '';
  try {
    existing = await readFile(OUT, 'utf8');
  } catch {
    existing = '';
  }

  // Compare with line endings normalised. `.gitattributes` pins the working tree
  // to LF, which is the actual fix, but a checkout that predates it or an editor
  // that rewrites on save would otherwise report drift on a file that is byte
  // identical in the repository and send somebody off to regenerate something
  // already correct. Line endings are not part of what this check is for.
  const normalise = (text) => text.replace(/\r\n/g, '\n');

  if (normalise(existing) !== normalise(content)) {
    process.stderr.write(
      'docs/rules.md is out of date with the rule registry.\n' +
        'Regenerate it with: npm run build && node scripts/generate-docs.mjs\n',
    );
    process.exit(1);
  }

  process.stdout.write('docs/rules.md matches the registry.\n');
} else {
  await writeFile(OUT, content, 'utf8');
  process.stdout.write(`Wrote ${OUT}\n`);
}
