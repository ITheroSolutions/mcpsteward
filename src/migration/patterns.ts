/**
 * Migration patterns: what breaks under 2026-07-28, and how to fix it.
 *
 * Every pattern traces to a requirement in `SPEC-NOTES.md`. The `why` text is
 * written for a developer who has to change the code, not for a report that only
 * needs to look thorough.
 */

export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface MigrationPattern {
  readonly id: string;
  readonly title: string;
  /** The rule in SPEC-NOTES.md this derives from. */
  readonly rule: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  /** Why it breaks, in one or two sentences. */
  readonly why: string;
  /** The specific fix, not a general gesture at the changelog. */
  readonly fix: string;
  /** Whether a safe mechanical transform exists. */
  readonly codemodable: boolean;
}

export const MIGRATION_PATTERNS: readonly MigrationPattern[] = [
  {
    id: 'MIG-INITIALIZE',
    title: 'initialize handshake',
    rule: 'MS-LIFE-005',
    severity: 'critical',
    why:
      'The initialize and notifications/initialized handshake was removed. A modern client never ' +
      'sends it, so a server that waits for it before serving requests will answer nothing.',
    fix:
      'Delete the initialize handler. Read the protocol version and client capabilities from each ' +
      'request _meta instead, and implement server/discover so clients can negotiate up front.',
    codemodable: false,
  },
  {
    id: 'MIG-SESSION',
    title: 'Mcp-Session-Id usage',
    rule: 'MS-HTTP-012',
    severity: 'critical',
    why:
      'Protocol level sessions and the Mcp-Session-Id header were removed. A server that mints or ' +
      'requires one is holding state a conforming client will never carry back.',
    fix:
      'Remove session minting and validation. State that must span requests becomes an explicit ' +
      'server minted handle passed as an ordinary tool argument.',
    codemodable: false,
  },
  {
    id: 'MIG-GET-STREAM',
    title: 'HTTP GET stream endpoint',
    rule: 'MS-HTTP-011',
    severity: 'high',
    why:
      'The standalone GET SSE endpoint was removed. Long lived notifications now flow on the ' +
      'response stream of a subscriptions/listen request instead.',
    fix: 'Respond 405 to GET on the MCP endpoint and implement subscriptions/listen.',
    codemodable: false,
  },
  {
    id: 'MIG-RESUMABILITY',
    title: 'Last-Event-ID resumability',
    rule: 'MS-HTTP-012',
    severity: 'medium',
    why:
      'SSE stream resumability and message redelivery were removed. A broken stream now loses the ' +
      'in flight request and the client re-issues it with a new id.',
    fix: 'Delete the Last-Event-ID handling and the event id bookkeeping behind it.',
    codemodable: false,
  },
  {
    id: 'MIG-SUBSCRIBE',
    title: 'resources/subscribe or resources/unsubscribe',
    rule: 'SEP-2575',
    severity: 'high',
    why:
      'Both methods were replaced by a single subscriptions/listen request whose response stream ' +
      'carries the notifications the client opted in to.',
    fix:
      'Implement subscriptions/listen, acknowledge the opted in notification types, and tag each ' +
      'notification with io.modelcontextprotocol/subscriptionId in _meta.',
    codemodable: false,
  },
  {
    id: 'MIG-PING',
    title: 'ping or logging/setLevel handler',
    rule: 'MS-LIFE-007',
    severity: 'medium',
    why: 'Both methods were removed from the protocol in this revision.',
    fix:
      'Delete the handlers. Log level is now per request through io.modelcontextprotocol/logLevel ' +
      'in _meta, and a server must not emit notifications/message for a request that omitted it.',
    codemodable: true,
  },
  {
    id: 'MIG-SERVER-REQUEST',
    title: 'server initiated request',
    rule: 'MS-HTTP-008',
    severity: 'critical',
    why:
      'Servers may no longer send roots/list, sampling/createMessage or elicitation/create as their ' +
      'own JSON-RPC requests. Multi Round-Trip Requests replaced that pattern entirely.',
    fix:
      'Return an InputRequiredResult with resultType "input_required" and an inputRequests array. ' +
      'The client retries the original request carrying inputResponses.',
    codemodable: false,
  },
  {
    id: 'MIG-CACHE-METADATA',
    title: 'list handler without cache metadata',
    rule: 'MS-CACHE-001',
    severity: 'high',
    why:
      'Results from the list methods and resources/read must now carry ttlMs and cacheScope. A ' +
      'result without them is non conforming even though it still parses.',
    fix:
      'Add ttlMs, a freshness hint in milliseconds and never negative, and cacheScope of "public" ' +
      'or "private". Use "private" for anything that varies per user.',
    codemodable: true,
  },
  {
    id: 'MIG-RESULT-TYPE',
    title: 'result without resultType',
    rule: 'MS-RES-001',
    severity: 'high',
    why: 'Every result must now declare resultType, and a client treats an unrecognised value as invalid.',
    fix: 'Add resultType: "complete" to ordinary results.',
    codemodable: true,
  },
  {
    id: 'MIG-ERROR-CODE',
    title: 'retired error code',
    rule: 'MS-ERR-002',
    severity: 'medium',
    why:
      'Code -32002 for resource not found was replaced by -32602, and -32042 was retired entirely. ' +
      'Codes introduced in draft were renumbered into the -32020 range.',
    fix:
      'Use -32602 for resource not found. Use -32020 HeaderMismatch, -32021 ' +
      'MissingRequiredClientCapability and -32022 UnsupportedProtocolVersion.',
    codemodable: true,
  },
  {
    id: 'MIG-DEPRECATED-CAPABILITY',
    title: 'deprecated capability',
    rule: 'MS-DEP-001',
    severity: 'low',
    why:
      'Roots, Sampling and Logging are deprecated with a minimum twelve month window. They still ' +
      'work, but new implementations should not adopt them.',
    fix:
      'Pass directories or files through tool parameters or resource URIs instead of Roots. ' +
      'Integrate with an LLM provider directly instead of Sampling. Log to stderr on stdio, or use ' +
      'OpenTelemetry, instead of Logging.',
    codemodable: false,
  },
  {
    id: 'MIG-TASKS',
    title: 'core tasks API',
    rule: 'SEP-2663',
    severity: 'medium',
    why:
      'Tasks moved out of the core protocol into the io.modelcontextprotocol/tasks extension, and ' +
      'the redesign replaced the blocking tasks/result with polling via tasks/get and removed ' +
      'tasks/list.',
    fix:
      'Declare the extension in capabilities and migrate tasks/result to tasks/get polling, with ' +
      'tasks/update for client to server input.',
    codemodable: false,
  },
];

