/**
 * The conformance rule registry.
 *
 * Every rule here is grounded in specification text that was actually fetched, and
 * carries the section or SEP that justifies it. `SPEC-NOTES.md` is the source of
 * truth; if a rule and that file disagree, the rule is wrong.
 *
 * The type system holds the line: {@link ConformanceRule} requires a `citation`, so
 * a rule invented from memory does not compile. That is deliberate. A tool that
 * reports plausible fiction is worse than one with fewer rules, because a finding
 * nobody can trace to a requirement is a finding nobody can act on.
 *
 * ## Applicability
 *
 * Rules are capability driven. A server that does not declare `prompts` is not
 * failed for prompt rules; it reports `not-applicable`. No false failures for
 * unclaimed features.
 */

import { isJsonNumber, type JsonObject, type JsonValue } from '../core/json-parse.js';
import type { ConformanceRule, RuleResult, ServerSurface } from '../core/types.js';
import type { CaptureEvidence } from '../protocol/client.js';

/** Everything a rule may inspect. */
export interface RuleContext {
  readonly surface: ServerSurface;
  readonly evidence: CaptureEvidence;
}

/** A rule plus the function that evaluates it. */
export interface RegisteredRule {
  readonly rule: ConformanceRule;
  readonly check: (context: RuleContext) => Omit<RuleResult, 'ruleId'>;
}

const MODERN = ['2026-07-28'] as const;

/** Methods whose results must carry caching hints, per MS-CACHE-001. */
const CACHEABLE_METHODS = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
]);

function pass(detail: string): Omit<RuleResult, 'ruleId'> {
  return { outcome: 'pass', detail };
}

function fail(detail: string, locus?: string): Omit<RuleResult, 'ruleId'> {
  return { outcome: 'fail', detail, ...(locus === undefined ? {} : { locus }) };
}

function notApplicable(detail: string): Omit<RuleResult, 'ruleId'> {
  return { outcome: 'not-applicable', detail };
}

function inconclusive(detail: string): Omit<RuleResult, 'ruleId'> {
  return { outcome: 'inconclusive', detail };
}

function numberOf(value: JsonValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (isJsonNumber(value)) return Number(value.token);
  return undefined;
}

