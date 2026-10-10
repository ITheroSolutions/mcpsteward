import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import * as api from '../../src/api.js';
import * as root from '../../src/index.js';

const execFileAsync = promisify(execFile);

const EXAMPLES_DIR = fileURLToPath(new URL('../../examples', import.meta.url));

async function exampleFiles(): Promise<string[]> {
  return (await readdir(EXAMPLES_DIR)).filter((name) => name.endsWith('.mjs')).sort();
}

/**
 * Every code sample in the documentation has to actually run.
 *
 * Running each example for real would mean starting servers and writing pins from
 * a test, so instead these assert the two things that actually break: that the
 * file parses, and that every symbol it imports really exists in the package it
 * imports from. A stale example that references a renamed export is the failure
 * mode worth catching, and it is the one a human reviewer misses.
 */
describe('examples', () => {
  it('ships all five documented examples', async () => {
    const files = await exampleFiles();

    expect(files).toEqual([
      '01-inventory-a-machine.mjs',
      '02-grade-one-server.mjs',
      '03-pin-and-detect-drift.mjs',
      '04-wire-a-ci-gate.mjs',
      '05-consume-from-another-tool.mjs',
    ]);
  });

  it('parses every example as valid JavaScript', async () => {
    // Node's own parser rather than a hand rolled one. These are ES modules with
    // top level await and import.meta, so anything that evaluates them as a
    // function body reports syntax errors that are artefacts of the test rather
    // than real defects, which is exactly what the first version of this test did.
    for (const file of await exampleFiles()) {
      await expect(
        execFileAsync(process.execPath, ['--check', join(EXAMPLES_DIR, file)]),
        `${file} does not parse`,
      ).resolves.toBeDefined();
    }
  }, 30_000);

  it('imports only symbols the package actually exports', async () => {
    const exported = {
      'mcpsteward/api': new Set(Object.keys(api)),
      'mcpsteward': new Set(Object.keys(root)),
    };
    let checked = 0;

    for (const file of await exampleFiles()) {
      const source = await readFile(join(EXAMPLES_DIR, file), 'utf8');

      for (const { module, names } of parseImports(source)) {
        if (!(module in exported)) continue;
        const available = exported[module as keyof typeof exported];

        for (const name of names) {
          checked += 1;
          expect(
            available.has(name),
            `${file} imports ${name} from ${module}, which does not export it`,
          ).toBe(true);
        }
      }
    }

    // Guards the check itself. When the package was renamed, the module names
    // above no longer matched the examples and this test passed while checking
    // nothing.
    expect(checked).toBeGreaterThan(10);
  });

  it('imports only from the package or from node builtins', async () => {
    // An example that reached into src/ would work in this repository and fail
    // for every reader who installed the package.
    for (const file of await exampleFiles()) {
      const source = await readFile(join(EXAMPLES_DIR, file), 'utf8');

      for (const { module } of parseImports(source)) {
        const permitted =
          module.startsWith('node:') ||
          module === 'mcpsteward' ||
          module.startsWith('mcpsteward/');

        expect(permitted, `${file} imports from ${module}`).toBe(true);
      }
    }
  });

  it('documents how to run each example', async () => {
    for (const file of await exampleFiles()) {
      const source = await readFile(join(EXAMPLES_DIR, file), 'utf8');
      expect(source, `${file} does not say how to run it`).toContain('Run with:');
    }
  });

  it('exits nonzero from the CI gate example, as a gate must', async () => {
    const source = await readFile(join(EXAMPLES_DIR, '04-wire-a-ci-gate.mjs'), 'utf8');

    expect(source).toContain('process.exit(1)');
    expect(source).toContain('process.exit(2)');
  });
});

describe('the api surface a third party sees', () => {
  it('exposes the one call operations', () => {
    for (const name of [
      'inventory',
      'captureServer',
      'conformServer',
      'trustServer',
      'diffServer',
      'recordCapture',
      'verifyLedger',
      'evaluatePolicy',
      'analyzeSourceTree',
    ]) {
      expect(typeof api[name as keyof typeof api], `${name} is missing`).toBe('function');
    }
  });

  it('exposes the session primitives', () => {
    expect(typeof api.ServerSession).toBe('function');
    expect(typeof api.withServer).toBe('function');
  });
});

interface ParsedImport {
  readonly module: string;
  readonly names: readonly string[];
}

/** Extract named imports and their source modules. */
function parseImports(source: string): readonly ParsedImport[] {
  const results: ParsedImport[] = [];
  const pattern = /import\s+(?:\{([^}]*)\}|\*\s+as\s+\w+|\w+)\s+from\s+'([^']+)'/g;

  for (const match of source.matchAll(pattern)) {
    const names = (match[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
      .filter((entry) => entry.length > 0);

    results.push({ module: match[2] ?? '', names });
  }

  return results;
}
