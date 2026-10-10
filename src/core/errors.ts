/**
 * Error taxonomy.
 *
 * Every throw in this package is one of these types. No bare `Error`, no string
 * throws. Two reasons.
 *
 * **Machine readability.** The CLI maps a code to an exit status, the MCP server
 * maps it to a JSON-RPC error, and the report renderers group by it. A caller
 * should never have to match on a message string.
 *
 * **Redaction.** An error message is one of the four places that must never carry a
 * secret from reaching, and it is the easiest one to leak through, because the
 * natural way to write a transport error is to interpolate the thing that failed.
 * Every message and every detail value is passed through {@link redact} inside the
 * constructor, so a caller cannot forget.
 */

import { redact, redactDeep, type RedactionOptions } from './redaction.js';

/**
 * Stable machine readable error codes.
 *
 * These appear in JSON and SARIF output and in users' CI configuration. Treat them
 * as public API: add freely, never rename, never repurpose.
 */
export const ERROR_CODES = [
  /** A transport could not be established, or died mid exchange. */
  'TRANSPORT_FAILURE',
  /** The server refused the request until the caller signs in. */
  'AUTHENTICATION_REQUIRED',
  /** The peer sent something the protocol does not permit. */
  'PROTOCOL_VIOLATION',
  /** No mutually supported protocol revision exists. */
  'VERSION_NEGOTIATION_FAILED',
  /** The revision is recognised but this package does not implement it. */
  'UNSUPPORTED_REVISION',
  /** Locating or parsing MCP client configuration failed. */
  'DISCOVERY_FAILURE',
  /** The ledger's hash chain is broken, truncated, reordered or rewritten. */
  'LEDGER_CORRUPTION',
  /** A policy rule was violated. */
  'POLICY_VIOLATION',
  /** Configuration was invalid. Carries the offending key. */
  'CONFIGURATION_INVALID',
  /** An operation exceeded its time budget. */
  'TIMEOUT',
  /** An operation was cancelled through its `AbortSignal`. */
  'CANCELLED',
  /** A defect in this package. Never the user's fault, always worth reporting. */
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Structured, JSON safe detail attached to an error. */
export type ErrorDetails = Readonly<Record<string, unknown>>;

export interface McpStewardErrorOptions {
  /** Structured context. Every string inside is redacted. */
  readonly details?: ErrorDetails;
  /** The underlying cause, preserved for stack traces but never rendered raw. */
  readonly cause?: unknown;
  /** Redaction options, typically carrying environment derived secrets. */
  readonly redaction?: RedactionOptions;
}

/**
 * Base class for every error this package throws.
 *
 * The message and all details are redacted during construction. There is no way to
 * construct one of these carrying an unredacted secret, which is the point: the
 * guarantee holds even when a future caller forgets it exists.
 */
export class McpStewardError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, options: McpStewardErrorOptions = {}) {
    // Redaction happens here rather than at render time so that a message which
    // escapes through an unexpected path, an uncaught throw printed by Node for
    // instance, is already safe.
    super(redact(message, options.redaction), { cause: options.cause });

    this.name = new.target.name;
    this.code = code;
    this.details = redactDeep(options.details ?? {}, options.redaction);

    // Keep the constructor out of the captured stack where the platform supports
    // it, so the first frame is the throw site the reader cares about.
    /* c8 ignore next 3 -- captureStackTrace is V8 only */
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }

  /**
   * JSON safe form for machine readable output.
   *
   * The cause is deliberately reduced to its message and code rather than
   * serialised whole: a cause is frequently a Node system error carrying a full
   * command line, which is exactly where a credential passed as an argument would
   * be sitting.
   */
  toJSON(): {
    name: string;
    code: ErrorCode;
    message: string;
    details: ErrorDetails;
    cause?: string;
  } {
    const cause = describeCause(this.cause);

    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      ...(cause === undefined ? {} : { cause }),
    };
  }
}

function describeCause(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof McpStewardError) return `${cause.code}: ${cause.message}`;
  if (cause instanceof Error) return redact(`${cause.name}: ${cause.message}`);
  return redact(describeUnknown(cause));
}

/**
 * Describe a thrown value that is not an `Error`.
 *
 * Plain `String()` on an object yields `[object Object]`, which tells a reader
 * nothing about why their capture failed. Anything structured is serialised
 * instead, so a rejected promise carrying a response body stays diagnosable.
 */
function describeUnknown(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'symbol':
      return value.toString();
    case 'function':
      return `[function ${value.name || 'anonymous'}]`;
    case 'undefined':
      return 'undefined';
    case 'object': {
      try {
        // `null` reaches this branch too, since `typeof null === 'object'`.
        // JSON.stringify renders it as the string "null", which is what a reader
        // wants to see for a `throw null`.
        return JSON.stringify(value);
      } catch {
        // Circular, or a getter that throws. Neither is a reason to lose the
        // original error, so degrade to a shape hint instead of failing.
        return Array.isArray(value) ? '[unserialisable array]' : '[unserialisable object]';
      }
    }
  }
}

