# SPEC-NOTES.md

Source of truth for every protocol claim in this codebase. If code and this file
disagree, the code is wrong.

## Provenance

Every requirement below was extracted from a page fetched live on 2026-07-30 from the
official specification site. Nothing here is written from model memory. The
2026-07-28 revision postdates the assistant training cutoff, so unfetched material is
treated as unknown rather than guessed.

Pages fetched and used:

| Source | URL |
| --- | --- |
| Key Changes (changelog) | https://modelcontextprotocol.io/specification/2026-07-28/changelog |
| Base protocol overview | https://modelcontextprotocol.io/specification/2026-07-28/basic/index |
| Versioning and Compatibility | https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning |
| Streamable HTTP transport | https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http |
| Discovery (`server/discover`) | https://modelcontextprotocol.io/specification/2026-07-28/server/discover |
| Caching | https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching |

Pages not yet fetched, so no rule may cite them until they are:
`basic/patterns/mrtr`, `basic/patterns/subscriptions`, `basic/transports/stdio`,
`server/tools`, `server/resources`, `server/prompts`, `basic/authorization/*`,
`server/utilities/pagination`, `schema`. Rules that would depend on these are listed
in VERIFY.md as deferred rather than invented.

## Revisions supported

| Revision | Era | Support in mcpsteward |
| --- | --- | --- |
| `2026-07-28` | modern, stateless, per request metadata | full, primary target |
| `2025-11-25` | legacy, `initialize` handshake, sessions | capture and downgrade detection only |

Era terminology is the specification's own, defined in Versioning and Compatibility:
**modern** means version, identity and capabilities travel as per request metadata
(`2026-07-28` and later). **legacy** means a session is established by an `initialize`
handshake (`2025-11-25` and earlier). **dual era** means both are supported.

## SEP index

Every entry below was verified against the specification changelog rather than taken
on trust from a summary. SEP-2575 is worth singling out: it is the largest single
source of breaking change in this revision, and it is routinely absent from informal
lists of what changed.

| SEP | Subject |
| --- | --- |
| SEP-2567 | Remove protocol level sessions and `Mcp-Session-Id` |
| SEP-2575 | Statelessness, removal of `initialize`, `server/discover`, `subscriptions/listen`, removal of `ping` and `logging/setLevel`, removal of SSE resumability |
| SEP-2322 | Multi Round Trip Requests, `resultType`, `InputRequiredResult` |
| SEP-2549 | `ttlMs` and `cacheScope` via `CacheableResult` |
| SEP-2243 | `Mcp-Method` and `Mcp-Name` headers, `x-mcp-header` |
| SEP-2663 | Tasks moved to the `io.modelcontextprotocol/tasks` extension |
| SEP-2577 | Deprecate Roots, Sampling, Logging |
| SEP-2596 | Feature lifecycle policy, deprecate HTTP+SSE transport |
| SEP-2106 | Loosen `inputSchema` and `outputSchema`, `$ref` bounds |
| SEP-2468 | `iss` parameter validation in authorization responses |
| SEP-2352 | Client credentials keyed by issuer |
| SEP-837 | `application_type` in Dynamic Client Registration |
| SEP-414 | OpenTelemetry trace context in `_meta` |

## Observability model

mcpsteward inspects a server while acting as a client. Requirements are therefore
classified by who they bind and whether an external client can observe compliance.

- **SERVER, observable**: eligible to become a graded conformance rule.
- **CLIENT**: binds the client, not the server under inspection. Never a graded rule.
  Recorded here because the migration analyzer checks client code against them.
- **SERVER, not externally observable**: recorded, but cannot be graded from the wire.

## Normative requirements

Each entry carries the rule id used by the conformance registry, the normative level,
the requirement, and the citation. Wording in quotes is verbatim from the cited page.

### Lifecycle and statelessness

**MS-LIFE-001** MUST, SERVER, observable
Servers MUST implement `server/discover`. Quote: "Servers **MUST** implement
`server/discover`."
Citation: Versioning and Compatibility, Protocol Version Negotiation; Discovery.

**MS-LIFE-002** MUST, SERVER, observable
A `DiscoverResult` includes `supportedVersions` (protocol versions the server supports)
and `capabilities`. `instructions` is optional.
Citation: Discovery, Data Types, DiscoverResult.

