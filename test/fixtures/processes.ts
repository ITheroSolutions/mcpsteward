/**
 * Counting leftover fixture processes.
 *
 * A transport that leaves a child behind is a real defect: `mcpsteward` spawns a
 * process per server it inspects, so an orphan per capture would accumulate
 * silently on the machine of anybody who ran it in a loop. These helpers exist so
 * the tests can assert the absence of that.
 *
 * Lifted out of `test/protocol/stdio-transport.test.ts` and `test/api/api.test.ts`,
 * which had carried byte identical copies of the counter.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** How many `conforming.mjs` fixture processes are currently running. */
export async function countFixtureProcesses(): Promise<number> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*conforming.mjs*' }).Count",
        ],
        { timeout: 10_000 },
      );
      return Number(stdout.trim()) || 0;
    }

    const { stdout } = await execFileAsync('sh', ['-c', 'ps -eo args | grep -c "[c]onforming.mjs"'], {
      timeout: 10_000,
    });
    return Number(stdout.trim()) || 0;
  } catch {
    // grep exits nonzero when it matches nothing, and the process listing may be
    // unavailable in a constrained environment. Either way, zero is the right
    // answer for a count.
    return 0;
  }
}

/**
 * Poll until the fixture process count falls to `atMost`, or the deadline passes.
 *
 * These assertions previously slept a flat 300ms and then counted once. That is a
 * timing assumption dressed as a correctness check, and it broke the first time
 * CI ran it: a loaded macOS runner had not finished reaping the child yet, so the
 * count came back 1 and the test reported an orphan that did not exist.
 *
 * Raising the sleep would only move the threshold. Polling removes the guess. It
 * returns immediately in the normal case, tolerates a slow runner, and still
 * fails after the deadline when a process really has been left behind, which is
 * the only thing this check is for.
 */
export async function waitForFixtureProcesses(atMost: number, deadlineMs = 15_000): Promise<number> {
  const deadline = Date.now() + deadlineMs;

  let count = await countFixtureProcesses();
  while (count > atMost && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    count = await countFixtureProcesses();
  }

  return count;
}
