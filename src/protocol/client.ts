/**
 * The capture client.
 *
 * Drives a transport to answer one question: what is this server advertising right
 * now, and which protocol revision did it actually speak while telling us?
 *
 * The second half of that matters as much as the first. A capture that silently
 * fell back to `2025-11-25` and is then presented as current would make the ledger
 * lie, so `revisionRequested` and `revisionUsed` are always recorded separately and
 * a downgrade is never invisible.
 */

import { hashCanonicalForm } from '../core/canonical.js';
import { buildDescriptors, isJsonObject } from '../core/descriptor.js';
import {
  CancellationError,
  ProtocolViolationError,
  TimeoutError,
  TransportError,
  VersionNegotiationError,
} from '../core/errors.js';
import { isJsonNumber, type JsonObject, type JsonValue } from '../core/json-parse.js';
import { NOOP_LOGGER, type Logger } from '../core/logger.js';
import { computeSurfaceHashes } from '../core/merkle.js';
import {
  eraOf,
  isSupportedRevision,
  selectBestRevision,
  SUPPORTED_REVISIONS,
  type ProtocolEra,
  type ProtocolRevision,
} from '../core/revisions.js';
import type {
  Descriptor,
  DescriptorCategory,
  ServerRef,
  ServerSurface,
  TransportKind,
} from '../core/types.js';
import { buildRequest, CLIENT_INFO, MCP_ERROR_CODES, META_KEYS } from './messages.js';

/** What the client needs from a transport. Both stdio and HTTP satisfy it. */
export interface Transport {
  request(
    message: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JsonValue>;
  /**
   * Send a notification, which carries no id and gets no response. Optional so
   * an existing transport keeps working; when absent, the client falls back to
   * `request` and ignores the outcome.
   */
  notify?(message: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  /**
   * False once a process based server has exited. Absent for transports with no
   * process, such as HTTP.
   */
  readonly isRunning?: boolean;
  /** Start a process based server again after it exited. Optional. */
  restart?(): void;
  dispose(): Promise<void>;
}

export interface CaptureOptions {
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryBackoffMs?: number;
  readonly preferredRevision?: ProtocolRevision;
  readonly allowDowngrade?: boolean;
  readonly maxDescriptors?: number;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: CaptureProgress) => void;
}

export interface CaptureProgress {
  readonly stage: 'discover' | 'tools' | 'prompts' | 'resources' | 'resourceTemplates';
  readonly received: number;
}

/**
 * Everything observed during a capture, beyond the surface itself.
 *
 * The conformance engine grades things a `ServerSurface` deliberately does not
 * carry: whether a `tools/list` result included `ttlMs` and `cacheScope`, whether
 * every result declared `resultType`, what the server said when asked for a method
 * it does not implement. Discarding the raw results and keeping only the
 * descriptors would throw all of that away, and the capture would have to be run a
 * second time to grade it.
 */
export interface CaptureEvidence {
  readonly discover: DiscoverOutcome;
  readonly negotiation: {
    readonly requested: ProtocolRevision;
    readonly used: ProtocolRevision;
    readonly downgraded: boolean;
  };
  /** Every list result received, in order, one entry per page. */
  readonly listResults: readonly { readonly method: string; readonly result: JsonObject }[];
  /** Methods that answered with an error, and the code they used. */
  readonly methodErrors: readonly {
    readonly method: string;
    readonly code: number;
    readonly message: string;
  }[];
}

export interface CaptureResult {
  readonly surface: ServerSurface;
  readonly evidence: CaptureEvidence;
}

/** What `server/discover` told us, when the server implements it. */
export interface DiscoverOutcome {
  readonly implemented: boolean;
  readonly supportedVersions: readonly string[];
  readonly capabilities: JsonObject | undefined;
  readonly serverInfo: JsonObject | undefined;
  readonly instructions: string | undefined;
  /** The raw result, kept so conformance rules can inspect it without re-fetching. */
  readonly raw: JsonObject | undefined;
  /**
   * Which era the probe identified.
   *
   * `modern` when the server answered `server/discover`, or refused with a
   * recognised modern error. `legacy` when it refused with anything else, which
   * per MS-STDIO-008 is how a handshake era server presents.
   */
  readonly era: ProtocolEra;
  /** The error code the probe received, when it received one. */
  readonly probeErrorCode?: number;
  /** The server exited when probed, and was restarted. */
  readonly probeCrashedServer?: boolean;
}

/**
 * Error codes defined by the modern revision.
 *
 * MS-STDIO-008 is explicit that era fallback MUST NOT be keyed to one specific
 * error code, because legacy servers answer an unknown pre-`initialize` request
 * with whatever their implementation happens to use. So the test is inverted:
 * a *recognised modern* error means modern, and anything else means legacy.
 */
const MODERN_ERROR_CODES = new Set<number>([
  MCP_ERROR_CODES.headerMismatch,
  MCP_ERROR_CODES.missingRequiredClientCapability,
  MCP_ERROR_CODES.unsupportedProtocolVersion,
]);

/** The list endpoints a surface is assembled from, and where results live. */
const LIST_ENDPOINTS: readonly {
  readonly method: string;
  readonly resultKey: string;
  readonly category: DescriptorCategory;
  readonly stage: CaptureProgress['stage'];
  readonly capability: string;
}[] = [
  { method: 'tools/list', resultKey: 'tools', category: 'tool', stage: 'tools', capability: 'tools' },
  {
    method: 'prompts/list',
    resultKey: 'prompts',
    category: 'prompt',
    stage: 'prompts',
    capability: 'prompts',
  },
  {
    method: 'resources/list',
    resultKey: 'resources',
    category: 'resource',
    stage: 'resources',
    capability: 'resources',
  },
  {
    method: 'resources/templates/list',
    resultKey: 'resourceTemplates',
    category: 'resourceTemplate',
    stage: 'resourceTemplates',
    capability: 'resources',
  },
];

/**
 * Pagination safety bound.
 *
 * A server that returns a cursor pointing at itself would otherwise spin forever.
 * The cursor is also compared against the previous one, which catches the common
 * case; this bound catches a cycle longer than one step.
 */
const MAX_PAGES = 1_000;

/**
 * The revision a handshake era server is captured at.
 *
 * The only legacy revision this package supports. A server from an even older era
 * negotiates down further during its own handshake, and whatever it answers with
 * is what the capture records.
 */
const LEGACY_REVISION: ProtocolRevision = '2025-11-25';

export class McpClient {
  private readonly logger: Logger;
  private requestCounter = 0;

