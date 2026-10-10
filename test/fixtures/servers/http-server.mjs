/**
 * A conforming 2026-07-28 Streamable HTTP MCP server, for tests only.
 *
 * Exported as a factory rather than a script so the test can start it on an
 * ephemeral port, learn the port, and shut it down deterministically. Behaviour is
 * varied through the `mode` option so one implementation can act as the correct
 * server and several specifically broken ones.
 *
 * Binds to 127.0.0.1 only, per MS-HTTP-010.
 */

import { createServer } from 'node:http';

const REVISION = '2026-07-28';

const TOOLS = [
  {
    name: 'get_weather',
    description: 'Returns the current weather for a location.',
    inputSchema: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
    },
  },
];

function cacheable(body, mode) {
  if (mode === 'no-cache-metadata') return body;
  return { ...body, ttlMs: 60000, cacheScope: 'public' };
}

export async function startHttpFixture({ mode = 'conforming' } = {}) {
  const received = [];

  const server = createServer((req, res) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(chunk));

    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');

      received.push({
        method: req.method,
        headers: { ...req.headers },
        body: bodyText,
      });

      // MS-HTTP-011: a server supporting only this revision responds 405 to GET
      // and DELETE on the MCP endpoint.
      if (req.method !== 'POST') {
        if (mode === 'allows-get') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('');
          return;
        }
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method Not Allowed' } }));
        return;
      }

      // MS-HTTP-009: validate Origin, reject an invalid one with 403.
      const origin = req.headers['origin'];
      if (origin !== undefined && mode !== 'ignores-origin') {
        if (!origin.startsWith('http://127.0.0.1') && !origin.startsWith('http://localhost')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Forbidden origin' } }));
          return;
        }
      }

      let request;
      try {
        request = JSON.parse(bodyText);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      const id = request.id;
      const meta = (request.params && request.params._meta) || {};
      const bodyVersion = meta['io.modelcontextprotocol/protocolVersion'];
      const headerVersion = req.headers['mcp-protocol-version'];

      const fail = (status, code, message, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: id ?? null,
            error: { code, message, ...(data ? { data } : {}) },
          }),
        );
      };

      // MS-HTTP-004: reject a header that disagrees with the body, 400 + -32020.
      if (mode !== 'ignores-header-mismatch') {
        if (headerVersion === undefined) {
          fail(400, -32020, 'Missing MCP-Protocol-Version header');
          return;
        }
        if (bodyVersion !== undefined && headerVersion !== bodyVersion) {
          fail(400, -32020, 'Header mismatch: MCP-Protocol-Version does not match body');
          return;
        }
        if (req.headers['mcp-method'] === undefined) {
          fail(400, -32020, 'Missing Mcp-Method header');
          return;
        }
        if (req.headers['mcp-method'] !== request.method) {
          fail(400, -32020, 'Header mismatch: Mcp-Method does not match body');
          return;
        }
      }

      // MS-META-001: a request missing a required _meta field is malformed.
      if (bodyVersion === undefined) {
        fail(400, -32602, 'Missing io.modelcontextprotocol/protocolVersion in _meta');
        return;
      }
      if (meta['io.modelcontextprotocol/clientCapabilities'] === undefined) {
        fail(400, -32602, 'Missing io.modelcontextprotocol/clientCapabilities in _meta');
        return;
      }

      // MS-ERR-006: unsupported version returns -32022 with supported and requested.
      if (bodyVersion !== REVISION) {
        fail(400, -32022, 'Unsupported protocol version', {
          supported: [REVISION],
          requested: bodyVersion,
        });
        return;
      }

      const respond = (result) => {
        // A response that never arrives, so a test can cancel or time out
        // against a request that is genuinely in flight rather than one that
        // failed to connect.
        if (mode === 'never-responds') return;

        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            ...result,
            _meta: {
              'io.modelcontextprotocol/serverInfo': { name: 'http-fixture', version: '1.0.0' },
            },
          },
        });

        if (mode === 'streams-response') {
          // The SSE path: a progress notification, a keep-alive comment, then
          // the final response terminating the stream.
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'X-Accel-Buffering': 'no',
          });
          res.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
          res.write(':\n\n');
          res.write(`data: ${payload}\n\n`);
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      };

      switch (request.method) {
        case 'server/discover':
          respond(
            cacheable(
              {
                supportedVersions: [REVISION],
                capabilities: { tools: {} },
                instructions: 'An HTTP fixture server used only by the mcpsteward test suite.',
              },
              mode,
            ),
          );
          return;

        case 'tools/list':
          respond(cacheable({ tools: TOOLS }, mode));
          return;

        default:
          // MS-HTTP-005: an unimplemented method is 404 with -32601.
          fail(404, -32601, `Method not found: ${request.method}`);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/mcp`;

  return {
    url,
    received,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
