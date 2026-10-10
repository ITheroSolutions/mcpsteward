/**
 * Trust pins and drift detection.
 *
 * A pin records the surface you approved. A diff compares a fresh capture against
 * it and classifies every difference. This is the question the package exists to
 * answer: has this server changed since you said yes to it?
 *
 * ## Why the classification matters more than the hash
 *
 * A changed root hash tells you something moved. It does not tell you whether a
 * tool gained a harmless optional field or whether its description was rewritten
 * to instruct the model to exfiltrate your files. Those need different responses,
 * so every difference is classified rather than merely counted.
 *
 * The single highest signal event is a description change on an already approved
 * tool. That is how tool poisoning presents: the name stays, the schema stays, the
 * text the model actually reads is replaced. Descriptor identity is kept separate
 * from content hash precisely so this reads as a modification rather than as a
 * removal plus an addition.
 *
 * A changed description is not by itself proof of anything, though. Legitimate
 * servers reword their tools on every release, and rating every such change
 * critical made one routine upgrade of a real server produce seventeen critical
 * alarms. Critical is reserved for a change whose text carries a sign of
 * poisoning; see markers.ts.
 *
 * ## The risk score is a heuristic and is labelled as one everywhere
 *
 * Weights are documented in full and every one is configurable. The score orders a
 * reviewer's attention. It is not a security guarantee and must never be rendered
 * as one.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { canonicalizeJsonValue, hashCanonicalForm, type ContentHash } from '../core/canonical.js';
import { readDescription, readInputSchema, readRequiredParameters, readSchemaProperties } from '../core/descriptor.js';
import { DiscoveryError, toMcpStewardError } from '../core/errors.js';
import { descriptorKey } from '../core/merkle.js';
import { redact } from '../core/redaction.js';
import type { JsonValue } from '../core/json-parse.js';
import { findPoisoningMarkers } from './markers.js';
import {
  assertNever,
  type Descriptor,
  type DescriptorFieldHashes,
  type DescriptorCategory,
  type DriftEvent,
  type DriftKind,
  type DriftReport,
  type RiskTier,
  type ServerSurface,
  type TrustPin,
} from '../core/types.js';

/**
 * Base risk per classification, before capability weighting.
 *
 * Every number here is a judgement, not a measurement. They are exposed so a user
 * who disagrees can change them rather than being told their disagreement is wrong.
 */
export interface RiskWeights {
  readonly kind: Readonly<Record<DriftKind, number>>;
  /**
   * Multiplier applied when a tool's schema or description suggests it touches
   * something consequential.
   */
  readonly sensitiveCapability: number;
  /** Score at or above which an event is critical, high, or medium. */
  readonly thresholds: { readonly critical: number; readonly high: number; readonly medium: number };
}

export const DEFAULT_RISK_WEIGHTS: RiskWeights = {
  kind: {
    // A new tool appearing on an approved server is the classic supply chain
    // move: you reviewed three tools, now there are four.
    'descriptor-added': 6,

    // Removal is disruptive but not usually an attack. It breaks callers rather
    // than deceiving them.
    'descriptor-removed': 3,

    // The text the model reads was replaced. How tool poisoning presents, but
    // also how every legitimate release presents, so on its own it is medium,
    // high on a tool that touches the filesystem, network or shell, and critical
    // only when the new text carries a sign of poisoning.
    'description-changed': 4,

    // Accepting more input than before. Lower risk on its own, but it is how a
    // benign looking tool grows an exfiltration path.
    'input-schema-widened': 4,

    // Accepting less. Usually a bug fix or a tightening.
    'input-schema-narrowed': 2,

    // Neither purely wider nor narrower. Something was restructured.
    'input-schema-changed-incompatibly': 6,

    // Changed, but a comparison against a pin cannot say in which direction.
    'input-schema-changed': 4,

    // Title, annotations, or another field the model is less likely to act on.
    'metadata-changed': 2,

    // Changed, against a pin too old to say which part. Weighted like a
    // description change, since it might be one.
    'descriptor-changed': 4,

    // A new mandatory parameter changes what every existing caller must send.
    'required-parameter-added': 5,

    // Two servers advertising confusingly similar tool names is how a model gets
    // steered to the wrong one.
    'name-collision': 7,

    // The server is speaking a different protocol revision than when approved.
    'revision-changed': 4,
  },
  sensitiveCapability: 1.75,
  thresholds: { critical: 12, high: 7, medium: 4 },
};

