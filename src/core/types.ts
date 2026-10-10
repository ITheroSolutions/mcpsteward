/**
 * The domain model.
 *
 * Where a rule can be enforced by the type system rather than by review, it is.
 * Two invariants matter enough to call out:
 *
 * - A {@link ConformanceRule} cannot be constructed without a `citation`. A tool
 *   that invents plausible requirements is worse than one with fewer rules, so the
 *   compiler holds that line rather than a code review.
 * - {@link DriftKind} is a closed union, and the classifier's default branch
 *   asserts `never`. Adding a classification without handling it everywhere becomes
 *   a compile error rather than a silently unclassified change.
 */

import type { ContentHash } from './canonical.js';
import type { JsonObject } from './json-parse.js';
import type { ProtocolRevision } from './revisions.js';

// ---------------------------------------------------------------------------
// Servers and transports
// ---------------------------------------------------------------------------

export type TransportKind = 'stdio' | 'http';

/**
 * How a server authenticates, as far as discovery can tell without connecting.
 *
 * `inline` is a finding in itself: a credential written directly into a client
 * configuration file is one `git add` away from being published.
 */
export type AuthPosture = 'none' | 'env' | 'inline' | 'oauth' | 'unknown';

/** A stdio server: a command this machine would spawn. */
export interface StdioServerRef {
  readonly transport: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Environment variable *names* only.
   *
   * Values are deliberately absent from this type. A `ServerRef` is rendered into
   * reports and inventories, and carrying values would put a credential one
   * careless interpolation away from a report. Values live only in the spawn call.
   */
  readonly envNames: readonly string[];
  readonly cwd?: string;
}

/** An HTTP server: an endpoint this machine would POST to. */
export interface HttpServerRef {
  readonly transport: 'http';
  readonly url: string;
  /** Header names only, for the same reason as {@link StdioServerRef.envNames}. */
  readonly headerNames: readonly string[];
}

export type ServerEndpoint = StdioServerRef | HttpServerRef;

/**
 * A server as configured on this machine.
 *
 * `id` is the stable identity used for pins and ledger entries. The same server
 * registered in four clients is one `ServerRef` with four {@link RegistrationSite}
 * entries, not four servers.
 */
export interface ServerRef {
  readonly id: string;
  readonly name: string;
  readonly endpoint: ServerEndpoint;
  readonly authPosture: AuthPosture;
  readonly registrations: readonly RegistrationSite[];
}

