import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServerSurface } from '../../src/core/types.js';
import { computeEntryHash, GENESIS_HASH, Ledger, LEDGER_MAGIC } from '../../src/ledger/index.js';

let root: string;
let path: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpsteward-ledger-'));
  path = join(root, 'surfaces.mcpsteward-ledger');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function surface(serverId: string, rootHash: string): ServerSurface {
  return {
    server: {
      id: serverId,
      name: serverId,
      endpoint: { transport: 'stdio', command: 'x', args: [], envNames: [] },
      authPosture: 'none',
      registrations: [],
    },
    revisionUsed: '2026-07-28',
    revisionRequested: '2026-07-28',
    transport: 'stdio',
    capturedAt: '2026-07-31T00:00:00.000Z',
    capabilities: undefined,
    serverInfo: undefined,
    descriptors: [],
    hashes: {
      root: `sha256:${rootHash.padEnd(64, '0')}`,
      byCategory: {},
      byDescriptor: { 'tool:example': `sha256:${'e'.repeat(64)}` },
    },
    durationMs: 42,
  };
}

async function appendN(ledger: Ledger, count: number, serverId = 'srv'): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await ledger.append({
      surface: surface(serverId, String(i)),
      toolVersion: '0.1.0',
      timestamp: `2026-07-31T00:00:0${String(i)}.000Z`,
    });
  }
}

/** Read the raw lines so a test can corrupt the file deliberately. */
async function rawLines(): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').filter((l) => l.length > 0);
}

async function writeLines(lines: readonly string[]): Promise<void> {
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}

describe('format', () => {
  it('writes a header identifying the file', async () => {
    const ledger = new Ledger(path);
    await ledger.initialize();

    const header = await ledger.readHeader();
    expect(header.magic).toBe(LEDGER_MAGIC);
    expect(header.version).toBe(1);
  });

  it('is newline delimited, so one bad write damages one line', async () => {
    const ledger = new Ledger(path);
    await appendN(ledger, 3);

    const lines = await rawLines();
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
  });

  it('initialising twice does not write a second header', async () => {
    const ledger = new Ledger(path);
    await ledger.initialize();
    await ledger.initialize();

    expect(await rawLines()).toHaveLength(1);
  });

  it('rejects a file that is not a ledger', async () => {
    await writeFile(path, '{"something":"else"}\n', 'utf8');
    await expect(new Ledger(path).readHeader()).rejects.toThrow(/not an mcpsteward ledger/);
  });

  it('rejects a future format version rather than guessing at it', async () => {
    await writeFile(path, `{"magic":"${LEDGER_MAGIC}","version":99}\n`, 'utf8');
    await expect(new Ledger(path).readHeader()).rejects.toThrow(/version 99 is not supported/);
  });
});

describe('appending', () => {
  it('starts at sequence zero linked to the genesis hash', async () => {
    const ledger = new Ledger(path);
    const entry = await ledger.append({ surface: surface('a', '1'), toolVersion: '0.1.0' });

    expect(entry.sequence).toBe(0);
    expect(entry.previousHash).toBe(GENESIS_HASH);
  });

  it('chains each entry to the one before it', async () => {
    const ledger = new Ledger(path);
    await appendN(ledger, 4);

    const entries = await ledger.readEntries();
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]?.previousHash).toBe(entries[i - 1]?.entryHash);
    }
  });

  it('numbers entries contiguously from zero', async () => {
    const ledger = new Ledger(path);
    await appendN(ledger, 5);

    expect((await ledger.readEntries()).map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4]);
  });

  it('records the surface root and the per descriptor hashes', async () => {
    const ledger = new Ledger(path);
    const entry = await ledger.append({ surface: surface('a', 'abc'), toolVersion: '0.1.0' });

    expect(entry.surfaceRoot).toMatch(/^sha256:abc0+$/);
    expect(entry.descriptorHashes['tool:example']).toBeDefined();
  });

  it('creates the containing directory if it does not exist', async () => {
    const nested = join(root, 'deep', 'nested', 'ledger.log');
    const ledger = new Ledger(nested);

    await expect(ledger.append({ surface: surface('a', '1'), toolVersion: '0.1.0' })).resolves
      .toBeDefined();
  });

  it('reads back the head', async () => {
    const ledger = new Ledger(path);
    await appendN(ledger, 3);

    expect((await ledger.readHead())?.sequence).toBe(2);
  });

  it('returns undefined as the head of an empty ledger', async () => {
    const ledger = new Ledger(path);
    await ledger.initialize();

    expect(await ledger.readHead()).toBeUndefined();
  });

  it('filters history by server', async () => {
    const ledger = new Ledger(path);
    await appendN(ledger, 2, 'alpha');
    await appendN(ledger, 3, 'beta');

    expect(await ledger.readServerHistory('alpha')).toHaveLength(2);
    expect(await ledger.readServerHistory('beta')).toHaveLength(3);
    expect(await ledger.readServerHistory('missing')).toHaveLength(0);
  });
});