**MS-LIFE-003** SHOULD, SERVER, observable
Servers SHOULD include `_meta['io.modelcontextprotocol/serverInfo']` in the discover
result. Quote: "Servers **SHOULD** include this field."
Citation: Discovery, Data Types.

**MS-LIFE-004** SHOULD, SERVER, observable
Servers SHOULD include `io.modelcontextprotocol/serverInfo` in every result's `_meta`.
Quote: "Servers **SHOULD** include the following `io.modelcontextprotocol/*` field in
every result's `_meta`, unless specifically configured not to do so".
Citation: Base protocol overview, Per response protocol fields.

**MS-LIFE-005** MUST NOT, SERVER, partially observable
The `initialize` and `notifications/initialized` handshake is removed. A server
presenting itself as `2026-07-28` only should not require it. A modern only server
SHOULD name its supported versions in any error it returns to an `initialize` request.
Citation: Key Changes major change 2; Versioning and Compatibility, Backward
Compatibility.

**MS-LIFE-006** MUST NOT, SERVER, observable
Servers MUST NOT rely on prior requests over the same connection to establish context.
Quote: "Servers **MUST NOT** rely on prior requests over the same connection to
establish context (e.g., capabilities, protocol version, client identity)."
Citation: Base protocol overview, Statelessness.

**MS-LIFE-007** MUST, SERVER, observable
`ping`, `logging/setLevel` and `notifications/roots/list_changed` are removed. A
`2026-07-28` server receiving `ping` or `logging/setLevel` is expected to answer
method not found rather than implement them.
Citation: Key Changes major change 5.

### Results and result types

**MS-RES-001** MUST, SERVER, observable
Every result MUST include a `resultType` field. Quote: "The `result` **MUST** include a
`resultType` field to indicate the type of the result."
Citation: Base protocol overview, Result Responses.

**MS-RES-002** MUST, SERVER, observable
`resultType` is `"complete"` for ordinary results and `"input_required"` for MRTR
interim results. Extensions MAY add values, but only values advertised via capabilities.
Citation: Base protocol overview, ResultType; Key Changes major change 8.

**MS-RES-003** MUST, CLIENT
Clients MUST treat an absent `resultType` from earlier protocol servers as
`"complete"`.
Citation: Base protocol overview, ResultType.

### Caching

**MS-CACHE-001** MUST, SERVER, observable
Servers MUST include caching hints on results with `resultType: "complete"` returned by
`server/discover`, `tools/list`, `prompts/list`, `resources/list`,
`resources/templates/list` and `resources/read`. Quote: "Servers MUST include caching
hints on results with `resultType: \"complete\"` returned by the following operations".
Citation: Caching, Cacheable Results.

**MS-CACHE-002** MUST, SERVER, observable
Servers MUST provide a `ttlMs` value that is greater than or equal to zero. Quote:
"Servers **MUST** provide a `ttlMs` value that is `>= 0`."
`ttlMs` is an integer count of milliseconds.
Citation: Caching, Time to Live Field.

**MS-CACHE-003** MUST, SERVER, observable
`cacheScope` is either `"public"` or `"private"`. No other value is defined.
Citation: Caching, Cacheable Model and Cache Scope Field.

**MS-CACHE-004** MUST, SERVER, observable
Servers MUST apply the same `cacheScope` to all response pages for a given list request.
Quote: "Servers **MUST** apply the same `cacheScope` to all response pages for a given
list request."
Citation: Caching, Interaction with Pagination.

**MS-CACHE-005** MUST NOT, SERVER, not externally observable
Interim results with `resultType: "input_required"` are not cacheable and carry no
caching hints.
Citation: Caching, Cacheable Results.

### Per request metadata

**MS-META-001** MUST, SERVER, observable
A request missing a required `_meta` field is malformed and the server MUST reject it
with `-32602` (Invalid params), and on HTTP the status MUST be `400 Bad Request`.
Quote: "A request missing any required field is malformed; the server **MUST** reject it
with JSON-RPC error code `-32602` (Invalid params). On HTTP, the response status
**MUST** be `400 Bad Request`."
Required fields are `io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities`.
Citation: Base protocol overview, Per request protocol fields.