/**
 * Signals that a tool touches something worth being careful about.
 *
 * Deliberately crude and deliberately visible. This is pattern matching on names
 * and descriptions, which is exactly the kind of heuristic that is wrong in both
 * directions: a tool called `run_query` may be read only, and a tool called
 * `get_helper` may shell out. It raises attention; it does not make a judgement.
 */
const SENSITIVE_SIGNALS = [
  'file',
  'path',
  'directory',
  'read',
  'write',
  'delete',
  'exec',
  'shell',
  'command',
  'spawn',
  'process',
  'http',
  'fetch',
  'request',
  'url',
  'network',
  'token',
  'secret',
  'credential',
  'password',
  'key',
  'auth',
  'env',
  'sql',
  'query',
  'database',
];

export interface PinOptions {
  /** Who approved it. Self reported, never used as a security control. */
  readonly approvedBy: string;
  readonly note?: string;
  /** Overrides the clock, for reproducible tests. */
  readonly approvedAt?: string;
}

/** Create a pin from a captured surface. */
export function createPin(surface: ServerSurface, options: PinOptions): TrustPin {
  return {
    serverId: surface.server.id,
    surfaceRoot: surface.hashes.root,
    descriptorHashes: surface.hashes.byDescriptor,
    fieldHashes: Object.fromEntries(
      surface.descriptors.map((descriptor) => [
        descriptorKey(descriptor.category, descriptor.identity),
        fieldHashesOf(descriptor),
      ]),
    ),
    revisionUsed: surface.revisionUsed,
    approvedAt: options.approvedAt ?? new Date().toISOString(),
    approvedBy: options.approvedBy,
    ...(options.note === undefined ? {} : { note: options.note }),
  };
}

