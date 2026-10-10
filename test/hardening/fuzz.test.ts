import { describe, expect, it } from 'vitest';

import { canonicalizeJsonText, canonicalizeValue } from '../../src/core/canonical.js';
import { parseConfigFile } from '../../src/core/config.js';
import { isMcpStewardError } from '../../src/core/errors.js';
import { parseJsonPreservingNumbers } from '../../src/core/json-parse.js';
import { identityOf, parseClientConfig } from '../../src/discovery/parse.js';
import { parsePolicy } from '../../src/policy/index.js';
import type { ClientDefinition } from '../../src/discovery/clients.js';

/**
 * Adversarial and random input against every parser.
 *
 * The contract under test is narrow and absolute: for any input at all, a parser
 * either returns a value or throws a typed error. It never hangs, never crashes
 * the process with an untyped throw, and never returns a wrong answer while
 * claiming success.
 *
 * These parsers all read attacker influenced data. A client configuration file
 * can be edited by anything with write access, and a server surface is written
 * entirely by the server being inspected.
 */

const CLIENT: ClientDefinition = {
  id: 'cursor',
  displayName: 'test',
  shape: 'mcpServers',
  confidence: 'confirmed',
  paths: [],
};

/** Deterministic generator, so a failure reproduces rather than vanishing. */
function makeRandom(seed: number): () => number {
  let state = seed;

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return Math.abs(state) / 0x7fffffff;
  };
}

/**
 * Inputs chosen to break a parser rather than to look plausible.
 *
 * Several are real attack shapes: prototype pollution keys, deep nesting to blow
 * a stack, huge numbers, lone surrogates, and a billion laughs style expansion.
 */
const ADVERSARIAL: readonly string[] = [
  '',
  ' ',
  '\n',
  '\0',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  '-Infinity',
  '{}',
  '[]',
  '[[[[[[[[[[]]]]]]]]]]',
  '{"__proto__":{"polluted":true}}',
  '{"constructor":{"prototype":{"polluted":true}}}',
  '{"a":' + '['.repeat(2000) + ']'.repeat(2000) + '}',
  '{"a":1e999}',
  '{"a":-1e999}',
  '{"a":1e-999}',
  '{"a":' + '9'.repeat(1000) + '}',
  '{"a":0.' + '9'.repeat(1000) + '}',
  '{"\\ud800":"lone high surrogate"}',
  '{"a":"\\udfff"}',
  '{"a":"\\u0000"}',
  '{"a":"' + 'x'.repeat(100_000) + '"}',
  '{"a":"\\\\\\\\\\\\\\\\"}',
  '{"a":1,"a":2}',
  '{"a":1,}',
  '{,}',
  '{"a"}',
  '{"a":}',
  '{:1}',
  '[1,,2]',
  'tru',
  'falsee',
  'nul',
  '"unterminated',
  '{"a":"\\x41"}',
  '{"a":01}',
  '{"a":+1}',
  '{"a":.5}',
  '{"a":1.}',
  '{"a":1e}',
  '{"a":--1}',
  '\ufeff{"a":1}',
  '{"a":1}\u0000',
  '[' + '1,'.repeat(50_000) + '1]',
];

describe('the JSON parser', () => {
  it('either parses or throws a typed error, for every adversarial input', () => {
    for (const input of ADVERSARIAL) {
      try {
        parseJsonPreservingNumbers(input);
      } catch (error) {
        expect(
          isMcpStewardError(error),
          `untyped throw for ${JSON.stringify(input.slice(0, 40))}: ${String(error)}`,
        ).toBe(true);
      }
    }
  });

  it('never pollutes the prototype', () => {
    for (const input of ADVERSARIAL) {
      try {
        parseJsonPreservingNumbers(input);
      } catch {
        // Rejection is a fine outcome. Pollution is not.
      }
    }

    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('bounds nesting rather than blowing the stack', () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);

    expect(() => parseJsonPreservingNumbers(deep)).toThrow(/nesting depth/);
  });

  it('survives random byte soup', () => {
    const random = makeRandom(0x1234abcd);

    for (let round = 0; round < 500; round += 1) {
      const length = Math.floor(random() * 200);
      let input = '';

      for (let i = 0; i < length; i += 1) {
        input += String.fromCharCode(Math.floor(random() * 0x7f));
      }

      try {
        parseJsonPreservingNumbers(input);
      } catch (error) {
        expect(isMcpStewardError(error), `untyped throw for round ${String(round)}`).toBe(true);
      }
    }
  });

  it('survives random mutations of valid JSON', () => {
    const random = makeRandom(0xfeed0001);
    const valid = '{"name":"tool","inputSchema":{"type":"object","properties":{"a":{"type":"string"}}}}';

    for (let round = 0; round < 500; round += 1) {
      const position = Math.floor(random() * valid.length);
      const replacement = String.fromCharCode(32 + Math.floor(random() * 94));
      const mutated = valid.slice(0, position) + replacement + valid.slice(position + 1);

      try {
        parseJsonPreservingNumbers(mutated);
      } catch (error) {
        expect(isMcpStewardError(error), `untyped throw for ${mutated.slice(0, 60)}`).toBe(true);
      }
    }
  });
});

