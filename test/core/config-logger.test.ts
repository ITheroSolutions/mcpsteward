import { describe, expect, it } from 'vitest';

import {
  configFromEnv,
  DEFAULT_CONFIG,
  parseConfigFile,
  resolveConfig,
  validateConfig,
} from '../../src/core/config.js';
import {
  createLogger,
  isLogLevel,
  NOOP_LOGGER,
  type Logger,
  type LogLevel,
  type LogRecord,
} from '../../src/core/logger.js';

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';

describe('logger defaults', () => {
  it('discards everything by default', () => {
    // The library must never write on its own, because stdout is an MCP
    // transport and a stray write corrupts somebody else's protocol stream.
    expect(() => {
      NOOP_LOGGER.error('an error');
      NOOP_LOGGER.info('some info');
      NOOP_LOGGER.trace('very verbose');
    }).not.toThrow();
  });

  it('emits nothing when no sink is supplied', () => {
    const logger = createLogger({ level: 'trace' });
    expect(() => {
      logger.error('still nowhere');
    }).not.toThrow();
  });
});

describe('logger levels', () => {
  function collect(level: LogLevel): { records: LogRecord[]; logger: Logger } {
    const records: LogRecord[] = [];
    const logger = createLogger({
      level,
      sink: (record) => records.push(record),
    });
    return { records, logger };
  }

  it('emits at and above the configured level', () => {
    const { records, logger } = collect('warn');

    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    logger.trace('t');

    expect(records.map((r) => r.level)).toEqual(['error', 'warn']);
  });

  it('emits everything at trace', () => {
    const { records, logger } = collect('trace');

    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    logger.trace('t');

    expect(records).toHaveLength(5);
  });

  it('emits nothing at silent', () => {
    const { records, logger } = collect('silent');
    logger.error('e');
    expect(records).toHaveLength(0);
  });
});

describe('logger redaction', () => {
  it('redacts the message', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'trace', sink: (r) => records.push(r) });

    logger.error(`auth failed with ${SECRET}`);

    expect(records[0]?.message).not.toContain(SECRET);
    expect(records[0]?.message).toContain('REDACTED');
  });

  it('redacts structured fields at any depth', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'trace', sink: (r) => records.push(r) });

    logger.info('connecting', { server: 'x', headers: { Authorization: `Bearer ${SECRET}` } });

    expect(JSON.stringify(records[0]?.fields)).not.toContain(SECRET);
  });

  it('applies environment derived secrets', () => {
    const opaque = 'anopaquevaluewithnorecognisableshape';
    const records: LogRecord[] = [];
    const logger = createLogger({
      level: 'trace',
      sink: (r) => records.push(r),
      redaction: { extraSecrets: [opaque] },
    });

    logger.info(`used ${opaque}`);
    expect(records[0]?.message).not.toContain(opaque);
  });
});

describe('logger child scoping', () => {
  it('merges parent fields into every record', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'trace', sink: (r) => records.push(r) }).child({
      serverId: 'srv-1',
    });

    logger.info('captured', { count: 3 });

    expect(records[0]?.fields).toEqual({ serverId: 'srv-1', count: 3 });
  });

  it('lets a call site override an inherited field', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'trace', sink: (r) => records.push(r) }).child({
      phase: 'discover',
    });

    logger.info('x', { phase: 'capture' });
    expect(records[0]?.fields).toMatchObject({ phase: 'capture' });
  });

  it('nests', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'trace', sink: (r) => records.push(r) })
      .child({ a: 1 })
      .child({ b: 2 });

    logger.info('x');
    expect(records[0]?.fields).toEqual({ a: 1, b: 2 });
  });

  it('omits the fields key entirely when there are none', () => {
    const records: LogRecord[] = [];
    createLogger({ level: 'trace', sink: (r) => records.push(r) }).info('bare');
    expect(Object.hasOwn(records[0] ?? {}, 'fields')).toBe(false);
  });

  it('preserves the level threshold through child loggers', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'warn', sink: (r) => records.push(r) }).child({ a: 1 });

    logger.info('should not appear');
    logger.warn('should appear');

    expect(records).toHaveLength(1);
  });
});

