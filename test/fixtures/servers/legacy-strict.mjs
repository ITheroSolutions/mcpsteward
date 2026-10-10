#!/usr/bin/env node
/**
 * A handshake era stdio server that is strict about the handshake, the way the
 * Python MCP SDK is: every request before `notifications/initialized` arrives is
 * refused. The SDK built legacy fixture is lenient and would not notice a client
 * that never sends the notification, which is exactly how mcpsteward came to never
 * send it on stdio without any test failing.
 */

import { createInterface } from 'node:readline';

let initialized = false;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'notifications/initialized') {
    initialized = true;
    return;
  }
  if (message.id === undefined) return;

  const fail = (code, text) => send({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'legacy-strict', version: '1.0.0' },
      },
    });
    return;
  }

  // Mimics an older Python SDK server observed in the wild: an unknown method
  // name fails validation and the process exits instead of replying.
  const KNOWN = new Set([
    'initialize',
    'ping',
    'tools/list',
    'prompts/list',
    'resources/list',
    'resources/templates/list',
  ]);
  if (process.env.LEGACY_STRICT_CRASH_ON_UNKNOWN === '1' && !KNOWN.has(message.method)) {
    process.stderr.write(`ValidationError: Input should be 'tools/list' [input_value='${message.method}']\n`);
    process.exit(1);
  }

  if (!initialized) {
    fail(-32602, 'Received request before initialization was complete');
    return;
  }

  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: [{ name: 'strict_tool', inputSchema: { type: 'object' } }] },
    });
    return;
  }

  fail(-32601, `Method not found: ${message.method}`);
});