describe('the canonicalizer', () => {
  it('never produces a wrong answer while claiming success', () => {
    // The property that matters: if it returns, the result must be idempotent.
    // A canonicalizer that silently mangled input would corrupt every hash.
    const random = makeRandom(0x0badf00d);

    for (let round = 0; round < 300; round += 1) {
      const value = randomValue(random, 0);
      const text = JSON.stringify(value);

      let once: string;
      try {
        once = canonicalizeJsonText(text);
      } catch (error) {
        expect(isMcpStewardError(error)).toBe(true);
        continue;
      }

      expect(canonicalizeJsonText(once), `not idempotent for ${text.slice(0, 60)}`).toBe(once);
    }
  });

  it('either canonicalizes or throws typed, for every adversarial input', () => {
    for (const input of ADVERSARIAL) {
      try {
        canonicalizeJsonText(input);
      } catch (error) {
        expect(
          isMcpStewardError(error),
          `untyped throw for ${JSON.stringify(input.slice(0, 40))}`,
        ).toBe(true);
      }
    }
  });

  it('refuses values it cannot represent rather than guessing', () => {
    const cases: readonly unknown[] = [
      { a: NaN },
      { a: Infinity },
      { a: -Infinity },
      { a: () => 1 },
      { a: Symbol('x') },
    ];

    for (const value of cases) {
      expect(() => canonicalizeValue(value), `accepted ${String(value)}`).toThrow();
    }
  });
});

describe('the configuration parser', () => {
  it('either parses or throws typed, for every adversarial input', () => {
    for (const input of ADVERSARIAL) {
      try {
        parseConfigFile(input, 'fuzz.json');
      } catch (error) {
        expect(
          isMcpStewardError(error),
          `untyped throw for ${JSON.stringify(input.slice(0, 40))}`,
        ).toBe(true);
      }
    }
  });

  it('rejects a config whose keys are hostile', () => {
    expect(() => parseConfigFile('{"__proto__":{"a":1}}', 'x.json')).toThrow(/unknown/);
    expect(({} as Record<string, unknown>)['a']).toBeUndefined();
  });
});

describe('the policy parser', () => {
  it('either parses or throws typed, for every adversarial input', () => {
    for (const input of ADVERSARIAL) {
      try {
        parsePolicy(input, 'fuzz.json');
      } catch (error) {
        expect(
          isMcpStewardError(error),
          `untyped throw for ${JSON.stringify(input.slice(0, 40))}`,
        ).toBe(true);
      }
    }
  });
});

describe('the client config parser', () => {
  it('either parses or throws typed, for every adversarial input', () => {
    for (const input of ADVERSARIAL) {
      try {
        parseClientConfig(input, CLIENT, 'fuzz.json');
      } catch (error) {
        expect(
          isMcpStewardError(error),
          `untyped throw for ${JSON.stringify(input.slice(0, 40))}`,
        ).toBe(true);
      }
    }
  });

  it('survives a server entry of any shape', () => {
    const shapes: readonly string[] = [
      '{"mcpServers":{"a":null}}',
      '{"mcpServers":{"a":[]}}',
      '{"mcpServers":{"a":1}}',
      '{"mcpServers":{"a":"str"}}',
      '{"mcpServers":{"a":{"command":null}}}',
      '{"mcpServers":{"a":{"command":"x","args":"not-an-array"}}}',
      '{"mcpServers":{"a":{"command":"x","env":"not-an-object"}}}',
      '{"mcpServers":{"a":{"url":123}}}',
      '{"mcpServers":{"":{"command":"x"}}}',
      '{"mcpServers":[]}',
      '{"mcpServers":null}',
    ];

    for (const shape of shapes) {
      try {
        parseClientConfig(shape, CLIENT, 'fuzz.json');
      } catch (error) {
        expect(isMcpStewardError(error), `untyped throw for ${shape}`).toBe(true);
      }
    }
  });
});