export function patternById(id: string): MigrationPattern | undefined {
  return MIGRATION_PATTERNS.find((p) => p.id === id);
}

/**
 * Syntactic signals for each pattern.
 *
 * These are the strings a detector looks for. They are deliberately specific:
 * matching the bare word "session" would flood any real codebase with noise and
 * train people to ignore the report.
 */
export const PATTERN_SIGNALS: Readonly<Record<string, readonly string[]>> = {
  'MIG-INITIALIZE': [
    'initialize',
    'notifications/initialized',
    'InitializeRequest',
    'InitializeResult',
    'InitializeRequestSchema',
  ],
  'MIG-SESSION': ['Mcp-Session-Id', 'mcp-session-id', 'sessionId', 'sessionID'],
  // A GET route on an MCP or SSE path is detected structurally, not from these;
  // a bare "GET" string is in every HTTP client and matched almost nothing else.
  'MIG-GET-STREAM': ['handleGet', 'onGet'],
  'MIG-RESUMABILITY': ['Last-Event-ID', 'last-event-id', 'lastEventId', 'resumptionToken'],
  'MIG-SUBSCRIBE': ['resources/subscribe', 'resources/unsubscribe'],
  'MIG-PING': ['ping', 'logging/setLevel', 'notifications/roots/list_changed'],
  'MIG-SERVER-REQUEST': ['roots/list', 'sampling/createMessage', 'elicitation/create'],
  'MIG-RESULT-TYPE': [],
  'MIG-CACHE-METADATA': [],
  'MIG-ERROR-CODE': ['-32002', '-32042', '-32001', '-32003', '-32004'],
  'MIG-DEPRECATED-CAPABILITY': ['roots:', 'sampling:', 'logging:'],
  'MIG-TASKS': ['tasks/result', 'tasks/list'],
};
