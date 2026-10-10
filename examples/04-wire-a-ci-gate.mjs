/**
 * Wire a CI gate.
 *
 * Exits nonzero when the machine violates the policy, with output that tells a
 * developer what to do rather than only that something is wrong.
 *
 * Exit codes, which a CI job can branch on:
 *   0  everything passed
 *   1  the policy was violated. The tool worked; the machine did not.
 *   2  the policy file is missing or malformed. That is the operator's mistake.
 *
 * Run with:  node examples/04-wire-a-ci-gate.mjs [policy-path]
 */

import { readFile } from 'node:fs/promises';

import { evaluatePolicy, inventory } from 'mcpsteward/api';
import { initPolicy, parsePolicy } from 'mcpsteward';

const policyPath = process.argv[2] ?? 'mcpsteward.policy.json';

const machine = await inventory();

let policy;
try {
  policy = parsePolicy(await readFile(policyPath, 'utf8'), policyPath);
} catch (error) {
  console.error(`Could not use ${policyPath}: ${error.message}`);
  console.error('');
  console.error('Here is a policy that would pass on this machine right now, except that');
  console.error('inline credentials fail immediately by design:');
  console.error('');
  console.error(JSON.stringify(initPolicy(machine), null, 2));

  process.exit(2);
}

const result = evaluatePolicy(policy, { inventory: machine });

// A check that could not run is reported rather than silently passing. A green
// gate that only checked half the policy must not look like one that checked all
// of it.
for (const note of result.notEvaluated) {
  console.error(`note: ${note}`);
}

if (result.passed) {
  console.log(`Policy satisfied. ${result.serversEvaluated} server(s) evaluated.`);
  process.exit(0);
}

console.error('');
console.error(`Policy FAILED. ${result.violations.length} violation(s).`);
console.error('');

for (const violation of result.violations) {
  console.error(`[${violation.severity}] ${violation.kind}`);
  console.error(`  ${violation.detail}`);
  console.error('');
}

process.exit(1);
