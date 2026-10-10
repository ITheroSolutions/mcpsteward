#!/usr/bin/env node
/**
 * mcpwarden as an MCP server.
 *
 * Exposes the toolkit over stdio so an agent can inspect its own tool surface, or
 * a host can drive discovery, conformance and drift without shelling out.
 *
 * ## Dogfooding
 *
 * This server implements the 2026-07-28 revision and is graded by mcpwarden's own
 * conformance engine as part of the test suite, at grade A. That is the strongest
 * credibility signal this package can offer: a tool that grades MCP servers and
 * cannot pass its own grader is not worth running.
 *
 * ## Stream discipline
 *
 * Only protocol traffic on stdout. Every diagnostic goes to stderr. The library
 * already refuses to write to a stream on its own, and ESLint forbids `console`,
 * so the only writer here is `send`.
 *
 * ## Tool descriptions are the prompt
 *
 * A model decides whether to call a tool from its description. These are written
 * to say what the tool does, what it costs, and what it will not do, because a
 * vague description produces a model that calls the wrong thing confidently.
 */

import { createInterface } from 'node:readline';

import { grade } from '../conformance/index.js';
import { isEntryPoint } from '../core/entry.js';
import { toMcpWardenError } from '../core/errors.js';
import { isJsonNumber, parseJsonPreservingNumbers, type JsonValue } from '../core/json-parse.js';
import { redactDeep } from '../core/redaction.js';
import { TARGET_REVISION } from '../core/revisions.js';
import { discover } from '../discovery/index.js';
import { Ledger } from '../ledger/index.js';
import { checkPolicy, loadPolicy } from '../policy/index.js';
import { captureServer, diffServer } from '../api.js';
import { loadPin } from '../trust/index.js';
import { VERSION } from '../cli/help.js';
import type { ServerRef } from '../core/types.js';
import type { ProtocolRevision } from '../core/revisions.js';
import type { CaptureEvidence } from '../protocol/client.js';

