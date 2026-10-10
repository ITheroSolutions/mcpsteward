/**
 * Migration findings that are true.
 *
 * Pointed at four real MCP server packages from the npm registry, the analyzer
 * first scanned nothing at all, because packages keep their code under dist, which
 * it ignored. Once it did scan them, most findings were false: `ping` inside
 * "Scraping", `GET` inside `INLINE_TOKEN_BUDGET`, the identifier `get` in
 * `map.get(key)`, every method called `initialize` and every search session's
 * `sessionId`. Across the four packages 689 findings became 7, each of which
 * points at something that really changes under 2026-07-28.
 *
 * Every snippet below is shaped like the real code that produced a false finding,
 * or a true one.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeMigration } from '../../src/migration/index.js';
import { run, type CliIo } from '../../src/cli/index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpsteward-precision-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, contents: string): Promise<void> {
  const full = join(root, relativePath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

async function idsFor(relativePath: string, contents: string, forceLinePass = false): Promise<string[]> {
  await write(relativePath, contents);
  const report = await analyzeMigration(root, { forceLinePass });
  return report.findings.map((f) => f.patternId);
}

describe('ordinary JavaScript that is not a migration problem', () => {
  const ordinary = [
    'log.info("Scraping URL", { url });',
    'log.info("Mapping URL", { url });',
    'log.info("Stopping interact session", { scrapeId });',
    'var INLINE_TOKEN_BUDGET = 2e4;',
    'const value = cache.get(key);',
    'app.get("/ping", (req, res) => res.send("ok"));',
    'res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,DELETE");',
    'class Device { async initialize() { this.ready = true; } }',
    'const sessionId = searchManager.start(query);',
    'const transport = new Transport({ sessionIdGenerator: undefined });',
    'const roots = listDirectories();',
  ];

  for (const line of ordinary) {
    it(`reports nothing for: ${line}`, async () => {
      expect(await idsFor('src/index.js', line)).toEqual([]);
    });
  }

  it('reports nothing in the line pass either, for the substring cases', async () => {
    const text = ['log.info("Scraping URL");', 'var INLINE_TOKEN_BUDGET = 2e4;', 'mapping();'].join('\n');
    expect(await idsFor('src/index.js', text, true)).toEqual([]);
  });
});

describe('code that really is a migration problem', () => {
  it('finds an initialize handler registered through the SDK schema', async () => {
    expect(
      await idsFor('src/server.js', 'server.setRequestHandler(InitializeRequestSchema, async () => ({}));'),
    ).toContain('MIG-INITIALIZE');
  });

  it('finds initialize and ping as method name strings', async () => {
    const ids = await idsFor('src/server.ts', "switch (method) { case 'initialize': break; case 'ping': break; }");
    expect(ids).toContain('MIG-INITIALIZE');
    expect(ids).toContain('MIG-PING');
  });

  it('finds a GET route on the MCP endpoint, the legacy SSE stream', async () => {
    expect(await idsFor('src/http.js', 'app.get("/mcp", handleStream);')).toEqual(['MIG-GET-STREAM']);
    expect(await idsFor('src/sse.js', "router.get('/sse', handleStream);")).toContain('MIG-GET-STREAM');
  });

  it('finds the same GET route in the line pass', async () => {
    expect(await idsFor('src/http.js', 'app.get("/mcp", handleStream);', true)).toEqual(['MIG-GET-STREAM']);
  });

  it('finds a deprecated capability declared as a key', async () => {
    expect(await idsFor('src/server.js', 'const caps = { tools: {}, logging: {} };')).toEqual([
      'MIG-DEPRECATED-CAPABILITY',
    ]);
  });

  it('finds the session header by name', async () => {
    expect(await idsFor('src/http.ts', "const id = req.headers['mcp-session-id'];")).toContain('MIG-SESSION');
  });
});

describe('what gets scanned', () => {
  it('scans compiled output when a package has nothing else, and says so', async () => {
    await write('dist/index.js', 'server.setRequestHandler(InitializeRequestSchema, h);');
    const report = await analyzeMigration(root);

    expect(report.filesScanned).toBe(1);
    expect(report.scannedCompiledOutput).toBe(true);
    expect(report.findings.map((f) => f.patternId)).toEqual(['MIG-INITIALIZE']);
  });

  it('still ignores dist when there is source alongside it', async () => {
    await write('src/index.ts', 'export const x = 1;');
    await write('dist/index.js', 'server.setRequestHandler(InitializeRequestSchema, h);');
    const report = await analyzeMigration(root);

    expect(report.scannedCompiledOutput).toBeUndefined();
    expect(report.findings).toEqual([]);
  });

  it('skips type declarations, which duplicate the code they describe', async () => {
    await write('dist/index.d.ts', 'export declare function initialize(): InitializeRequest;');
    await write('dist/index.js', 'export const x = 1;');
    expect((await analyzeMigration(root)).findings).toEqual([]);
  });

  it('skips a minified bundle', async () => {
    const minified = 'var a="initialize",b="ping",c=x.get("/mcp");'.repeat(1_000);
    await write('public/assets/index-abc123.js', minified);
    expect((await analyzeMigration(root)).findings).toEqual([]);
  });
});

describe('migrate exit codes', () => {
  async function cli(args: readonly string[]): Promise<number> {
    const io: CliIo = { stdout: () => undefined, stderr: () => undefined, env: {}, isTty: false };
    return await run(args, io);
  }

  it('exits 0 for a clean codebase', async () => {
    // It used to exit 1 unconditionally, so migrate in CI could never pass.
    await write('src/index.ts', 'export const add = (a: number, b: number) => a + b;');
    expect(await cli(['migrate', root])).toBe(0);
  });

  it('exits 1 when it finds something', async () => {
    await write('src/index.ts', "const m = 'initialize';");
    expect(await cli(['migrate', root])).toBe(1);
  });

  it('exits 2 when there is nothing to scan, rather than passing', async () => {
    expect(await cli(['migrate', root])).toBe(2);
  });
});