**MS-META-002** MUST, SERVER, observable
A server MUST NOT rely on capabilities the client has not declared, and MUST return
`MissingRequiredClientCapabilityError` (`-32021`) with `data.requiredCapabilities`
listing the missing capabilities, `400 Bad Request` on HTTP.
Citation: Base protocol overview, Per request protocol fields.

**MS-META-003** MUST, BOTH, observable
Reserved `_meta` key prefixes: any prefix whose second label is `modelcontextprotocol`
or `mcp` is reserved for MCP use. Key names have an optional dotted prefix ending in a
slash, and a name that begins and ends with an alphanumeric character and may contain
hyphens, underscores and dots in between. `traceparent`, `tracestate` and `baggage` are
reserved exceptions to the prefix rule.
Citation: Base protocol overview, `_meta`.

**MS-META-004** MUST, SERVER, observable
On notifications delivered via a `subscriptions/listen` stream the server MUST include
`io.modelcontextprotocol/subscriptionId` in `_meta`.
Citation: Base protocol overview, Per response protocol fields.

**MS-META-005** MUST NOT, SERVER, observable
Servers MUST NOT emit `notifications/message` for requests that did not include
`io.modelcontextprotocol/logLevel` in `_meta`.
Citation: Key Changes major change 5.

### Error codes

**MS-ERR-001** MUST NOT, SERVER, observable
The range `-32020` to `-32099` is reserved for the MCP specification. Implementations
MUST NOT emit any code from this sub range that is not defined by the specification and
MUST use defined codes only with their specified meanings.
Citation: Base protocol overview, Error Codes.

**MS-ERR-002** MUST NOT, SERVER, observable
Implementations of this protocol version MUST NOT emit `-32002` (resource not found,
replaced by `-32602`) or `-32042` (URL elicitation required).
Citation: Base protocol overview, Error Codes.

**MS-ERR-003** MUST, SERVER, observable
Defined MCP error codes are exactly: `-32020` `HeaderMismatch`, `-32021`
`MissingRequiredClientCapability`, `-32022` `UnsupportedProtocolVersion`.
Citation: Base protocol overview, Error Codes.

**MS-ERR-004** SHOULD NOT, SERVER, observable
New implementations SHOULD NOT use codes from `-32000` to `-32019` at all. New codes
MUST NOT be allocated in that sub range.
Citation: Base protocol overview, Error Codes.

**MS-ERR-005** MUST, SERVER, observable
Resource not found is reported as `-32602` (Invalid Params) in this revision.
Citation: Key Changes minor change 6.

**MS-ERR-006** MUST, SERVER, observable
`UnsupportedProtocolVersionError` carries `data.supported` (array of versions) and
`data.requested`.
Citation: Versioning and Compatibility, Protocol Version Negotiation.

### Streamable HTTP transport

**MS-HTTP-001** MUST, SERVER, observable
The server MUST provide a single HTTP endpoint path supporting POST.
Citation: Streamable HTTP, opening section.

**MS-HTTP-002** MUST, SERVER, observable
Every POST request MUST include an `MCP-Protocol-Version` header, and its value MUST
match `io.modelcontextprotocol/protocolVersion` in the body `_meta`. On mismatch the
server MUST reject with `400 Bad Request` and a `HeaderMismatch` error.
Citation: Streamable HTTP, Protocol Version Header.

**MS-HTTP-003** MUST, BOTH, observable
`Mcp-Method` (source field `method`) is required on all requests. `Mcp-Name` (source
field `params.name` or `params.uri`) is required for `tools/call`, `resources/read` and
`prompts/get`. Quote: "These headers are **REQUIRED** for compliance."
Citation: Streamable HTTP, Standard Request Headers.

**MS-HTTP-004** MUST, SERVER, observable
Servers that process the request body MUST reject requests where header values do not
match the corresponding body values, returning HTTP `400 Bad Request` and JSON-RPC error
`-32020` (`HeaderMismatch`). Validation failures include a missing required standard
header, a value mismatch, and a value containing invalid characters. Servers MUST decode
the `=?base64?...?=` sentinel encoding before comparing.
Citation: Streamable HTTP, Server Validation.