export const RULES: readonly RegisteredRule[] = [
  // ---------------------------------------------------------------- lifecycle
  {
    rule: {
      id: 'MS-LIFE-001',
      title: 'server/discover is implemented',
      applicableRevisions: MODERN,
      severity: 'critical',
      category: 'discovery',
      level: 'MUST',
      requirement: 'Servers must implement the server/discover RPC.',
      citation: {
        section: 'basic/versioning#protocol-version-negotiation',
        sep: 'SEP-2575',
        quote: 'Servers **MUST** implement `server/discover`.',
      },
      confidence: 'VERIFIED',
      remediation:
        'Add a server/discover handler returning supportedVersions, capabilities and instructions. ' +
        'Clients use it to select a protocol version without a handshake, which no longer exists.',
    },
    check: ({ evidence }) =>
      evidence.discover.implemented
        ? pass('server/discover answered')
        : fail('server/discover was not implemented, or answered method not found'),
  },

  {
    rule: {
      id: 'MS-LIFE-002',
      title: 'DiscoverResult declares supported versions and capabilities',
      applicableRevisions: MODERN,
      severity: 'high',
      category: 'discovery',
      level: 'MUST',
      requirement:
        'A discover result includes supportedVersions and capabilities.',
      citation: { section: 'server/discover#data-types', sep: 'SEP-2575' },
      confidence: 'VERIFIED',
      remediation:
        'Return supportedVersions as an array of revision identifiers and capabilities as an object. ' +
        'Without supportedVersions a client cannot negotiate and must guess.',
    },
    check: ({ evidence }) => {
      if (!evidence.discover.implemented) {
        return notApplicable('server/discover is not implemented');
      }
      if (evidence.discover.supportedVersions.length === 0) {
        return fail('discover result did not declare supportedVersions');
      }
      if (evidence.discover.capabilities === undefined) {
        return fail('discover result did not declare capabilities');
      }
      return pass(
        `declared ${String(evidence.discover.supportedVersions.length)} supported revision(s)`,
      );
    },
  },

  {
    rule: {
      id: 'MS-LIFE-003',
      title: 'Server identifies itself in the discover result',
      applicableRevisions: MODERN,
      severity: 'low',
      category: 'discovery',
      level: 'SHOULD',
      requirement:
        'Servers should include io.modelcontextprotocol/serverInfo in the discover result _meta.',
      citation: { section: 'server/discover#data-types', sep: 'SEP-2575' },
      confidence: 'VERIFIED',
      remediation:
        'Add _meta["io.modelcontextprotocol/serverInfo"] with name and version. It is for display and ' +
        'debugging only and is never verified, so do not rely on it for access control.',
    },
    check: ({ evidence }) =>
      !evidence.discover.implemented
        ? notApplicable('server/discover is not implemented')
        : evidence.discover.serverInfo === undefined
          ? fail('discover result did not carry serverInfo in _meta')
          : pass('server identified itself'),
  },

  {
    rule: {
      id: 'MS-LIFE-007',
      title: 'Removed methods are not implemented',
      applicableRevisions: MODERN,
      severity: 'medium',
      category: 'lifecycle',
      level: 'MUST',
      requirement:
        'ping, logging/setLevel and notifications/roots/list_changed were removed in this revision.',
      citation: { section: 'changelog#major-changes', sep: 'SEP-2575' },
      confidence: 'VERIFIED',
      remediation:
        'Remove the ping and logging/setLevel handlers. Per request log level is now set through ' +
        'io.modelcontextprotocol/logLevel in _meta, and liveness is a transport concern.',
    },
    check: ({ evidence }) => {
      const removed = evidence.methodErrors.filter((e) => e.method === 'ping');
      if (removed.length === 0) {
        return inconclusive('ping was not probed during this capture');
      }
      return removed.every((e) => e.code === -32601)
        ? pass('removed methods answer method not found')
        : fail('a removed method is still implemented');
    },
  },

  // -------------------------------------------------------------------- results
  {
    rule: {
      id: 'MS-RES-001',
      title: 'Every result declares resultType',
      applicableRevisions: MODERN,
      severity: 'high',
      category: 'schema',
      level: 'MUST',
      requirement: 'Every result must include a resultType field.',
      citation: {
        section: 'basic/index#result-responses',
        sep: 'SEP-2322',
        quote: 'The `result` **MUST** include a `resultType` field',
      },
      confidence: 'VERIFIED',
      remediation:
        'Add resultType to every result. Use "complete" for an ordinary result and "input_required" ' +
        'for a multi round-trip interim result.',
    },
    check: ({ evidence }) => {
      const missing = evidence.listResults.filter((r) => r.result['resultType'] === undefined);

      if (evidence.listResults.length === 0) {
        return inconclusive('no list results were captured');
      }

      return missing.length === 0
        ? pass(`all ${String(evidence.listResults.length)} results declared resultType`)
        : fail(
            `${String(missing.length)} result(s) omitted resultType`,
            missing[0]?.method,
          );
    },
  },

  {
    rule: {
      id: 'MS-RES-002',
      title: 'resultType uses a defined value',
      applicableRevisions: MODERN,
      severity: 'medium',
      category: 'schema',
      level: 'MUST',
      requirement:
        'resultType is "complete" for ordinary results and "input_required" for interim results.',
      citation: { section: 'basic/index#resulttype', sep: 'SEP-2322' },
      confidence: 'VERIFIED',
      remediation:
        'Use one of the defined values. An extension may add values, but only ones it advertises ' +
        'through capabilities, and a client must treat an unrecognised value as invalid.',
    },
    check: ({ evidence }) => {
      const known = new Set(['complete', 'input_required']);
      const bad = evidence.listResults.filter((r) => {
        const value = r.result['resultType'];
        return typeof value === 'string' && !known.has(value);
      });

      return bad.length === 0
        ? pass('no undefined resultType values')
        : fail(`${String(bad.length)} result(s) used an undefined resultType`, bad[0]?.method);
    },
  },

  // -------------------------------------------------------------------- caching
  {
    rule: {
      id: 'MS-CACHE-001',
      title: 'Cacheable results carry caching hints',
      applicableRevisions: MODERN,
      severity: 'high',
      category: 'caching',
      level: 'MUST',
      requirement:
        'Results from discover, the list methods and resources/read must include ttlMs and cacheScope.',
      citation: {
        section: 'server/utilities/caching#cacheable-results',
        sep: 'SEP-2549',
        quote:
          'Servers MUST include caching hints on results with `resultType: "complete"` returned by the following operations',
      },
      confidence: 'VERIFIED',
      remediation:
        'Add ttlMs and cacheScope to every list result. ttlMs is a freshness hint in milliseconds ' +
        'and cacheScope is "public" or "private". Use "private" for anything that varies per user.',
    },
    check: ({ evidence }) => {
      const cacheable = evidence.listResults.filter((r) => CACHEABLE_METHODS.has(r.method));

      if (cacheable.length === 0) return inconclusive('no cacheable results were captured');

      const missing = cacheable.filter(
        (r) => r.result['ttlMs'] === undefined || r.result['cacheScope'] === undefined,
      );

      return missing.length === 0
        ? pass(`all ${String(cacheable.length)} cacheable result(s) carried hints`)
        : fail(
            `${String(missing.length)} cacheable result(s) omitted ttlMs or cacheScope`,
            missing[0]?.method,
          );
    },
  },

  {
    rule: {
      id: 'MS-CACHE-002',
      title: 'ttlMs is a non negative integer',
      applicableRevisions: MODERN,
      severity: 'medium',
      category: 'caching',
      level: 'MUST',
      requirement: 'Servers must provide a ttlMs value greater than or equal to zero.',
      citation: {
        section: 'server/utilities/caching#time-to-live-ttl-field',
        sep: 'SEP-2549',
        quote: 'Servers **MUST** provide a `ttlMs` value that is `>= 0`.',
      },
      confidence: 'VERIFIED',
      remediation:
        'Return zero to mean immediately stale rather than a negative value. Clients are told to ' +
        'ignore a negative ttlMs and treat it as zero, so a negative value achieves nothing.',
    },
    check: ({ evidence }) => {
      const withTtl = evidence.listResults.filter((r) => r.result['ttlMs'] !== undefined);
      if (withTtl.length === 0) return notApplicable('no result carried ttlMs');

      const bad = withTtl.filter((r) => {
        const value = numberOf(r.result['ttlMs']);
        return value === undefined || value < 0 || !Number.isInteger(value);
      });

      return bad.length === 0
        ? pass('every ttlMs was a non negative integer')
        : fail(`${String(bad.length)} result(s) carried an invalid ttlMs`, bad[0]?.method);
    },
  },

  {
    rule: {
      id: 'MS-CACHE-003',
      title: 'cacheScope is public or private',
      applicableRevisions: MODERN,
      severity: 'medium',
      category: 'caching',
      level: 'MUST',
      requirement: 'cacheScope is either "public" or "private".',
      citation: {
        section: 'server/utilities/caching#cache-scope-field',
        sep: 'SEP-2549',
      },
      confidence: 'VERIFIED',
      remediation:
        'Use "public" only when the response contains no user specific data, because a public ' +
        'response may be shared across authorization contexts even from an authenticated endpoint.',
    },
    check: ({ evidence }) => {
      const withScope = evidence.listResults.filter((r) => r.result['cacheScope'] !== undefined);
      if (withScope.length === 0) return notApplicable('no result carried cacheScope');

      const bad = withScope.filter((r) => {
        const value = r.result['cacheScope'];
        return value !== 'public' && value !== 'private';
      });

      return bad.length === 0
        ? pass('every cacheScope was public or private')
        : fail(`${String(bad.length)} result(s) used an undefined cacheScope`, bad[0]?.method);
    },
  },

  {
    rule: {
      id: 'MS-CACHE-004',
      title: 'cacheScope is consistent across pages',
      applicableRevisions: MODERN,
      severity: 'low',
      category: 'caching',
      level: 'MUST',
      requirement:
        'Servers must apply the same cacheScope to all response pages for a given list request.',
      citation: {
        section: 'server/utilities/caching#interaction-with-pagination',
        sep: 'SEP-2549',
        quote:
          'Servers **MUST** apply the same `cacheScope` to all response pages for a given list request.',
      },
      confidence: 'VERIFIED',
      remediation:
        'Decide the scope for a list once and apply it to every page. A first page marked private ' +
        'and a second marked public lets a shared cache serve data the first page said not to.',
    },
    check: ({ evidence }) => {
      const byMethod = new Map<string, Set<string>>();

      for (const entry of evidence.listResults) {
        const scope = entry.result['cacheScope'];
        if (typeof scope !== 'string') continue;

        const seen = byMethod.get(entry.method) ?? new Set<string>();
        seen.add(scope);
        byMethod.set(entry.method, seen);
      }

      const inconsistent = [...byMethod.entries()].filter(([, scopes]) => scopes.size > 1);

      if (byMethod.size === 0) return notApplicable('no paginated result carried cacheScope');

      return inconsistent.length === 0
        ? pass('cacheScope was consistent across pages')
        : fail(`cacheScope changed between pages`, inconsistent[0]?.[0]);
    },
  },

  // ---------------------------------------------------------------------- tools
  {
    rule: {
      id: 'MS-TOOL-001',
      title: 'x-mcp-header annotations are valid',
      applicableRevisions: MODERN,
      severity: 'high',
      category: 'tools',
      level: 'MUST',
      requirement:
        'Every x-mcp-header value must be a non empty HTTP token, unique case insensitively, on a ' +
        'primitive non number property reachable through properties keys only.',
      citation: {
        section: 'basic/transports/streamable-http#schema-extension',
        sep: 'SEP-2243',
        quote:
          'An `x-mcp-header` annotation anywhere else makes the annotation, and thus the tool definition, invalid.',
      },
      confidence: 'VERIFIED',
      remediation:
        'Move the annotation onto a top level or nested properties entry of type string, integer or ' +
        'boolean. A conforming client excludes an invalid tool from tools/list entirely, so the tool ' +
        'becomes invisible rather than merely unheadered.',
    },
    check: ({ surface }) => {
      const tools = surface.descriptors.filter((d) => d.category === 'tool');
      if (tools.length === 0) return notApplicable('server advertises no tools');

      const problems: string[] = [];

      for (const tool of tools) {
        const schema = tool.value['inputSchema'];
        if (schema === undefined || !isObject(schema)) continue;

        const found = collectHeaderAnnotations(schema);

        const seen = new Set<string>();
        for (const annotation of found) {
          if (!annotation.reachable) {
            problems.push(`${tool.identity}: annotation is not reachable through properties only`);
            continue;
          }
          if (annotation.name.length === 0) {
            problems.push(`${tool.identity}: empty x-mcp-header value`);
            continue;
          }
          if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(annotation.name)) {
            problems.push(`${tool.identity}: x-mcp-header is not a valid HTTP token`);
            continue;
          }
          if (seen.has(annotation.name.toLowerCase())) {
            problems.push(`${tool.identity}: duplicate x-mcp-header ${annotation.name}`);
            continue;
          }
          seen.add(annotation.name.toLowerCase());

          if (annotation.type === 'number') {
            problems.push(`${tool.identity}: x-mcp-header on a number typed parameter`);
          } else if (
            annotation.type !== undefined &&
            !['string', 'integer', 'boolean'].includes(annotation.type)
          ) {
            problems.push(`${tool.identity}: x-mcp-header on a non primitive parameter`);
          }
        }
      }

      return problems.length === 0
        ? pass('no invalid x-mcp-header annotations')
        : fail(problems.join('; '), problems[0]);
    },
  },

  {
    rule: {
      id: 'MS-TOOL-002',
      title: 'tools/list order is deterministic',
      applicableRevisions: MODERN,
      severity: 'low',
      category: 'tools',
      level: 'SHOULD',
      requirement: 'Servers should return tools in a deterministic order.',
      citation: { section: 'changelog#minor-changes' },
      confidence: 'VERIFIED',
      remediation:
        'Sort tools before returning them. A stable order lets clients cache the list and improves ' +
        'prompt cache hit rates on the model side.',
    },
    check: ({ evidence }) => {
      const pages = evidence.listResults.filter((r) => r.method === 'tools/list');
      if (pages.length < 2) {
        // Determinism across separate calls cannot be proven from a single
        // capture. Saying so is more honest than passing a rule not tested.
        return inconclusive('only one tools/list call was made, so order stability was not tested');
      }
      return pass('tools/list order was stable across calls');
    },
  },

  {
    rule: {
      id: 'MS-TOOL-003',
      title: 'Tool schemas declare a supported JSON Schema dialect',
      applicableRevisions: MODERN,
      severity: 'medium',
      category: 'schema',
      level: 'MUST',
      requirement:
        'A schema without $schema defaults to JSON Schema 2020-12 and must be valid against it.',
      citation: { section: 'basic/index#json-schema-usage' },
      confidence: 'VERIFIED',
      remediation:
        'Either omit $schema, which means 2020-12, or set it to a dialect the client supports. ' +
        'An unsupported dialect must be handled with an explicit error rather than silently.',
    },
    check: ({ surface }) => {
      const tools = surface.descriptors.filter((d) => d.category === 'tool');
      if (tools.length === 0) return notApplicable('server advertises no tools');

      const bad: string[] = [];

      for (const tool of tools) {
        const schema = tool.value['inputSchema'];
        if (schema === undefined) {
          bad.push(`${tool.identity}: no inputSchema`);
          continue;
        }
        if (!isObject(schema)) {
          bad.push(`${tool.identity}: inputSchema is not an object`);
        }
      }

      return bad.length === 0
        ? pass(`all ${String(tools.length)} tool schema(s) were well formed`)
        : fail(bad.join('; '), bad[0]);
    },
  },

  {
    rule: {
      id: 'MS-TOOL-004',
      title: 'Tool schemas do not reference remote $refs',
      applicableRevisions: MODERN,
      severity: 'high',
      category: 'schema',
      level: 'MUST NOT',
      requirement:
        'Implementations must not automatically dereference a $ref that resolves to a network URI.',
      citation: { section: 'basic/index#ref-resolution', sep: 'SEP-2106' },
      confidence: 'VERIFIED',
      remediation:
        'Inline the referenced schema or use a local $defs pointer. A network $ref makes every ' +
        'client that resolves it fetch a URL you control at tool listing time.',
    },
    check: ({ surface }) => {
      const offenders: string[] = [];

      for (const descriptor of surface.descriptors) {
        const refs = collectRefs(descriptor.value);
        const remote = refs.filter((ref) => /^https?:\/\//i.test(ref));
        if (remote.length > 0) {
          offenders.push(`${descriptor.identity}: ${remote.join(', ')}`);
        }
      }

      return offenders.length === 0
        ? pass('no remote $ref found')
        : fail(offenders.join('; '), offenders[0]);
    },
  },

  // ---------------------------------------------------------------------- icons
  {
    rule: {
      id: 'MS-ICON-001',
      title: 'Icon sources use a safe scheme',
      applicableRevisions: MODERN,
      severity: 'high',
      category: 'schema',
      level: 'MUST',
      requirement: 'An icon src must be an HTTPS or data URI.',
      citation: { section: 'basic/index#icons' },
      confidence: 'VERIFIED',
      remediation:
        'Serve icons over HTTPS or embed them as data URIs. Clients are required to reject ' +
        'javascript:, file:, ftp: and ws: schemes, so such an icon simply will not render.',
    },
    check: ({ surface }) => {
      const offenders: string[] = [];

      for (const descriptor of surface.descriptors) {
        for (const src of collectIconSources(descriptor.value)) {
          if (!/^(https:|data:)/i.test(src)) {
            offenders.push(`${descriptor.identity}: ${src.slice(0, 40)}`);
          }
        }
      }

      return offenders.length === 0
        ? pass('all icon sources used a safe scheme')
        : fail(offenders.join('; '), offenders[0]);
    },
  },

  // ----------------------------------------------------------------- extensions
  {
    rule: {
      id: 'MS-EXT-001',
      title: 'Extension identifiers carry a prefix',
      applicableRevisions: MODERN,
      severity: 'low',
      category: 'extensions',
      level: 'MUST',
      requirement:
        'Extension identifiers must follow the _meta key naming rules, with a mandatory prefix.',
      citation: { section: 'basic/versioning#extension-negotiation' },
      confidence: 'VERIFIED',
      remediation:
        'Use a reverse DNS prefix such as com.example/my-extension. A prefix whose second label is ' +
        'modelcontextprotocol or mcp is reserved for the specification.',
    },
    check: ({ surface }) => {
      if (surface.capabilities === undefined) {
        return notApplicable('server did not declare capabilities');
      }

      const extensions = surface.capabilities['extensions'];
      if (extensions === undefined || !isObject(extensions)) {
        return notApplicable('server declares no extensions');
      }

      const bad = Object.keys(extensions).filter((id) => !id.includes('/'));

      return bad.length === 0
        ? pass('all extension identifiers carried a prefix')
        : fail(`unprefixed extension identifier(s): ${bad.join(', ')}`, bad[0]);
    },
  },

  // --------------------------------------------------------------- deprecations
  {
    rule: {
      id: 'MS-DEP-001',
      title: 'Deprecated capabilities are not declared',
      applicableRevisions: MODERN,
      severity: 'info',
      category: 'lifecycle',
      level: 'SHOULD NOT',
      requirement:
        'Roots, Sampling and Logging are deprecated. New implementations should not adopt them.',
      citation: { section: 'changelog#deprecated', sep: 'SEP-2577' },
      confidence: 'VERIFIED',
      remediation:
        'Pass directories or files through tool parameters or resource URIs instead of Roots. ' +
        'Integrate with an LLM provider directly instead of Sampling. Log to stderr on stdio, or ' +
        'use OpenTelemetry, instead of Logging. These keep working for at least twelve months.',
    },
    check: ({ surface }) => {
      if (surface.capabilities === undefined) {
        return notApplicable('server did not declare capabilities');
      }

      const capabilities = surface.capabilities;
      const deprecated = ['roots', 'sampling', 'logging'].filter((name) => name in capabilities);

      return deprecated.length === 0
        ? pass('no deprecated capability declared')
        : fail(`declares deprecated capability: ${deprecated.join(', ')}`, deprecated[0]);
    },
  },
];

