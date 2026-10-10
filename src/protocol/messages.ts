/**
 * JSON-RPC message construction for both protocol eras.
 *
 * The 2026-07-28 revision is stateless: there is no handshake and no session, so
 * every request carries its own protocol version and client capabilities in
 * `_meta`. That makes request construction the whole of the client's protocol
 * knowledge, which is why it lives in one small module.
 *
 * ## Why this is deliberately permissive
 *
 * A conformance prober has to send requests that are wrong on purpose. Rules like
 * MS-META-001 (the server must reject a request missing required `_meta` fields
 * with `-32602`) can only be tested by sending exactly the request a correct client
 * is built to make impossible. So the builders here take an options bag that can
 * omit required fields, and the *correct* shape is the default rather than the only
 * possibility.
 */

import type { JsonValue } from '../core/json-parse.js';
import type { ProtocolRevision } from '../core/revisions.js';
import { VERSION } from '../cli/help.js';

/** Reserved `_meta` keys, exactly as the specification names them. */
export const META_KEYS = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  logLevel: 'io.modelcontextprotocol/logLevel',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  progressToken: 'progressToken',
} as const;

/** HTTP headers the transport mirrors from the body. */
export const HTTP_HEADERS = {
  protocolVersion: 'MCP-Protocol-Version',
  method: 'Mcp-Method',
  name: 'Mcp-Name',
} as const;

/** Error codes defined by this revision. */
export const MCP_ERROR_CODES = {
  headerMismatch: -32020,
  missingRequiredClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
} as const;

/** JSON-RPC codes used by the protocol. */
export const JSONRPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/**
 * Error codes this revision forbids implementations from emitting.
 *
 * Retired rather than reused, exactly as the specification retires them. See
 * MS-ERR-002.
 */
export const RETIRED_ERROR_CODES = {
  /** Resource not found in 2025-11-25 and earlier. Replaced by `-32602`. */
  resourceNotFound: -32002,
  /** URL elicitation required, 2025-11-25 only. */
  urlElicitationRequired: -32042,
} as const;

export interface Implementation {
  readonly name: string;
  readonly version: string;
}

/** How mcpsteward identifies itself. Self reported, never a security control. */
export const CLIENT_INFO: Implementation = {
  name: 'mcpsteward',
  version: VERSION,
};

export interface RequestMetaOptions {
  readonly revision: ProtocolRevision;
  /** Capabilities to declare. Defaults to an empty object, which is valid. */
  readonly capabilities?: Record<string, JsonValue>;
  /** Client identity. Omitted when `false`, which the specification permits. */
  readonly clientInfo?: Implementation | false;
  readonly logLevel?: string;
  readonly progressToken?: string | number;

  /**
   * Deliberately omit `io.modelcontextprotocol/protocolVersion`.
   *
   * Only for probing MS-META-001. A conforming client never does this.
   */
  readonly omitProtocolVersion?: boolean;

  /**
   * Deliberately omit `io.modelcontextprotocol/clientCapabilities`.
   *
   * Only for probing MS-META-001. A conforming client never does this.
   */
  readonly omitCapabilities?: boolean;
}

/** Build the `_meta` object for a modern request. */
export function buildRequestMeta(options: RequestMetaOptions): Record<string, JsonValue> {
  const meta: Record<string, JsonValue> = {};

  if (options.omitProtocolVersion !== true) {
    meta[META_KEYS.protocolVersion] = options.revision;
  }

  if (options.clientInfo !== false) {
    const info = options.clientInfo ?? CLIENT_INFO;
    meta[META_KEYS.clientInfo] = { name: info.name, version: info.version };
  }

  if (options.omitCapabilities !== true) {
    meta[META_KEYS.clientCapabilities] = options.capabilities ?? {};
  }

  if (options.logLevel !== undefined) meta[META_KEYS.logLevel] = options.logLevel;

  if (options.progressToken !== undefined) {
    meta[META_KEYS.progressToken] =
      typeof options.progressToken === 'number'
        ? { __jsonNumber: true, token: String(options.progressToken) }
        : options.progressToken;
  }

  return meta;
}

