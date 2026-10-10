#!/usr/bin/env node
/**
 * A conforming 2026-07-28 stdio MCP server.
 *
 * Deliberately small and hand written rather than built on an SDK, because no
 * published SDK implements this revision. Everything it does is traceable to a
 * requirement in SPEC-NOTES.md.
 *
 * Behaviour can be varied through MCPSTEWARD_FIXTURE_MODE so that one file can act
 * as both the correct server and several specifically broken ones.
 */

import { createInterface } from 'node:readline';

const MODE = process.env.MCPSTEWARD_FIXTURE_MODE ?? 'conforming';
const REVISION = '2026-07-28';

const TOOLS = [
  {
    name: 'get_weather',
    description: 'Returns the current weather for a location.',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City and region.' },
      },
      required: ['location'],
    },
  },
  {
    name: 'search_documents',
    description: 'Searches indexed documents by relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['query'],
    },
  },
];

/**
 * Tool variants that violate one specific rule each.
 *
 * Kept beside the conforming tools so a reader can see exactly what makes each
 * one invalid, and so a rule's failing fixture is never further away than its
 * passing one.
 */
const BROKEN_TOOLS = {
  // MS-TOOL-001: x-mcp-header on a number typed parameter, which the
  // specification forbids because a number has no canonical header encoding.
  'bad-header-number': {
    name: 'bad_header_number',
    description: 'Annotates a number parameter.',
    inputSchema: {
      type: 'object',
      properties: { amount: { type: 'number', 'x-mcp-header': 'Amount' } },
    },
  },

  // MS-TOOL-001: annotation buried under a composition keyword, so it is not
  // statically reachable through properties keys alone.
  'bad-header-unreachable': {
    name: 'bad_header_unreachable',
    description: 'Hides an annotation under anyOf.',
    inputSchema: {
      type: 'object',
      properties: {
        choice: {
          anyOf: [{ type: 'string', 'x-mcp-header': 'Choice' }, { type: 'integer' }],
        },
      },
    },
  },

  // MS-TOOL-001: two parameters claiming the same header name, differing only
  // in case. Header names are case insensitive, so one would silently win.
  'bad-header-duplicate': {
    name: 'bad_header_duplicate',
    description: 'Claims one header twice.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', 'x-mcp-header': 'Region' },
        b: { type: 'string', 'x-mcp-header': 'region' },
      },
    },
  },

  // MS-TOOL-004: a $ref pointing at a network URI, which every client is
  // forbidden from dereferencing automatically.
  'remote-ref': {
    name: 'remote_ref',
    description: 'References a remote schema.',
    inputSchema: {
      type: 'object',
      properties: { payload: { $ref: 'https://example.com/schema.json' } },
    },
  },

  // MS-ICON-001: an icon using a scheme clients must reject.
  'unsafe-icon': {
    name: 'unsafe_icon',
    description: 'Advertises a javascript icon.',
    inputSchema: { type: 'object', properties: {} },
    icons: [{ src: 'javascript:alert(1)', mimeType: 'image/png' }],
  },
};

const PROMPTS = [{ name: 'summarize', description: 'Summarizes a document.' }];

const RESOURCES = [
  { uri: 'file:///readme.md', name: 'readme', mimeType: 'text/markdown' },
];

function cacheable(body) {
  // MS-CACHE-001: results from these operations must carry caching hints.
  if (MODE === 'no-cache-metadata') return body;
  if (MODE === 'negative-ttl') return { ...body, ttlMs: -1, cacheScope: 'public' };
  if (MODE === 'bad-cache-scope') return { ...body, ttlMs: 60000, cacheScope: 'shared' };
  return { ...body, ttlMs: 60000, cacheScope: 'public' };
}

function complete(body) {
  // MS-RES-001: every result carries resultType.
  if (MODE === 'no-result-type') return body;
  // MS-RES-002: only defined values may be used.
  if (MODE === 'bad-result-type') return { resultType: 'finished', ...body };
  return { resultType: 'complete', ...body };
}

/** The tool list for the current mode. */
function toolsFor(mode) {
  if (mode === 'duplicate-tool') return [...TOOLS, TOOLS[0]];
  const broken = BROKEN_TOOLS[mode];
  if (broken !== undefined) return [...TOOLS, broken];
  return TOOLS;
}

