import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalizeJsonText, hashCanonicalForm } from '../../src/core/canonical.js';
import { buildDescriptors } from '../../src/core/descriptor.js';
import { computeSurfaceHashes, EMPTY_MERKLE_ROOT, merkleLeaf, merkleNode } from '../../src/core/merkle.js';
import { parseJsonPreservingNumbers } from '../../src/core/json-parse.js';
import { GENESIS_HASH, LEDGER_FORMAT_VERSION, LEDGER_MAGIC } from '../../src/ledger/index.js';

const execFileAsync = promisify(execFile);
const PROJECT = fileURLToPath(new URL('../..', import.meta.url));
const FORMATS = fileURLToPath(new URL('../../docs/formats.md', import.meta.url));
const RULES = fileURLToPath(new URL('../../docs/rules.md', import.meta.url));
const GENERATOR_ENTRY = fileURLToPath(new URL('../../dist/conformance/index.js', import.meta.url));

/**
 * Build if `dist` is not there, for the same reason `test/mcp/dogfood.test.ts`
 * does.
 *
 * `scripts/generate-docs.mjs` imports the compiled rule registry, and
 * `npm run verify` runs the tests before the build. On a fresh clone `dist`
 * does not exist yet, so the drift check below
 * failed with a module resolution error rather than a documentation problem.
 * That went unnoticed locally because a previous build had left `dist` behind,
 * and surfaced the first time CI ever ran on a clean checkout.
 */
beforeAll(async () => {
  if (existsSync(GENERATOR_ENTRY)) return;

  await execFileAsync('npm', ['run', 'build'], {
    cwd: PROJECT,
    shell: process.platform === 'win32',
  });
}, 180_000);

/**
 * The documentation must be true.
 *
 * `docs/formats.md` promises to be precise enough that somebody could write an
 * independent verifier without reading the source. That promise is only worth
 * something if the constants in it are actually right, and writing this file
 * caught two that were not: an invented genesis hash, and a claim that fixed
 * labels are hashed as quoted JSON strings when they are hashed raw. An
 * independent implementation following the wrong version would have produced
 * mismatching hashes and had no way to tell whose fault it was.
 *
 * So every constant the document states is pinned here against the running code.
 */

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('docs/formats.md states true constants', () => {
  it('documents the correct genesis hash', async () => {
    const document = await readFile(FORMATS, 'utf8');
    expect(document).toContain(GENESIS_HASH);
  });

  it('documents the genesis input as raw bytes, matching the implementation', () => {
    // The document says the input is raw UTF-8, not a quoted JSON string. If
    // that were wrong, an independent verifier would compute a different chain
    // head and reject every valid ledger.
    const raw = `${LEDGER_MAGIC}/v${String(LEDGER_FORMAT_VERSION)}/genesis`;
    expect(`sha256:${sha256Hex(raw)}`).toBe(GENESIS_HASH);

    // And confirm the quoted form, which the document previously claimed, is
    // genuinely different. This is the mistake being guarded against.
    expect(`sha256:${sha256Hex(`"${raw}"`)}`).not.toBe(GENESIS_HASH);
  });

  it('documents the correct empty merkle root', async () => {
    const document = await readFile(FORMATS, 'utf8');

    expect(EMPTY_MERKLE_ROOT).toBe(`sha256:${sha256Hex('')}`);
    expect(document).toContain(EMPTY_MERKLE_ROOT.slice('sha256:'.length));
  });

  it('documents the correct category name hash', async () => {
    const document = await readFile(FORMATS, 'utf8');
    const expected = hashCanonicalForm('tool');

    expect(expected).toBe(`sha256:${sha256Hex('tool')}`);
    expect(document).toContain(expected);
  });

  it('documents the number canonicalization table correctly', async () => {
    const document = await readFile(FORMATS, 'utf8');

    // Every row of the table in section 2.3, checked against the real thing.
    const rows: readonly (readonly [string, string])[] = [
      ['0', '0'],
      ['-0', '0'],
      ['0.0', '0'],
      ['0e100', '0'],
      ['1', '1e0'],
      ['1.0', '1e0'],
      ['1.000', '1e0'],
      ['-1', '-1e0'],
      ['100', '1e2'],
      ['1e2', '1e2'],
      ['0.1', '1e-1'],
      ['1.5', '1.5e0'],
      ['1.50', '1.5e0'],
      ['15e-1', '1.5e0'],
      ['12345', '1.2345e4'],
      ['0.000123', '1.23e-4'],
      ['9007199254740993', '9.007199254740993e15'],
      ['123456789012345678901234567890', '1.2345678901234567890123456789e29'],
    ];

    for (const [input, expected] of rows) {
      expect(canonicalizeJsonText(input), `${input} does not canonicalize as documented`).toBe(
        expected,
      );
      expect(document, `the table omits ${expected}`).toContain(expected);
    }
  });

  it('documents the worked example correctly', async () => {
    // Section 7. If this drifts, the one example a reader will actually follow
    // is the thing that misleads them.
    const source = '{ "name": "ping_host", "description": "Pings a host.", "timeoutMs": 1000 }';
    const expected = '{"description":"Pings a host.","name":"ping_host","timeoutMs":1e3}';

    expect(canonicalizeJsonText(source)).toBe(expected);

    const document = await readFile(FORMATS, 'utf8');
    expect(document).toContain(expected);
  });

  it('documents the surface root construction correctly', () => {
    // Rebuild a one tool surface exactly as section 4.3 and section 7 describe,
    // and check it against what the implementation produces.
    const descriptors = buildDescriptors('tool', [
      parseJsonPreservingNumbers(
        '{"name":"ping_host","description":"Pings a host.","timeoutMs":1000}',
      ),
    ]);

    const actual = computeSurfaceHashes(descriptors);

    const categoryRoot = merkleLeaf(descriptors[0]!.hash);
    const entry = merkleNode(hashCanonicalForm('tool'), categoryRoot);
    const expected = merkleLeaf(entry);

    expect(actual.root, 'the documented construction disagrees with the code').toBe(expected);
    expect(actual.byCategory.tool).toBe(categoryRoot);
  });

  it('documents the descriptor key format correctly', () => {
    const descriptors = buildDescriptors('tool', [parseJsonPreservingNumbers('{"name":"x"}')]);
    const hashes = computeSurfaceHashes(descriptors);

    expect(Object.keys(hashes.byDescriptor)).toEqual(['tool:x']);
  });

  it('states the ledger limitation rather than overclaiming', async () => {
    const document = await readFile(FORMATS, 'utf8');

    expect(document).toMatch(/does \*\*not\*\* prove the ledger is authentic/i);
    expect(document).toContain('threat-model.md');
  });
});