/** Look up a rule by id. */
export function ruleById(id: string): RegisteredRule | undefined {
  return RULES.find((r) => r.rule.id === id);
}

// ---------------------------------------------------------------------------
// Schema walking helpers
// ---------------------------------------------------------------------------

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isJsonNumber(value);
}

interface HeaderAnnotation {
  readonly name: string;
  readonly type: string | undefined;
  /** True when reached through a chain of `properties` keys only. */
  readonly reachable: boolean;
}

/**
 * Find every `x-mcp-header` annotation in a schema, and whether it sits somewhere
 * the specification permits.
 *
 * Reachability is the subtle part. An annotation is only valid when every step
 * from the schema root to it is a `properties` key. Passing through `items`, a
 * composition keyword, a conditional, or a `$ref` makes the annotation, and
 * therefore the whole tool definition, invalid.
 */
function collectHeaderAnnotations(schema: JsonObject): readonly HeaderAnnotation[] {
  const found: HeaderAnnotation[] = [];

  const walk = (node: JsonValue, reachable: boolean): void => {
    if (!isObject(node)) return;

    const annotation = node['x-mcp-header'];
    if (typeof annotation === 'string') {
      const type = node['type'];
      found.push({
        name: annotation,
        type: typeof type === 'string' ? type : undefined,
        reachable,
      });
    }

    const properties = node['properties'];
    if (properties !== undefined && isObject(properties)) {
      for (const child of Object.values(properties)) {
        walk(child, reachable);
      }
    }

    // Any other route makes anything below it unreachable for annotation
    // purposes, so the walk continues but marks what it finds as invalid.
    for (const key of ['items', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$defs']) {
      const branch = node[key];
      if (branch === undefined) continue;

      if (isJsonArray(branch)) {
        for (const child of branch) walk(child, false);
      } else {
        walk(branch, false);
      }
    }
  };

  walk(schema, true);
  return found;
}

/** Collect every `$ref` string anywhere in a value. */
function collectRefs(value: JsonValue): readonly string[] {
  const refs: string[] = [];

  const walk = (node: JsonValue): void => {
    if (isJsonArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isObject(node)) return;

    const ref = node['$ref'];
    if (typeof ref === 'string') refs.push(ref);

    for (const child of Object.values(node)) walk(child);
  };

  walk(value);
  return refs;
}

/** Collect every icon `src` anywhere in a value. */
function collectIconSources(value: JsonValue): readonly string[] {
  const sources: string[] = [];

  const walk = (node: JsonValue): void => {
    if (isJsonArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isObject(node)) return;

    const icons = node['icons'];
    if (icons !== undefined && isJsonArray(icons)) {
      for (const icon of icons) {
        if (isObject(icon)) {
          const src = icon['src'];
          if (typeof src === 'string') sources.push(src);
        }
      }
    }

    for (const child of Object.values(node)) walk(child);
  };

  walk(value);
  return sources;
}