/** A transport could not be established, or died mid exchange. */
export class TransportError extends McpStewardError {
  constructor(message: string, options?: McpStewardErrorOptions) {
    super('TRANSPORT_FAILURE', message, options);
  }
}

/**
 * The server answered HTTP 401 or 403: it will not describe itself to a caller
 * that has not signed in.
 *
 * Deliberately not a {@link TransportError}. The connection worked and the server
 * answered clearly, so retrying cannot change the outcome, and reporting it as a
 * transport failure sent people looking for a network problem that did not
 * exist. Most hosted MCP servers behave this way, so it is the single most
 * common result of pointing mcpsteward at a real machine.
 */
export class AuthenticationRequiredError extends McpStewardError {
  constructor(message: string, options?: McpStewardErrorOptions) {
    super('AUTHENTICATION_REQUIRED', message, options);
  }
}

/**
 * The peer sent something the protocol does not permit.
 *
 * This is distinct from a conformance rule failure. A conformance failure is an
 * observation this package is designed to make and report. A protocol violation is
 * a response so malformed that the exchange cannot continue.
 */
export class ProtocolViolationError extends McpStewardError {
  constructor(message: string, options?: McpStewardErrorOptions) {
    super('PROTOCOL_VIOLATION', message, options);
  }
}

/** No mutually supported protocol revision exists. */
export class VersionNegotiationError extends McpStewardError {
  constructor(message: string, options?: McpStewardErrorOptions) {
    super('VERSION_NEGOTIATION_FAILED', message, options);
  }
}

/** The revision is recognised but this package does not implement it. */
export class UnsupportedRevisionError extends McpStewardError {
  constructor(message: string, options?: McpStewardErrorOptions) {
    super('UNSUPPORTED_REVISION', message, options);
  }
}

/** Locating or parsing MCP client configuration failed. */
export class DiscoveryError extends McpStewardError {
  constructor(message: string, options?: McpStewardErrorOptions) {
    super('DISCOVERY_FAILURE', message, options);
  }
}

/**
 * The ledger's hash chain is broken.
 *
 * Carries the exact sequence number where integrity fails, because "your ledger is
 * corrupt" is not actionable and "entry 41 does not chain to entry 40" is.
 */
export class LedgerCorruptionError extends McpStewardError {
  constructor(message: string, options?: McpStewardErrorOptions) {
    super('LEDGER_CORRUPTION', message, options);
  }
}

/** A policy rule was violated. */
export class PolicyViolationError extends McpStewardError {
  constructor(message: string, options?: McpStewardErrorOptions) {
    super('POLICY_VIOLATION', message, options);
  }
}

/** Configuration was invalid. Names the offending key in `details.key`. */
export class ConfigurationError extends McpStewardError {
  constructor(message: string, options?: McpStewardErrorOptions) {
    super('CONFIGURATION_INVALID', message, options);
  }
}

/** An operation exceeded its time budget. */
export class TimeoutError extends McpStewardError {
  constructor(message: string, options?: McpStewardErrorOptions) {
    super('TIMEOUT', message, options);
  }
}

/**
 * An operation was cancelled through its `AbortSignal`.
 *
 * Distinct from {@link TimeoutError}: a timeout is this package giving up, a
 * cancellation is the caller changing their mind. Callers routinely want to treat
 * the two differently, and a CLI should report only one of them as a failure.
 */
export class CancellationError extends McpStewardError {
  constructor(message = 'Operation was cancelled', options?: McpStewardErrorOptions) {
    super('CANCELLED', message, options);
  }
}

/** A defect in this package. */
export class InternalError extends McpStewardError {
  constructor(message: string, options?: McpStewardErrorOptions) {
    super('INTERNAL', message, options);
  }
}

/** Narrow an unknown caught value to this package's error type. */
export function isMcpStewardError(value: unknown): value is McpStewardError {
  return value instanceof McpStewardError;
}

/**
 * Narrow a caught value to a specific code without importing the class.
 *
 * Useful at boundaries that care about one condition, for example a CLI deciding
 * whether a cancellation should be reported as a failure.
 */
export function hasErrorCode(value: unknown, code: ErrorCode): boolean {
  return isMcpStewardError(value) && value.code === code;
}

/**
 * Wrap an arbitrary caught value as an {@link InternalError}, preserving anything
 * that is already one of ours.
 *
 * Every `catch` that cannot handle a value should funnel through here rather than
 * rethrowing raw, so nothing escapes the taxonomy or the redaction guarantee.
 */
export function toMcpStewardError(value: unknown, context: string): McpStewardError {
  if (isMcpStewardError(value)) return value;

  const description = value instanceof Error ? value.message : describeUnknown(value);
  return new InternalError(`${context}: ${description}`, { cause: value });
}
