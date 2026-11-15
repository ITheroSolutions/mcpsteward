/**
 * The protocol faculty: a client that speaks MCP over stdio or Streamable HTTP.
 *
 * `package.json` has always exported `mcpsteward/protocol`, but until 0.2.0 no
 * module stood behind it, so importing it failed. Most callers want
 * `mcpsteward/api` instead, which assembles these pieces.
 */

export {
  deriveServerId,
  McpClient,
  surfaceRootOf,
  type CaptureEvidence,
  type CaptureOptions,
  type CaptureProgress,
  type CaptureResult,
  type DiscoverOutcome,
  type ToolCallOptions,
  type ToolCallResult,
  type Transport,
} from './client.js';

export { HttpTransport, type HttpTransportOptions } from './http-transport.js';

export { StdioTransport, type StdioTransportOptions } from './stdio-transport.js';

export {
  buildHttpHeaders,
  buildRequest,
  buildRequestMeta,
  CLIENT_INFO,
  JSONRPC_ERROR_CODES,
  MCP_ERROR_CODES,
  META_KEYS,
  type Implementation,
  type JsonRpcRequestOptions,
  type RequestMetaOptions,
} from './messages.js';
