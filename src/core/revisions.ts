/**
 * Protocol revision identifiers and era classification.
 *
 * Every claim in this module is grounded in SPEC-NOTES.md. The era terminology is
 * the specification's own, defined in Versioning and Compatibility: a *modern*
 * revision carries version, identity and capabilities as per request metadata; a
 * *legacy* revision establishes a session with an `initialize` handshake.
 */

/** Revisions this package can speak. Ordered newest first. */
export const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25'] as const;

export type ProtocolRevision = (typeof SUPPORTED_REVISIONS)[number];

/**
 * The revision mcpsteward grades against. Capture works on every supported
 * revision; conformance grading targets this one only. See DECISIONS.md D-003.
 */
export const TARGET_REVISION = '2026-07-28' satisfies ProtocolRevision;

/**
 * Protocol era.
 *
 * `modern` revisions are stateless and carry `_meta` on every request.
 * `legacy` revisions require the `initialize` handshake removed by SEP-2575.
 */
export type ProtocolEra = 'modern' | 'legacy';

const ERA_BY_REVISION: Readonly<Record<ProtocolRevision, ProtocolEra>> = {
  '2026-07-28': 'modern',
  '2025-11-25': 'legacy',
};

/**
 * Revisions known to the specification but not implemented here. Recognising them
 * lets mcpsteward report "this server speaks a revision I do not grade" rather than
 * the less useful "unknown revision".
 *
 * Sourced from the changelog's compatibility discussion and the transport page's
 * backward compatibility section, both of which name these revisions explicitly.
 */
export const KNOWN_UNSUPPORTED_REVISIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export type KnownRevision = ProtocolRevision | (typeof KNOWN_UNSUPPORTED_REVISIONS)[number];

export function isSupportedRevision(value: string): value is ProtocolRevision {
  return (SUPPORTED_REVISIONS as readonly string[]).includes(value);
}

export function isKnownRevision(value: string): value is KnownRevision {
  return (
    isSupportedRevision(value) ||
    (KNOWN_UNSUPPORTED_REVISIONS as readonly string[]).includes(value)
  );
}

export function eraOf(revision: ProtocolRevision): ProtocolEra {
  return ERA_BY_REVISION[revision];
}

/**
 * True when the revision predates the stateless rewrite and therefore requires the
 * `initialize` handshake. Kept separate from {@link eraOf} because call sites read
 * better asking the question they actually mean.
 */
export function requiresInitializeHandshake(revision: ProtocolRevision): boolean {
  return eraOf(revision) === 'legacy';
}

/**
 * Compare two revisions by their date shaped identifiers.
 *
 * Revision identifiers are `YYYY-MM-DD` strings, which sort lexicographically in
 * chronological order. This is a property of the specification's own naming scheme
 * rather than an assumption about dates, so plain string comparison is correct and
 * no date parsing is involved.
 *
 * @returns negative when `a` is older than `b`, zero when equal, positive when newer.
 */
export function compareRevisions(a: KnownRevision, b: KnownRevision): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Pick the newest revision this package supports from a server's advertised list,
 * as returned in `DiscoverResult.supportedVersions` or in the `data.supported`
 * field of an `UnsupportedProtocolVersionError` (`-32022`).
 *
 * @returns the newest mutually supported revision, or `undefined` when there is no
 * overlap. `undefined` is the caller's signal to report an incompatible server
 * rather than to silently downgrade.
 */
export function selectBestRevision(
  serverSupported: readonly string[],
): ProtocolRevision | undefined {
  let best: ProtocolRevision | undefined;

  for (const candidate of serverSupported) {
    if (!isSupportedRevision(candidate)) continue;
    if (best === undefined || compareRevisions(candidate, best) > 0) {
      best = candidate;
    }
  }

  return best;
}
