/**
 * The awaited promise must always settle, in a process with nothing else running.
 *
 * Every other test in this suite runs under vitest, and the runner keeps its own
 * handles on the event loop. That hides an entire class of defect: a timer
 * created with `unref()` cannot hold the loop open by itself, so if it is the
 * only thing left scheduled, Node drains the loop and exits while a caller is
 * still awaiting the promise that timer was supposed to settle.
 *
 * Under vitest the timer always fires, because the runner is alive. In a bare
 * CLI process it never does. `mcpsteward conform <a server that dies on spawn>`
 * exited with code 13, ERR_UNSETTLED_TOP_LEVEL_AWAIT, printing no finding, no
 * error and no explanation.
 *
 * So these tests spawn a real Node process with nothing else in it. That is the
 * only configuration in which the bug is observable, which is exactly why it
 * survived 985 passing tests.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const PROJECT = fileURLToPath(new URL('../..', import.meta.url));
const API_ENTRY = fileURLToPath(new URL('../../dist/api.js', import.meta.url));
const DEAD_SERVER = fileURLToPath(new URL('../fixtures/servers/exits-immediately.mjs', import.meta.url));

beforeAll(async () => {
  if (existsSync(API_ENTRY)) return;

  await execFileAsync('npm', ['run', 'build'], {
    cwd: PROJECT,
    shell: process.platform === 'win32',
  });
}, 180_000);

/**
 * Run a module in a bare Node process and report how it ended.
 *
 * The source goes to a real file rather than `node -e`. Passing a multi line
 * script through `-e` is quoted by the platform shell, and on Windows that
 * mangled it into a different failure, which made the first version of this
 * test pass for a reason that had nothing to do with the defect.
 */
async function runBare(source: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mcpsteward-loop-'));
  const script = join(dir, 'probe.mjs');

  try {
    await writeFile(script, source, 'utf8');

    const { stdout, stderr } = await execFileAsync(process.execPath, [script], {
      cwd: PROJECT,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CAPTURE_A_DEAD_SERVER = `
import { captureServer } from ${JSON.stringify(pathToFileURL(API_ENTRY).href)};

const server = {
  id: 'dead',
  name: 'dead',
  endpoint: {
    transport: 'stdio',
    command: process.execPath,
    args: [${JSON.stringify(DEAD_SERVER)}],
    envNames: [],
  },
  authPosture: 'none',
  registrations: [],
};

try {
  await captureServer(server, { timeoutMs: 3000 });
  console.log('SETTLED:resolved');
} catch (error) {
  console.log('SETTLED:' + error.constructor.name);
}
`;

describe('a capture against a server that dies on spawn', () => {
  it('settles rather than draining the event loop', async () => {
    const result = await runBare(CAPTURE_A_DEAD_SERVER);

    // Node exits 13 with ERR_UNSETTLED_TOP_LEVEL_AWAIT when the loop empties
    // while a top level await is still pending. That is the defect.
    expect(result.code, `exit 13 means the await never settled.\n${result.stderr}`).not.toBe(13);
    expect(result.stderr).not.toMatch(/unsettled top-level await/i);
  }, 90_000);

  it('rejects with a typed error naming the failure', async () => {
    const result = await runBare(CAPTURE_A_DEAD_SERVER);

    expect(result.stdout).toContain('SETTLED:');
    expect(result.stdout, 'a dead server must reject, not resolve').not.toContain(
      'SETTLED:resolved',
    );
  }, 90_000);
});
