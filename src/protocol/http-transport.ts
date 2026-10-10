/**
 * Streamable HTTP transport.
 *
 * Every JSON-RPC message is its own POST to a single endpoint (MS-HTTP-001). The
 * server answers with either a single JSON object or an SSE stream scoped to that
 * request, and the client must support both (MS-HTTP-007).
 *
 * ## What this revision removed
 *
 * There is no session and no `Mcp-Session-Id` (MS-HTTP-012). There is no GET
 * stream endpoint. There is no `Last-Event-ID` resumability: a broken response
 * stream loses the in-flight request and the client re-issues it as a new request
 * with a new id. None of that machinery exists here, and its absence is the point
 * rather than an omission.
 *
 * ## Why there is a raw probe alongside the normal request path
 *
 * Most of the HTTP conformance rules are about the *envelope* rather than the
 * body: a `400` with `-32020` when headers disagree with the body, a `404` with
 * `-32601` for an unknown method, a `405` for a GET. A transport that only ever
 * returns a parsed JSON-RPC result throws that evidence away. {@link rawRequest}
 * keeps the status line and headers so the conformance engine can grade them.
 */

import {
  AuthenticationRequiredError,
  CancellationError,
  McpStewardError,
  TimeoutError,
  TransportError,
} from '../core/errors.js';
import { parseJsonPreservingNumbers, type JsonValue } from '../core/json-parse.js';
import { NOOP_LOGGER, type Logger } from '../core/logger.js';
import type { ProtocolRevision } from '../core/revisions.js';
import {
  buildHttpHeaders,
  METHODS_REQUIRING_NAME_HEADER,
  serializeForStdio,
} from './messages.js';

/** Cap on a response body, so a hostile endpoint cannot exhaust memory. */
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface HttpTransportOptions {
  readonly url: string;
  /** Extra headers, typically authorization supplied by the caller. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly logger?: Logger;
  readonly maxResponseBytes?: number;
  /** Overrides the revision read from the outgoing message. Only for probing. */
  readonly revision?: ProtocolRevision;
}

/** A complete HTTP exchange, kept intact so conformance rules can grade it. */
export interface RawHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType: string;
  /** The raw body text. For an SSE response, the concatenated data payloads. */
  readonly bodyText: string;
  /** The parsed JSON-RPC message, when the body contained one. */
  readonly message: JsonValue | undefined;
  /** True when the server answered with `text/event-stream`. */
  readonly streamed: boolean;
}

export interface RawRequestOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Override the HTTP method. Only for probing MS-HTTP-011. */
  readonly httpMethod?: string;
  /** Replace the computed headers wholesale. Only for probing. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Send this body verbatim instead of serialising the message. Only for probing. */
  readonly rawBody?: string;
}

export class HttpTransport {
  private readonly logger: Logger;
  private readonly maxResponseBytes: number;
  private disposed = false;

  /**
   * Set only by a legacy `initialize` handshake.
   *
   * The 2026-07-28 revision has no sessions (MS-HTTP-012), but the handshake era
   * revisions this package still captures do: the server issues an
   * `Mcp-Session-Id` in its `initialize` response and refuses every later request
   * that does not carry it, answering "Server not initialized". Without this, no
   * session based legacy server could be captured over HTTP at all.
   */
  private sessionId: string | undefined;

  /**
   * The revision a legacy handshake settled on. Legacy requests carry no `_meta`
   * revision, and without this their `MCP-Protocol-Version` header would claim
   * 2026-07-28, which a strict legacy server rejects with 400.
   */
  private negotiatedRevision: string | undefined;