describe('cross platform paths', () => {
  it('distinguishes Windows drive letters', () => {
    const c = identityOf({ transport: 'stdio', command: 'C:\\srv\\a.exe', args: [], envNames: [] });
    const d = identityOf({ transport: 'stdio', command: 'D:\\srv\\a.exe', args: [], envNames: [] });

    expect(c).not.toBe(d);
  });

  it('distinguishes a UNC path from a local one', () => {
    const unc = identityOf({
      transport: 'stdio',
      command: '\\\\server\\share\\a.exe',
      args: [],
      envNames: [],
    });
    const local = identityOf({
      transport: 'stdio',
      command: 'C:\\a.exe',
      args: [],
      envNames: [],
    });

    expect(unc).not.toBe(local);
  });

  it('preserves spaces in a path', () => {
    const spaced = identityOf({
      transport: 'stdio',
      command: 'C:\\Program Files\\My Server\\run.exe',
      args: ['--flag'],
      envNames: [],
    });

    expect(spaced).toContain('Program Files');
  });

  it('treats forward and backslash paths as different servers', () => {
    // They may resolve to the same file on Windows, but the configuration says
    // what it says. Silently merging them would understate the inventory.
    const back = identityOf({ transport: 'stdio', command: 'C:\\a\\b.exe', args: [], envNames: [] });
    const forward = identityOf({ transport: 'stdio', command: 'C:/a/b.exe', args: [], envNames: [] });

    expect(back).not.toBe(forward);
  });

  it('handles a POSIX absolute path', () => {
    const posix = identityOf({
      transport: 'stdio',
      command: '/usr/local/bin/server',
      args: [],
      envNames: [],
    });

    expect(posix).toContain('/usr/local/bin/server');
  });

  it('handles a URL with a port, a path and a query', () => {
    const a = identityOf({
      transport: 'http',
      url: 'https://example.com:8443/mcp?tenant=1',
      headerNames: [],
    });
    const b = identityOf({
      transport: 'http',
      url: 'https://example.com:8443/mcp?tenant=2',
      headerNames: [],
    });

    // The query is not part of the endpoint identity, so these are one server.
    expect(a).toBe(b);
  });

  it('distinguishes ports on the same host', () => {
    const a = identityOf({ transport: 'http', url: 'http://localhost:3000/mcp', headerNames: [] });
    const b = identityOf({ transport: 'http', url: 'http://localhost:3001/mcp', headerNames: [] });

    expect(a).not.toBe(b);
  });

  it('survives a malformed URL rather than throwing', () => {
    expect(() =>
      identityOf({ transport: 'http', url: 'not a url at all', headerNames: [] }),
    ).not.toThrow();
  });
});

/** Build a random JSON safe value. */
function randomValue(random: () => number, depth: number): unknown {
  const roll = random();

  if (depth > 4 || roll < 0.35) {
    if (roll < 0.05) return null;
    if (roll < 0.1) return random() < 0.5;
    if (roll < 0.2) return Math.floor(random() * 1_000_000) - 500_000;
    if (roll < 0.25) return random() * 1e6;
    return randomString(random);
  }

  if (roll < 0.65) {
    return Array.from({ length: Math.floor(random() * 5) }, () => randomValue(random, depth + 1));
  }

  const out: Record<string, unknown> = {};
  const count = Math.floor(random() * 5);

  for (let i = 0; i < count; i += 1) {
    out[randomString(random)] = randomValue(random, depth + 1);
  }

  return out;
}

function randomString(random: () => number): string {
  const alphabet = 'abcXYZ019 _-./\\"\'\n\t{}[]:,世界';
  const length = Math.floor(random() * 12);

  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(random() * alphabet.length)] ?? 'a';
  }

  return out;
}
