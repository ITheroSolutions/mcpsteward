#!/usr/bin/env node
/**
 * A genuine 2025-11-25 legacy MCP server, built on the official SDK.
 *
 * One correct fixture per revision. The modern one is hand
 * written because no published SDK implements 2026-07-28, but the legacy one is
 * deliberately NOT hand written: this is exactly where the SDK devDependency
 * earns its keep.
 *
 * A legacy fixture we wrote ourselves would only prove that our client agrees
 * with our own reading of the old specification. Built on the SDK, it proves the
 * era probe and the downgrade path work against a real implementation somebody
 * else maintains, which is the only version of that test worth having.
 *
 * This server requires the `initialize` handshake and speaks no modern method, so
 * a modern request against it must fail deterministically rather than being half
 * understood.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const TOOLS = [
  {
    name: 'legacy_lookup',
    description: 'Looks up a term. Served by a 2025-11-25 era server.',
    inputSchema: {
      type: 'object',
      properties: { term: { type: 'string' } },
      required: ['term'],
    },
  },
];

const PROMPTS = [{ name: 'legacy_summarize', description: 'Summarizes a document.' }];

const RESOURCES = [
  { uri: 'file:///legacy.md', name: 'legacy', mimeType: 'text/markdown' },
];

const server = new Server(
  { name: 'legacy-fixture', version: '1.0.0' },
  { capabilities: { tools: {}, prompts: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: PROMPTS }));
server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: RESOURCES }));
server.setRequestHandler(CallToolRequestSchema, (request) => ({
  content: [{ type: 'text', text: `Definition of ${String(request.params.arguments?.term)}` }],
}));

await server.connect(new StdioServerTransport());