**MS-HTTP-005** MUST, SERVER, observable
If the server does not implement the requested RPC method it MUST respond `404 Not
Found` with JSON-RPC error `-32601`.
Citation: Streamable HTTP, Protocol Version Header.

**MS-HTTP-006** MUST, SERVER, observable
If the body is a JSON-RPC notification and the server accepts it, the server MUST return
`202 Accepted` with no body.
Citation: Streamable HTTP, Sending Messages.

**MS-HTTP-007** MUST, SERVER, observable
If the body is a JSON-RPC request the server MUST return either
`Content-Type: application/json` or `Content-Type: text/event-stream`.
Citation: Streamable HTTP, Sending Messages.

**MS-HTTP-008** MUST NOT, SERVER, observable
The server MUST NOT send independent JSON-RPC requests on a response stream. Server to
client interactions are embedded as `inputRequests` inside an `InputRequiredResult`.
Citation: Streamable HTTP, Receiving Messages.

**MS-HTTP-009** MUST, SERVER, observable
Servers MUST validate the `Origin` header, and if present and invalid MUST respond
`403 Forbidden`.
Citation: Streamable HTTP, Security and Endpoint.

**MS-HTTP-010** SHOULD, SERVER, observable
When running locally servers SHOULD bind only to localhost rather than all interfaces.
Citation: Streamable HTTP, Security and Endpoint.

**MS-HTTP-011** SHOULD, SERVER, observable
A server supporting only this revision SHOULD respond `405 Method Not Allowed` to HTTP
GET or DELETE on the MCP endpoint, SHOULD ignore an `Mcp-Session-Id` header and not mint
or echo session IDs, and SHOULD ignore `Last-Event-ID`.
Citation: Streamable HTTP, Earlier Streamable HTTP Revisions.

**MS-HTTP-012** MUST NOT, SERVER, observable
Sessions and the `Mcp-Session-Id` header are removed. Resumable SSE via `Last-Event-ID`
is not supported. Quote: "Resumable SSE streams via `Last-Event-ID` are not supported."
Citation: Key Changes major changes 1 and 9; Streamable HTTP, Receiving Messages.

**MS-HTTP-013** SHOULD, SERVER, observable
Servers SHOULD include `X-Accel-Buffering: no` when initiating an SSE stream.
Citation: Streamable HTTP, Receiving Messages.

### stdio transport

**MS-STDIO-001** MUST NOT, SERVER, observable
Messages are delimited by newlines and MUST NOT contain embedded newlines. Quote:
"Messages are delimited by newlines, and **MUST NOT** contain embedded newlines."
There is no `Content-Length` framing and no header layer.
Citation: stdio, opening section; Request Metadata.

**MS-STDIO-002** MUST NOT, SERVER, observable
The server MUST NOT write anything to `stdout` that is not a valid MCP message.
Quote: "The server **MUST NOT** write anything to its `stdout` that is not a valid MCP
message."
Citation: stdio, opening section.

**MS-STDIO-003** MAY, SERVER, observable
The server MAY write UTF-8 strings to `stderr` for any logging purpose. The client MAY
capture, forward or ignore it and SHOULD NOT assume `stderr` output indicates an error.
Citation: stdio, opening section.

**MS-STDIO-004** MUST NOT, SERVER, observable
The server MUST NOT write JSON-RPC requests to `stdout`. Server to client interactions
are carried in `InputRequiredResult` replies.
Citation: stdio, Receiving Messages.

**MS-STDIO-005** MUST, CLIENT
On stdio the client MUST send `notifications/cancelled` referencing the request id in
order to cancel. Unlike Streamable HTTP there is no per request stream to close.
Citation: stdio, Cancellation.

**MS-STDIO-006** SHOULD, SERVER, observable
Servers SHOULD exit promptly when standard input is closed or reads return end of file.
Quote: "This is the primary graceful-shutdown signal and the only portable one".
Citation: stdio, Shutdown.

**MS-STDIO-007** SHOULD, CLIENT
The client SHOULD shut down by closing the input stream, waiting for exit, then forcibly
terminating if the server does not exit within a reasonable time. On Windows, where POSIX
signals are unavailable, `TerminateProcess` or Job Objects are named as the mechanism.
Citation: stdio, Shutdown.