/** One place a server was found configured. */
export interface RegistrationSite {
  /** Client identifier, for example `claude-desktop` or `vscode`. */
  readonly client: string;
  /** Absolute path to the configuration file it was found in. */
  readonly configPath: string;
  /** Whether this registration carried a credential inline. */
  readonly hasInlineCredential: boolean;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export type DescriptorCategory = 'tool' | 'prompt' | 'resource' | 'resourceTemplate';

export const DESCRIPTOR_CATEGORIES = [
  'tool',
  'prompt',
  'resource',
  'resourceTemplate',
] as const satisfies readonly DescriptorCategory[];

/**
 * One advertised item from a server's surface.
 *
 * `identity` and `hash` are deliberately separate, and the distinction is what
 * makes drift detection useful. Identity answers "which tool is this", content
 * hash answers "has it changed". Without the split, a tool whose description was
 * edited would read as a removal plus an addition, which hides the single most
 * important signal this package looks for: a description that changed after you
 * approved it.
 */
export interface Descriptor {
  readonly category: DescriptorCategory;
  /** Stable identity within its category. The tool name, or the resource URI. */
  readonly identity: string;
  /** The parsed value, with number tokens preserved. */
  readonly value: JsonObject;
  /** Canonical JSON text of {@link value}. */
  readonly canonical: string;
  /** SHA-256 over {@link canonical}. */
  readonly hash: ContentHash;
}

/** The three hash levels over a surface. */
export interface SurfaceHashes {
  /** Merkle root over every category root. Changes when anything changes. */
  readonly root: ContentHash;
  /** One merkle root per category, so a diff can skip untouched categories. */
  readonly byCategory: Readonly<Partial<Record<DescriptorCategory, ContentHash>>>;
  /** Content hash per descriptor, keyed by `category + identity`. */
  readonly byDescriptor: Readonly<Record<string, ContentHash>>;
}

/**
 * What a server advertised at one moment.
 *
 * `revisionUsed` records the revision the capture actually spoke, which is not
 * necessarily the newest one attempted. A downgraded capture is never presented as
 * a current one.
 */
export interface ServerSurface {
  readonly server: ServerRef;
  readonly revisionUsed: ProtocolRevision;
  readonly revisionRequested: ProtocolRevision;
  readonly transport: TransportKind;
  /** ISO 8601, always UTC. */
  readonly capturedAt: string;
  readonly capabilities: JsonObject | undefined;
  readonly serverInfo: JsonObject | undefined;
  readonly descriptors: readonly Descriptor[];
  readonly hashes: SurfaceHashes;
  /** Wall clock duration of the capture, in milliseconds. */
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Conformance
// ---------------------------------------------------------------------------

export type NormativeLevel = 'MUST' | 'MUST NOT' | 'SHOULD' | 'SHOULD NOT' | 'MAY';

export type RuleCategory =
  | 'transport'
  | 'lifecycle'
  | 'discovery'
  | 'tools'
  | 'prompts'
  | 'resources'
  | 'errors'
  | 'schema'
  | 'caching'
  | 'authorization'
  | 'extensions';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * How well grounded a rule is.
 *
 * `VERIFIED` means the requirement was read in fetched specification text and the
 * citation names where. `UNVERIFIED` means it is plausible but ungrounded: it
 * reports, is listed in `VERIFY.md`, and never affects the graded score.
 */
export type RuleConfidence = 'VERIFIED' | 'UNVERIFIED';

/**
 * A citation into the specification.
 *
 * Required on every rule, by the type system. This is the invariant that keeps the
 * package honest: a rule that cannot say where its requirement comes from does not
 * compile.
 */
export interface SpecCitation {
  /** For example `basic/transports/streamable-http#server-validation`. */
  readonly section: string;
  /** For example `SEP-2243`. Absent when the requirement predates the SEP process. */
  readonly sep?: string;
  /** The requirement in the specification's own words, where short enough to quote. */
  readonly quote?: string;
}

export interface ConformanceRule {
  /** Stable, never reused or renumbered. For example `MS-CACHE-002`. */
  readonly id: string;
  readonly title: string;
  readonly applicableRevisions: readonly ProtocolRevision[];
  readonly severity: Severity;
  readonly category: RuleCategory;
  readonly level: NormativeLevel;
  /** The requirement in one sentence. */
  readonly requirement: string;
  readonly citation: SpecCitation;
  readonly confidence: RuleConfidence;
  /** Written for the developer who has to fix it. */
  readonly remediation: string;
}

export type RuleOutcome = 'pass' | 'fail' | 'not-applicable' | 'inconclusive';

export interface RuleResult {
  readonly ruleId: string;
  readonly outcome: RuleOutcome;
  /** Why, in terms a developer can act on. Redacted. */
  readonly detail: string;
  /** Where in the surface the problem is, when it can be localised. */
  readonly locus?: string;
  readonly evidence?: JsonObject;
}

export type GradeLetter = 'A' | 'B' | 'C' | 'D' | 'F';

export interface Grade {
  /**
   * `not-graded` when there is nothing honest to grade: the server speaks a
   * revision other than the graded one, or no rule produced a result. In that
   * case `letter` and `score` are null rather than a number, because an empty
   * rule set scored as 100 out of 100 is an A the server did not earn, and a
   * CI gate reading the letter would pass it.
   */
  readonly status: 'graded' | 'not-graded';
  /** Why the server was not graded. Present only when `status` is `not-graded`. */
  readonly reason?: string;
  readonly letter: GradeLetter | null;
  /** Zero to one hundred, or null when not graded. */
  readonly score: number | null;
  readonly mustPassed: number;
  readonly mustFailed: number;
  readonly shouldPassed: number;
  readonly shouldFailed: number;
  /** Rules that reported but were excluded from the score. */
  readonly unverifiedReported: number;
  readonly notApplicable: number;
}

export interface Finding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  readonly remediation: string;
  readonly citation: SpecCitation;
  readonly confidence: RuleConfidence;
  readonly locus?: string;
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/**
 * Every way a surface can differ from its pin.
 *
 * A closed union on purpose. The classifier's default branch asserts `never`, so
 * adding a member here without handling it everywhere is a compile error rather
 * than a change that quietly classifies as nothing.
 */
export type DriftKind =
  | 'descriptor-added'
  | 'descriptor-removed'
  | 'description-changed'
  | 'input-schema-widened'
  | 'input-schema-narrowed'
  | 'input-schema-changed-incompatibly'
  /** The schema changed, and a pin cannot say in which direction. */
  | 'input-schema-changed'
  /** Something other than the description or schema changed, such as title or annotations. */
  | 'metadata-changed'
  /** Changed, compared against a pin too old to say which part. */
  | 'descriptor-changed'
  | 'required-parameter-added'
  | 'name-collision'
  | 'revision-changed';

export const DRIFT_KINDS = [
  'descriptor-added',
  'descriptor-removed',
  'description-changed',
  'input-schema-widened',
  'input-schema-narrowed',
  'input-schema-changed-incompatibly',
  'input-schema-changed',
  'metadata-changed',
  'descriptor-changed',
  'required-parameter-added',
  'name-collision',
  'revision-changed',
] as const satisfies readonly DriftKind[];

export type RiskTier = 'critical' | 'high' | 'medium' | 'low';

export interface DriftEvent {
  readonly kind: DriftKind;
  readonly category: DescriptorCategory;
  readonly identity: string;
  /** Human readable summary. Redacted. */
  readonly summary: string;
  readonly before?: ContentHash;
  readonly after?: ContentHash;
  /**
   * Heuristic risk, never a guarantee.
   *
   * Weights are configurable and the heuristic is documented in full. This is
   * labelled a heuristic everywhere it is rendered, because presenting a score as
   * a security guarantee would be the most damaging thing this package could do.
   */
  readonly risk: RiskTier;
  readonly riskFactors: readonly string[];
}

export interface DriftReport {
  readonly server: ServerRef;
  readonly pinnedAt: string;
  readonly comparedAt: string;
  readonly pinnedRoot: ContentHash;
  readonly currentRoot: ContentHash;
  readonly events: readonly DriftEvent[];
  readonly unchanged: number;
}

// ---------------------------------------------------------------------------
// Ledger and pins
// ---------------------------------------------------------------------------

/**
 * One append-only ledger entry.
 *
 * `entryHash` is computed over the canonical form of every preceding field
 * including `previousHash`, which is what chains the log. `docs/formats.md`
 * specifies this precisely enough for an independent verifier, because a trust
 * format nobody else can check is not a trust format.
 */
export interface LedgerEntry {
  /** Monotonic, starting at zero, no gaps. */
  readonly sequence: number;
  /** ISO 8601, always UTC. */
  readonly timestamp: string;
  readonly serverId: string;
  readonly revisionUsed: ProtocolRevision;
  readonly transport: TransportKind;
  readonly surfaceRoot: ContentHash;
  readonly descriptorHashes: Readonly<Record<string, ContentHash>>;
  /** Version of mcpsteward that wrote the entry. */
  readonly toolVersion: string;
  readonly durationMs: number;
  /** The previous entry's `entryHash`, or the genesis constant for sequence zero. */
  readonly previousHash: ContentHash;
  /** Hash over the canonical form of every field above. */
  readonly entryHash: ContentHash;
}

/** An approved baseline for a server's surface. */
/** Hashes of the parts of one descriptor. See docs/formats.md section 6. */
export interface DescriptorFieldHashes {
  /** The `description` string. Absent when the descriptor has none. */
  readonly description?: ContentHash;
  /** `inputSchema` for a tool, `arguments` for a prompt. Absent otherwise. */
  readonly input?: ContentHash;
  /** Every other field, with those two removed. */
  readonly rest: ContentHash;
}

export interface TrustPin {
  readonly serverId: string;
  readonly surfaceRoot: ContentHash;
  readonly descriptorHashes: Readonly<Record<string, ContentHash>>;
  /**
   * Per descriptor, a hash of each part separately, so a later diff can say which
   * part changed without the pin storing any content. Absent in pins written
   * before it existed; see docs/formats.md section 6.
   */
  readonly fieldHashes?: Readonly<Record<string, DescriptorFieldHashes>>;
  readonly revisionUsed: ProtocolRevision;
  /** ISO 8601, always UTC. */
  readonly approvedAt: string;
  /** Who approved it. Free text, self reported, never used as a security control. */
  readonly approvedBy: string;
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface Policy {
  readonly version: 1;
  readonly allowServers?: readonly string[];
  readonly denyServers?: readonly string[];
  readonly requiredAuthPosture?: readonly AuthPosture[];
  readonly minimumGrade?: GradeLetter;
  readonly maximumDriftRisk?: RiskTier;
  readonly allowUnpinnedServers?: boolean;
  readonly failOnInlineCredentials?: boolean;
}

export type PolicyViolationKind =
  | 'server-denied'
  | 'server-not-allowlisted'
  | 'auth-posture-forbidden'
  | 'grade-below-minimum'
  | 'drift-risk-exceeded'
  | 'server-unpinned'
  | 'inline-credential';

export interface PolicyViolation {
  readonly kind: PolicyViolationKind;
  readonly serverId: string;
  /** What is wrong and what to do about it. Redacted. */
  readonly detail: string;
  readonly severity: Severity;
}

/**
 * Assert a value is `never`.
 *
 * Used in the default branch of every exhaustive switch over a closed union. When
 * a union gains a member and a switch is not updated, this fails to compile at the
 * call site rather than throwing at runtime in front of a user.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