  constructor(private readonly options: HttpTransportOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  /**
   * Send a request and return the parsed JSON-RPC response.
   *
   * Satisfies the `Transport` interface the capture client depends on.
   */
  async request(
    message: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const response = await this.rawRequest(message, { timeoutMs, ...(signal ? { signal } : {}) });

    // Checked before the body is interpreted at all. Servers phrase a refusal in
    // every shape: a vendor JSON error, a plain string, even a JSON-RPC error. The
    // status is the one signal they agree on.
    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationRequiredError(
        `${this.host} requires you to sign in before it will describe itself (HTTP ${String(response.status)}). ` +
          'mcpsteward does not sign in to servers, so it cannot see what this one advertises.',
        {
          details: {
            status: response.status,
            host: this.host,
            // A WWW-Authenticate challenge usually means OAuth. Recorded so a
            // report can say what kind of sign in the server expects.
            challenge: response.headers['www-authenticate'] !== undefined,
          },
        },
      );
    }

    if (response.message === undefined) {
      throw new TransportError(
        `Server returned HTTP ${String(response.status)} with no JSON-RPC message`,
        { details: { status: response.status, contentType: response.contentType } },
      );
    }

    return response.message;
  }

  /**
   * Send a notification. The server answers `202 Accepted` with no body
   * (MS-HTTP-006), so there is nothing to return.
   */
  async notify(
    message: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.rawRequest(message, { timeoutMs, ...(signal ? { signal } : {}) });
  }

  /** The endpoint's host, safe to print. The full URL can carry a token in its query. */
  private get host(): string {
    try {
      return new URL(this.options.url).host;
    } catch {
      return 'the server';
    }
  }

  /**
   * Send a request and return the whole exchange.
   *
   * A non `2xx` status is not an error here. Several conformance rules require a
   * specific error status paired with a specific JSON-RPC code, so a `400` with
   * `-32020` is a *correct* answer that the engine needs to see rather than a
   * failure to swallow.
   */
  async rawRequest(
    message: Record<string, unknown>,
    options: RawRequestOptions,
  ): Promise<RawHttpResponse> {
    if (this.disposed) throw new TransportError('Transport has been disposed');

    const method = typeof message['method'] === 'string' ? message['method'] : '';
    const headers = options.headers ?? this.headersFor(message, method);

    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // Not unref'd, matching the stdio transport. This timer aborts a fetch the
    // caller is awaiting, so it must be able to hold the event loop open. An
    // in flight fetch usually holds it anyway through its socket, which makes
    // the failure rarer here than on stdio rather than impossible. The finally
    // below clears it on every path.
    const timer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs);

    try {
      const body =
        options.rawBody ??
        // Reuse the stdio serialiser for its embedded newline assertion, then
        // drop the trailing newline HTTP does not want.
        serializeForStdio(message).slice(0, -1);

      const response = await fetch(this.options.url, {
        method: options.httpMethod ?? 'POST',
        headers: { ...headers, ...this.options.headers },
        ...(options.httpMethod === 'GET' || options.httpMethod === 'DELETE' ? {} : { body }),
        signal: controller.signal,
        redirect: 'manual',
      });

      const exchange = await this.readResponse(response);
      if (method === 'initialize') this.observeHandshake(exchange);
      return exchange;
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new CancellationError('Request cancelled by the caller');
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new TimeoutError(`Request timed out after ${String(options.timeoutMs)}ms`, {
          details: { timeoutMs: options.timeoutMs, method },
        });
      }

      if (error instanceof McpStewardError) throw error;