**MS-STDIO-008** SHOULD and MUST NOT, CLIENT
A dual era client SHOULD probe with `server/discover` before any other request. Three
outcomes: a `DiscoverResult` means modern; a recognised modern JSON-RPC error means
modern but with a different version, and the client MUST NOT fall back to `initialize`;
any other error or no response within a reasonable timeout means legacy.
The fallback MUST NOT be keyed to one specific error code, because legacy servers answer
unknown pre-`initialize` requests with implementation defined errors, commonly `-32601`
or `-32602`, or not at all.
Citation: stdio, Backward Compatibility.

**MS-STDIO-009** RECOMMENDED, CLIENT
A modern only client does not need to probe, but probing is still recommended: some
legacy servers do not validate that a request arrives after `initialize` and would
process an era ambiguous method such as `tools/call` under legacy semantics. Probing
yields a deterministic failure instead.
Citation: stdio, Backward Compatibility.

### Tool definitions and `x-mcp-header`

**MS-TOOL-001** MUST, SERVER, observable
Constraints on every `x-mcp-header` value in a tool `inputSchema`. The value MUST NOT be
empty; MUST match HTTP field name token syntax (`1*tchar`, RFC 9110 section 5.1); MUST
NOT contain control characters including CR or LF; MUST be case insensitively unique
among all `x-mcp-header` values in the `inputSchema`; MUST only be applied to parameters
of primitive type (integer, string, boolean) and never to `number`; and MUST only be
applied to properties statically reachable from the schema root through a chain
consisting solely of `properties` keys, never through `items`, `oneOf`, `anyOf`,
`allOf`, `not`, `if`, `then`, `else` or `$ref`.
Quote: "An `x-mcp-header` annotation anywhere else makes the annotation — and thus the
tool definition — invalid."
Integer values MUST be within the JavaScript safe range.
Citation: Streamable HTTP, Schema Extension.

**MS-TOOL-002** SHOULD, SERVER, observable
Servers SHOULD return tools from `tools/list` in a deterministic order.
Citation: Key Changes minor change 3.

**MS-TOOL-003** MUST, BOTH, observable
Schemas without a `$schema` field default to JSON Schema 2020-12. Implementations MUST
support at least 2020-12. Schemas MUST be valid according to their declared or default
dialect.
Citation: Base protocol overview, JSON Schema Usage.

**MS-TOOL-004** MUST NOT, BOTH, observable
Implementations MUST NOT automatically dereference `$ref` values that resolve to a
network URI. An opt in mode MUST be disabled by default. Schemas that fail to validate
due to an unresolved external `$ref` SHOULD be rejected rather than treated as
permissive.
Citation: Base protocol overview, `$ref` Resolution.

**MS-TOOL-005** SHOULD, BOTH, observable
Implementations SHOULD bound composition keyword use (`anyOf`, `oneOf`, `allOf`,
`if`/`then`/`else`, `$defs`) with a maximum depth, a subschema cap or a time budget, to
prevent a malicious schema acting as a denial of service vector.
Citation: Base protocol overview, Composition Keyword Resource Use.

**MS-TOOL-006** MUST, CLIENT
Clients using Streamable HTTP MUST reject tool definitions whose `x-mcp-header` values
violate the constraints, by excluding the invalid tool from the result of `tools/list`,
and SHOULD log a warning naming the tool and the reason.
Citation: Streamable HTTP, Schema Extension.

### Icons

**MS-ICON-001** MUST, BOTH, observable
Icon `src` MUST be an HTTPS or `data:` URI. Clients MUST reject unsafe schemes such as
`javascript:`, `file:`, `ftp:`, `ws:` and local app schemes, and MUST disallow scheme
changes and cross origin redirects.
Citation: Base protocol overview, `icons`, Security considerations.

### Extensions

**MS-EXT-001** MUST, BOTH, observable
Extensions are advertised in the `extensions` field of `ClientCapabilities` and
`ServerCapabilities`, as a map of extension identifier to a settings object. Extension
identifiers MUST follow the `_meta` key naming rules with a mandatory prefix.
Citation: Versioning and Compatibility, Extension Negotiation; Key Changes minor change 1.

