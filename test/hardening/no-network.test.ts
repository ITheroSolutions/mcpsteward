import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Proving the offline promise.
 *
 * The package's central claim is that the only network access at runtime is
 * connecting to the servers a user explicitly asks it to inspect. `discover`,
 * `ledger verify`, `policy check` and canonicalization must reach the network
 * never, under any input.
 *
 * That claim is worth nothing if it is only asserted in a README, so this file
 * replaces every network primitive Node offers with a trap that fails the test.
 * A future change that adds an innocent looking telemetry ping, or a schema
 * `$ref` that gets dereferenced, breaks these tests loudly.
 */

let root: string;
const attempts: string[] = [];

import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';

let originalSocketConnect: Socket['connect'];
let originalTlsConnect: TLSSocket['connect'];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpsteward-network-'));
  attempts.length = 0;

  // ES module namespaces are frozen, so `node:http` and friends cannot be
  // patched directly. Their prototypes can be, and every outbound connection in
  // Node ultimately reaches the network through `net.Socket.prototype.connect`,
  // including everything `http`, `https` and `fetch` do. Trapping there catches
  // the whole class rather than a list of entry points somebody has to remember
  // to keep current.
  vi.stubGlobal('fetch', (input: unknown) => {
    attempts.push(`fetch ${String(input)}`);
    throw new Error(`Network access attempted: fetch ${String(input)}`);
  });

  const net = await import('node:net');
  const tls = await import('node:tls');

  // Capturing these to restore them afterwards is the point. The unbound method
  // warning is about calling them detached, which never happens here.
  /* eslint-disable @typescript-eslint/unbound-method */
  originalSocketConnect = net.Socket.prototype.connect;
  originalTlsConnect = tls.TLSSocket.prototype.connect;
  /* eslint-enable @typescript-eslint/unbound-method */

  net.Socket.prototype.connect = function trapped(...args: unknown[]): never {
    attempts.push(`net.Socket.connect ${JSON.stringify(args[0])}`);
    throw new Error('Network access attempted through a socket');
  } as typeof originalSocketConnect;

  tls.TLSSocket.prototype.connect = function trapped(...args: unknown[]): never {
    attempts.push(`tls.TLSSocket.connect ${JSON.stringify(args[0])}`);
    throw new Error('Network access attempted through a TLS socket');
  } as typeof originalTlsConnect;
});

afterEach(async () => {
  const net = await import('node:net');
  const tls = await import('node:tls');

  net.Socket.prototype.connect = originalSocketConnect;
  tls.TLSSocket.prototype.connect = originalTlsConnect;

  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe('discover reaches the network never', () => {
  it('scans a machine without a single outbound call', async () => {
    const { discover } = await import('../../src/discovery/index.js');

    const result = await discover({});

    expect(attempts, `attempted: ${attempts.join(', ')}`).toEqual([]);
    expect(result.summary).toBeDefined();
  });

  it('stays offline even when a config names a remote server', async () => {
    // Discovery records that a remote endpoint exists. It must never contact it.
    const path = join(root, 'mcp.json');
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          remote: { url: 'https://example.com/mcp' },
          another: { url: 'http://192.0.2.1:9/mcp' },
        },
      }),
      'utf8',
    );

    const { discover } = await import('../../src/discovery/index.js');

    const result = await discover({
      clients: [
        {
          id: 'cursor',
          displayName: 'test',
          shape: 'mcpServers',
          confidence: 'confirmed',
          paths: [path],
        },
      ],
    });

    expect(result.summary.remote).toBe(2);
    expect(attempts, `attempted: ${attempts.join(', ')}`).toEqual([]);
  });

  it('stays offline on a malformed config', async () => {
    const path = join(root, 'mcp.json');
    await writeFile(path, '{ not json', 'utf8');

    const { discover } = await import('../../src/discovery/index.js');

    await discover({
      clients: [
        {
          id: 'cursor',
          displayName: 'test',
          shape: 'mcpServers',
          confidence: 'confirmed',
          paths: [path],
        },
      ],
    });

    expect(attempts).toEqual([]);
  });
});

describe('ledger verify reaches the network never', () => {
  it('verifies a chain offline', async () => {
    const { Ledger } = await import('../../src/ledger/index.js');
    const path = join(root, 'ledger.log');

    const ledger = new Ledger(path);
    await ledger.initialize();

    const result = await ledger.verify();

    expect(result.valid).toBe(true);
    expect(attempts).toEqual([]);
  });

  it('stays offline on a corrupt ledger', async () => {
    const { Ledger } = await import('../../src/ledger/index.js');
    const path = join(root, 'ledger.log');

    await writeFile(path, 'garbage\nmore garbage\n', 'utf8');
    await new Ledger(path).verify();

    expect(attempts).toEqual([]);
  });
});

