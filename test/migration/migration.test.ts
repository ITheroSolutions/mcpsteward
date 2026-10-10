import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { allMigrationPatterns, analyzeMigration, patternById } from '../../src/migration/index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpsteward-migration-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, contents: string): Promise<void> {
  const full = join(root, relativePath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents, 'utf8');
}

describe('pattern registry', () => {
  it('gives every pattern a unique id', () => {
    const ids = allMigrationPatterns().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every pattern a specific fix rather than a gesture at the changelog', () => {
    for (const pattern of allMigrationPatterns()) {
      expect(pattern.fix.length, `${pattern.id} has no real fix`).toBeGreaterThan(40);
      expect(pattern.why.length, `${pattern.id} does not explain why`).toBeGreaterThan(40);
    }
  });

  it('ties every pattern to a rule in SPEC-NOTES', () => {
    for (const pattern of allMigrationPatterns()) {
      expect(pattern.rule).toMatch(/^(MS-|SEP-)/);
    }
  });

  it('looks a pattern up by id', () => {
    expect(patternById('MIG-SESSION')?.severity).toBe('critical');
    expect(patternById('MIG-NOPE')).toBeUndefined();
  });
});

describe('detecting each breaking pattern', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['MIG-INITIALIZE', 'server.setRequestHandler("initialize", handler);', 'initialize handler'],
    ['MIG-SESSION', 'const id = headers["Mcp-Session-Id"];', 'session header'],
    ['MIG-SUBSCRIBE', 'server.setRequestHandler("resources/subscribe", h);', 'subscribe method'],
    ['MIG-PING', 'server.setRequestHandler("ping", h);', 'ping handler'],
    ['MIG-SERVER-REQUEST', 'await server.request("sampling/createMessage", p);', 'server request'],
    ['MIG-TASKS', 'const r = await client.request("tasks/result", p);', 'tasks/result'],
    ['MIG-RESUMABILITY', 'const last = req.headers["Last-Event-ID"];', 'resumability'],
  ];

  for (const [patternId, source, description] of cases) {
    it(`detects ${description}`, async () => {
      await write('src/server.ts', source);

      const report = await analyzeMigration(root);
      const found = report.findings.filter((f) => f.patternId === patternId);

      expect(found.length, `${patternId} not detected in: ${source}`).toBeGreaterThan(0);
      expect(found[0]?.file).toBe('src/server.ts');
      expect(found[0]?.line).toBe(1);
    });
  }

  it('reports the retired error codes', async () => {
    await write('src/errors.ts', 'const RESOURCE_NOT_FOUND = -32002;');

    const report = await analyzeMigration(root);
    expect(report.findings.some((f) => f.patternId === 'MIG-ERROR-CODE')).toBe(true);
  });

  it('carries the specific fix into the finding', async () => {
    await write('src/server.ts', 'server.setRequestHandler("initialize", handler);');

    const report = await analyzeMigration(root);
    const finding = report.findings.find((f) => f.patternId === 'MIG-INITIALIZE');

    expect(finding?.fix).toContain('server/discover');
    expect(finding?.why).toContain('removed');
    expect(finding?.rule).toBe('MS-LIFE-005');
  });
});

describe('avoiding false positives', () => {
  it('does not report a method name mentioned in a line comment', async () => {
    await write(
      'src/notes.ts',
      ['// We used to send initialize here before the rewrite.', 'const x = 1;'].join('\n'),
    );

    const report = await analyzeMigration(root);
    expect(report.findings).toEqual([]);
  });

  it('does not report a method name inside a block comment', async () => {
    await write(
      'src/notes.ts',
      ['/*', ' * The old Mcp-Session-Id header lived here.', ' */', 'const x = 1;'].join('\n'),
    );

    const report = await analyzeMigration(root);
    expect(report.findings).toEqual([]);
  });

  it('does not report a word that merely contains a signal', async () => {
    // "ping" appears inside mapping, shipping and stripping. A substring match
    // would flood any real codebase and train people to ignore the report.
    await write(
      'src/util.ts',
      ['const mapping = {};', 'function stripping(s) { return s; }', 'let shipping = true;'].join(
        '\n',
      ),
    );

    const report = await analyzeMigration(root);
    expect(report.findings.filter((f) => f.patternId === 'MIG-PING')).toEqual([]);
  });

  it('does not report an unrelated identifier that resembles a header', async () => {
    await write('src/util.ts', 'const sessionIdentifier = 1;');

    const report = await analyzeMigration(root);
    expect(report.findings.filter((f) => f.patternId === 'MIG-SESSION')).toEqual([]);
  });

  it('reports a clean modern server as clean', async () => {
    await write(
      'src/server.ts',
      [
        'export function handleDiscover() {',
        '  return { resultType: "complete", supportedVersions: ["2026-07-28"], ttlMs: 60000 };',
        '}',
      ].join('\n'),
    );

    const report = await analyzeMigration(root);
    expect(report.findings).toEqual([]);
  });
});