**MS-EXT-002** MUST, BOTH, not externally observable
If one party supports an extension and the other does not, the supporting party MUST
either revert to core protocol behavior or reject the request with an appropriate error.
Citation: Versioning and Compatibility, Extension Negotiation.

### Deprecations

Deprecated features remain functional during a minimum twelve month window. New
implementations should not adopt them. These generate advisory findings, never graded
MUST failures.

**MS-DEP-001** Roots, Sampling and Logging are deprecated (SEP-2577). Suggested
migrations: pass directories or files via tool parameters, resource URIs or server
configuration instead of Roots; integrate directly with LLM provider APIs instead of
Sampling; log to stderr on stdio or use OpenTelemetry instead of Logging.
Citation: Key Changes, Deprecated 1.

**MS-DEP-002** The HTTP+SSE transport from `2024-11-05` is reclassified as Deprecated
(SEP-2596).
Citation: Key Changes, Deprecated 2.

**MS-DEP-003** `includeContext` values `"thisServer"` and `"allServers"` are Deprecated.
Citation: Key Changes, Deprecated 3.

**MS-DEP-004** OAuth 2.0 Dynamic Client Registration (RFC 7591) is deprecated in favour
of Client ID Metadata Documents.
Citation: Key Changes, Deprecated 4.

### Authorization

Recorded for the migration analyzer. Not gradable without performing an authorization
flow, which mcpsteward does not do.

**MS-AUTH-001** SHOULD and MUST, split. Authorization servers SHOULD include the `iss`
parameter per RFC 9207, and MCP clients MUST validate a present `iss` against the
recorded issuer before redeeming the authorization code.
Citation: Key Changes minor change 7.

**MS-AUTH-002** MUST, CLIENT. Clients MUST specify an appropriate `application_type`
during Dynamic Client Registration.
Citation: Key Changes minor change 8.

**MS-AUTH-003** MUST, CLIENT. Client credentials are bound to the issuing authorization
server. Clients MUST key persisted credentials by issuer identifier, MUST NOT reuse them
with a different authorization server, and MUST re register when the authorization
server changes.
Citation: Key Changes minor change 9.

**MS-AUTH-004** SHOULD NOT, SERVER. Implementations using stdio SHOULD NOT follow the
authorization specification and should instead retrieve credentials from the
environment.
Citation: Base protocol overview, Auth.

## Migration signals

Patterns in server source that break under `2026-07-28`, each traceable to a requirement
above. Used by the migration analyzer.

| Signal | Breaks because | Rule |
| --- | --- | --- |
| `initialize` or `notifications/initialized` handler | handshake removed | MS-LIFE-005 |
| Reading or writing `Mcp-Session-Id` | sessions removed | MS-HTTP-012 |
| Session or connection scoped state keyed by connection | statelessness | MS-LIFE-006 |
| HTTP GET stream endpoint | GET endpoint removed | MS-HTTP-011 |
| `Last-Event-ID` or SSE event id resumability | resumability removed | MS-HTTP-012 |
| `resources/subscribe` or `resources/unsubscribe` | replaced by `subscriptions/listen` | Key Changes major change 4 |
| `ping` or `logging/setLevel` handler | methods removed | MS-LIFE-007 |
| `tasks/result` or `tasks/list` | tasks moved to extension and redesigned | Key Changes major change 6 |
| Server initiated `roots/list`, `sampling/createMessage`, `elicitation/create` requests | replaced by MRTR | MS-HTTP-008 |
| `notifications/elicitation/complete` or `elicitationId` | removed | Key Changes minor change 11 |
| List handler returning no `ttlMs` or `cacheScope` | required by CacheableResult | MS-CACHE-001 |
| Result returned without `resultType` | required field | MS-RES-001 |
| No `server/discover` handler | required RPC | MS-LIFE-001 |
| Error code `-32002` for resource not found | renumbered to `-32602` | MS-ERR-005 |
| Error codes `-32001`, `-32003`, `-32004` | renumbered to `-32020`, `-32021`, `-32022` | MS-ERR-003 |
| Hand rolled SSE framing | transport shape changed | MS-HTTP-007 |

## Open questions

Tracked in VERIFY.md. Nothing in this file is inferred; anything uncertain is deferred
rather than written down as fact.