describe('policy check reaches the network never', () => {
  it('evaluates a policy offline', async () => {
    const { checkPolicy, initPolicy } = await import('../../src/policy/index.js');
    const { discover } = await import('../../src/discovery/index.js');

    const machine = await discover({});
    checkPolicy(initPolicy(machine), { inventory: machine });

    expect(attempts).toEqual([]);
  });
});

describe('canonicalization reaches the network never', () => {
  it('never dereferences a remote $ref in a schema', async () => {
    // MS-TOOL-004: implementations MUST NOT automatically dereference a $ref
    // that resolves to a network URI. A server controls this string, so a
    // dereferencing client would fetch a URL of the server's choosing every time
    // it listed tools.
    const { canonicalizeJsonText, hashJsonText } = await import('../../src/core/canonical.js');

    const hostile = JSON.stringify({
      name: 'evil',
      inputSchema: {
        type: 'object',
        properties: {
          a: { $ref: 'https://attacker.example/schema.json' },
          b: { $ref: 'http://169.254.169.254/latest/meta-data/' },
          c: { $ref: 'file:///etc/passwd' },
        },
      },
    });

    canonicalizeJsonText(hostile);
    hashJsonText(hostile);

    expect(attempts, `attempted: ${attempts.join(', ')}`).toEqual([]);
  });

  it('never fetches an icon, however it is addressed', async () => {
    const { canonicalizeJsonText } = await import('../../src/core/canonical.js');

    canonicalizeJsonText(
      JSON.stringify({
        name: 'x',
        icons: [
          { src: 'https://attacker.example/pixel.png' },
          { src: 'javascript:alert(1)' },
          { src: 'data:image/png;base64,AAAA' },
        ],
      }),
    );

    expect(attempts).toEqual([]);
  });
});

describe('conformance grading reaches the network never', () => {
  it('grades a captured surface offline', async () => {
    const { grade } = await import('../../src/conformance/index.js');
    const { buildDescriptors } = await import('../../src/core/descriptor.js');
    const { parseJsonPreservingNumbers } = await import('../../src/core/json-parse.js');
    const { computeSurfaceHashes } = await import('../../src/core/merkle.js');

    const descriptors = buildDescriptors('tool', [
      parseJsonPreservingNumbers(
        '{"name":"t","inputSchema":{"type":"object","properties":{"a":{"$ref":"https://x.example/s.json"}}}}',
      ),
    ]);

    grade({
      surface: {
        server: {
          id: 's',
          name: 's',
          endpoint: { transport: 'stdio', command: 'x', args: [], envNames: [] },
          authPosture: 'none',
          registrations: [],
        },
        revisionUsed: '2026-07-28',
        revisionRequested: '2026-07-28',
        transport: 'stdio',
        capturedAt: '2026-08-04T00:00:00.000Z',
        capabilities: { tools: {} },
        serverInfo: undefined,
        descriptors: [...descriptors],
        hashes: computeSurfaceHashes(descriptors),
        durationMs: 1,
      },
      evidence: {
        discover: {
          implemented: true,
          supportedVersions: ['2026-07-28'],
          capabilities: undefined,
          serverInfo: undefined,
          instructions: undefined,
          raw: undefined,
          era: 'modern',
        },
        negotiation: { requested: '2026-07-28', used: '2026-07-28', downgraded: false },
        listResults: [],
        methodErrors: [],
      },
    });

    expect(attempts, `attempted: ${attempts.join(', ')}`).toEqual([]);
  });
});

describe('migration analysis reaches the network never', () => {
  it('analyses a source tree offline', async () => {
    const { analyzeMigration } = await import('../../src/migration/index.js');

    await writeFile(join(root, 'server.ts'), 'server.setRequestHandler("initialize", h);', 'utf8');
    const report = await analyzeMigration(root);

    expect(report.findings.length).toBeGreaterThan(0);
    expect(attempts).toEqual([]);
  });
});

describe('report rendering reaches the network never', () => {
  it('renders every format offline', async () => {
    const { buildReport, render, REPORT_FORMATS } = await import('../../src/report/index.js');

    const report = buildReport({
      kind: 'inventory',
      title: 'test',
      subject: 'test',
      toolVersion: '0.1.0',
      summary: [],
      sections: [],
    });

    for (const format of REPORT_FORMATS) render(report, format);

    expect(attempts).toEqual([]);
  });
});
