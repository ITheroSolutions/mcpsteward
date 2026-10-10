import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyCodemod,
  codemodErrorCodes,
  codemodFile,
  ERROR_CODE_REPLACEMENTS,
  RETIRED_WITHOUT_REPLACEMENT,
  unifiedDiff,
} from '../../src/migration/codemod.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcpsteward-codemod-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('renumbering retired error codes', () => {
  it('rewrites the resource not found code', async () => {
    const result = await codemodErrorCodes('x.ts', 'const NOT_FOUND = -32002;');

    expect(result.output).toBe('const NOT_FOUND = -32602;');
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]?.why).toContain('Invalid Params');
  });

  it('rewrites every renumbered draft code', async () => {
    const source = [
      'const A = -32001;',
      'const B = -32003;',
      'const C = -32004;',
    ].join('\n');

    const result = await codemodErrorCodes('x.ts', source);

    expect(result.output).toContain('-32020');
    expect(result.output).toContain('-32021');
    expect(result.output).toContain('-32022');
    expect(result.edits).toHaveLength(3);
  });

  it('reports a code with no successor for a human rather than guessing', async () => {
    // -32042 was removed entirely. Inventing a replacement would be worse than
    // leaving it, because the author has to decide what the code should become.
    const result = await codemodErrorCodes('x.ts', 'const URL_ELICIT = -32042;');

    expect(result.edits).toEqual([]);
    expect(result.output).toBe('const URL_ELICIT = -32042;');
    expect(result.manual[0]?.reason).toContain('removed entirely');
  });

  it('handles several occurrences in one file without corrupting offsets', async () => {
    const source = [
      'switch (code) {',
      '  case -32002: return "a";',
      '  case -32001: return "b";',
      '  case -32003: return "c";',
      '}',
    ].join('\n');

    const result = await codemodErrorCodes('x.ts', source);

    expect(result.output).toContain('case -32602:');
    expect(result.output).toContain('case -32020:');
    expect(result.output).toContain('case -32021:');
    expect(result.output).not.toContain('-32002');
  });

  it('leaves a file with nothing to change byte identical', async () => {
    const source = 'const OK = -32602;\nconst ALSO = 42;\n';
    const result = await codemodErrorCodes('x.ts', source);

    expect(result.output).toBe(source);
    expect(result.edits).toEqual([]);
    expect(result.diff).toBe('');
  });
});

describe('what it refuses to touch', () => {
  it('does not rewrite a number inside a comment', async () => {
    // The whole reason literals are located through the AST. A text based
    // rewrite would edit this and corrupt the author's own notes.
    const source = ['// We used to return -32002 here before the renumber.', 'const x = 1;'].join(
      '\n',
    );

    const result = await codemodErrorCodes('x.ts', source);

    expect(result.output).toBe(source);
    expect(result.edits).toEqual([]);
  });

  it('does not rewrite a number inside a string', async () => {
    const source = 'const message = "error -32002 occurred";';
    const result = await codemodErrorCodes('x.ts', source);

    expect(result.output).toBe(source);
  });

  it('does not rewrite an unsigned literal with the same digits', async () => {
    // 32002 is not -32002. Without the sign check this would be corrupted.
    const source = 'const port = 32002;';
    const result = await codemodErrorCodes('x.ts', source);

    expect(result.output).toBe(source);
  });

  it('does not rewrite a longer number that contains the digits', async () => {
    const source = 'const big = -320021;';
    const result = await codemodErrorCodes('x.ts', source);

    expect(result.output).toBe(source);
  });

  it('does not touch an unrelated negative number', async () => {
    const source = 'const offset = -1;\nconst other = -32700;';
    const result = await codemodErrorCodes('x.ts', source);

    expect(result.output).toBe(source);
  });
});

describe('the diff', () => {
  it('shows the change before anything is written', async () => {
    const result = await codemodErrorCodes('src/errors.ts', 'const NOT_FOUND = -32002;');

    expect(result.diff).toContain('--- a/src/errors.ts');
    expect(result.diff).toContain('+++ b/src/errors.ts');
    expect(result.diff).toContain('-const NOT_FOUND = -32002;');
    expect(result.diff).toContain('+const NOT_FOUND = -32602;');
  });

  it('includes surrounding context', async () => {
    const source = ['line1', 'line2', 'line3', 'const x = -32002;', 'line5'].join('\n');
    const result = await codemodErrorCodes('x.ts', source);

    expect(result.diff).toContain(' line2');
    expect(result.diff).toContain(' line5');
  });

  it('is empty when nothing changed', () => {
    expect(unifiedDiff('x.ts', 'same', 'same')).toBe('');
  });
});

describe('writing is a separate, explicit step', () => {
  it('computing a codemod writes nothing', async () => {
    // Nothing may write as a side effect of being asked what it would do.
    const path = join(root, 'errors.ts');
    const original = 'const NOT_FOUND = -32002;';
    await writeFile(path, original, 'utf8');

    const result = await codemodFile(path);

    expect(result.edits).toHaveLength(1);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('applies only when asked', async () => {
    const path = join(root, 'errors.ts');
    await writeFile(path, 'const NOT_FOUND = -32002;', 'utf8');

    const result = await codemodFile(path);
    await applyCodemod(result);

    expect(await readFile(path, 'utf8')).toBe('const NOT_FOUND = -32602;');
  });

  it('does not rewrite a file that needs no change', async () => {
    const path = join(root, 'clean.ts');
    const original = 'const OK = 1;';
    await writeFile(path, original, 'utf8');

    await applyCodemod(await codemodFile(path));

    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('is idempotent, so running it twice changes nothing further', async () => {
    const path = join(root, 'errors.ts');
    await writeFile(path, 'const NOT_FOUND = -32002;', 'utf8');

    await applyCodemod(await codemodFile(path));
    const once = await readFile(path, 'utf8');

    await applyCodemod(await codemodFile(path));

    expect(await readFile(path, 'utf8')).toBe(once);
  });
});

describe('the replacement table', () => {
  it('maps every renumbered code to the range the specification reserves', () => {
    for (const [, replacement] of Object.entries(ERROR_CODE_REPLACEMENTS)) {
      const inReserved = replacement.to <= -32020 && replacement.to >= -32099;
      const isInvalidParams = replacement.to === -32602;

      expect(
        inReserved || isInvalidParams,
        `${String(replacement.to)} is neither reserved nor a JSON-RPC standard code`,
      ).toBe(true);
    }
  });

  it('explains every replacement', () => {
    for (const [, replacement] of Object.entries(ERROR_CODE_REPLACEMENTS)) {
      expect(replacement.why.length).toBeGreaterThan(20);
    }
  });

  it('never maps a code to itself', () => {
    for (const [from, replacement] of Object.entries(ERROR_CODE_REPLACEMENTS)) {
      expect(replacement.to).not.toBe(Number(from));
    }
  });

  it('does not offer a replacement for a code that has none', () => {
    for (const code of Object.keys(RETIRED_WITHOUT_REPLACEMENT)) {
      expect(ERROR_CODE_REPLACEMENTS[Number(code)]).toBeUndefined();
    }
  });
});