/** Cache lifetime advertised on list results, in milliseconds. */
const TTL_MS = 60_000;

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly handler: (args: Record<string, JsonValue>) => Promise<unknown>;
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'discover_servers',
    description:
      'List every MCP server configured on this machine, with its transport, how it ' +
      'authenticates, which clients registered it, and whether any credential is written ' +
      'directly into a configuration file. Reads local configuration only: it connects to ' +
      'nothing and starts nothing, so it is safe to call and cannot wake a server up. ' +
      'Credential values are never returned, only the fact that one exists.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const inventory = await discover({ projectDirectories: [process.cwd()] });

      return {
        summary: inventory.summary,
        servers: inventory.servers.map((server) => ({
          id: server.id,
          name: server.name,
          transport: server.endpoint.transport,
          authPosture: server.authPosture,
          clients: server.registrations.map((r) => r.client),
          hasInlineCredential: server.registrations.some((r) => r.hasInlineCredential),
        })),
        problems: inventory.problems,
      };
    },
  },

  {
    name: 'capture_surface',
    description:
      'Connect to one configured server and record exactly what it advertises: its tools, ' +
      'prompts, resources and resource templates, with a content hash for each and a merkle ' +
      'root over the whole surface. This starts the server process, so it is slower than ' +
      'discover_servers and has a side effect. Returns the protocol revision actually ' +
      'spoken, which may be older than the one requested.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name as reported by discover_servers.' },
      },
      required: ['server'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const server = await resolveServer(readString(args, 'server'));
      const surface = await captureServer(server, { env: {} });

      return {
        server: server.name,
        revisionUsed: surface.revisionUsed,
        revisionRequested: surface.revisionRequested,
        surfaceRoot: surface.hashes.root,
        capturedAt: surface.capturedAt,
        descriptors: surface.descriptors.map((d) => ({
          category: d.category,
          identity: d.identity,
          hash: d.hash,
        })),
      };
    },
  },

  {
    name: 'check_conformance',
    description:
      'Grade one configured server against the 2026-07-28 MCP specification and return a ' +
      'letter grade with every finding. Each finding carries the specification section or ' +
      'SEP that justifies it and a remediation written for whoever has to fix it, so the ' +
      'result can be checked rather than merely believed. Every rule is deterministic: no ' +
      'model is involved and the same server always grades the same. This starts the ' +
      'server process.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name as reported by discover_servers.' },
      },
      required: ['server'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const server = await resolveServer(readString(args, 'server'));
      const surface = await captureServer(server, { env: {} });
      const report = grade({ surface, evidence: emptyEvidence(surface.revisionUsed) });

      return {
        server: server.name,
        grade: report.grade,
        findings: report.findings.map((f) => ({
          ruleId: f.ruleId,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          remediation: f.remediation,
          citation: f.citation.sep ?? f.citation.section,
        })),
      };
    },
  },

  {
    name: 'diff_against_trust',
    description:
      'Compare a server against the surface that was previously approved for it, and ' +
      'classify every difference: a tool added or removed, a description changed after ' +
      'approval, a schema widened or narrowed, a parameter newly required, a name that ' +
      'collides with another server. A description change on an approved tool is the ' +
      'highest signal event here, because that is how tool poisoning presents. Fails if ' +
      'the server has never been approved. Risk scores are a heuristic, not a guarantee.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server name as reported by discover_servers.' },
        pinPath: { type: 'string', description: 'Path to the pin file recording the approval.' },
      },
      required: ['server', 'pinPath'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const server = await resolveServer(readString(args, 'server'));
      const pin = await loadPin(readString(args, 'pinPath'));
      const { report } = await diffServer(server, pin, { env: {} });

      return {
        server: server.name,
        pinnedAt: report.pinnedAt,
        changed: report.events.length > 0,
        unchanged: report.unchanged,
        events: report.events,
        note: 'Risk scoring is a heuristic that orders attention. It is not a security guarantee.',
      };
    },
  },

  {
    name: 'verify_ledger',
    description:
      'Walk the append-only surface ledger and prove its hash chain is unbroken, reporting ' +
      'the exact sequence number where integrity fails if it does. Reads a local file and ' +
      'connects to nothing. Note the limit honestly: this proves the chain is internally ' +
      'consistent, not that it is authentic. Anyone who can rewrite the file from entry ' +
      'zero can produce a forgery that verifies cleanly.',
    inputSchema: {
      type: 'object',
      properties: {
        ledgerPath: { type: 'string', description: 'Path to the ledger file.' },
      },
      required: ['ledgerPath'],
      additionalProperties: false,
    },
    handler: async (args) => await new Ledger(readString(args, 'ledgerPath')).verify(),
  },

  {
    name: 'check_policy',
    description:
      'Evaluate a policy file against the servers configured on this machine and return ' +
      'every violation, each naming the server, what the policy required, what was found, ' +
      'and the next action. Also reports any check that could not run for lack of input, ' +
      'so a passing result cannot be mistaken for a complete one. Reads local files only.',
    inputSchema: {
      type: 'object',
      properties: {
        policyPath: { type: 'string', description: 'Path to the policy file.' },
      },
      required: ['policyPath'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const policy = await loadPolicy(readString(args, 'policyPath'));
      const inventory = await discover({ projectDirectories: [process.cwd()] });

      return checkPolicy(policy, { inventory });
    },
  },
];

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/**
 * The only writer to stdout in this process.
 *
 * The id is written back exactly as it arrived. Requests are parsed with number
 * tokens preserved, so a numeric id is held as a token object, and serialising
 * that object directly answered a request whose id was `1` with an id of
 * `{"__jsonNumber":true,"token":"1"}`. No client could match that to its
 * request, and every client that numbers its requests, which is nearly all of
 * them, would have timed out on every call. The test suite's own client uses
 * string ids, which is why nothing caught it.
 */
function send(id: JsonValue, body: Record<string, unknown>): void {
  const rest = JSON.stringify(body);
  process.stdout.write(`{"jsonrpc":"2.0","id":${idText(id)},${rest.slice(1)}\n`);
}

/** A request id as JSON text: the original number token, a string, or null. */
function idText(id: JsonValue): string {
  if (isJsonNumber(id)) return id.token;
  if (typeof id === 'string') return JSON.stringify(id);
  return 'null';
}

function diagnostic(text: string): void {
  process.stderr.write(`${text}\n`);
}

const SERVER_META = {
  _meta: {
    'io.modelcontextprotocol/serverInfo': { name: 'mcpwarden', version: VERSION },
  },
};