      throw new TransportError(`Could not reach ${this.host}: ${describeNetworkFailure(error)}`, {
        details: { method, host: this.host, code: networkErrorCode(error) },
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private headersFor(
    message: Record<string, unknown>,
    method: string,
  ): Record<string, string> {
    const revision = this.options.revision ?? this.revisionFromMessage(message, method);
    const params = message['params'];
    const name = readNameForHeader(params, method);

    const headers = buildHttpHeaders({
      revision,
      method,
      ...(name === undefined ? {} : { name }),
    });

    if (this.sessionId !== undefined) headers['Mcp-Session-Id'] = this.sessionId;

    return headers;
  }

  /**
   * Remember what a legacy `initialize` handshake established: the session the
   * server issued, and the revision it agreed to.
   */
  private observeHandshake(exchange: RawHttpResponse): void {
    if (exchange.status < 200 || exchange.status >= 300) return;

    const session = exchange.headers['mcp-session-id'];
    // The session id must be visible ASCII; anything else is not echoed back.
    if (session !== undefined && /^[\x21-\x7e]{1,512}$/.test(session)) this.sessionId = session;

    const message = exchange.message;
    if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
      const result = (message as Record<string, unknown>)['result'];
      if (typeof result === 'object' && result !== null) {
        const version = (result as Record<string, unknown>)['protocolVersion'];
        if (typeof version === 'string') this.negotiatedRevision = version;
      }
    }
  }

  /**
   * Read the revision out of the outgoing message body.
   *
   * MS-HTTP-002 requires the `MCP-Protocol-Version` header to match the body's
   * `_meta` value, so taking it from anywhere else would risk sending a request
   * that is non conforming by construction.
   */
  private revisionFromMessage(message: Record<string, unknown>, method: string): ProtocolRevision {
    const params = message['params'];

    if (typeof params === 'object' && params !== null) {
      const record = params as Record<string, unknown>;
      const meta = record['_meta'];
      if (typeof meta === 'object' && meta !== null) {
        const version = (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'];
        if (typeof version === 'string') return version as ProtocolRevision;
      }

      // A legacy handshake carries its revision in the body instead of `_meta`.
      if (method === 'initialize' && typeof record['protocolVersion'] === 'string') {
        return record['protocolVersion'] as ProtocolRevision;
      }
    }

    // Every later legacy request speaks the revision the handshake agreed.
    if (this.negotiatedRevision !== undefined) return this.negotiatedRevision as ProtocolRevision;

    return '2026-07-28';
  }

  private async readResponse(response: Response): Promise<RawHttpResponse> {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const contentType = headers['content-type'] ?? '';
    const streamed = contentType.includes('text/event-stream');

    const bodyText = await this.readBody(response);

    // A 202 Accepted for a notification carries no body by design (MS-HTTP-006).
    if (bodyText.length === 0) {
      return { status: response.status, headers, contentType, bodyText, message: undefined, streamed };
    }

    const payload = streamed ? lastSseData(bodyText) : bodyText;

    if (payload === undefined) {
      return { status: response.status, headers, contentType, bodyText, message: undefined, streamed };
    }

    let message: JsonValue | undefined;
    try {
      message = parseJsonPreservingNumbers(payload);
    } catch {
      // A body that is not JSON is itself a finding for the conformance engine.
      // The exchange is returned intact so the engine can grade it.
      this.logger.debug('response body was not valid JSON', { status: response.status });
      message = undefined;
    }

    // Valid JSON is not necessarily a JSON-RPC message. Hosted servers answer an
    // unauthenticated request with their own error shapes, such as
    // `{"error":"invalid_token"}` or `{"message":"Unauthorized"}`, and treating
    // those as protocol messages produced the baffling report "returned neither
    // a result nor an error". The body stays in `bodyText` for grading.
    if (message !== undefined && !looksLikeJsonRpc(message)) {
      this.logger.debug('response body was JSON but not JSON-RPC', { status: response.status });
      message = undefined;
    }

    return { status: response.status, headers, contentType, bodyText, message, streamed };
  }

  private async readBody(response: Response): Promise<string> {
    if (response.body === null) return '';

    // `response.body` is typed `ReadableStream<any>` by the bundled fetch types,
    // so the chunk type has to be stated. It is narrowed rather than widened: the
    // stream yields `Uint8Array` at runtime, and asserting that is what keeps the
    // byte counting below meaningful.
    //
    // The alternative was `response.arrayBuffer()`, which types cleanly but
    // downloads the whole body before the size cap can reject it, turning the
    // cap into an assertion rather than a defence.
    const body = response.body as ReadableStream<Uint8Array>;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      bytes += value.byteLength;
      if (bytes > this.maxResponseBytes) {
        await reader.cancel();
        throw new TransportError(
          `Response exceeded ${String(this.maxResponseBytes)} bytes`,
          { details: { limit: this.maxResponseBytes } },
        );
      }

      text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;

    // A legacy session is closed explicitly, which the handshake era revisions
    // ask clients to do. Best effort only: disposal must never hang or throw on
    // account of a server that has already gone.
    if (this.sessionId !== undefined) {
      try {
        await this.rawRequest(
          {},
          {
            timeoutMs: 2_000,
            httpMethod: 'DELETE',
            headers: {
              'Mcp-Session-Id': this.sessionId,
              ...(this.negotiatedRevision === undefined
                ? {}
                : { 'MCP-Protocol-Version': this.negotiatedRevision }),
            },
          },
        );
      } catch {
        // Nothing useful to do; the session will expire on the server.
      }
    }

    this.disposed = true;
  }
}

/**
 * Whether a parsed body is shaped like a JSON-RPC message at all.
 *
 * Deliberately loose: a response missing `jsonrpc` but carrying a `result` is
 * still a JSON-RPC answer, a malformed one the conformance engine needs to see.
 * What is excluded is JSON with none of the markers, and an `error` that is a
 * plain string, which JSON-RPC never uses and vendor error bodies often do.
 */
function looksLikeJsonRpc(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(looksLikeJsonRpc);
  if (typeof value !== 'object' || value === null) return false;

  const record = value as Record<string, unknown>;
  const error = record['error'];

  return (
    record['jsonrpc'] !== undefined ||
    'result' in record ||
    'method' in record ||
    (typeof error === 'object' && error !== null)
  );
}

/** The system error code behind a failed fetch, such as ECONNREFUSED. */
function networkErrorCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Say why a fetch failed in words.
 *
 * Node reports every network failure as the same bare "fetch failed", with the
 * real reason on `cause`. A local server that simply is not running produced
 * "HTTP request failed: fetch failed", which reads like a defect.
 */
function describeNetworkFailure(error: unknown): string {
  const code = networkErrorCode(error);

  switch (code) {
    case 'ECONNREFUSED':
      return 'nothing is listening there (connection refused). If this is a local server, it is probably not running.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'the host name could not be resolved.';
    case 'ECONNRESET':
      return 'the connection was reset by the server.';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return 'the connection attempt timed out.';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `its TLS certificate was rejected (${code}).`;
    default: {
      const message = error instanceof Error ? error.message : 'unknown error';
      return code === undefined ? message : `${message} (${code})`;
    }
  }
}

/**
 * Extract the final JSON-RPC message from an SSE body.
 *
 * The server may emit progress notifications before the response, and the final
 * response SHOULD terminate the stream, so the last data payload is the answer.
 * Comment lines beginning with a colon are keep-alives and carry no event data;
 * the SSE specification requires clients to ignore them rather than treat them as
 * malformed, which matters because servers are encouraged to send them on long
 * lived streams.
 */
export function lastSseData(body: string): string | undefined {
  const payloads: string[] = [];
  let current: string[] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine.length === 0) {
      if (current.length > 0) {
        payloads.push(current.join('\n'));
        current = [];
      }
      continue;
    }

    // A keep-alive comment. Ignore it.
    if (rawLine.startsWith(':')) continue;

    if (rawLine.startsWith('data:')) {
      // A single optional space after the colon is part of the framing.
      const value = rawLine.slice('data:'.length);
      current.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }

  if (current.length > 0) payloads.push(current.join('\n'));

  return payloads.at(-1);
}

/**
 * Read the value the `Mcp-Name` header must carry.
 *
 * `params.name` for `tools/call` and `prompts/get`, `params.uri` for
 * `resources/read` (MS-HTTP-003).
 */
function readNameForHeader(params: unknown, method: string): string | undefined {
  if (!METHODS_REQUIRING_NAME_HEADER.has(method)) return undefined;
  if (typeof params !== 'object' || params === null) return undefined;

  const record = params as Record<string, unknown>;
  const name = record['name'];
  if (typeof name === 'string') return name;

  const uri = record['uri'];
  if (typeof uri === 'string') return uri;

  return undefined;
}
