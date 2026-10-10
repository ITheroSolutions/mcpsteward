/**
 * Pin a server's surface, then detect when it changes.
 *
 * This is the durable half of mcpwarden. A conformance grade tells you about
 * today; a pin tells you whether what you approved is still what you have.
 *
 * The event this exists to catch is a tool description being rewritten after you
 * approved it. That is how tool poisoning presents: the name stays, the schema
 * stays, and the text the model actually reads is replaced.
 *
 * Run with:  node examples/03-pin-and-detect-drift.mjs <server-name>
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { captureServer, createPin, inventory } from '@itherosolutions/mcpwarden/api';
import { diffAgainstPin } from '@itherosolutions/mcpwarden';

const name = process.argv[2];

if (name === undefined) {
  console.error('Usage: node 03-pin-and-detect-drift.mjs <server-name>');
  process.exit(2);
}

const machine = await inventory();
const server = machine.servers.find((s) => s.name === name);

if (server === undefined) {
  console.error(`No configured server named ${JSON.stringify(name)}.`);
  process.exit(2);
}

const env = {};
if (server.endpoint.transport === 'stdio') {
  for (const variable of server.endpoint.envNames) {
    const value = process.env[variable];
    if (value !== undefined) env[variable] = value;
  }
}

const pinPath = join('.mcpwarden-example', `${server.id}.pin.json`);

const surface = await captureServer(server, { env });

let existing;
try {
  existing = JSON.parse(await readFile(pinPath, 'utf8'));
} catch {
  existing = undefined;
}

if (existing === undefined) {
  // First run: approve what is there now.
  //
  // Approving without reading is the weakest link in this whole design. The pin
  // records that somebody said yes, not that anybody actually looked.
  const pin = createPin(surface, { approvedBy: process.env.USER ?? 'example' });

  await mkdir(dirname(pinPath), { recursive: true });
  await writeFile(pinPath, `${JSON.stringify(pin, null, 2)}\n`, 'utf8');

  console.log(`Pinned ${server.name}.`);
  console.log(`  surface root: ${pin.surfaceRoot}`);
  console.log(`  ${surface.descriptors.length} descriptor(s) approved`);
  console.log('');
  console.log('Run this script again to check for drift.');
  process.exit(0);
}

const report = diffAgainstPin(surface, existing);

if (report.events.length === 0) {
  console.log(`${server.name} is unchanged since it was approved on ${existing.approvedAt}.`);
  console.log(`  ${report.unchanged} descriptor(s) verified identical.`);
  process.exit(0);
}

console.log(`${server.name} has CHANGED since ${existing.approvedAt}.`);
console.log(`  approved root: ${report.pinnedRoot}`);
console.log(`  current root:  ${report.currentRoot}`);
console.log('');

for (const event of report.events) {
  console.log(`[${event.risk}] ${event.kind}  ${event.category} ${event.identity}`);
  console.log(`  ${event.summary}`);
  for (const factor of event.riskFactors) console.log(`  - ${factor}`);
  console.log('');
}

console.log('Risk scoring is a heuristic that orders attention. It is not a guarantee.');
console.log('If these changes are expected, delete the pin and run this again to re-approve.');

process.exitCode = 1;