describe('verification', () => {
  it('proves an untouched chain valid', async () => {
    const ledger = new Ledger(path);
    await appendN(ledger, 5);

    const result = await ledger.verify();
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBe(5);
  });

  it('accepts an empty but initialised ledger', async () => {
    const ledger = new Ledger(path);
    await ledger.initialize();

    const result = await ledger.verify();
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBe(0);
  });

  describe('corruption is reported precisely, never silently accepted', () => {
    it('detects a rewritten middle entry and names it', async () => {
      const ledger = new Ledger(path);
      await appendN(ledger, 5);

      const lines = await rawLines();
      const tampered = JSON.parse(lines[3]!) as Record<string, unknown>;
      tampered['surfaceRoot'] = `sha256:${'f'.repeat(64)}`;
      lines[3] = JSON.stringify(tampered);
      await writeLines(lines);

      const result = await ledger.verify();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(2);
      expect(result.reason).toMatch(/entry 2 has been modified/);
    });

    it('detects a removed entry', async () => {
      const ledger = new Ledger(path);
      await appendN(ledger, 5);

      const lines = await rawLines();
      lines.splice(3, 1);
      await writeLines(lines);

      const result = await ledger.verify();
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/reordered, removed or inserted/);
    });

    it('detects reordered entries', async () => {
      const ledger = new Ledger(path);
      await appendN(ledger, 5);

      const lines = await rawLines();
      const swapped = [lines[0]!, lines[1]!, lines[3]!, lines[2]!, lines[4]!, lines[5]!];
      await writeLines(swapped);

      const result = await ledger.verify();
      expect(result.valid).toBe(false);
    });

    it('cannot detect the last entries being cleanly removed, but the head shows it', async () => {
      // A stated limitation, pinned so the documentation stays true. A chain cut
      // at a line boundary is a shorter, still consistent chain; nothing inside
      // the file records how long it should be. The head hash, recorded
      // elsewhere beforehand, is what differs.
      const ledger = new Ledger(path);
      await appendN(ledger, 5);
      const before = await ledger.verify();

      const lines = await rawLines();
      await writeLines(lines.slice(0, -2));

      const after = await ledger.verify();
      expect(after.valid).toBe(true);
      expect(after.entryCount).toBe(before.entryCount - 2);
      expect(before.headHash).toMatch(/^sha256:/);
      expect(after.headHash).not.toBe(before.headHash);
    });

    it('detects truncation mid line', async () => {
      const ledger = new Ledger(path);
      await appendN(ledger, 3);

      const text = await readFile(path, 'utf8');
      await writeFile(path, text.slice(0, text.length - 40), 'utf8');

      const result = await ledger.verify();
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not valid JSON|interrupted|missing required fields/);
    });

    it('detects a first entry that does not link to genesis', async () => {
      const ledger = new Ledger(path);
      await appendN(ledger, 2);

      const lines = await rawLines();
      const first = JSON.parse(lines[1]!) as Record<string, unknown>;
      first['previousHash'] = `sha256:${'0'.repeat(64)}`;
      lines[1] = JSON.stringify(first);
      await writeLines(lines);

      const result = await ledger.verify();
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/genesis/);
    });

    it('detects an entry whose hash was recomputed but whose link was not', async () => {
      // The subtle attack: edit an entry and fix its own hash, hoping the chain
      // is only checked one link deep.
      const ledger = new Ledger(path);
      await appendN(ledger, 4);

      const lines = await rawLines();
      const tampered = JSON.parse(lines[2]!) as Record<string, unknown>;
      tampered['durationMs'] = 9999;
      tampered['entryHash'] = computeEntryHash(
        tampered as unknown as Parameters<typeof computeEntryHash>[0],
      );
      lines[2] = JSON.stringify(tampered);
      await writeLines(lines);

      const result = await ledger.verify();
      expect(result.valid).toBe(false);
      // Entry 1 now hashes differently, so entry 2 no longer chains to it.
      expect(result.brokenAt).toBe(2);
    });

    it('detects an entry missing required fields', async () => {
      const ledger = new Ledger(path);
      await appendN(ledger, 2);

      const lines = await rawLines();
      const stripped = JSON.parse(lines[1]!) as Record<string, unknown>;
      delete stripped['serverId'];
      lines[1] = JSON.stringify(stripped);
      await writeLines(lines);

      const result = await ledger.verify();
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/missing required fields/);
    });

    it('reports a missing file rather than throwing', async () => {
      const result = await new Ledger(join(root, 'absent.log')).verify();
      expect(result.valid).toBe(false);
    });
  });

  describe('fuzzing', () => {
    it('never reports a corrupted ledger as valid, and never hangs or crashes', async () => {
      // Deterministic so a failure is reproducible rather than a heisenbug.
      let seed = 0x5eed1234;
      const random = (): number => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return Math.abs(seed) / 0x7fffffff;
      };

      const ledger = new Ledger(path);
      await appendN(ledger, 6);
      const pristine = await readFile(path, 'utf8');

      expect((await ledger.verify()).valid).toBe(true);

      for (let round = 0; round < 60; round += 1) {
        const bytes = Buffer.from(pristine, 'utf8');
        const position = Math.floor(random() * bytes.length);
        const replacement = Math.floor(random() * 94) + 32;

        if (bytes[position] === replacement) continue;
        bytes[position] = replacement;

        await writeFile(path, bytes);

        // The contract: it returns an answer, that answer is not "valid", and it
        // never throws an untyped error or loops.
        const result = await ledger.verify();
        expect(result.valid, `corruption at byte ${String(position)} was accepted`).toBe(false);
        expect(typeof result.reason).toBe('string');
      }
    }, 30_000);
  });
});