describe('docs/rules.md is generated, not hand written', () => {
  it('matches the rule registry exactly', async () => {
    // A hand edited rule table drifts: somebody adds a rule and forgets the
    // docs, and within a release the documentation is quietly lying about what
    // the tool checks. The generator is the source of truth and this is the
    // check that keeps it so.
    await expect(
      execFileAsync(process.execPath, ['scripts/generate-docs.mjs', '--check'], {
        cwd: PROJECT,
      }),
    ).resolves.toBeDefined();
  }, 60_000);

  it('says plainly that it is generated', async () => {
    const document = await readFile(RULES, 'utf8');
    expect(document).toContain('generated from the rule registry');
    expect(document).toContain('Do not edit it by hand');
  });

  it('carries a citation for every rule it lists', async () => {
    const document = await readFile(RULES, 'utf8');

    const ruleHeadings = [...document.matchAll(/^#### (MS-[A-Z]+-\d{3}):/gm)];
    const specRows = [...document.matchAll(/^\| Specification \|/gm)];

    expect(ruleHeadings.length).toBeGreaterThan(0);
    expect(specRows.length).toBe(ruleHeadings.length);
  });
});

describe('the formatting rule holds across every document', () => {
  const documents = [
    'README.md',
    'DECISIONS.md',
    'VERIFY.md',
    'RELEASE.md',
    'SPEC-NOTES.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'docs/architecture.md',
    'docs/threat-model.md',
    'docs/formats.md',
    'docs/rules.md',
  ];

  for (const name of documents) {
    it(`${name} uses no em dashes, en dashes or emoji in its own prose`, async () => {
      const text = await readFile(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8');
      const ours = withoutQuotations(text);

      expect(ours, `${name} contains an em dash`).not.toMatch(/—/);
      expect(ours, `${name} contains an en dash`).not.toMatch(/–/);
      expect(ours, `${name} contains an emoji`).not.toMatch(
        /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
      );
    });
  }

  it('exempts verbatim quotation rather than silently rewriting sources', async () => {
    // SPEC-NOTES.md quotes the MCP specification, which uses em dashes itself.
    // Editing a quotation to match a house style makes the quotation wrong, and
    // the entire value of that file is that it reproduces the specification
    // faithfully. So quoted material is exempt, and this test asserts the
    // exemption is actually load bearing rather than dead code that would let a
    // real violation through unnoticed.
    const text = await readFile(fileURLToPath(new URL('../../SPEC-NOTES.md', import.meta.url)), 'utf8');

    expect(text, 'the exemption is no longer needed and should be removed').toMatch(/—/);
    expect(withoutQuotations(text)).not.toMatch(/—/);
  });
});

/**
 * Remove verbatim quotations so only our own prose is checked.
 *
 * Two forms carry quoted specification text: a `Quote:` prefixed passage, which
 * may wrap across lines until the closing double quote, and a markdown blockquote.
 */
function withoutQuotations(text: string): string {
  return text
    .replace(/Quote:\s*"[\s\S]*?"/g, 'Quote: <verbatim>')
    .replace(/^>.*$/gm, '> <verbatim>');
}
