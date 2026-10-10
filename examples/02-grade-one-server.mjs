/**
 * Grade one server against the 2026-07-28 specification.
 *
 * Every finding carries the specification section or SEP that justifies it, so a
 * result can be checked rather than merely believed.
 *
 * Run with:  node examples/02-grade-one-server.mjs <server-name>
 */

import { conformServer, inventory } from 'mcpsteward/api';

const name = process.argv[2];

if (name === undefined) {
  console.error('Usage: node 02-grade-one-server.mjs <server-name>');
  console.error('Run 01-inventory-a-machine.mjs first to see what is configured.');
  process.exit(2);
}

const machine = await inventory();
const server = machine.servers.find((s) => s.name === name);

if (server === undefined) {
  console.error(`No configured server named ${JSON.stringify(name)}.`);
  console.error(`Found: ${machine.servers.map((s) => s.name).join(', ') || 'none'}`);
  process.exit(2);
}

// Only the environment variables the configuration named are passed to the child.
// Handing a server the whole environment would leak every credential this process
// holds into a program it did not write.
const env = {};
if (server.endpoint.transport === 'stdio') {
  for (const variable of server.endpoint.envNames) {
    const value = process.env[variable];
    if (value !== undefined) env[variable] = value;
  }
}

const { surface, report } = await conformServer(server, {
  env,
  timeoutMs: 30_000,
  onProgress: (event) => process.stderr.write(`  ${event.stage}: ${event.received}\n`),
});

console.log('');
console.log(`${server.name} graded ${report.grade.letter} (${report.grade.score}/100)`);
console.log(`  revision spoken: ${surface.revisionUsed}`);
console.log(`  MUST passed ${report.grade.mustPassed}, failed ${report.grade.mustFailed}`);
console.log(`  SHOULD passed ${report.grade.shouldPassed}, failed ${report.grade.shouldFailed}`);
console.log(`  not applicable: ${report.grade.notApplicable}`);

if (report.findings.length === 0) {
  console.log('');
  console.log('No findings. This server satisfies every rule that applies to it.');
} else {
  console.log('');
  for (const finding of report.findings) {
    console.log(`[${finding.severity}] ${finding.ruleId}  ${finding.title}`);
    console.log(`  ${finding.detail}`);
    console.log(`  Fix: ${finding.remediation}`);
    console.log(`  Spec: ${finding.citation.sep ?? finding.citation.section}`);
    console.log('');
  }
}

// A MUST failure means the server does not implement a mandatory requirement.
process.exitCode = report.grade.mustFailed > 0 ? 1 : 0;
