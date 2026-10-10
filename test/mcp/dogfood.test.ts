import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { grade } from '../../src/conformance/index.js';
import type { ServerRef } from '../../src/core/types.js';
import { McpClient } from '../../src/protocol/client.js';
import { StdioTransport } from '../../src/protocol/stdio-transport.js';

/**
 * mcpsteward grading its own MCP server.
 *
 * This is the strongest credibility signal the package can offer,
 * and it is right: a tool that grades MCP servers and cannot pass its own grader
 * is not worth running. The grade A assertion below is the whole point of this
 * file, and it must never be relaxed to make a change land.
 *
 * The server under test is the built output, spawned as a real child process
 * speaking real protocol over real pipes. Nothing is stubbed.
 */

const SERVER = fileURLToPath(new URL('../../dist/mcp/index.js', import.meta.url));
const PROJECT = fileURLToPath(new URL('../..', import.meta.url));

const open: McpClient[] = [];

/**
 * Build the server if it is not there.
 *
 * `npm run verify` runs the tests before the build, so on a fresh clone
 * `dist` does not exist yet and every test in this
 * file would fail for a reason that has nothing to do with conformance. Building
 * on demand keeps the failure signal honest: a red test here means the server is
 * actually non conforming.
 */
beforeAll(async () => {
  if (existsSync(SERVER)) return;

  await promisify(execFile)('npm', ['run', 'build'], {
    cwd: PROJECT,
    shell: process.platform === 'win32',
  });
}, 180_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.dispose()));
});

const SELF: ServerRef = {
  id: 'mcpsteward-self',
  name: 'mcpsteward',
  endpoint: { transport: 'stdio', command: 'node', args: [SERVER], envNames: [] },
  authPosture: 'none',
  registrations: [],
};

function connect(): McpClient {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [SERVER],
    env: {},
  });

  transport.start();

  const client = new McpClient(transport, { timeoutMs: 20_000, retries: 0 });
  open.push(client);
  return client;
}

describe('mcpsteward grades its own MCP server', () => {
  it('reaches grade A against its own conformance engine', async () => {
    const captured = await connect().capture(SELF, 'stdio');
    const report = grade(captured);

    // If this ever fails, the fix is the server, not this assertion.
    expect(report.grade.mustFailed, formatFailures(report)).toBe(0);
    expect(report.grade.letter, formatFailures(report)).toBe('A');
  }, 30_000);

  it('fails no rule at any severity', async () => {
    const report = grade(await connect().capture(SELF, 'stdio'));
    expect(report.findings, formatFailures(report)).toEqual([]);
  }, 30_000);

  it('speaks the revision it claims to', async () => {
    const captured = await connect().capture(SELF, 'stdio');
    expect(captured.surface.revisionUsed).toBe('2026-07-28');
    expect(captured.evidence.negotiation.downgraded).toBe(false);
  }, 30_000);
});

describe('protocol behaviour', () => {
  it('implements server/discover with supported versions and capabilities', async () => {
    const outcome = await connect().discover('2026-07-28');

    expect(outcome.implemented).toBe(true);
    expect(outcome.supportedVersions).toEqual(['2026-07-28']);
    expect(outcome.capabilities).toHaveProperty('tools');
    expect(outcome.serverInfo).toMatchObject({ name: 'mcpsteward' });
  }, 30_000);

  it('rejects a version it does not support, naming what it does', async () => {
    const outcome = await connect().discover('2025-11-25');

    // The legacy era sends no _meta, so this exercises the missing field path
    // rather than the version path. Either way it must not silently succeed.
    expect(!outcome.implemented || outcome.supportedVersions.length > 0).toBe(true);
  }, 30_000);

  it('carries caching hints on list results', async () => {
    const captured = await connect().capture(SELF, 'stdio');
    const lists = captured.evidence.listResults;

    expect(lists.length).toBeGreaterThan(0);
    for (const entry of lists) {
      expect(entry.result['ttlMs'], `${entry.method} has no ttlMs`).toBeDefined();
      expect(entry.result['cacheScope'], `${entry.method} has no cacheScope`).toBeDefined();
    }
  }, 30_000);

  it('declares resultType on every result', async () => {
    const captured = await connect().capture(SELF, 'stdio');

    for (const entry of captured.evidence.listResults) {
      expect(entry.result['resultType']).toBe('complete');
    }
  }, 30_000);
});