describe('isLogLevel', () => {
  it('accepts every declared level', () => {
    for (const level of ['silent', 'error', 'warn', 'info', 'debug', 'trace']) {
      expect(isLogLevel(level)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isLogLevel('verbose')).toBe(false);
    expect(isLogLevel('')).toBe(false);
    expect(isLogLevel('ERROR')).toBe(false);
  });
});

describe('config defaults', () => {
  it('resolves with no input at all', () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('targets the graded revision by default', () => {
    expect(resolveConfig().preferredRevision).toBe('2026-07-28');
  });
});

describe('config precedence', () => {
  it('applies file over defaults', () => {
    const config = resolveConfig({ fileConfig: { timeoutMs: 1000 } });
    expect(config.timeoutMs).toBe(1000);
  });

  it('applies environment over file', () => {
    const config = resolveConfig({
      fileConfig: { timeoutMs: 1000 },
      env: { MCPSTEWARD_TIMEOUT_MS: '2000' },
    });
    expect(config.timeoutMs).toBe(2000);
  });

  it('applies per call overrides over environment', () => {
    const config = resolveConfig({
      fileConfig: { timeoutMs: 1000 },
      env: { MCPSTEWARD_TIMEOUT_MS: '2000' },
      overrides: { timeoutMs: 3000 },
    });
    expect(config.timeoutMs).toBe(3000);
  });

  it('leaves untouched keys at their default', () => {
    const config = resolveConfig({ overrides: { timeoutMs: 5 } });
    expect(config.retries).toBe(DEFAULT_CONFIG.retries);
  });

  it('does not fail when a low precedence bad value is overridden by a good one', () => {
    // Validation runs once on the merged result, so a stale bad value in a
    // checked in file does not break a CI job that overrides it.
    expect(() =>
      resolveConfig({ fileConfig: { timeoutMs: -1 }, overrides: { timeoutMs: 100 } }),
    ).not.toThrow();
  });
});

describe('config from environment', () => {
  it('reads numbers, strings and booleans', () => {
    const overrides = configFromEnv({
      MCPSTEWARD_TIMEOUT_MS: '1234',
      MCPSTEWARD_RETRIES: '5',
      MCPSTEWARD_LOG_LEVEL: 'debug',
      MCPSTEWARD_ALLOW_DOWNGRADE: 'false',
      MCPSTEWARD_LEDGER_PATH: '/var/lib/mcpsteward.log',
    });

    expect(overrides).toEqual({
      timeoutMs: 1234,
      retries: 5,
      logLevel: 'debug',
      allowDowngrade: false,
      ledgerPath: '/var/lib/mcpsteward.log',
    });
  });

  it('accepts several boolean spellings', () => {
    for (const truthy of ['true', '1', 'yes', 'TRUE']) {
      expect(configFromEnv({ MCPSTEWARD_ALLOW_DOWNGRADE: truthy }).allowDowngrade).toBe(true);
    }
    for (const falsy of ['false', '0', 'no', 'FALSE']) {
      expect(configFromEnv({ MCPSTEWARD_ALLOW_DOWNGRADE: falsy }).allowDowngrade).toBe(false);
    }
  });

  it('ignores empty and absent variables', () => {
    expect(configFromEnv({ MCPSTEWARD_TIMEOUT_MS: '' })).toEqual({});
    expect(configFromEnv({})).toEqual({});
  });

  it('ignores unrecognised MCPSTEWARD variables rather than failing the run', () => {
    // A stale exported variable from months ago should not break a run.
    expect(configFromEnv({ MCPSTEWARD_SOMETHING_OLD: 'x' })).toEqual({});
  });

  it('names the variable when a number is unparseable', () => {
    expect(() => configFromEnv({ MCPSTEWARD_TIMEOUT_MS: 'soon' })).toThrow(
      /MCPSTEWARD_TIMEOUT_MS must be a number/,
    );
  });

  it('names the variable when a boolean is unparseable', () => {
    expect(() => configFromEnv({ MCPSTEWARD_ALLOW_DOWNGRADE: 'maybe' })).toThrow(
      /MCPSTEWARD_ALLOW_DOWNGRADE must be a boolean/,
    );
  });
});

describe('config validation names the offending key', () => {
  const cases: readonly (readonly [string, Record<string, unknown>, RegExp])[] = [
    ['timeoutMs zero', { timeoutMs: 0 }, /timeoutMs must be a positive integer/],
    ['timeoutMs negative', { timeoutMs: -1 }, /timeoutMs must be a positive integer/],
    ['timeoutMs fractional', { timeoutMs: 1.5 }, /timeoutMs must be a positive integer/],
    ['retries negative', { retries: -1 }, /retries must be a non negative integer/],
    ['maxDescriptors zero', { maxDescriptors: 0 }, /maxDescriptors must be a positive integer/],
    [
      'preferredRevision unknown',
      { preferredRevision: '2099-01-01' },
      /preferredRevision must be a supported protocol revision/,
    ],
    ['logLevel unknown', { logLevel: 'verbose' }, /logLevel must be one of/],
    ['allowDowngrade not boolean', { allowDowngrade: 'yes' }, /allowDowngrade must be a boolean/],
    ['ledgerPath empty', { ledgerPath: '' }, /ledgerPath must be a non empty string/],
  ];

  for (const [name, overrides, pattern] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => validateConfig(overrides)).toThrow(pattern);
    });
  }

  it('reports the key in structured details, not only in the message', () => {
    try {
      validateConfig({ timeoutMs: -1 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { details: { key: string } }).details.key).toBe('timeoutMs');
    }
  });

  it('accepts zero retries, which means do not retry', () => {
    expect(validateConfig({ retries: 0 }).retries).toBe(0);
  });
});

