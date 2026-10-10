/**
 * The CLI inventories the project it is run in, not only the user's own config.
 *
 * It used to read only configuration under the home directory. A repository's
 * `.mcp.json`, which is how Claude Code scopes servers to a project, was never
 * seen, and the CI example in the README checked nothing at all: a CI runner has
 * no MCP configuration in its home directory, so `verify` found no servers and
 * passed.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run, type CliIo } from '../../src/cli/index.js';

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'mcpsteward-project-'));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

async function cli(args: readonly string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => undefined,
    env: {},
    isTty: false,
    cwd: project,
  };
  return { code: await run(args, io), stdout };
}

interface JsonReport {
  sections: { items: { title: string; severity?: string; detail?: string }[] }[];
}

describe('project level configuration', () => {
  beforeEach(async () => {
    await writeFile(
      join(project, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'project-db': {
            command: 'node',
            args: ['db-server.js'],
            env: { API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' },
          },
        },
      }),
    );
    await mkdir(join(project, '.vscode'));
    await writeFile(
      join(project, '.vscode', 'mcp.json'),
      JSON.stringify({ servers: { 'workspace-tools': { type: 'stdio', command: 'node', args: ['tools.js'] } } }),
    );
  });

  it('is inventoried by discover', async () => {
    const { stdout } = await cli(['discover', '--format', 'json']);
    const titles = (JSON.parse(stdout) as JsonReport).sections.flatMap((s) => s.items.map((i) => i.title));

    expect(titles).toContain('project-db');
    expect(titles).toContain('workspace-tools');
  });

  it('reports an inline credential in it as critical, without printing it', async () => {
    const { stdout } = await cli(['discover', '--format', 'json']);
    const item = (JSON.parse(stdout) as JsonReport).sections
      .flatMap((s) => s.items)
      .find((i) => i.title === 'project-db');

    expect(item?.severity).toBe('critical');
    expect(stdout).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('makes verify fail in CI, where the project is all there is', async () => {
    const policy = join(project, 'mcpsteward.policy.json');
    await writeFile(policy, JSON.stringify({ version: 1, failOnInlineCredentials: true }));

    const { code, stdout } = await cli(['verify', '--policy', policy, '--format', 'json']);

    expect(code).toBe(1);
    expect(stdout).toContain('project-db');
  });
});