/** Write a pin to disk. */
export async function savePin(path: string, pin: TrustPin): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(pin, null, 2)}\n`, 'utf8');
}

/** Read a pin from disk. */
export async function loadPin(path: string): Promise<TrustPin> {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new DiscoveryError(`Could not read the pin at ${path}`, {
      details: { path },
      cause: error,
    });
  }

  try {
    const parsed = JSON.parse(text) as TrustPin;

    if (typeof parsed.serverId !== 'string' || typeof parsed.surfaceRoot !== 'string') {
      throw new DiscoveryError(`${path} is not a valid pin`, { details: { path } });
    }

    return parsed;
  } catch (error) {
    throw toMcpStewardError(error, `reading the pin at ${path}`);
  }
}

export interface DiffOptions {
  readonly weights?: RiskWeights;
  /**
   * Surfaces from other servers, used to detect a tool name that collides with
   * one already advertised elsewhere on this machine.
   */
  readonly otherSurfaces?: readonly ServerSurface[];
}

/**
 * Compare a fresh capture against a pin.
 *
 * Uses the per descriptor hashes rather than re-hashing, so an unchanged
 * descriptor costs a string comparison and a large surface diffs in linear time.
 */
export function diffAgainstPin(
  surface: ServerSurface,
  pin: TrustPin,
  options: DiffOptions = {},
): DriftReport {
  const weights = options.weights ?? DEFAULT_RISK_WEIGHTS;
  const events: DriftEvent[] = [];

  const current = new Map<string, Descriptor>();
  for (const descriptor of surface.descriptors) {
    current.set(descriptorKey(descriptor.category, descriptor.identity), descriptor);
  }

  const pinnedKeys = new Set(Object.keys(pin.descriptorHashes));
  let unchanged = 0;

  // The revision the server speaks is part of what was approved. A server that
  // has moved era is not the server that was pinned, whatever its tools say.
  if (surface.revisionUsed !== pin.revisionUsed) {
    events.push(
      buildEvent(
        'revision-changed',
        'tool',
        surface.server.id,
        `protocol revision changed from ${pin.revisionUsed} to ${surface.revisionUsed}`,
        weights,
        false,
      ),
    );
  }

  for (const [key, descriptor] of current) {
    const pinnedHash = pin.descriptorHashes[key];

    if (pinnedHash === undefined) {
      events.push(
        buildEvent(
          'descriptor-added',
          descriptor.category,
          descriptor.identity,
          `${descriptor.category} ${descriptor.identity} was not present when this server was approved`,
          weights,
          isSensitive(descriptor),
          { after: descriptor.hash },
          markersIn(descriptor),
        ),
      );
      continue;
    }

    pinnedKeys.delete(key);

    if (pinnedHash === descriptor.hash) {
      unchanged += 1;
      continue;
    }

    // Something about this descriptor changed. Classify what, because "changed"
    // alone does not tell a reviewer whether to care.
    events.push(...classifyChange(descriptor, pin.fieldHashes?.[key], weights));
  }

  for (const key of pinnedKeys) {
    const { category, identity } = parseKey(key);
    const before = pin.descriptorHashes[key];

    events.push(
      buildEvent(
        'descriptor-removed',
        category,
        identity,
        `${category} ${identity} was present when approved but is gone now`,
        weights,
        false,
        before === undefined ? {} : { before },
      ),
    );
  }

  events.push(...detectNameCollisions(surface, options.otherSurfaces ?? [], weights));

  return {
    server: surface.server,
    pinnedAt: pin.approvedAt,
    comparedAt: surface.capturedAt,
    pinnedRoot: pin.surfaceRoot,
    currentRoot: surface.hashes.root,
    events: events.sort(byRisk),
    unchanged,
  };
}

/**
 * Classify what changed about a descriptor that already existed, against a pin.
 *
 * A pin stores hashes, not content, which is deliberate: a pin should not be a
 * copy of a server's surface sitting in a file. Since per field hashes were added
 * it can still say *which* part changed: the description, the input schema, or
 * other fields such as the title. What it cannot say is how the old text read, so
 * the current text is what is checked for signs of poisoning.
 *
 * A pin written before per field hashes existed cannot even say which part, and
 * this used to report every such change as a description change, the highest
 * weighted classification, which it had no evidence for. It now says the part is
 * unknown.
 */
function classifyChange(
  descriptor: Descriptor,
  pinned: DescriptorFieldHashes | undefined,
  weights: RiskWeights,
): readonly DriftEvent[] {
  const sensitive = isSensitive(descriptor);
  const markers = markersIn(descriptor);
  const hashes = { after: descriptor.hash };
  const label = `${descriptor.category} ${descriptor.identity}`;

  if (pinned === undefined) {
    return [
      buildEvent(
        'descriptor-changed',
        descriptor.category,
        descriptor.identity,
        `${label} changed after it was approved. This pin predates per field hashes, so ` +
          'which part changed is unknown; trust the server again to record them.',
        weights,
        sensitive,
        hashes,
        markers,
      ),
    ];
  }

  const now = fieldHashesOf(descriptor);
  const events: DriftEvent[] = [];

  if (now.description !== pinned.description) {
    events.push(
      buildEvent(
        'description-changed',
        descriptor.category,
        descriptor.identity,
        `${label}: the description changed after it was approved`,
        weights,
        sensitive,
        hashes,
        markers,
      ),
    );
  }

  if (now.input !== pinned.input) {
    events.push(
      buildEvent(
        'input-schema-changed',
        descriptor.category,
        descriptor.identity,
        `${label}: the input schema changed after it was approved`,
        weights,
        sensitive,
        hashes,
        markers,
      ),
    );
  }

  if (now.rest !== pinned.rest) {
    events.push(
      buildEvent(
        'metadata-changed',
        descriptor.category,
        descriptor.identity,
        `${label}: fields other than the description and schema changed, such as the title or annotations`,
        weights,
        sensitive,
        hashes,
      ),
    );
  }

  return events;
}

/**
 * Hash each part of a descriptor separately. See docs/formats.md section 6.
 *
 * Each part is hashed exactly as a whole descriptor is, `sha256` over its
 * canonical JSON, so an independent implementation needs nothing new.
 */
export function fieldHashesOf(descriptor: Descriptor): DescriptorFieldHashes {
  const value = descriptor.value;
  const inputField = inputFieldOf(descriptor);

  const rest: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'description' || key === inputField) continue;
    rest[key] = entry;
  }

  const description = value['description'];
  const input = inputField === undefined ? undefined : value[inputField];

  return {
    ...(description === undefined ? {} : { description: hashPart(description) }),
    ...(input === undefined ? {} : { input: hashPart(input) }),
    rest: hashPart(rest),
  };
}

function hashPart(part: JsonValue): ContentHash {
  return hashCanonicalForm(canonicalizeJsonValue(part));
}

/** The field carrying a descriptor's input shape: `inputSchema` for a tool, `arguments` for a prompt. */
function inputFieldOf(descriptor: Descriptor): string | undefined {
  if (descriptor.category === 'tool') return 'inputSchema';
  if (descriptor.category === 'prompt') return 'arguments';
  return undefined;
}

/**
 * Signs of poisoning in everything about a descriptor the model reads: its
 * description, and the text inside its input schema, where parameter
 * descriptions are an equally good hiding place.
 */
function markersIn(descriptor: Descriptor): readonly string[] {
  const inputField = inputFieldOf(descriptor);
  const input = inputField === undefined ? undefined : descriptor.value[inputField];

  return findPoisoningMarkers(
    [readDescription(descriptor) ?? '', input === undefined ? '' : JSON.stringify(input)].join('\n'),
  );
}

/**
 * Compare two full captures.
 *
 * Strictly more informative than comparing against a pin, because both sides have
 * content rather than only hashes. Used when the previous surface is available,
 * for example from a watch loop or a stored capture.
 */
export function diffSurfaces(
  before: ServerSurface,
  after: ServerSurface,
  options: DiffOptions = {},
): DriftReport {
  const weights = options.weights ?? DEFAULT_RISK_WEIGHTS;
  const events: DriftEvent[] = [];

  const previous = new Map<string, Descriptor>();
  for (const descriptor of before.descriptors) {
    previous.set(descriptorKey(descriptor.category, descriptor.identity), descriptor);
  }

  let unchanged = 0;

  if (before.revisionUsed !== after.revisionUsed) {
    events.push(
      buildEvent(
        'revision-changed',
        'tool',
        after.server.id,
        `protocol revision changed from ${before.revisionUsed} to ${after.revisionUsed}`,
        weights,
        false,
      ),
    );
  }

  for (const descriptor of after.descriptors) {
    const key = descriptorKey(descriptor.category, descriptor.identity);
    const old = previous.get(key);

    if (old === undefined) {
      events.push(
        buildEvent(
          'descriptor-added',
          descriptor.category,
          descriptor.identity,
          `${descriptor.category} ${descriptor.identity} is new`,
          weights,
          isSensitive(descriptor),
          { after: descriptor.hash },
          markersIn(descriptor),
        ),
      );
      continue;
    }

    previous.delete(key);

    if (old.hash === descriptor.hash) {
      unchanged += 1;
      continue;
    }

    events.push(...classifyDetailed(old, descriptor, weights));
  }

  for (const [key, old] of previous) {
    const { category, identity } = parseKey(key);
    events.push(
      buildEvent(
        'descriptor-removed',
        category,
        identity,
        `${category} ${identity} was removed`,
        weights,
        false,
        { before: old.hash },
      ),
    );
  }

  events.push(...detectNameCollisions(after, options.otherSurfaces ?? [], weights));

  return {
    server: after.server,
    pinnedAt: before.capturedAt,
    comparedAt: after.capturedAt,
    pinnedRoot: before.hashes.root,
    currentRoot: after.hashes.root,
    events: events.sort(byRisk),
    unchanged,
  };
}

/** Field level classification, possible only when both sides have content. */
function classifyDetailed(
  before: Descriptor,
  after: Descriptor,
  weights: RiskWeights,
): readonly DriftEvent[] {
  const events: DriftEvent[] = [];
  const sensitive = isSensitive(after) || isSensitive(before);

  const beforeDescription = readDescription(before);
  const afterDescription = readDescription(after);

  const markers = markersIn(after);

  if (beforeDescription !== afterDescription) {
    events.push(
      buildEvent(
        'description-changed',
        after.category,
        after.identity,
        `description changed after approval`,
        weights,
        sensitive,
        { before: before.hash, after: after.hash },
        markers,
      ),
    );
  }

  const beforeSchema = readInputSchema(before);
  const afterSchema = readInputSchema(after);

  const beforeRequired = new Set(readRequiredParameters(beforeSchema));
  const afterRequired = readRequiredParameters(afterSchema);

  const newlyRequired = afterRequired.filter((name) => !beforeRequired.has(name));
  if (newlyRequired.length > 0) {
    events.push(
      buildEvent(
        'required-parameter-added',
        after.category,
        after.identity,
        `parameter(s) now required: ${newlyRequired.join(', ')}`,
        weights,
        sensitive,
        { before: before.hash, after: after.hash },
      ),
    );
  }

  const beforeProperties = new Set(readSchemaProperties(beforeSchema));
  const afterProperties = new Set(readSchemaProperties(afterSchema));

  const added = [...afterProperties].filter((name) => !beforeProperties.has(name));
  const removed = [...beforeProperties].filter((name) => !afterProperties.has(name));

  if (added.length > 0 && removed.length > 0) {
    events.push(
      buildEvent(
        'input-schema-changed-incompatibly',
        after.category,
        after.identity,
        `schema gained ${added.join(', ')} and lost ${removed.join(', ')}`,
        weights,
        sensitive,
        { before: before.hash, after: after.hash },
      ),
    );
  } else if (added.length > 0) {
    events.push(
      buildEvent(
        'input-schema-widened',
        after.category,
        after.identity,
        `schema gained parameter(s): ${added.join(', ')}`,
        weights,
        sensitive,
        { before: before.hash, after: after.hash },
      ),
    );
  } else if (removed.length > 0) {
    events.push(
      buildEvent(
        'input-schema-narrowed',
        after.category,
        after.identity,
        `schema lost parameter(s): ${removed.join(', ')}`,
        weights,
        sensitive,
        { before: before.hash, after: after.hash },
      ),
    );
  }

  // A schema can change without gaining or losing a parameter: a type, a
  // constraint, or a parameter's own description, which the model also reads.
  // This used to fall into a catch all reported as an incompatible restructure,
  // including when only the title had changed.
  const beforeFields = fieldHashesOf(before);
  const afterFields = fieldHashesOf(after);
  const schemaReported = events.some((event) => event.kind !== 'description-changed');

  if (beforeFields.input !== afterFields.input && !schemaReported) {
    events.push(
      buildEvent(
        'input-schema-changed',
        after.category,
        after.identity,
        'the schema changed without gaining or losing a parameter, for example a type or a parameter description',
        weights,
        sensitive,
        { before: before.hash, after: after.hash },
        markers,
      ),
    );
  }

  if (beforeFields.rest !== afterFields.rest) {
    events.push(
      buildEvent(
        'metadata-changed',
        after.category,
        after.identity,
        'fields other than the description and schema changed, such as the title or annotations',
        weights,
        sensitive,
        { before: before.hash, after: after.hash },
      ),
    );
  }

  return events;
}

/**
 * Detect tool names that collide confusingly with another server's.
 *
 * Two servers both advertising `search` is how a model gets steered to the wrong
 * one. Exact matches and near misses that differ only by separators or case are
 * both reported, because both are usable for the same confusion.
 */
function detectNameCollisions(
  surface: ServerSurface,
  others: readonly ServerSurface[],
  weights: RiskWeights,
): readonly DriftEvent[] {
  const events: DriftEvent[] = [];

  const foreign = new Map<string, string>();
  for (const other of others) {
    if (other.server.id === surface.server.id) continue;
    for (const descriptor of other.descriptors) {
      if (descriptor.category !== 'tool') continue;
      foreign.set(normalizeName(descriptor.identity), other.server.name);
    }
  }

  for (const descriptor of surface.descriptors) {
    if (descriptor.category !== 'tool') continue;

    const owner = foreign.get(normalizeName(descriptor.identity));
    if (owner === undefined) continue;

    events.push(
      buildEvent(
        'name-collision',
        'tool',
        descriptor.identity,
        `tool name collides with one advertised by ${owner}`,
        weights,
        isSensitive(descriptor),
        { after: descriptor.hash },
      ),
    );
  }

  return events;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_\-\s.]/g, '');
}

function parseKey(key: string): { category: DescriptorCategory; identity: string } {
  const separator = key.indexOf(':');
  const category = key.slice(0, separator) as DescriptorCategory;
  return { category, identity: key.slice(separator + 1) };
}

/** Whether a descriptor looks like it touches something consequential. */
function isSensitive(descriptor: Descriptor): boolean {
  const haystack = `${descriptor.identity} ${readDescription(descriptor) ?? ''} ${JSON.stringify(
    readInputSchema(descriptor) ?? {},
  )}`.toLowerCase();

  return SENSITIVE_SIGNALS.some((signal) => haystack.includes(signal));
}

function buildEvent(
  kind: DriftKind,
  category: DescriptorCategory,
  identity: string,
  summary: string,
  weights: RiskWeights,
  sensitive: boolean,
  hashes: { before?: ContentHash; after?: ContentHash } = {},
  markers: readonly string[] = [],
): DriftEvent {
  const base = weights.kind[kind];
  const weighted = sensitive ? base * weights.sensitiveCapability : base;

  // A sign of poisoning in new or changed text is what critical is for.
  const score = markers.length > 0 ? Math.max(weighted, weights.thresholds.critical) : weighted;

  const factors: string[] = [describeKind(kind)];
  if (sensitive) {
    factors.push('schema or description suggests filesystem, network, shell or credential access');
  }
  factors.push(...markers);

  return {
    kind,
    category,
    identity: redact(identity),
    summary: redact(summary),
    risk: toTier(score, weights),
    riskFactors: factors,
    ...(hashes.before === undefined ? {} : { before: hashes.before }),
    ...(hashes.after === undefined ? {} : { after: hashes.after }),
  };
}

/**
 * Explain a classification in one line.
 *
 * Exhaustive over {@link DriftKind}, with a `never` assertion in the default
 * branch. Adding a classification without handling it here is a compile error,
 * which is the invariant the domain model exists to enforce.
 */
export function describeKind(kind: DriftKind): string {
  switch (kind) {
    case 'descriptor-added':
      return 'a new item appeared on an approved server';
    case 'descriptor-removed':
      return 'an approved item is gone';
    case 'description-changed':
      return 'the text the model reads was changed after approval';
    case 'input-schema-widened':
      return 'the schema now accepts more than it did';
    case 'input-schema-narrowed':
      return 'the schema now accepts less than it did';
    case 'input-schema-changed-incompatibly':
      return 'the schema was restructured';
    case 'input-schema-changed':
      return 'the schema changed';
    case 'metadata-changed':
      return 'a field other than the description or schema changed';
    case 'descriptor-changed':
      return 'the item changed, and the pin is too old to say which part';
    case 'required-parameter-added':
      return 'a new parameter is now mandatory';
    case 'name-collision':
      return 'the name is confusable with another server';
    case 'revision-changed':
      return 'the server is speaking a different protocol revision';
    default:
      return assertNever(kind, 'drift kind');
  }
}

function toTier(score: number, weights: RiskWeights): RiskTier {
  if (score >= weights.thresholds.critical) return 'critical';
  if (score >= weights.thresholds.high) return 'high';
  if (score >= weights.thresholds.medium) return 'medium';
  return 'low';
}

const TIER_ORDER: readonly RiskTier[] = ['critical', 'high', 'medium', 'low'];

function byRisk(a: DriftEvent, b: DriftEvent): number {
  const rank = TIER_ORDER.indexOf(a.risk) - TIER_ORDER.indexOf(b.risk);
  return rank !== 0 ? rank : a.identity.localeCompare(b.identity);
}

/** True when a report contains no differences at all. */
export function isUnchanged(report: DriftReport): boolean {
  return report.events.length === 0 && report.pinnedRoot === report.currentRoot;
}

/** The highest risk tier present in a report, or undefined when clean. */
export function highestRisk(report: DriftReport): RiskTier | undefined {
  for (const tier of TIER_ORDER) {
    if (report.events.some((e) => e.risk === tier)) return tier;
  }
  return undefined;
}
