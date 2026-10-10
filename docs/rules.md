# Conformance rules and migration patterns

This file is generated from the rule registry by `scripts/generate-docs.mjs`. Do not edit it by hand: a test asserts it matches the registry, so an edit here fails the build rather than shipping.

Regenerate with:

```bash
npm run build && node scripts/generate-docs.mjs
```

## How to read this

Every rule carries a **citation** naming the specification section or SEP that justifies it. That is enforced by the type system: a rule without one does not compile. A finding you cannot trace to a requirement is a finding you cannot act on.

**Confidence** is `VERIFIED` when the requirement was read in specification text that was actually fetched, and `UNVERIFIED` when it is plausible but ungrounded. An `UNVERIFIED` rule reports but is excluded from the graded score, so it can never silently change any grade without notice.

**Normative level** is the wording the specification itself uses. MUST rules dominate the grade, and a single MUST failure caps the letter regardless of score.

## Summary

| Measure | Count |
| --- | --- |
| Conformance rules | 17 |
| MUST and MUST NOT | 14 |
| SHOULD and SHOULD NOT | 3 |
| VERIFIED | 17 |
| UNVERIFIED | 0 |
| Migration patterns | 12 |

## Conformance rules

### caching

#### MS-CACHE-001: Cacheable results carry caching hints