describe('analysis passes', () => {
  it('uses the compiler when it is available', async () => {
    await write('src/server.ts', 'const x = 1;');

    const report = await analyzeMigration(root);
    expect(report.analysis).toBe('typescript');
    expect(report.degradedReason).toBeUndefined();
  });

  it('labels line pass findings as lower confidence', async () => {
    await write('src/server.ts', 'server.setRequestHandler("initialize", h);');

    const compiled = await analyzeMigration(root);
    const lines = await analyzeMigration(root, { forceLinePass: true });

    expect(compiled.findings[0]?.confidence).toBe('high');
    expect(lines.findings[0]?.confidence).toBe('low');
    expect(lines.analysis).toBe('line-oriented');
  });

  it('still analyses non TypeScript languages, at lower confidence', async () => {
    // The compiler cannot parse Python, so those files take the line pass even
    // when it is available. Labelling that honestly is the whole point.
    await write('src/server.py', 'handler = server.request_handler("resources/subscribe")');

    const report = await analyzeMigration(root);
    const finding = report.findings.find((f) => f.patternId === 'MIG-SUBSCRIBE');

    expect(finding).toBeDefined();
    expect(finding?.confidence).toBe('medium');
  });
});

describe('tree walking', () => {
  it('skips node_modules and other build directories', async () => {
    await write('node_modules/pkg/index.ts', 'server.setRequestHandler("initialize", h);');
    await write('dist/bundle.js', 'server.setRequestHandler("initialize", h);');
    await write('src/clean.ts', 'const x = 1;');

    const report = await analyzeMigration(root);

    expect(report.findings).toEqual([]);
    expect(report.filesScanned).toBe(1);
  });

  it('walks nested directories', async () => {
    await write('src/a/b/c/deep.ts', 'const id = headers["Mcp-Session-Id"];');

    const report = await analyzeMigration(root);
    expect(report.findings[0]?.file).toBe('src/a/b/c/deep.ts');
  });

  it('uses forward slashes in reported paths on every platform', async () => {
    await write('src/nested/server.ts', 'const id = headers["Mcp-Session-Id"];');

    const report = await analyzeMigration(root);
    expect(report.findings[0]?.file).not.toContain('\\');
  });

  it('honours the file cap', async () => {
    for (let i = 0; i < 10; i += 1) {
      await write(`src/file${String(i)}.ts`, 'const x = 1;');
    }

    const report = await analyzeMigration(root, { maxFiles: 3 });
    expect(report.filesScanned).toBe(3);
  });

  it('returns an empty report for an empty tree', async () => {
    const report = await analyzeMigration(root);
    expect(report.filesScanned).toBe(0);
    expect(report.findings).toEqual([]);
  });
});

describe('report shape', () => {
  it('sorts findings by severity then location', async () => {
    await write('src/a.ts', 'const level = "logging/setLevel";');
    await write('src/b.ts', 'const id = headers["Mcp-Session-Id"];');

    const report = await analyzeMigration(root);
    const order = ['critical', 'high', 'medium', 'low'];
    const ranks = report.findings.map((f) => order.indexOf(f.severity));

    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('summarises counts per pattern', async () => {
    await write('src/a.ts', 'const id = headers["Mcp-Session-Id"];');
    await write('src/b.ts', 'const other = headers["Mcp-Session-Id"];');

    const report = await analyzeMigration(root);
    expect(report.summary['MIG-SESSION']).toBe(2);
  });

  it('redacts a credential that was hardcoded in the source', async () => {
    // A migration report is an outbound artifact like any other, and a server
    // repository is exactly where a hardcoded token tends to live.
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    await write('src/server.ts', `const token = "${secret}"; server.request("ping", {});`);

    const report = await analyzeMigration(root);
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});