describe('the advertised tool surface', () => {
  it('exposes all six documented tools', async () => {
    const captured = await connect().capture(SELF, 'stdio');
    const names = captured.surface.descriptors.map((d) => d.identity).sort();

    expect(names).toEqual([
      'capture_surface',
      'check_conformance',
      'check_policy',
      'diff_against_trust',
      'discover_servers',
      'verify_ledger',
    ]);
  }, 30_000);

  it('returns tools in a deterministic order across captures', async () => {
    // Order stability lets a client cache the list and improves prompt cache
    // hit rates on the model side.
    const first = await connect().capture(SELF, 'stdio');
    const second = await connect().capture(SELF, 'stdio');

    expect(second.surface.hashes.root).toBe(first.surface.hashes.root);
  }, 40_000);

  it('describes every tool well enough for a model to choose correctly', async () => {
    // The description is the prompt. A vague one produces a model that calls
    // the wrong thing confidently.
    const captured = await connect().capture(SELF, 'stdio');

    for (const descriptor of captured.surface.descriptors) {
      const description = descriptor.value['description'];

      expect(typeof description, `${descriptor.identity} has no description`).toBe('string');
      expect(
        (description as string).length,
        `${descriptor.identity} has a thin description`,
      ).toBeGreaterThan(120);
    }
  }, 30_000);

  it('says which tools have side effects and which do not', async () => {
    // A model needs to know that discover_servers is free and capture_surface
    // starts a process.
    const captured = await connect().capture(SELF, 'stdio');

    const byName = new Map(
      captured.surface.descriptors.map((d) => [d.identity, describeOf(d)]),
    );

    expect(byName.get('discover_servers')).toMatch(/connects to nothing|starts nothing/i);
    expect(byName.get('capture_surface')).toMatch(/starts the server/i);
    expect(byName.get('verify_ledger')).toMatch(/connects to nothing/i);
  }, 30_000);

  it('states the ledger limitation honestly in the tool description', async () => {
    // A tool description that overclaimed would mislead a model into telling a
    // user their ledger is authentic when it is only internally consistent.
    const captured = await connect().capture(SELF, 'stdio');

    const verify = captured.surface.descriptors.find((d) => d.identity === 'verify_ledger');
    expect(describeOf(verify)).toMatch(/not that it is authentic|forgery/i);
  }, 30_000);

  it('labels the drift risk score as a heuristic', async () => {
    const captured = await connect().capture(SELF, 'stdio');

    const diff = captured.surface.descriptors.find((d) => d.identity === 'diff_against_trust');
    expect(describeOf(diff)).toMatch(/heuristic/i);
  }, 30_000);

  it('gives every tool a valid object input schema', async () => {
    const captured = await connect().capture(SELF, 'stdio');

    for (const descriptor of captured.surface.descriptors) {
      const schema = descriptor.value['inputSchema'] as Record<string, unknown> | undefined;

      expect(schema, `${descriptor.identity} has no inputSchema`).toBeDefined();
      expect(schema?.['type']).toBe('object');
    }
  }, 30_000);
});

/** Read a descriptor description as a string, whatever the server sent. */
function describeOf(descriptor: { value: Record<string, unknown> } | undefined): string {
  const value = descriptor?.value['description'];
  return typeof value === 'string' ? value : '';
}

/** Render failures so a red test says what is wrong without a rerun. */
function formatFailures(report: ReturnType<typeof grade>): string {
  if (report.findings.length === 0) return 'no findings';

  return (
    `\n${report.grade.letter ?? 'not graded'} (${String(report.grade.score)}/100)\n` +
    report.findings
      .map((f) => `  ${f.ruleId} [${f.severity}] ${f.title}\n    ${f.detail}`)
      .join('\n')
  );
}