function respond(id: JsonValue, result: Record<string, unknown>): void {
  send(id, { result: { resultType: 'complete', ...result, ...SERVER_META } });
}

function respondError(id: JsonValue, code: number, message: string, data?: unknown): void {
  send(id, { error: { code, message, ...(data === undefined ? {} : { data }) } });
}

/**
 * Per connection state, used only for clients of the handshake era.
 *
 * A 2026-07-28 request is self describing and is handled statelessly, as that
 * revision requires. But no MCP client in use when this was released speaks
 * 2026-07-28 yet, so a server that spoke nothing else could not be used by any
 * of them. A client that opens with `initialize` is served under the previous
 * revision for the rest of the connection, which is how that revision works.
 */
export interface ConnectionState {
  legacy: boolean;
}

/** The handshake era revisions this server answers `initialize` for. */
const LEGACY_REVISIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26'];

/** Caching hints, required on every complete list result by MW-CACHE-001. */
function cacheable<T extends Record<string, unknown>>(body: T): T & Record<string, unknown> {
  return { ...body, ttlMs: TTL_MS, cacheScope: 'public' };
}

export async function handleRequest(
  request: Record<string, JsonValue>,
  state: ConnectionState = { legacy: false },
): Promise<void> {
  const method = request['method'];

  // A message without an id is a notification, and a notification is never
  // answered, whatever it says. This used to reply with an error carrying a null
  // id, which a client has no request to match against.
  if (request['id'] === undefined) return;

  const id = request['id'];
  const params = asObject(request['params']);
  const meta = asObject(params['_meta']);

  const requested = meta['io.modelcontextprotocol/protocolVersion'];

  // The handshake of the previous era. The server answers with the newest
  // handshake era revision it shares with the client.
  if (method === 'initialize' && typeof requested !== 'string') {
    const asked = params['protocolVersion'];
    const agreed = typeof asked === 'string' && LEGACY_REVISIONS.includes(asked) ? asked : '2025-11-25';

    state.legacy = true;
    send(id, {
      result: {
        protocolVersion: agreed,
        capabilities: { tools: {} },
        serverInfo: { name: 'mcpwarden', version: VERSION },
        instructions: INSTRUCTIONS,
      },
    });
    return;
  }

  if (state.legacy && typeof requested !== 'string') {
    await handleLegacy(id, method, params);
    return;
  }

  // MW-META-001: a request missing a required _meta field is malformed.
  if (typeof requested !== 'string') {
    respondError(id, -32602, 'Missing io.modelcontextprotocol/protocolVersion in _meta');
    return;
  }

  if (meta['io.modelcontextprotocol/clientCapabilities'] === undefined) {
    respondError(id, -32602, 'Missing io.modelcontextprotocol/clientCapabilities in _meta');
    return;
  }

  // MW-ERR-006: an unsupported version carries the list this server does support.
  if (requested !== TARGET_REVISION) {
    respondError(id, -32022, 'Unsupported protocol version', {
      supported: [TARGET_REVISION],
      requested,
    });
    return;
  }

  switch (method) {
    // MW-LIFE-001: servers MUST implement server/discover.
    case 'server/discover':
      respond(
        id,
        cacheable({
          supportedVersions: [TARGET_REVISION],
          capabilities: { tools: {} },
          instructions: INSTRUCTIONS,
        }),
      );
      return;

    case 'tools/list':
      respond(
        id,
        cacheable({
          // MW-TOOL-002: a deterministic order lets clients cache the list.
          tools: listedTools().map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
        }),
      );
      return;

    case 'tools/call': {
      const outcome = await callTool(params);
      if (outcome === undefined) {
        respondError(id, -32602, `Unknown tool ${describeMethod(params['name'])}`);
        return;
      }
      respond(id, outcome);
      return;
    }

    default:
      // MW-LIFE-007: ping and logging/setLevel were removed, so they land here.
      respondError(id, -32601, `Method not found: ${describeMethod(method)}`);
  }
}

/** Render a method name for an error message without risking [object Object]. */
const INSTRUCTIONS =
  'Inspect MCP servers configured on this machine. discover_servers, verify_ledger ' +
  'and check_policy read local files and connect to nothing. capture_surface, ' +
  'check_conformance and diff_against_trust start the server being inspected.';