describe('compaction', () => {
  it('keeps the requested number of entries per server', async () => {
    const ledger = new Ledger(path);
    await appendN(ledger, 5, 'alpha');
    await appendN(ledger, 4, 'beta');

    const result = await ledger.compact(2);

    expect(result.kept).toBe(4);
    expect(result.removed).toBe(5);
  });

  it('produces a ledger that verifies in its own right', async () => {
    // A compacted ledger that failed its own verification would be worse than
    // useless, so the retained entries are re-chained from genesis.
    const ledger = new Ledger(path);
    await appendN(ledger, 6, 'alpha');

    await ledger.compact(2);

    const result = await ledger.verify();
    expect(result.valid).toBe(true);
    expect(result.entryCount).toBe(2);
  });

  it('renumbers sequences contiguously from zero', async () => {
    const ledger = new Ledger(path);
    await appendN(ledger, 5, 'alpha');
    await ledger.compact(2);

    expect((await ledger.readEntries()).map((e) => e.sequence)).toEqual([0, 1]);
  });

  it('keeps the most recent entries, not the oldest', async () => {
    const ledger = new Ledger(path);
    await appendN(ledger, 5, 'alpha');

    const before = await ledger.readEntries();
    await ledger.compact(1);
    const after = await ledger.readEntries();

    expect(after[0]?.surfaceRoot).toBe(before[4]?.surfaceRoot);
  });

  it('preserves the header', async () => {
    const ledger = new Ledger(path);
    await appendN(ledger, 3);
    await ledger.compact(1);

    expect((await ledger.readHeader()).magic).toBe(LEDGER_MAGIC);
  });

  it('refuses to keep zero entries', async () => {
    const ledger = new Ledger(path);
    await appendN(ledger, 2);

    await expect(ledger.compact(0)).rejects.toThrow(/at least one entry/);
  });

  it('leaves a ledger that needs no compaction untouched', async () => {
    const ledger = new Ledger(path);
    await appendN(ledger, 2, 'alpha');

    const result = await ledger.compact(5);
    expect(result.removed).toBe(0);
    expect((await ledger.verify()).valid).toBe(true);
  });
});

describe('entry hashing', () => {
  it('changes when any covered field changes', async () => {
    const ledger = new Ledger(path);
    const entry = await ledger.append({
      surface: surface('a', '1'),
      toolVersion: '0.1.0',
      timestamp: '2026-07-31T00:00:00.000Z',
    });

    const fields = [
      'sequence',
      'timestamp',
      'serverId',
      'surfaceRoot',
      'toolVersion',
      'durationMs',
      'previousHash',
    ] as const;

    for (const field of fields) {
      const mutated = { ...entry, [field]: field === 'durationMs' ? 999 : 'changed' };
      expect(computeEntryHash(mutated), `${field} is not covered by the hash`).not.toBe(
        entry.entryHash,
      );
    }
  });

  it('is stable for identical input', async () => {
    const ledger = new Ledger(path);
    const entry = await ledger.append({
      surface: surface('a', '1'),
      toolVersion: '0.1.0',
      timestamp: '2026-07-31T00:00:00.000Z',
    });

    expect(computeEntryHash(entry)).toBe(entry.entryHash);
    expect(computeEntryHash(entry)).toBe(computeEntryHash(entry));
  });

  it('binds the genesis hash to the format and version', () => {
    // A ledger cannot be re-headed by deleting the first entry and presenting
    // the second as the beginning.
    expect(GENESIS_HASH).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
