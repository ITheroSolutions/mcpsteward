/**
 * The append-only surface ledger.
 *
 * A tamper evident record of what every server advertised, every time it was
 * captured. This is the durable half of the package: a conformance grade tells you
 * about today, a ledger tells you what was true on the day you approved something
 * and whether it is still true now.
 *
 * ## Format
 *
 * A versioned header line, then one JSON entry per line. Newline delimited so a
 * reader never has to hold the whole file in memory and a truncated write damages
 * exactly one line.
 *
 * Each entry carries the hash of the previous entry, and its own hash is computed
 * over the canonical form of every preceding field including that link. Changing
 * any entry changes its hash, which breaks the link the next entry recorded, and
 * so on to the end. Verification walks the chain and reports the exact sequence
 * number where it breaks.
 *
 * `docs/formats.md` specifies this precisely enough that somebody could write an
 * independent verifier, which matters: a trust format nobody else can check is not
 * a trust format.
 *
 * ## What a hash chain does and does not give you
 *
 * It makes *undetected* modification hard. Someone who edits entry 40 in place
 * must also recompute 41 through the end, and verification catches them if they do
 * not.
 *
 * It does **not** stop a local attacker who can rewrite the file from entry zero.
 * Nothing here is externally anchored or notarised, so a complete forgery by
 * someone with write access verifies cleanly. That is stated plainly in
 * `docs/threat-model.md` rather than hidden behind the words "tamper evident".
 */

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

import { canonicalizeValue, hashCanonicalForm, type ContentHash } from '../core/canonical.js';
import { LedgerCorruptionError, toMcpStewardError } from '../core/errors.js';
import { NOOP_LOGGER, type Logger } from '../core/logger.js';
import type { LedgerEntry, ServerSurface } from '../core/types.js';

/** Format version. Bumping this is a breaking change to every written ledger. */
export const LEDGER_FORMAT_VERSION = 1;

export const LEDGER_MAGIC = 'mcpsteward-ledger';

/**
 * The previous hash recorded by the first entry.
 *
 * A fixed constant rather than an empty string, so that entry zero is bound to
 * this format and this version. A ledger cannot be re-headed by deleting the first
 * entry and presenting the second as the beginning.
 */
export const GENESIS_HASH: ContentHash = hashCanonicalForm(
  `${LEDGER_MAGIC}/v${String(LEDGER_FORMAT_VERSION)}/genesis`,
);

export interface LedgerHeader {
  readonly magic: string;
  readonly version: number;
  readonly createdAt: string;
}

export interface AppendInput {
  readonly surface: ServerSurface;
  readonly toolVersion: string;
  /** Overrides the clock. Only for tests, which need reproducible entries. */
  readonly timestamp?: string;
}

export interface VerifyResult {
  readonly valid: boolean;
  readonly entryCount: number;
  /** The sequence number where integrity failed, when it did. */
  readonly brokenAt?: number;
  readonly reason?: string;
  readonly headRoot?: ContentHash;
  /**
   * The entry hash of the last entry. Together with `entryCount` this identifies
   * the whole chain. Verification cannot tell that trailing entries were cleanly
   * removed, because the shorter chain is still consistent; comparing this value
   * with one recorded earlier, somewhere other than this file, is what can.
   */
  readonly headHash?: ContentHash;
}

/**
 * Fields covered by an entry's hash, in a fixed order.
 *
 * The order is part of the format. Canonicalization sorts object keys, so the
 * literal order here does not affect the hash, but listing them explicitly is what
 * stops a future field being added to the entry without being covered by the hash.
 * A field outside this list is not protected, and that must be a deliberate choice
 * rather than an oversight.
 */
function hashableFields(entry: Omit<LedgerEntry, 'entryHash'>): Record<string, unknown> {
  return {
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    serverId: entry.serverId,
    revisionUsed: entry.revisionUsed,
    transport: entry.transport,
    surfaceRoot: entry.surfaceRoot,
    descriptorHashes: entry.descriptorHashes,
    toolVersion: entry.toolVersion,
    durationMs: entry.durationMs,
    previousHash: entry.previousHash,
  };
}

/** Compute an entry's hash over the canonical form of its preceding fields. */
export function computeEntryHash(entry: Omit<LedgerEntry, 'entryHash'>): ContentHash {
  return hashCanonicalForm(canonicalizeValue(hashableFields(entry)));
}

export interface LedgerOptions {
  readonly logger?: Logger;
}

export class Ledger {
  private readonly logger: Logger;