/** MW-TOOL-002: a deterministic order lets clients cache the list. */
function listedTools(): readonly (typeof TOOLS)[number][] {
  return [...TOOLS].sort((a, b) => a.name.localeCompare(b.name));
}

/** Run a tool. Undefined when no tool has that name. */
async function callTool(
  params: Record<string, JsonValue>,
): Promise<Record<string, unknown> | undefined> {
  const tool = TOOLS.find((t) => t.name === params['name']);
  if (tool === undefined) return undefined;

  try {
    const output = await tool.handler(asObject(params['arguments']));

    return {
      content: [{ type: 'text', text: JSON.stringify(redactDeep(output), null, 2) }],
      structuredContent: redactDeep(output),
      isError: false,
    };
  } catch (error) {
    // A failed tool call is a result, not a protocol error. The model needs to
    // see what went wrong so it can choose differently.
    const wrapped = toMcpWardenError(error, `calling ${tool.name}`);

    return {
      content: [{ type: 'text', text: `${wrapped.code}: ${wrapped.message}` }],
      isError: true,
    };
  }
}

/**
 * Serve a request from a client that opened with `initialize`.
 *
 * The same tools with the previous revision's result shapes: no `resultType`, no
 * caching hints, and `ping` answered, since that revision defines it.
 */
async function handleLegacy(
  id: JsonValue,
  method: JsonValue | undefined,
  params: Record<string, JsonValue>,
): Promise<void> {
  switch (method) {
    case 'ping':
      send(id, { result: {} });
      return;

    case 'tools/list':
      send(id, {
        result: {
          tools: listedTools().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      });
      return;

    case 'tools/call': {
      const outcome = await callTool(params);
      if (outcome === undefined) {
        respondError(id, -32602, `Unknown tool ${describeMethod(params['name'])}`);
        return;
      }
      send(id, { result: outcome });
      return;
    }

    default:
      respondError(id, -32601, `Method not found: ${describeMethod(method)}`);
  }
}

function describeMethod(method: JsonValue | undefined): string {
  return typeof method === 'string' ? method : JSON.stringify(method);
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}

function readString(args: Record<string, JsonValue>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`Argument ${JSON.stringify(key)} must be a string`);
  }
  return value;
}

async function resolveServer(name: string): Promise<ServerRef> {
  const inventory = await discover({ projectDirectories: [process.cwd()] });
  const server = inventory.servers.find((s) => s.name === name || s.id === name);

  if (server === undefined) {
    throw new Error(
      `No configured server named ${JSON.stringify(name)}. ` +
        `Call discover_servers to see what is available.`,
    );
  }

  return server;
}

/**
 * Evidence for grading a surface captured without it.
 *
 * `capture_surface` returns only the surface, so rules that need raw list results
 * report `inconclusive` rather than failing. Reporting a rule as failed because
 * this server did not gather the evidence would blame the graded server for our
 * own omission.
 */
function emptyEvidence(revision: ProtocolRevision): CaptureEvidence {
  return {
    discover: {
      implemented: true,
      supportedVersions: [revision],
      capabilities: undefined,
      serverInfo: undefined,
      instructions: undefined,
      raw: undefined,
      era: 'modern',
    },
    negotiation: { requested: revision, used: revision, downgraded: false },
    listResults: [],
    methodErrors: [],
  };
}

/** Start the server on stdio. */
export function serve(): void {
  const reader = createInterface({ input: process.stdin });
  const state: ConnectionState = { legacy: false };

  reader.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let request: JsonValue;
    try {
      request = parseJsonPreservingNumbers(trimmed);
    } catch {
      respondError(null, -32700, 'Parse error');
      return;
    }

    void handleRequest(asObject(request), state).catch((error: unknown) => {
      const wrapped = toMcpWardenError(error, 'handling a request');
      diagnostic(`internal error: ${wrapped.message}`);
    });
  });

  // MW-STDIO-006: exit promptly when stdin closes.
  reader.on('close', () => {
    process.exit(0);
  });

  diagnostic(`mcpwarden ${VERSION} MCP server ready, speaking ${TARGET_REVISION}`);
}

/* c8 ignore start -- the process entry point is exercised by subprocess tests */
if (isEntryPoint(import.meta.url)) serve();
/* c8 ignore stop */
