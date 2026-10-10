import { describe, expect, it } from 'vitest';

import {
  buildHttpHeaders,
  buildRequest,
  buildRequestMeta,
  CLIENT_INFO,
  decodeHeaderValue,
  encodeHeaderValue,
  META_KEYS,
  METHODS_REQUIRING_NAME_HEADER,
  serializeForStdio,
} from '../../src/protocol/messages.js';

describe('request _meta', () => {
  it('carries the two required fields by default', () => {
    // MS-META-001: protocolVersion and clientCapabilities are required on every
    // request. A server must reject a request missing either with -32602.
    const meta = buildRequestMeta({ revision: '2026-07-28' });

    expect(meta[META_KEYS.protocolVersion]).toBe('2026-07-28');
    expect(meta[META_KEYS.clientCapabilities]).toEqual({});
  });

  it('identifies the client by default', () => {
    // Clients SHOULD include clientInfo on every request.
    const meta = buildRequestMeta({ revision: '2026-07-28' });
    expect(meta[META_KEYS.clientInfo]).toEqual({
      name: CLIENT_INFO.name,
      version: CLIENT_INFO.version,
    });
  });

  it('omits clientInfo when explicitly disabled', () => {
    const meta = buildRequestMeta({ revision: '2026-07-28', clientInfo: false });
    expect(META_KEYS.clientInfo in meta).toBe(false);
  });

  it('carries declared capabilities', () => {
    const meta = buildRequestMeta({
      revision: '2026-07-28',
      capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
    });

    expect(meta[META_KEYS.clientCapabilities]).toEqual({
      extensions: { 'io.modelcontextprotocol/tasks': {} },
    });
  });

  it('carries an optional log level', () => {
    // Servers MUST NOT emit notifications/message for requests without this.
    const meta = buildRequestMeta({ revision: '2026-07-28', logLevel: 'debug' });
    expect(meta[META_KEYS.logLevel]).toBe('debug');
  });

  it('omits the log level when not requested', () => {
    expect(META_KEYS.logLevel in buildRequestMeta({ revision: '2026-07-28' })).toBe(false);
  });

  describe('deliberate malformation, for probing', () => {
    // These exist because a conformance prober has to send exactly the request a
    // correct client library is built to make impossible.
    it('can omit the protocol version', () => {
      const meta = buildRequestMeta({ revision: '2026-07-28', omitProtocolVersion: true });
      expect(META_KEYS.protocolVersion in meta).toBe(false);
      expect(META_KEYS.clientCapabilities in meta).toBe(true);
    });

    it('can omit capabilities', () => {
      const meta = buildRequestMeta({ revision: '2026-07-28', omitCapabilities: true });
      expect(META_KEYS.clientCapabilities in meta).toBe(false);
      expect(META_KEYS.protocolVersion in meta).toBe(true);
    });
  });
});

describe('buildRequest', () => {
  it('produces a well formed JSON-RPC 2.0 request', () => {
    const request = buildRequest({ id: 1, method: 'tools/list', revision: '2026-07-28' });

    expect(request['jsonrpc']).toBe('2.0');
    expect(request['id']).toBe(1);
    expect(request['method']).toBe('tools/list');
  });

  it('nests _meta inside params, not beside them', () => {
    const request = buildRequest({
      id: 'a',
      method: 'tools/call',
      revision: '2026-07-28',
      params: { name: 'get_weather', arguments: { location: 'Sarnia' } },
    });

    const params = request['params'] as Record<string, unknown>;
    expect(params['name']).toBe('get_weather');
    expect(params['_meta']).toBeDefined();
    expect(request['_meta']).toBeUndefined();
  });

  it('can omit _meta entirely for probing', () => {
    const request = buildRequest({
      id: 1,
      method: 'tools/list',
      revision: '2026-07-28',
      omitMeta: true,
    });

    expect((request['params'] as Record<string, unknown>)['_meta']).toBeUndefined();
  });

  it('accepts a string id as well as a number', () => {
    expect(buildRequest({ id: 'discover-1', method: 'server/discover', revision: '2026-07-28' })['id']).toBe(
      'discover-1',
    );
  });
});

