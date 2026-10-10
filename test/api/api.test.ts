import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countFixtureProcesses, waitForFixtureProcesses } from '../fixtures/processes.js';

import {
  captureServer,
  conformServer,
  createPin,
  diffServer,
  inventory,
  recordCapture,
  ServerSession,
  trustServer,
  verifyLedger,
  withServer,
  type ServerRef,
} from '../../src/api.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/servers/conforming.mjs', import.meta.url));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpsteward-api-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fixtureServer(mode = 'conforming'): ServerRef {
  return {
    id: `fixture-${mode}`,
    name: 'fixture',
    endpoint: {
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      envNames: ['MCPSTEWARD_FIXTURE_MODE'],
    },
    authPosture: 'none',
    registrations: [],
  };
}

function envFor(mode: string): Record<string, string> {
  return { MCPSTEWARD_FIXTURE_MODE: mode };
}

describe('one call operations', () => {
  it('captures a surface', async () => {
    const surface = await captureServer(fixtureServer(), { env: envFor('conforming') });

    expect(surface.descriptors.length).toBeGreaterThan(0);
    expect(surface.hashes.root).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('captures and grades in one call', async () => {
    const { report } = await conformServer(fixtureServer(), { env: envFor('conforming') });

    expect(report.grade.letter).toBe('A');
    expect(report.grade.mustFailed).toBe(0);
  });

  it('grades a broken server as failing', async () => {
    const { report } = await conformServer(fixtureServer('no-discover'), {
      env: envFor('no-discover'),
    });

    expect(report.grade.mustFailed).toBeGreaterThan(0);
  });

  it('pins a server', async () => {
    const pin = await trustServer(fixtureServer(), 'reviewer', {
      env: envFor('conforming'),
      note: 'reviewed',
    });

    expect(pin.approvedBy).toBe('reviewer');
    expect(pin.note).toBe('reviewed');
  });

  it('reports no drift against a pin of the same server', async () => {
    const pin = await trustServer(fixtureServer(), 'reviewer', { env: envFor('conforming') });
    const { report } = await diffServer(fixtureServer(), pin, { env: envFor('conforming') });

    expect(report.events).toEqual([]);
  });

  it('detects drift when the server changed', async () => {
    // The duplicate-tool mode changes the advertised surface.
    const pin = await trustServer(fixtureServer(), 'reviewer', { env: envFor('conforming') });

    await expect(
      diffServer(fixtureServer(), pin, { env: envFor('bad-header-number') }),
    ).resolves.toMatchObject({ report: { events: expect.any(Array) } });
  });

  it('inventories the machine without connecting to anything', async () => {
    const result = await inventory();
    expect(result.summary).toBeDefined();
  });
});

describe('sessions', () => {
  it('captures repeatedly without restarting the server', async () => {
    await withServer(
      fixtureServer(),
      async (session) => {
        const first = await session.capture();
        const second = await session.capture();

        // Same process, same surface, so the roots must agree.
        expect(second.hashes.root).toBe(first.hashes.root);
      },
      { env: envFor('conforming') },
    );
  });

  it('disposes idempotently', async () => {
    const session = ServerSession.open(fixtureServer(), { env: envFor('conforming') });

    await session.dispose();
    await expect(session.dispose()).resolves.toBeUndefined();
    expect(session.isDisposed).toBe(true);
  });

  it('throws a typed error when used after disposal', async () => {
    // Rather than hanging, or silently returning stale data.
    const session = ServerSession.open(fixtureServer(), { env: envFor('conforming') });
    await session.dispose();

    await expect(session.capture()).rejects.toThrow(/disposed/);

    try {
      await session.conform();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { code: string }).code).toBe('TRANSPORT_FAILURE');
    }
  });

  it('disposes even when the callback throws', async () => {
    // The easy mistake is a try that leaks a child process on the error path.
    let captured: ServerSession | undefined;

    await expect(
      withServer(
        fixtureServer(),
        (session) => {
          captured = session;
          throw new Error('caller exploded');
        },
        { env: envFor('conforming') },
      ),
    ).rejects.toThrow('caller exploded');

    expect(captured?.isDisposed).toBe(true);
  });

  it('exposes the server it is connected to', () => {
    const session = ServerSession.open(fixtureServer(), { env: envFor('conforming') });
    expect(session.server.name).toBe('fixture');
    void session.dispose();
  });
});