describe('parseConfigFile', () => {
  it('parses a valid file', () => {
    expect(parseConfigFile('{"timeoutMs":5000}', 'x.json')).toEqual({ timeoutMs: 5000 });
  });

  it('rejects invalid JSON, naming the path', () => {
    expect(() => parseConfigFile('{oops}', '/etc/mcpsteward.json')).toThrow(
      /\/etc\/mcpsteward\.json is not valid JSON/,
    );
  });

  it('rejects a non object document', () => {
    expect(() => parseConfigFile('[1,2]', 'x.json')).toThrow(/must contain a JSON object/);
    expect(() => parseConfigFile('"a string"', 'x.json')).toThrow(/must contain a JSON object/);
    expect(() => parseConfigFile('null', 'x.json')).toThrow(/must contain a JSON object/);
  });

  it('rejects unknown keys rather than ignoring them', () => {
    // A misspelled key in a deliberately written file is a mistake being made
    // right now, unlike a stale environment variable. Silently ignoring
    // timeoutMS when the field is timeoutMs produces a run that quietly uses
    // the default, which is the worst outcome.
    expect(() => parseConfigFile('{"timeoutMS":5000}', 'x.json')).toThrow(
      /unknown configuration keys: timeoutMS/,
    );
  });

  it('lists every unknown key', () => {
    expect(() => parseConfigFile('{"a":1,"b":2}', 'x.json')).toThrow(/a, b/);
  });

  it('accepts the optional path keys', () => {
    expect(() =>
      parseConfigFile('{"ledgerPath":"/tmp/l","policyPath":"/tmp/p"}', 'x.json'),
    ).not.toThrow();
  });

  it('redacts a secret that appears in a config error', () => {
    try {
      parseConfigFile(`{"unknownKey":"${SECRET}"}`, 'x.json');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
});
