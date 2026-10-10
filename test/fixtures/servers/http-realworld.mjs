/**
 * HTTP servers that behave the way real hosted MCP servers were observed to.
 *
 * The conforming fixture in http-server.mjs is a model citizen. These are not.
 * Each mode reproduces a response seen from a real server when mcpsteward was first
 * pointed at one, so the tests pin the behaviour against the actual shapes:
 *
 * - `auth-vendor-json`: 401 with a challenge and a vendor error body such as
 *   `{"error":"invalid_token"}`. Seen from several large hosted servers.
 * - `auth-jsonrpc`: 401 whose body is a well formed JSON-RPC error.
 * - `auth-forbidden`: 403 with a plain text body.
 * - `legacy-session`: a handshake era Streamable HTTP server that issues an
 *   `Mcp-Session-Id`, rejects any later request without it, rejects a
 *   `MCP-Protocol-Version` header other than the one agreed, and, like the
 *   Python SDK, refuses requests until `notifications/initialized` arrives.
 * - `json-not-jsonrpc`: 200 with JSON that is not a JSON-RPC message.
 *
 * Binds to 127.0.0.1 only.
 */

import { createServer } from 'node:http';

const LEGACY = '2025-11-25';
const SESSION = 'session-7f3a';

export async function startRealWorldFixture({ mode }) {
  const received = [];
  const state = { initialized: false, closed: false };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      received.push({ method: req.method, headers: { ...req.headers }, body: bodyText });

      const json = (status, body, extra = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
        res.end(JSON.stringify(body));
      };

      if (mode === 'auth-vendor-json') {
        json(401, { error: 'invalid_token', error_description: 'Missing or invalid access token' }, {
          'WWW-Authenticate': 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"',
        });
        return;
      }

      if (mode === 'auth-jsonrpc') {
        json(401, { jsonrpc: '2.0', error: { code: -32603, message: 'Unauthorized' } });
        return;
      }

      if (mode === 'auth-forbidden') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      if (mode === 'json-not-jsonrpc') {
        json(200, { status: 'ok', message: 'hello' });
        return;
      }

      // legacy-session
      if (req.method === 'DELETE') {
        if (req.headers['mcp-session-id'] === SESSION) state.closed = true;
        res.writeHead(200);
        res.end();
        return;
      }

      let request;
      try {
        request = JSON.parse(bodyText);
      } catch {
        json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }

      const reject = (message) =>
        json(400, { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message } });

      if (request.method === 'initialize') {
        const header = req.headers['mcp-protocol-version'];
        if (header !== undefined && header !== request.params?.protocolVersion) {
          reject(`Bad Request: Unsupported protocol version: ${header}`);
          return;
        }
        json(
          200,
          {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: LEGACY,
              capabilities: { tools: {} },
              serverInfo: { name: 'legacy-session-fixture', version: '1.0.0' },
            },
          },
          { 'Mcp-Session-Id': SESSION },
        );
        return;
      }

      if (req.headers['mcp-session-id'] !== SESSION) {
        reject('Bad Request: Server not initialized');
        return;
      }

      if (req.headers['mcp-protocol-version'] !== LEGACY) {
        reject(`Bad Request: Unsupported protocol version: ${req.headers['mcp-protocol-version']}`);
        return;
      }

      if (request.method === 'notifications/initialized') {
        state.initialized = true;
        res.writeHead(202);
        res.end();
        return;
      }

      if (!state.initialized) {
        reject('Received request before initialization was complete');
        return;
      }

      if (request.method === 'tools/list') {
        json(200, {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: [
              {
                name: 'lookup',
                description: 'Looks something up.',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        });
        return;
      }

      json(200, {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    received,
    state,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