| Field | Value |
| --- | --- |
| Severity | high |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [server/utilities/caching#cacheable-results](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#cacheable-results) (SEP-2549) |

**Requirement.** Results from discover, the list methods and resources/read must include ttlMs and cacheScope.

> Servers MUST include caching hints on results with `resultType: "complete"` returned by the following operations

**Remediation.** Add ttlMs and cacheScope to every list result. ttlMs is a freshness hint in milliseconds and cacheScope is "public" or "private". Use "private" for anything that varies per user.

#### MS-CACHE-002: ttlMs is a non negative integer

| Field | Value |
| --- | --- |
| Severity | medium |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [server/utilities/caching#time-to-live-ttl-field](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#time-to-live-ttl-field) (SEP-2549) |

**Requirement.** Servers must provide a ttlMs value greater than or equal to zero.

> Servers **MUST** provide a `ttlMs` value that is `>= 0`.

**Remediation.** Return zero to mean immediately stale rather than a negative value. Clients are told to ignore a negative ttlMs and treat it as zero, so a negative value achieves nothing.

#### MS-CACHE-003: cacheScope is public or private

| Field | Value |
| --- | --- |
| Severity | medium |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [server/utilities/caching#cache-scope-field](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#cache-scope-field) (SEP-2549) |

**Requirement.** cacheScope is either "public" or "private".

**Remediation.** Use "public" only when the response contains no user specific data, because a public response may be shared across authorization contexts even from an authenticated endpoint.

#### MS-CACHE-004: cacheScope is consistent across pages

| Field | Value |
| --- | --- |
| Severity | low |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [server/utilities/caching#interaction-with-pagination](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#interaction-with-pagination) (SEP-2549) |

**Requirement.** Servers must apply the same cacheScope to all response pages for a given list request.

> Servers **MUST** apply the same `cacheScope` to all response pages for a given list request.

**Remediation.** Decide the scope for a list once and apply it to every page. A first page marked private and a second marked public lets a shared cache serve data the first page said not to.

### discovery

#### MS-LIFE-001: server/discover is implemented

| Field | Value |
| --- | --- |
| Severity | critical |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [basic/versioning#protocol-version-negotiation](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#protocol-version-negotiation) (SEP-2575) |

**Requirement.** Servers must implement the server/discover RPC.

> Servers **MUST** implement `server/discover`.

**Remediation.** Add a server/discover handler returning supportedVersions, capabilities and instructions. Clients use it to select a protocol version without a handshake, which no longer exists.

#### MS-LIFE-002: DiscoverResult declares supported versions and capabilities

| Field | Value |
| --- | --- |
| Severity | high |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [server/discover#data-types](https://modelcontextprotocol.io/specification/2026-07-28/server/discover#data-types) (SEP-2575) |

**Requirement.** A discover result includes supportedVersions and capabilities.

**Remediation.** Return supportedVersions as an array of revision identifiers and capabilities as an object. Without supportedVersions a client cannot negotiate and must guess.

#### MS-LIFE-003: Server identifies itself in the discover result

| Field | Value |
| --- | --- |
| Severity | low |
| Level | SHOULD |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [server/discover#data-types](https://modelcontextprotocol.io/specification/2026-07-28/server/discover#data-types) (SEP-2575) |

**Requirement.** Servers should include io.modelcontextprotocol/serverInfo in the discover result _meta.

**Remediation.** Add _meta["io.modelcontextprotocol/serverInfo"] with name and version. It is for display and debugging only and is never verified, so do not rely on it for access control.

### extensions

#### MS-EXT-001: Extension identifiers carry a prefix

| Field | Value |
| --- | --- |
| Severity | low |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [basic/versioning#extension-negotiation](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#extension-negotiation) |

**Requirement.** Extension identifiers must follow the _meta key naming rules, with a mandatory prefix.

**Remediation.** Use a reverse DNS prefix such as com.example/my-extension. A prefix whose second label is modelcontextprotocol or mcp is reserved for the specification.

### lifecycle

#### MS-LIFE-007: Removed methods are not implemented

| Field | Value |
| --- | --- |
| Severity | medium |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [changelog#major-changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog#major-changes) (SEP-2575) |

**Requirement.** ping, logging/setLevel and notifications/roots/list_changed were removed in this revision.

**Remediation.** Remove the ping and logging/setLevel handlers. Per request log level is now set through io.modelcontextprotocol/logLevel in _meta, and liveness is a transport concern.

#### MS-DEP-001: Deprecated capabilities are not declared

| Field | Value |
| --- | --- |
| Severity | info |
| Level | SHOULD NOT |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [changelog#deprecated](https://modelcontextprotocol.io/specification/2026-07-28/changelog#deprecated) (SEP-2577) |

**Requirement.** Roots, Sampling and Logging are deprecated. New implementations should not adopt them.

**Remediation.** Pass directories or files through tool parameters or resource URIs instead of Roots. Integrate with an LLM provider directly instead of Sampling. Log to stderr on stdio, or use OpenTelemetry, instead of Logging. These keep working for at least twelve months.

### schema

#### MS-ICON-001: Icon sources use a safe scheme

| Field | Value |
| --- | --- |
| Severity | high |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [basic/index#icons](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#icons) |

**Requirement.** An icon src must be an HTTPS or data URI.

**Remediation.** Serve icons over HTTPS or embed them as data URIs. Clients are required to reject javascript:, file:, ftp: and ws: schemes, so such an icon simply will not render.

#### MS-RES-001: Every result declares resultType

| Field | Value |
| --- | --- |
| Severity | high |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [basic/index#result-responses](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#result-responses) (SEP-2322) |

**Requirement.** Every result must include a resultType field.

> The `result` **MUST** include a `resultType` field

**Remediation.** Add resultType to every result. Use "complete" for an ordinary result and "input_required" for a multi round-trip interim result.

#### MS-TOOL-004: Tool schemas do not reference remote $refs

| Field | Value |
| --- | --- |
| Severity | high |
| Level | MUST NOT |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [basic/index#ref-resolution](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#ref-resolution) (SEP-2106) |

**Requirement.** Implementations must not automatically dereference a $ref that resolves to a network URI.

**Remediation.** Inline the referenced schema or use a local $defs pointer. A network $ref makes every client that resolves it fetch a URL you control at tool listing time.

#### MS-RES-002: resultType uses a defined value

| Field | Value |
| --- | --- |
| Severity | medium |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [basic/index#resulttype](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#resulttype) (SEP-2322) |

**Requirement.** resultType is "complete" for ordinary results and "input_required" for interim results.

**Remediation.** Use one of the defined values. An extension may add values, but only ones it advertises through capabilities, and a client must treat an unrecognised value as invalid.

#### MS-TOOL-003: Tool schemas declare a supported JSON Schema dialect

| Field | Value |
| --- | --- |
| Severity | medium |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [basic/index#json-schema-usage](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#json-schema-usage) |

**Requirement.** A schema without $schema defaults to JSON Schema 2020-12 and must be valid against it.

**Remediation.** Either omit $schema, which means 2020-12, or set it to a dialect the client supports. An unsupported dialect must be handled with an explicit error rather than silently.

### tools

#### MS-TOOL-001: x-mcp-header annotations are valid

| Field | Value |
| --- | --- |
| Severity | high |
| Level | MUST |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [basic/transports/streamable-http#schema-extension](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#schema-extension) (SEP-2243) |

**Requirement.** Every x-mcp-header value must be a non empty HTTP token, unique case insensitively, on a primitive non number property reachable through properties keys only.

> An `x-mcp-header` annotation anywhere else makes the annotation, and thus the tool definition, invalid.

**Remediation.** Move the annotation onto a top level or nested properties entry of type string, integer or boolean. A conforming client excludes an invalid tool from tools/list entirely, so the tool becomes invisible rather than merely unheadered.

#### MS-TOOL-002: tools/list order is deterministic

| Field | Value |
| --- | --- |
| Severity | low |
| Level | SHOULD |
| Confidence | VERIFIED |
| Revisions | 2026-07-28 |
| Specification | [changelog#minor-changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog#minor-changes) |

**Requirement.** Servers should return tools in a deterministic order.

**Remediation.** Sort tools before returning them. A stable order lets clients cache the list and improves prompt cache hit rates on the model side.

## Migration patterns

Patterns in MCP server source that break under 2026-07-28. Detected by `mcpsteward migrate <path>`. Each traces to a rule above or to the SEP that introduced the change.

### MIG-INITIALIZE: initialize handshake

| Field | Value |
| --- | --- |
| Severity | critical |
| Rule | MS-LIFE-005 |
| Safe codemod exists | no |

**Why it breaks.** The initialize and notifications/initialized handshake was removed. A modern client never sends it, so a server that waits for it before serving requests will answer nothing.

**Fix.** Delete the initialize handler. Read the protocol version and client capabilities from each request _meta instead, and implement server/discover so clients can negotiate up front.

### MIG-SERVER-REQUEST: server initiated request

| Field | Value |
| --- | --- |
| Severity | critical |
| Rule | MS-HTTP-008 |
| Safe codemod exists | no |

**Why it breaks.** Servers may no longer send roots/list, sampling/createMessage or elicitation/create as their own JSON-RPC requests. Multi Round-Trip Requests replaced that pattern entirely.

**Fix.** Return an InputRequiredResult with resultType "input_required" and an inputRequests array. The client retries the original request carrying inputResponses.

### MIG-SESSION: Mcp-Session-Id usage

| Field | Value |
| --- | --- |
| Severity | critical |
| Rule | MS-HTTP-012 |
| Safe codemod exists | no |

**Why it breaks.** Protocol level sessions and the Mcp-Session-Id header were removed. A server that mints or requires one is holding state a conforming client will never carry back.

**Fix.** Remove session minting and validation. State that must span requests becomes an explicit server minted handle passed as an ordinary tool argument.

### MIG-CACHE-METADATA: list handler without cache metadata

| Field | Value |
| --- | --- |
| Severity | high |
| Rule | MS-CACHE-001 |
| Safe codemod exists | yes |

**Why it breaks.** Results from the list methods and resources/read must now carry ttlMs and cacheScope. A result without them is non conforming even though it still parses.

**Fix.** Add ttlMs, a freshness hint in milliseconds and never negative, and cacheScope of "public" or "private". Use "private" for anything that varies per user.

### MIG-GET-STREAM: HTTP GET stream endpoint

| Field | Value |
| --- | --- |
| Severity | high |
| Rule | MS-HTTP-011 |
| Safe codemod exists | no |

**Why it breaks.** The standalone GET SSE endpoint was removed. Long lived notifications now flow on the response stream of a subscriptions/listen request instead.

**Fix.** Respond 405 to GET on the MCP endpoint and implement subscriptions/listen.

### MIG-RESULT-TYPE: result without resultType

| Field | Value |
| --- | --- |
| Severity | high |
| Rule | MS-RES-001 |
| Safe codemod exists | yes |

**Why it breaks.** Every result must now declare resultType, and a client treats an unrecognised value as invalid.

**Fix.** Add resultType: "complete" to ordinary results.

### MIG-SUBSCRIBE: resources/subscribe or resources/unsubscribe

| Field | Value |
| --- | --- |
| Severity | high |
| Rule | SEP-2575 |
| Safe codemod exists | no |

**Why it breaks.** Both methods were replaced by a single subscriptions/listen request whose response stream carries the notifications the client opted in to.

**Fix.** Implement subscriptions/listen, acknowledge the opted in notification types, and tag each notification with io.modelcontextprotocol/subscriptionId in _meta.

### MIG-ERROR-CODE: retired error code

| Field | Value |
| --- | --- |
| Severity | medium |
| Rule | MS-ERR-002 |
| Safe codemod exists | yes |

**Why it breaks.** Code -32002 for resource not found was replaced by -32602, and -32042 was retired entirely. Codes introduced in draft were renumbered into the -32020 range.

**Fix.** Use -32602 for resource not found. Use -32020 HeaderMismatch, -32021 MissingRequiredClientCapability and -32022 UnsupportedProtocolVersion.

### MIG-PING: ping or logging/setLevel handler

| Field | Value |
| --- | --- |
| Severity | medium |
| Rule | MS-LIFE-007 |
| Safe codemod exists | yes |

**Why it breaks.** Both methods were removed from the protocol in this revision.

**Fix.** Delete the handlers. Log level is now per request through io.modelcontextprotocol/logLevel in _meta, and a server must not emit notifications/message for a request that omitted it.

### MIG-RESUMABILITY: Last-Event-ID resumability

| Field | Value |
| --- | --- |
| Severity | medium |
| Rule | MS-HTTP-012 |
| Safe codemod exists | no |

**Why it breaks.** SSE stream resumability and message redelivery were removed. A broken stream now loses the in flight request and the client re-issues it with a new id.

**Fix.** Delete the Last-Event-ID handling and the event id bookkeeping behind it.

### MIG-TASKS: core tasks API

| Field | Value |
| --- | --- |
| Severity | medium |
| Rule | SEP-2663 |
| Safe codemod exists | no |

**Why it breaks.** Tasks moved out of the core protocol into the io.modelcontextprotocol/tasks extension, and the redesign replaced the blocking tasks/result with polling via tasks/get and removed tasks/list.

**Fix.** Declare the extension in capabilities and migrate tasks/result to tasks/get polling, with tasks/update for client to server input.

### MIG-DEPRECATED-CAPABILITY: deprecated capability

| Field | Value |
| --- | --- |
| Severity | low |
| Rule | MS-DEP-001 |
| Safe codemod exists | no |

**Why it breaks.** Roots, Sampling and Logging are deprecated with a minimum twelve month window. They still work, but new implementations should not adopt them.

**Fix.** Pass directories or files through tool parameters or resource URIs instead of Roots. Integrate with an LLM provider directly instead of Sampling. Log to stderr on stdio, or use OpenTelemetry, instead of Logging.

---

Generated from the registry. The rule count above is the real count: there is no separate list to fall out of date.