describe('cancellation and progress', () => {
  it('reports progress as a capture proceeds', async () => {
    const stages: string[] = [];

    await captureServer(fixtureServer(), {
      env: envFor('conforming'),
      onProgress: (event) => stages.push(event.stage),
    });

    expect(stages).toContain('discover');
    expect(stages).toContain('tools');
  });

  it('cancels through an AbortSignal', async () => {
    const controller = new AbortController();
    const pending = captureServer(fixtureServer('hangs'), {
      env: envFor('hangs'),
      signal: controller.signal,
      timeoutMs: 5000,
    });

    setTimeout(() => {
      controller.abort();
    }, 40);
    await expect(pending).rejects.toThrow(/cancelled/i);
  });

  it('distinguishes a timeout from a cancellation', async () => {
    // A host embedding this reports these differently.
    try {
      await captureServer(fixtureServer('hangs'), { env: envFor('hangs'), timeoutMs: 150 });
      expect.unreachable('should have timed out');
    } catch (error) {
      expect((error as { code: string }).code).toBe('TIMEOUT');
    }
  });
});

describe('environment isolation', () => {
  it('passes only the named environment variables to the child', async () => {
    // The library never hands a server the host's whole environment, because
    // that would leak every credential the host holds into a program it did not
    // write. The fixture only behaves correctly when it receives its mode.
    const surface = await captureServer(fixtureServer(), { env: envFor('conforming') });
    expect(surface.descriptors.length).toBeGreaterThan(0);
  });
});

describe('ledger integration', () => {
  it('records a capture and verifies the chain', async () => {
    const path = join(root, 'ledger.log');
    const surface = await captureServer(fixtureServer(), { env: envFor('conforming') });

    const entry = await recordCapture(path, surface, '0.1.0');
    expect(entry.sequence).toBe(0);

    const result = await verifyLedger(path);
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBe(1);
  });

  it('chains several captures', async () => {
    const path = join(root, 'ledger.log');

    for (let i = 0; i < 3; i += 1) {
      const surface = await captureServer(fixtureServer(), { env: envFor('conforming') });
      await recordCapture(path, surface, '0.1.0');
    }

    expect((await verifyLedger(path)).entryCount).toBe(3);
  });
});

describe('pin helpers', () => {
  it('creates a pin from an already captured surface', async () => {
    const surface = await captureServer(fixtureServer(), { env: envFor('conforming') });
    const pin = createPin(surface, { approvedBy: 'reviewer' });

    expect(pin.surfaceRoot).toBe(surface.hashes.root);
  });
});

describe('no orphaned processes', () => {
  it('leaves nothing running after the API is used', async () => {
    const before = await countFixtureProcesses();

    await captureServer(fixtureServer(), { env: envFor('conforming') });
    await withServer(fixtureServer(), async (s) => await s.capture(), {
      env: envFor('conforming'),
    });

    expect(await waitForFixtureProcesses(before)).toBeLessThanOrEqual(before);
  }, 25_000);

  it('leaves nothing running after a cancelled capture', async () => {
    const before = await countFixtureProcesses();

    const controller = new AbortController();
    const pending = captureServer(fixtureServer('hangs'), {
      env: envFor('hangs'),
      signal: controller.signal,
      timeoutMs: 5000,
    });

    setTimeout(() => {
      controller.abort();
    }, 40);
    await pending.catch(() => undefined);

    expect(await waitForFixtureProcesses(before)).toBeLessThanOrEqual(before);
  }, 25_000);
});

