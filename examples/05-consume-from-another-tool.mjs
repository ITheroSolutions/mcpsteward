/**
 * Consume mcpsteward from another tool.
 *
 * Shows the pieces a host application actually needs: a session it controls, its
 * own logger, cancellation it owns, and a report rendered into whichever format
 * the surrounding system speaks.
 *
 * Run with:  node examples/05-consume-from-another-tool.mjs
 */

import { fileURLToPath } from 'node:url';

import { ServerSession, withServer } from 'mcpsteward/api';
import { buildReport, createLogger, grade, render } from 'mcpsteward';

// A server this example controls, so the script is runnable with no setup and
// never touches anything real.
const FIXTURE = fileURLToPath(
  new URL('../test/fixtures/servers/conforming.mjs', import.meta.url),
);

const server = {
  id: 'example-fixture',
  name: 'example-fixture',
  endpoint: {
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    envNames: ['MCPSTEWARD_FIXTURE_MODE'],
  },
  authPosture: 'none',
  registrations: [],
};

// The library never writes to a stream on its own. A host supplies a sink and
// decides where diagnostics go. stdout is an MCP transport, so this one uses
// stderr.
const logger = createLogger({
  level: 'info',
  sink: (record) => process.stderr.write(`[${record.level}] ${record.message}\n`),
});

// The host owns cancellation. This one gives up after five seconds regardless of
// any per request timeout.
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 5_000);

try {
  const { surface, report } = await withServer(
    server,
    async (session) => await session.conform(),
    {
      logger,
      signal: controller.signal,
      env: { MCPSTEWARD_FIXTURE_MODE: 'conforming' },
      onProgress: (event) => logger.info(`captured ${event.stage}`, { count: event.received }),
    },
  );

  // Turn the result into whatever format the surrounding system speaks. Every
  // renderer receives an already redacted model, so a host cannot accidentally
  // publish a credential a server sent.
  const rendered = buildReport({
    kind: 'conformance',
    title: 'Embedded conformance check',
    subject: server.name,
    toolVersion: '0.1.0',
    summary: [
      { label: 'Grade', value: report.grade.letter },
      { label: 'Revision', value: surface.revisionUsed },
      { label: 'Descriptors', value: String(surface.descriptors.length) },
    ],
    sections: [
      {
        title: 'Findings',
        emptyMessage: 'None.',
        items: report.findings.map((finding) => ({
          id: finding.ruleId,
          title: finding.title,
          severity: finding.severity,
          detail: finding.detail,
          remediation: finding.remediation,
        })),
      },
    ],
  });

  process.stdout.write(render(rendered, 'markdown'));
} finally {
  clearTimeout(deadline);
}

// A separate session, to show that dispose is idempotent and that using a session
// after disposal fails loudly rather than silently.
const session = ServerSession.open(server, {
  env: { MCPSTEWARD_FIXTURE_MODE: 'conforming' },
});

await session.dispose();
await session.dispose();

try {
  await session.capture();
} catch (error) {
  process.stderr.write(`\nUsing a disposed session throws ${error.code}, as intended.\n`);
}