export interface JsonRpcRequestOptions extends RequestMetaOptions {
  readonly id: string | number;
  readonly method: string;
  /** Method parameters, excluding `_meta`, which is built separately. */
  readonly params?: Record<string, JsonValue>;
  /** Omit `_meta` entirely. Only for probing. */
  readonly omitMeta?: boolean;
}

/**
 * Build a modern JSON-RPC request as a plain serialisable object.
 *
 * Returned as a value rather than as text so the transport can decide framing, and
 * so tests can assert on structure rather than on string matching.
 */
export function buildRequest(options: JsonRpcRequestOptions): Record<string, unknown> {
  const params: Record<string, unknown> = { ...options.params };

  if (options.omitMeta !== true) {
    params['_meta'] = buildRequestMeta(options);
  }

  return {
    jsonrpc: '2.0',
    id: options.id,
    method: options.method,
    params,
  };
}

/**
 * Serialise a message for the stdio transport.
 *
 * One message per line, and the message must not contain an embedded newline
 * (MS-STDIO-001). `JSON.stringify` escapes newlines inside strings, so the only
 * way one could appear is a bug here; the assertion makes that loud rather than
 * silently corrupting the peer's parser.
 */
export function serializeForStdio(message: unknown): string {
  const text = JSON.stringify(message);

  /* c8 ignore next 3 -- unreachable unless JSON.stringify changes semantics */
  if (text.includes('\n')) {
    throw new Error('Refusing to write a stdio message containing an embedded newline');
  }

  return `${text}\n`;
}

/**
 * Headers a conforming client sends with a Streamable HTTP POST.
 *
 * `Mcp-Name` is required for `tools/call`, `resources/read` and `prompts/get`, and
 * carries `params.name` or `params.uri` (MS-HTTP-003). Values outside the safe
 * ASCII set are carried in the `=?base64?...?=` sentinel form.
 */
export function buildHttpHeaders(options: {
  readonly revision: ProtocolRevision;
  readonly method: string;
  readonly name?: string;
  readonly omitProtocolVersionHeader?: boolean;
  readonly omitMethodHeader?: boolean;
  readonly omitNameHeader?: boolean;
  /** Force a mismatched header value, for probing MS-HTTP-004. */
  readonly overrideName?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  if (options.omitProtocolVersionHeader !== true) {
    headers[HTTP_HEADERS.protocolVersion] = options.revision;
  }

  if (options.omitMethodHeader !== true) {
    headers[HTTP_HEADERS.method] = options.method;
  }

  const nameValue = options.overrideName ?? options.name;
  if (nameValue !== undefined && options.omitNameHeader !== true) {
    headers[HTTP_HEADERS.name] = encodeHeaderValue(nameValue);
  }

  return headers;
}

/** Methods that require the `Mcp-Name` header, per MS-HTTP-003. */
export const METHODS_REQUIRING_NAME_HEADER = new Set([
  'tools/call',
  'resources/read',
  'prompts/get',
]);

/**
 * Encode a header value, using the Base64 sentinel when it cannot be carried
 * safely as plain ASCII.
 *
 * Per the specification, a value must be encoded when it contains non ASCII,
 * control characters, or leading or trailing whitespace. A plain ASCII value that
 * happens to look like the sentinel must also be encoded, so a tool genuinely
 * named `=?base64?x?=` cannot be confused for an encoded value.
 */
export function encodeHeaderValue(value: string): string {
  if (needsBase64(value)) {
    return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
  }
  return value;
}

/** Decode a header value that may be in the Base64 sentinel form. */
export function decodeHeaderValue(value: string): string {
  if (value.startsWith('=?base64?') && value.endsWith('?=')) {
    const encoded = value.slice('=?base64?'.length, -'?='.length);
    return Buffer.from(encoded, 'base64').toString('utf8');
  }
  return value;
}

function needsBase64(value: string): boolean {
  if (value.startsWith('=?base64?') && value.endsWith('?=')) return true;
  if (value !== value.trim()) return true;

  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // Visible ASCII plus space and horizontal tab, per RFC 9110 field values.
    if (code !== 0x09 && (code < 0x20 || code > 0x7e)) return true;
  }

  return false;
}