describe('stdio framing', () => {
  it('appends exactly one newline', () => {
    const line = serializeForStdio({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
  });

  it('escapes newlines inside string values rather than emitting them raw', () => {
    // MS-STDIO-001: messages MUST NOT contain embedded newlines. A tool
    // description with a line break is completely ordinary, so this is the
    // common case rather than an edge case.
    const line = serializeForStdio({ description: 'first line\nsecond line' });

    expect(line.split('\n')).toHaveLength(2);
    expect(line).toContain('\\n');
  });

  it('round trips through JSON.parse', () => {
    const message = { jsonrpc: '2.0', id: 1, params: { text: 'a\nb\tc' } };
    expect(JSON.parse(serializeForStdio(message))).toEqual(message);
  });

  it('handles unicode without corrupting it', () => {
    const line = serializeForStdio({ name: '世界' });
    expect(JSON.parse(line)).toEqual({ name: '世界' });
  });
});

describe('HTTP headers', () => {
  it('sends the protocol version header matching the body', () => {
    // MS-HTTP-002: the header value MUST match the body _meta value, and a
    // server MUST reject a mismatch with 400 and -32020.
    const headers = buildHttpHeaders({ revision: '2026-07-28', method: 'tools/list' });
    expect(headers['MCP-Protocol-Version']).toBe('2026-07-28');
  });

  it('sends Mcp-Method on every request', () => {
    const headers = buildHttpHeaders({ revision: '2026-07-28', method: 'tools/list' });
    expect(headers['Mcp-Method']).toBe('tools/list');
  });

  it('sends Mcp-Name when a name is supplied', () => {
    const headers = buildHttpHeaders({
      revision: '2026-07-28',
      method: 'tools/call',
      name: 'get_weather',
    });
    expect(headers['Mcp-Name']).toBe('get_weather');
  });

  it('accepts both content types, as required', () => {
    const headers = buildHttpHeaders({ revision: '2026-07-28', method: 'tools/list' });
    expect(headers['Accept']).toContain('application/json');
    expect(headers['Accept']).toContain('text/event-stream');
  });

  it('knows which methods require the name header', () => {
    expect(METHODS_REQUIRING_NAME_HEADER.has('tools/call')).toBe(true);
    expect(METHODS_REQUIRING_NAME_HEADER.has('resources/read')).toBe(true);
    expect(METHODS_REQUIRING_NAME_HEADER.has('prompts/get')).toBe(true);
    expect(METHODS_REQUIRING_NAME_HEADER.has('tools/list')).toBe(false);
  });

  describe('deliberate malformation, for probing', () => {
    it('can omit each required header independently', () => {
      expect(
        'MCP-Protocol-Version' in
          buildHttpHeaders({
            revision: '2026-07-28',
            method: 'tools/list',
            omitProtocolVersionHeader: true,
          }),
      ).toBe(false);

      expect(
        'Mcp-Method' in
          buildHttpHeaders({
            revision: '2026-07-28',
            method: 'tools/list',
            omitMethodHeader: true,
          }),
      ).toBe(false);
    });

    it('can send a name header that disagrees with the body', () => {
      // This is the only way to test MS-HTTP-004, which requires the server to
      // reject a header and body mismatch with -32020.
      const headers = buildHttpHeaders({
        revision: '2026-07-28',
        method: 'tools/call',
        name: 'real_name',
        overrideName: 'different_name',
      });

      expect(headers['Mcp-Name']).toBe('different_name');
    });
  });
});

describe('header value encoding', () => {
  it('leaves plain ASCII alone', () => {
    expect(encodeHeaderValue('us-west1')).toBe('us-west1');
    expect(encodeHeaderValue('get_weather')).toBe('get_weather');
    expect(encodeHeaderValue('file:///projects/config.json')).toBe(
      'file:///projects/config.json',
    );
  });

  it('encodes non ASCII', () => {
    expect(encodeHeaderValue('Hello, 世界')).toBe('=?base64?SGVsbG8sIOS4lueVjA==?=');
  });

  it('encodes leading and trailing whitespace', () => {
    expect(encodeHeaderValue(' padded ')).toBe('=?base64?IHBhZGRlZCA=?=');
  });

  it('encodes embedded newlines', () => {
    expect(encodeHeaderValue('line1\nline2')).toBe('=?base64?bGluZTEKbGluZTI=?=');
  });

  it('encodes a plain ASCII value that looks like the sentinel', () => {
    // Otherwise a tool genuinely named =?base64?literal?= would be decoded as
    // though it were encoded, and the header would stop matching the body.
    expect(encodeHeaderValue('=?base64?literal?=')).toBe('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=');
  });

  it('round trips every case', () => {
    const cases = [
      'us-west1',
      'Hello, 世界',
      ' padded ',
      'line1\nline2',
      '=?base64?literal?=',
      'file:///a/b/c.json',
      '',
    ];

    for (const value of cases) {
      expect(decodeHeaderValue(encodeHeaderValue(value))).toBe(value);
    }
  });

  it('leaves an unencoded value alone when decoding', () => {
    expect(decodeHeaderValue('plain')).toBe('plain');
  });
});
