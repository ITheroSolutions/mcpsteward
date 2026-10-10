/**
 * Inventory every MCP server configured on this machine.
 *
 * Entirely offline. This script connects to nothing and starts nothing, so it is
 * safe to run on a machine you do not fully trust.
 *
 * Run with:  node examples/01-inventory-a-machine.mjs
 */

import { inventory } from 'mcpsteward/api';

const result = await inventory();

console.log(`${result.summary.totalServers} MCP server(s) configured on this machine.`);
console.log(`  ${result.summary.local} local (stdio), ${result.summary.remote} remote (http)`);
console.log(`  found in: ${result.summary.clientsFound.join(', ') || 'no clients'}`);

if (result.summary.withInlineCredentials > 0) {
  console.log('');
  console.log(
    `WARNING: ${result.summary.withInlineCredentials} server(s) have a credential written`,
  );
  console.log('directly into a configuration file. Those values are one commit away from');
  console.log('being published. Replace them with environment references and rotate them.');
}

console.log('');

for (const server of result.servers) {
  const where =
    server.endpoint.transport === 'stdio'
      ? `${server.endpoint.command} ${server.endpoint.args.join(' ')}`.trim()
      : server.endpoint.url;

  const clients = server.registrations.map((r) => r.client).join(', ');

  console.log(`${server.name}`);
  console.log(`  ${server.endpoint.transport}, auth ${server.authPosture}, via ${clients}`);
  console.log(`  ${where}`);
}

// A file that exists but could not be parsed is reported separately from one that
// simply is not there. "You have no MCP servers" and "your config is corrupt so I
// could not tell" are very different answers.
if (result.problems.length > 0) {
  console.log('');
  console.log('Problems:');
  for (const problem of result.problems) {
    console.log(`  ${problem.configPath}: ${problem.reason}`);
  }
}