  constructor(
    private readonly transport: Transport,
    private readonly options: CaptureOptions = {},
  ) {
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  private nextId(): string {
    this.requestCounter += 1;
    return `ms-${String(this.requestCounter)}`;
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 30_000;
  }

  /**
   * Call `server/discover`.
   *
   * Servers MUST implement this (MS-LIFE-001), so a method-not-found answer is a
   * conformance finding rather than a transport failure. It is reported as
   * `implemented: false` and capture continues, because a non conforming server is
   * exactly the thing this package exists to inspect: refusing to look at it would
   * defeat the purpose.
   */
  async discover(revision: ProtocolRevision): Promise<DiscoverOutcome> {
    this.options.onProgress?.({ stage: 'discover', received: 0 });

    const response = await this.send('server/discover', revision, {});
    const error = readError(response);

    if (error !== undefined) {
      // A version rejection is a real answer and carries the server's supported
      // list, which is what negotiation needs.
      if (error.code === MCP_ERROR_CODES.unsupportedProtocolVersion) {
        return {
          implemented: true,
          supportedVersions: readSupportedVersions(error.data),
          capabilities: undefined,
          serverInfo: undefined,
          instructions: undefined,
          raw: undefined,
          era: 'modern',
          probeErrorCode: error.code,
        };
      }

      // Any other error means this is not a modern server. A modern one that
      // simply failed to implement server/discover is indistinguishable from a
      // legacy one at this point, and treating both as legacy is the safe
      // reading: it is better to capture honestly at the older revision than to
      // record a legacy surface as though it were current.
      return {
        implemented: false,
        supportedVersions: [],
        capabilities: undefined,
        serverInfo: undefined,
        instructions: undefined,
        raw: undefined,
        era: MODERN_ERROR_CODES.has(error.code) ? 'modern' : 'legacy',
        probeErrorCode: error.code,
      };
    }

    const result = readResult(response);
    if (result === undefined) {
      throw new ProtocolViolationError('server/discover returned neither a result nor an error');
    }

    return {
      implemented: true,
      supportedVersions: readStringArray(result['supportedVersions']),
      capabilities: asObject(result['capabilities']),
      serverInfo: readServerInfo(result),
      instructions: typeof result['instructions'] === 'string' ? result['instructions'] : undefined,
      raw: result,
      era: 'modern',
    };
  }

  /**
   * Run the era probe, surviving a server that the probe itself kills.
   *
   * Found on a real server: a Python MCP server built on an older SDK answered
   * `server/discover` by failing validation of the method name and exiting,
   * rather than replying with method not found. A modern server must implement
   * `server/discover`, so dying on it is itself proof of a handshake era server.
   * When the transport can restart the process, it is restarted and the capture
   * continues down the legacy path, instead of the whole capture failing on a
   * question the server could not have answered.
   */
  private async discoverOrRestart(revision: ProtocolRevision): Promise<DiscoverOutcome> {
    try {
      return await this.discover(revision);
    } catch (error) {
      const died =
        error instanceof TransportError &&
        this.transport.isRunning === false &&
        this.transport.restart !== undefined;

      if (!died) throw error;

      this.logger.warn('server exited when probed with server/discover; restarting it', {
        revision,
      });
      this.transport.restart?.();

      return {
        implemented: false,
        supportedVersions: [],
        capabilities: undefined,
        serverInfo: undefined,
        instructions: undefined,
        raw: undefined,
        era: 'legacy',
        probeCrashedServer: true,
      };
    }
  }

  /**
   * Perform the legacy `initialize` handshake.
   *
   * Only reached when the era probe identified a handshake era server. Returns
   * the revision the server negotiated, which is what the capture must record.
   */
  private async initializeLegacy(revision: ProtocolRevision): Promise<ProtocolRevision> {
    const response = await this.send('initialize', revision, {
      protocolVersion: revision,
      capabilities: {},
      clientInfo: { name: CLIENT_INFO.name, version: CLIENT_INFO.version },
    });

    const error = readError(response);
    if (error !== undefined) {
      throw new VersionNegotiationError(
        `Server refused the initialize handshake: ${error.message}`,
        { details: { code: error.code } },
      );
    }

    const result = readResult(response);
    const negotiated = result?.['protocolVersion'];

    // The server chooses the revision during a legacy handshake, so what it
    // answers with is what the capture must record, not what we asked for.
    const used =
      typeof negotiated === 'string' && isSupportedRevision(negotiated) ? negotiated : revision;

    // The handshake is only complete once the client acknowledges it, and some
    // servers, the Python SDK's among them, refuse every request until it does.
    //
    // This used to go through `request`, which on stdio refuses any message
    // without an id, so the notification was never actually sent there and the
    // refusal was swallowed below. A notification is not a request.
    const initialized = { jsonrpc: '2.0', method: 'notifications/initialized', params: {} };
    const sent =
      this.transport.notify === undefined
        ? this.transport.request(initialized, this.timeoutMs, this.options.signal)
        : this.transport.notify(initialized, this.timeoutMs, this.options.signal);

    await sent.catch(() => {
      // With the request fallback there is no response to wait for, so a timeout
      // is expected rather than a failure. The handshake is complete either way.
    });

    return used;
  }

  /**
   * Choose the revision to capture with.
   *
   * Attempts the preferred revision. If the server rejects it and advertises what
   * it does support, the newest mutually supported revision is selected instead,
   * and the caller is told a downgrade happened.
   */
  async negotiateRevision(): Promise<{
    requested: ProtocolRevision;
    used: ProtocolRevision;
    downgraded: boolean;
    discover: DiscoverOutcome;
  }> {
    const requested = this.options.preferredRevision ?? SUPPORTED_REVISIONS[0];
    const discover = await this.discoverOrRestart(requested);

    // The era probe said this is a handshake era server (MS-STDIO-008).
    //
    // Proceeding as though it were modern is the trap this whole path exists to
    // avoid. A legacy server will happily answer an era ambiguous method such as
    // `tools/list` under legacy semantics while ignoring the modern `_meta` it
    // does not understand, so the capture succeeds and records a revision the
    // server does not actually speak. That is precisely the "never silently
    // present a downgraded capture as a current one" failure.
    if (discover.era === 'legacy') {
      if (this.options.allowDowngrade === false) {
        throw new VersionNegotiationError(
          `Server may speak a handshake era revision rather than ${requested}, and downgrade is disabled`,
          { details: { requested, probeErrorCode: discover.probeErrorCode } },
        );
      }

      // The probe result is genuinely ambiguous here, and pretending otherwise
      // breaks one case or the other.
      //
      // A server answering `-32601` to `server/discover` is either a legacy
      // server that has never heard of the method, or a modern server that
      // failed to implement a MUST. The specification cannot distinguish them
      // from the error code alone, and says so.
      //
      // So the handshake is attempted rather than assumed. If it succeeds, the
      // server is legacy and the capture records the older revision honestly. If
      // it fails, the server is modern and merely non conforming, which is
      // exactly the server this package exists to inspect. Refusing to capture
      // it would be the worse of the two failures.
      try {
        const used = await this.initializeLegacy(LEGACY_REVISION);

        this.logger.warn('server is handshake era, capturing at the older revision', {
          requested,
          used,
        });

        return { requested, used, downgraded: true, discover };
      } catch {
        this.logger.debug('initialize was refused, treating the server as modern', {
          probeErrorCode: discover.probeErrorCode,
        });
      }
    }

    // A modern server that simply did not implement server/discover. Proceed as
    // requested; the missing method is a finding the conformance engine reports.
    if (!discover.implemented || discover.supportedVersions.length === 0) {
      return { requested, used: requested, downgraded: false, discover };
    }

    if (discover.supportedVersions.includes(requested)) {
      return { requested, used: requested, downgraded: false, discover };
    }

    const best = selectBestRevision(discover.supportedVersions);

    if (best === undefined) {
      throw new VersionNegotiationError(
        `No mutually supported protocol revision. Server supports ${discover.supportedVersions.join(', ')}`,
        { details: { requested, serverSupported: [...discover.supportedVersions] } },
      );
    }

    if (this.options.allowDowngrade === false) {
      throw new VersionNegotiationError(
        `Server does not support ${requested} and downgrade is disabled`,
        { details: { requested, available: best } },
      );
    }

    this.logger.warn('protocol downgrade', { requested, used: best });

    return { requested, used: best, downgraded: true, discover };
  }

  /**
   * Capture a server's full advertised surface.
   *
   * Records which revision was actually used, so a downgraded capture can never be
   * mistaken for a current one.
   */
  async captureSurface(server: ServerRef, transportKind: TransportKind): Promise<ServerSurface> {
    return (await this.capture(server, transportKind)).surface;
  }

  /**
   * Capture a surface and retain the evidence needed to grade it.
   *
   * Same work as {@link captureSurface}, but keeps the raw list results and error
   * responses so the conformance engine can grade them without a second capture.
   */
  async capture(server: ServerRef, transportKind: TransportKind): Promise<CaptureResult> {
    const startedAt = Date.now();
    const negotiation = await this.negotiateRevision();
    const revision = negotiation.used;

    const listResults: { method: string; result: JsonObject }[] = [];
    const methodErrors: { method: string; code: number; message: string }[] = [];

    const capabilities = negotiation.discover.capabilities;
    const descriptors: Descriptor[] = [];
    const maxDescriptors = this.options.maxDescriptors ?? 10_000;

    for (const endpoint of LIST_ENDPOINTS) {
      // Capability driven: a server that does not declare prompts is not asked
      // for them, and is never failed for not having them. No false findings for
      // unclaimed features.
      if (capabilities !== undefined && !(endpoint.capability in capabilities)) {
        this.logger.debug('skipping undeclared capability', { method: endpoint.method });
        continue;
      }

      const values = await this.collectPages(endpoint.method, endpoint.resultKey, revision, {
        stage: endpoint.stage,
        limit: maxDescriptors - descriptors.length,
        listResults,
        methodErrors,
      });

      descriptors.push(...buildDescriptors(endpoint.category, values));

      if (descriptors.length >= maxDescriptors) {
        this.logger.warn('descriptor limit reached, capture truncated', {
          limit: maxDescriptors,
        });
        break;
      }
    }

    const surface: ServerSurface = {
      server,
      revisionUsed: revision,
      revisionRequested: negotiation.requested,
      transport: transportKind,
      capturedAt: new Date().toISOString(),
      capabilities,
      serverInfo: negotiation.discover.serverInfo,
      descriptors,
      hashes: computeSurfaceHashes(descriptors),
      durationMs: Date.now() - startedAt,
    };

    return {
      surface,
      evidence: {
        discover: negotiation.discover,
        negotiation: {
          requested: negotiation.requested,
          used: negotiation.used,
          downgraded: negotiation.downgraded,
        },
        listResults,
        methodErrors,
      },
    };
  }

  /**
   * Follow a paginated list endpoint to exhaustion.
   *
   * A repeated cursor is treated as a protocol violation rather than followed,
   * because the alternative is an infinite loop against a server that may be
   * hostile rather than merely broken.
   */
  private async collectPages(
    method: string,
    resultKey: string,
    revision: ProtocolRevision,
    options: {
      stage: CaptureProgress['stage'];
      limit: number;
      listResults: { method: string; result: JsonObject }[];
      methodErrors: { method: string; code: number; message: string }[];
    },
  ): Promise<JsonValue[]> {
    const collected: JsonValue[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params: Record<string, JsonValue> = cursor === undefined ? {} : { cursor };
      const response = await this.send(method, revision, params);

      const error = readError(response);
      if (error !== undefined) {
        options.methodErrors.push({ method, code: error.code, message: error.message });

        // A server that does not implement an endpoint simply has none of that
        // category. That is a legitimate shape, not a failure.
        if (error.code === -32601) {
          this.logger.debug('endpoint not implemented', { method });
          return collected;
        }

        throw new ProtocolViolationError(`${method} failed: ${error.message}`, {
          details: { method, code: error.code },
        });
      }

      const result = readResult(response);
      if (result === undefined) {
        throw new ProtocolViolationError(`${method} returned neither a result nor an error`, {
          details: { method },
        });
      }

      options.listResults.push({ method, result });

      const items = result[resultKey];
      if (items !== undefined && isJsonArray(items)) collected.push(...items);

      this.options.onProgress?.({ stage: options.stage, received: collected.length });

      if (collected.length >= options.limit) return collected.slice(0, options.limit);

      const nextCursor = result['nextCursor'];
      if (typeof nextCursor !== 'string' || nextCursor.length === 0) return collected;

      if (seenCursors.has(nextCursor)) {
        throw new ProtocolViolationError(
          `${method} returned a repeating pagination cursor, which would loop forever`,
          { details: { method, page } },
        );
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new ProtocolViolationError(
      `${method} exceeded ${String(MAX_PAGES)} pages without completing`,
      { details: { method } },
    );
  }

  /**
   * Send one request, with retries and backoff.
   *
   * Only transport failures are retried. A protocol level error is a real answer
   * from the server and retrying it would just ask the same question again. A
   * cancellation is never retried, because the caller has already said stop.
   */
  private async send(
    method: string,
    revision: ProtocolRevision,
    params: Record<string, JsonValue>,
  ): Promise<JsonObject> {
    const retries = this.options.retries ?? 2;
    const backoff = this.options.retryBackoffMs ?? 250;

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      this.throwIfAborted();

      const request = buildRequest({
        id: this.nextId(),
        method,
        revision,
        params,
        // The legacy era has no per request metadata; it establishes state with a
        // handshake instead, so sending `_meta` there would be meaningless.
        ...(eraOf(revision) === 'legacy' ? { omitMeta: true } : {}),
      });

      try {
        const response = await this.transport.request(
          request,
          this.timeoutMs,
          this.options.signal,
        );

        const record = asObject(response);
        if (record === undefined) {
          throw new ProtocolViolationError(`${method} response was not a JSON object`, {
            details: { method },
          });
        }

        return record;
      } catch (error) {
        lastError = error;

        if (error instanceof CancellationError) throw error;
        if (!(error instanceof TransportError || error instanceof TimeoutError)) throw error;

        if (attempt === retries) break;

        // A server process that has exited will not answer a retry either. Each
        // one failed instantly, after a growing backoff, and only delayed the
        // real report.
        if (this.transport.isRunning === false) break;

        const delay = backoff * 2 ** attempt;
        this.logger.debug('retrying after transport failure', { method, attempt, delay });
        await sleep(delay, this.options.signal);
      }
    }

    throw lastError;
  }

  private throwIfAborted(): void {
    if (this.options.signal?.aborted === true) {
      throw new CancellationError('Capture cancelled by the caller');
    }
  }

  async dispose(): Promise<void> {
    await this.transport.dispose();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Not unref'd. This is the backoff between capture retries, and an
    // unref'd timer here was the direct cause of `conform` against a server
    // that dies on spawn exiting with ERR_UNSETTLED_TOP_LEVEL_AWAIT: the child
    // was gone, so nothing else held the loop open, the backoff timer could not,
    // and Node exited while the caller was still awaiting the capture. The abort
    // path clears it, so a cancelled capture does not wait out the delay.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CancellationError('Capture cancelled while backing off'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Narrow a JSON value to an object.
 *
 * Uses the shared type guard rather than an inline `Array.isArray` check, because
 * `Array.isArray` does not remove `readonly JsonValue[]` from the union in the
 * negative branch, so an array would still be typed as an object here.
 */
/**
 * Narrow a JSON value to an array.
 *
 * Array.isArray alone widens the element type to any, which would let an
 * unchecked value spread straight into the descriptor list.
 */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined) return undefined;
  return isJsonObject(value) ? value : undefined;
}

function readResult(response: JsonObject): JsonObject | undefined {
  return asObject(response['result']);
}

interface JsonRpcErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data: JsonValue | undefined;
}

function readError(response: JsonObject): JsonRpcErrorShape | undefined {
  const error = asObject(response['error']);
  if (error === undefined) return undefined;

  const rawCode = error['code'];
  const code = isJsonNumber(rawCode) ? Number(rawCode.token) : Number.NaN;
  const message = typeof error['message'] === 'string' ? error['message'] : 'unknown error';

  return { code, message, data: error['data'] };
}

/**
 * Read the `supported` list from an `UnsupportedProtocolVersionError`.
 *
 * MS-ERR-006 requires `data.supported` and `data.requested`.
 */
function readSupportedVersions(data: JsonValue | undefined): readonly string[] {
  const record = asObject(data);
  if (record === undefined) return [];
  return readStringArray(record['supported']);
}

function readStringArray(value: JsonValue | undefined): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Read `_meta['io.modelcontextprotocol/serverInfo']` from a result. */
function readServerInfo(result: JsonObject): JsonObject | undefined {
  const meta = asObject(result['_meta']);
  if (meta === undefined) return undefined;
  return asObject(meta[META_KEYS.serverInfo]);
}

/** Content hash of a surface, for callers that only need the root. */
export function surfaceRootOf(surface: ServerSurface): string {
  return surface.hashes.root;
}

/** A stable server id derived from its endpoint, for pins and ledger entries. */
export function deriveServerId(name: string, endpoint: string): string {
  return hashCanonicalForm(`${name}${endpoint}`).slice('sha256:'.length, 16 + 7);
}
