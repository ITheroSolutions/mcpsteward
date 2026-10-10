import { describe, expect, it } from 'vitest';

import {
  AuthenticationRequiredError,
  CancellationError,
  ConfigurationError,
  DiscoveryError,
  ERROR_CODES,
  hasErrorCode,
  InternalError,
  isMcpStewardError,
  LedgerCorruptionError,
  McpStewardError,
  PolicyViolationError,
  ProtocolViolationError,
  TimeoutError,
  toMcpStewardError,
  TransportError,
  UnsupportedRevisionError,
  VersionNegotiationError,
} from '../../src/core/errors.js';

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';

describe('error taxonomy shape', () => {
  const cases = [
    { Ctor: TransportError, code: 'TRANSPORT_FAILURE' },
    { Ctor: AuthenticationRequiredError, code: 'AUTHENTICATION_REQUIRED' },
    { Ctor: ProtocolViolationError, code: 'PROTOCOL_VIOLATION' },
    { Ctor: VersionNegotiationError, code: 'VERSION_NEGOTIATION_FAILED' },
    { Ctor: UnsupportedRevisionError, code: 'UNSUPPORTED_REVISION' },
    { Ctor: DiscoveryError, code: 'DISCOVERY_FAILURE' },
    { Ctor: LedgerCorruptionError, code: 'LEDGER_CORRUPTION' },
    { Ctor: PolicyViolationError, code: 'POLICY_VIOLATION' },
    { Ctor: ConfigurationError, code: 'CONFIGURATION_INVALID' },
    { Ctor: TimeoutError, code: 'TIMEOUT' },
    { Ctor: InternalError, code: 'INTERNAL' },
  ] as const;

  for (const { Ctor, code } of cases) {
    describe(Ctor.name, () => {
      it('carries its stable code', () => {
        expect(new Ctor('something went wrong').code).toBe(code);
      });

      it('is an Error and an McpStewardError', () => {
        const error = new Ctor('something went wrong');
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(McpStewardError);
        expect(isMcpStewardError(error)).toBe(true);
      });

      it('reports its own class name rather than the base name', () => {
        // A stack trace reading "Error" tells the reader nothing.
        expect(new Ctor('x').name).toBe(Ctor.name);
      });

      it('is throwable and catchable by its own type', () => {
        expect(() => {
          throw new Ctor('boom');
        }).toThrow(Ctor);
      });
    });
  }

  it('declares a code for every constructor used above', () => {
    const declared = new Set<string>(ERROR_CODES);
    for (const { code } of cases) {
      expect(declared.has(code)).toBe(true);
    }
    // CANCELLED is exercised separately because its message defaults.
    expect(declared.has('CANCELLED')).toBe(true);
  });

  it('has no duplicate codes', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe('CancellationError', () => {
  it('defaults its message', () => {
    expect(new CancellationError().message).toBe('Operation was cancelled');
  });

  it('accepts an explicit message', () => {
    expect(new CancellationError('user pressed ctrl c').message).toBe('user pressed ctrl c');
  });

  it('is distinguishable from a timeout', () => {
    // A CLI reports one of these as a failure and the other as a normal exit,
    // so conflating them would be a real behavioural bug.
    expect(new CancellationError().code).not.toBe(new TimeoutError('t').code);
  });
});

describe('redaction is enforced at construction', () => {
  it('redacts a secret in the message', () => {
    const error = new TransportError(`failed to connect using ${SECRET}`);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain('REDACTED');
  });

  it('redacts secrets nested in details', () => {
    const error = new DiscoveryError('config parse failed', {
      details: {
        path: '/home/dev/.config/mcp.json',
        env: { GITHUB_TOKEN: SECRET },
        nested: { deeper: [SECRET] },
      },
    });

    const serialized = JSON.stringify(error.details);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain('/home/dev/.config/mcp.json');
  });

  it('redacts a secret reaching the message through a cause', () => {
    const error = new TransportError('spawn failed', {
      cause: new Error(`command was: server --token ${SECRET}`),
    });

    expect(JSON.stringify(error.toJSON())).not.toContain(SECRET);
  });

  it('removes environment derived secrets when they are supplied', () => {
    // This value matches no vendor pattern. Only the environment tells us it is
    // a credential, which is exactly the case the redaction option exists for.
    const opaque = 'justalongopaquevaluewithnoprefix123';
    const error = new TransportError(`server rejected ${opaque}`, {
      redaction: { extraSecrets: [opaque] },
    });

    expect(error.message).not.toContain(opaque);
  });

  it('defaults details to an empty object rather than undefined', () => {
    expect(new InternalError('x').details).toEqual({});
  });
});

describe('toJSON', () => {
  it('produces a machine readable shape', () => {
    const error = new LedgerCorruptionError('entry 41 does not chain to entry 40', {
      details: { sequence: 41, expected: 'sha256:' + 'a'.repeat(64) },
    });

    expect(error.toJSON()).toEqual({
      name: 'LedgerCorruptionError',
      code: 'LEDGER_CORRUPTION',
      message: 'entry 41 does not chain to entry 40',
      details: { sequence: 41, expected: 'sha256:' + 'a'.repeat(64) },
    });
  });

  it('omits the cause key entirely when there is no cause', () => {
    expect(Object.hasOwn(new InternalError('x').toJSON(), 'cause')).toBe(false);
  });

  it('reduces a cause to a description rather than serialising it whole', () => {
    // A Node system error carries the full command line, which is where a
    // credential passed as an argument would be sitting.
    const error = new TransportError('spawn failed', {
      cause: new Error('ENOENT: no such file or directory'),
    });

    expect(error.toJSON().cause).toBe('Error: ENOENT: no such file or directory');
  });

  it('describes a nested McpStewardError cause by its code', () => {
    const inner = new TimeoutError('capture exceeded 5000ms');
    const outer = new DiscoveryError('inventory failed', { cause: inner });

    expect(outer.toJSON().cause).toBe('TIMEOUT: capture exceeded 5000ms');
  });

  it('survives a non Error cause', () => {
    const error = new InternalError('odd throw', { cause: 'a bare string' });
    expect(error.toJSON().cause).toBe('a bare string');
  });

  it('is JSON serialisable without throwing', () => {
    const error = new PolicyViolationError('grade below minimum', {
      details: { required: 'B', actual: 'D' },
    });
    expect(() => JSON.stringify(error)).not.toThrow();
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({ code: 'POLICY_VIOLATION' });
  });
});

describe('hasErrorCode', () => {
  it('matches the right code', () => {
    expect(hasErrorCode(new TimeoutError('t'), 'TIMEOUT')).toBe(true);
  });

  it('rejects a different code', () => {
    expect(hasErrorCode(new TimeoutError('t'), 'CANCELLED')).toBe(false);
  });

  it('rejects a foreign error', () => {
    expect(hasErrorCode(new Error('plain'), 'INTERNAL')).toBe(false);
    expect(hasErrorCode(undefined, 'INTERNAL')).toBe(false);
    expect(hasErrorCode('a string', 'INTERNAL')).toBe(false);
  });
});

describe('toMcpStewardError', () => {
  it('passes through an error that is already ours, unchanged', () => {
    const original = new TimeoutError('capture exceeded 5000ms');
    expect(toMcpStewardError(original, 'while capturing')).toBe(original);
  });

  it('wraps a foreign Error as INTERNAL and keeps the cause', () => {
    const foreign = new TypeError('cannot read properties of undefined');
    const wrapped = toMcpStewardError(foreign, 'while parsing config');

    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.message).toContain('while parsing config');
    expect(wrapped.message).toContain('cannot read properties of undefined');
    expect(wrapped.cause).toBe(foreign);
  });

  it('wraps a thrown non Error value', () => {
    const wrapped = toMcpStewardError('a bare string throw', 'while doing a thing');
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.message).toContain('a bare string throw');
  });

  it('redacts a secret carried by a foreign error', () => {
    const wrapped = toMcpStewardError(new Error(`token ${SECRET} rejected`), 'while connecting');
    expect(wrapped.message).not.toContain(SECRET);
  });

  it('wraps null and undefined without throwing', () => {
    expect(toMcpStewardError(null, 'ctx').code).toBe('INTERNAL');
    expect(toMcpStewardError(undefined, 'ctx').code).toBe('INTERNAL');
  });
});