/** The capability set for the current mode. */
function capabilitiesFor(mode) {
  // MS-DEP-001: Roots, Sampling and Logging are deprecated.
  if (mode === 'deprecated-capabilities') {
    return { tools: {}, prompts: {}, resources: {}, roots: {}, sampling: {}, logging: {} };
  }
  // MS-EXT-001: an extension identifier without the mandatory prefix.
  if (mode === 'unprefixed-extension') {
    return { tools: {}, prompts: {}, resources: {}, extensions: { mytasks: {} } };
  }
  // MS-EXT-001 passing case. A server declaring no extensions at all reports
  // not applicable rather than passing, so proving the rule accepts a correct
  // identifier needs a server that actually declares one.
  if (mode === 'prefixed-extension') {
    return {
      tools: {},
      prompts: {},
      resources: {},
      extensions: { 'io.modelcontextprotocol/tasks': {} },
    };
  }
  return { tools: {}, prompts: {}, resources: {} };
}

function serverMeta() {
  // MS-LIFE-004: servers SHOULD identify themselves in each result's _meta.
  if (MODE === 'no-server-info') return {};
  return {
    _meta: {
      'io.modelcontextprotocol/serverInfo': { name: 'fixture-server', version: '1.0.0' },
    },
  };
}

function send(message) {
  // MS-STDIO-001: one message per line, no embedded newlines.
  process.stdout.write(JSON.stringify(message) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result: { ...complete(result), ...serverMeta() } });
}

function respondError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

function readMeta(params) {
  return (params && params._meta) || {};
}

function handle(request) {
  const { id, method, params } = request;
  const meta = readMeta(params);
  const requested = meta['io.modelcontextprotocol/protocolVersion'];

  // MS-META-001: a request missing a required _meta field is malformed.
  if (MODE !== 'accepts-missing-meta') {
    if (requested === undefined) {
      respondError(id, -32602, 'Missing io.modelcontextprotocol/protocolVersion in _meta');
      return;
    }
    if (meta['io.modelcontextprotocol/clientCapabilities'] === undefined) {
      respondError(id, -32602, 'Missing io.modelcontextprotocol/clientCapabilities in _meta');
      return;
    }
  }

  // MS-ERR-006: unsupported version returns -32022 with supported and requested.
  if (requested !== undefined && requested !== REVISION && MODE !== 'accepts-any-version') {
    respondError(id, -32022, 'Unsupported protocol version', {
      supported: [REVISION],
      requested,
    });
    return;
  }

  switch (method) {
    case 'server/discover': {
      // MS-LIFE-001: servers MUST implement server/discover.
      if (MODE === 'no-discover') {
        respondError(id, -32601, 'Method not found');
        return;
      }
      respond(
        id,
        cacheable({
          supportedVersions: [REVISION],
          capabilities: capabilitiesFor(MODE),
          instructions: 'A fixture server used only by the mcpsteward test suite.',
        }),
      );
      return;
    }

    case 'tools/list':
      respond(id, cacheable({ tools: toolsFor(MODE) }));
      return;

    case 'prompts/list':
      respond(id, cacheable({ prompts: PROMPTS }));
      return;

    case 'resources/list':
      respond(id, cacheable({ resources: RESOURCES }));
      return;

    case 'resources/templates/list':
      respond(id, cacheable({ resourceTemplates: [] }));
      return;

    case 'ping':
      // MS-LIFE-007: ping was removed in this revision.
      if (MODE === 'implements-ping') {
        respond(id, {});
        return;
      }
      respondError(id, -32601, 'Method not found');
      return;

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

// Behaviours that are about the process rather than about a message.
if (MODE === 'writes-junk-to-stdout') {
  // MS-STDIO-002 violation: non MCP output on stdout.
  process.stdout.write('starting up, please wait\n');
}

if (MODE === 'noisy-stderr') {
  // Entirely legitimate. MS-STDIO-003 says a client must not treat this as an error.
  setInterval(() => process.stderr.write('debug: still alive\n'), 5).unref();
}

if (MODE === 'crashes-immediately') {
  process.exit(3);
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    respondError(null, -32700, 'Parse error');
    return;
  }

  if (MODE === 'hangs') return;

  if (MODE === 'exits-mid-capture' && request.method === 'tools/list') {
    process.exit(7);
  }

  if (MODE === 'invalid-json-response') {
    process.stdout.write('{ this is not valid json\n');
    return;
  }

  handle(request);
});

// MS-STDIO-006: exit promptly when stdin closes.
rl.on('close', () => {
  if (MODE !== 'ignores-stdin-close') process.exit(0);
});