  constructor(
    private readonly path: string,
    options: LedgerOptions = {},
  ) {
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** Create the ledger file with its header if it does not already exist. */
  async initialize(): Promise<void> {
    if (await this.exists()) return;

    await mkdir(dirname(this.path), { recursive: true });

    const header: LedgerHeader = {
      magic: LEDGER_MAGIC,
      version: LEDGER_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
    };

    // `wx` fails if the file appeared between the check and the write, which is
    // the correct outcome: two processes initialising concurrently must not
    // produce a ledger with two headers.
    const handle = await open(this.path, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(header)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  }

  async exists(): Promise<boolean> {
    try {
      await readFile(this.path, { encoding: 'utf8', flag: 'r' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Append a capture to the chain.
   *
   * The append is a single write of one complete line. A process killed partway
   * through leaves the previous chain intact and, at worst, a trailing partial
   * line that verification reports precisely rather than silently accepting.
   */
  async append(input: AppendInput): Promise<LedgerEntry> {
    await this.initialize();

    const head = await this.readHead();

    const withoutHash: Omit<LedgerEntry, 'entryHash'> = {
      sequence: head === undefined ? 0 : head.sequence + 1,
      timestamp: input.timestamp ?? new Date().toISOString(),
      serverId: input.surface.server.id,
      revisionUsed: input.surface.revisionUsed,
      transport: input.surface.transport,
      surfaceRoot: input.surface.hashes.root,
      descriptorHashes: input.surface.hashes.byDescriptor,
      toolVersion: input.toolVersion,
      durationMs: input.surface.durationMs,
      previousHash: head === undefined ? GENESIS_HASH : head.entryHash,
    };

    const entry: LedgerEntry = { ...withoutHash, entryHash: computeEntryHash(withoutHash) };

    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    this.logger.debug('ledger entry appended', { sequence: entry.sequence });

    return entry;
  }

  /** Read the header, or throw if the file is not a ledger. */
  async readHeader(): Promise<LedgerHeader> {
    const first = await this.firstLine();

    if (first === undefined) {
      throw new LedgerCorruptionError('Ledger file is empty and has no header', {
        details: { path: this.path },
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(first);
    } catch (cause) {
      throw new LedgerCorruptionError('Ledger header is not valid JSON', {
        details: { path: this.path },
        cause,
      });
    }

    const header = parsed as Partial<LedgerHeader>;

    if (header.magic !== LEDGER_MAGIC) {
      throw new LedgerCorruptionError('File is not an mcpsteward ledger', {
        details: { path: this.path },
      });
    }

    if (header.version !== LEDGER_FORMAT_VERSION) {
      throw new LedgerCorruptionError(
        `Ledger format version ${String(header.version)} is not supported by this build, which writes version ${String(LEDGER_FORMAT_VERSION)}`,
        { details: { path: this.path, found: header.version } },
      );
    }

    return header as LedgerHeader;
  }

  /** Read every entry, in order. */
  async readEntries(): Promise<readonly LedgerEntry[]> {
    const entries: LedgerEntry[] = [];

    for await (const { line, index } of this.lines()) {
      if (index === 0) continue;
      if (line.trim().length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new LedgerCorruptionError(
          `Ledger line ${String(index + 1)} is not valid JSON, which usually means a write was interrupted`,
          { details: { path: this.path, line: index + 1 }, cause },
        );
      }

      entries.push(parsed as LedgerEntry);
    }

    return entries;
  }

  /** The most recent entry, or undefined for an empty ledger. */
  async readHead(): Promise<LedgerEntry | undefined> {
    const entries = await this.readEntries();
    return entries.at(-1);
  }

  /** Every entry for one server, oldest first. */
  async readServerHistory(serverId: string): Promise<readonly LedgerEntry[]> {
    return (await this.readEntries()).filter((e) => e.serverId === serverId);
  }

  /**
   * Walk the chain and prove it unbroken.
   *
   * Reports the exact sequence number where integrity fails. "Your ledger is
   * corrupt" is not actionable; "entry 41 does not chain to entry 40" is.
   *
   * Never throws for a corrupt ledger. Corruption is an answer this function
   * exists to give, so it is returned rather than raised. It throws only when the
   * file cannot be read at all.
   */
  async verify(): Promise<VerifyResult> {
    let entries: readonly LedgerEntry[];

    try {
      await this.readHeader();
      entries = await this.readEntries();
    } catch (error) {
      const wrapped = toMcpStewardError(error, 'reading the ledger');
      return { valid: false, entryCount: 0, reason: wrapped.message };
    }

    let previousHash: ContentHash = GENESIS_HASH;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      /* c8 ignore next */
      if (entry === undefined) continue;

      if (!isWellFormed(entry)) {
        return {
          valid: false,
          entryCount: entries.length,
          brokenAt: index,
          reason: `entry at position ${String(index)} is missing required fields`,
        };
      }

      // A gap or a reordering shows up here before any hash is checked, which
      // gives a clearer message than a hash mismatch would.
      if (entry.sequence !== index) {
        return {
          valid: false,
          entryCount: entries.length,
          brokenAt: index,
          reason:
            `entry at position ${String(index)} claims sequence ${String(entry.sequence)}, ` +
            'so an entry has been reordered, removed or inserted',
        };
      }

      if (entry.previousHash !== previousHash) {
        return {
          valid: false,
          entryCount: entries.length,
          brokenAt: entry.sequence,
          reason:
            entry.sequence === 0
              ? 'the first entry does not link to the genesis hash'
              : `entry ${String(entry.sequence)} does not chain to entry ${String(entry.sequence - 1)}`,
        };
      }

      const expected = computeEntryHash(entry);
      if (entry.entryHash !== expected) {
        return {
          valid: false,
          entryCount: entries.length,
          brokenAt: entry.sequence,
          reason: `entry ${String(entry.sequence)} has been modified: its contents do not match its recorded hash`,
        };
      }

      previousHash = entry.entryHash;
    }

    const head = entries.at(-1);

    return {
      valid: true,
      entryCount: entries.length,
      ...(head === undefined ? {} : { headRoot: head.surfaceRoot, headHash: head.entryHash }),
    };
  }

  /**
   * Rewrite the ledger atomically.
   *
   * Writes a temporary file and renames it over the original, because rename is
   * atomic on every platform this package supports. A process killed partway
   * through leaves the original intact rather than a half written ledger.
   *
   * Used only by compaction. Nothing in the normal append path rewrites history.
   */
  private async rewrite(header: LedgerHeader, entries: readonly LedgerEntry[]): Promise<void> {
    const temporary = `${this.path}.tmp`;
    const body = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join('\n');

    await writeFile(temporary, `${body}\n`, 'utf8');
    await rename(temporary, this.path);
  }

  /**
   * Compact the ledger, keeping the most recent entries per server.
   *
   * Compaction re-chains what it keeps, so the result verifies as a valid ledger
   * in its own right. It cannot preserve the link back to the discarded history,
   * which means compaction is an explicit, irreversible loss of provenance rather
   * than a housekeeping detail. It is therefore never automatic.
   *
   * @param keepPerServer how many recent entries to retain for each server.
   */
  async compact(keepPerServer: number): Promise<{ removed: number; kept: number }> {
    if (keepPerServer < 1) {
      throw new LedgerCorruptionError('Compaction must keep at least one entry per server', {
        details: { keepPerServer },
      });
    }

    const header = await this.readHeader();
    const entries = await this.readEntries();

    const byServer = new Map<string, LedgerEntry[]>();
    for (const entry of entries) {
      const list = byServer.get(entry.serverId) ?? [];
      list.push(entry);
      byServer.set(entry.serverId, list);
    }

    const keep = new Set<LedgerEntry>();
    for (const list of byServer.values()) {
      for (const entry of list.slice(-keepPerServer)) keep.add(entry);
    }

    const retained = entries.filter((e) => keep.has(e));

    // Re-chain from genesis. Sequence numbers are reassigned because the format
    // requires them to be contiguous from zero, and a compacted ledger that
    // failed its own verification would be worse than useless.
    let previousHash: ContentHash = GENESIS_HASH;
    const rechained: LedgerEntry[] = [];

    for (let index = 0; index < retained.length; index += 1) {
      const original = retained[index];
      /* c8 ignore next */
      if (original === undefined) continue;

      const withoutHash: Omit<LedgerEntry, 'entryHash'> = {
        ...original,
        sequence: index,
        previousHash,
      };

      const entry: LedgerEntry = { ...withoutHash, entryHash: computeEntryHash(withoutHash) };
      rechained.push(entry);
      previousHash = entry.entryHash;
    }

    await this.rewrite(header, rechained);

    return { removed: entries.length - rechained.length, kept: rechained.length };
  }

  private async firstLine(): Promise<string | undefined> {
    for await (const { line } of this.lines()) return line;
    return undefined;
  }

  private async *lines(): AsyncGenerator<{ line: string; index: number }> {
    const stream = createReadStream(this.path, { encoding: 'utf8' });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });

    let index = 0;
    try {
      for await (const line of reader) {
        yield { line, index };
        index += 1;
      }
    } finally {
      reader.close();
      stream.destroy();
    }
  }
}

/**
 * Check an entry carries every field the format requires.
 *
 * A truncated or hand edited entry frequently parses as JSON but is missing
 * fields, and computing a hash over the remainder would produce a mismatch whose
 * message pointed at the wrong problem.
 */
function isWellFormed(entry: unknown): entry is LedgerEntry {
  if (typeof entry !== 'object' || entry === null) return false;

  const record = entry as Record<string, unknown>;

  return (
    typeof record['sequence'] === 'number' &&
    typeof record['timestamp'] === 'string' &&
    typeof record['serverId'] === 'string' &&
    typeof record['surfaceRoot'] === 'string' &&
    typeof record['previousHash'] === 'string' &&
    typeof record['entryHash'] === 'string' &&
    typeof record['toolVersion'] === 'string' &&
    typeof record['descriptorHashes'] === 'object' &&
    record['descriptorHashes'] !== null
  );
}
