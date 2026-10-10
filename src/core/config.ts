/**
 * Configuration resolution.
 *
 * Precedence, lowest to highest:
 *
 * 1. **Built in defaults.** Everything has one, so mcpsteward runs with no
 *    configuration at all.
 * 2. **Configuration file.** `mcpsteward.config.json`, or a path given explicitly.
 * 3. **Environment.** `MCPSTEWARD_*` variables.
 * 4. **Per call overrides.** What the caller passed to this specific operation.
 *
 * Later wins. A value set in two places is not an error; the higher precedence one
 * simply applies, which is what lets a CI job override a checked in file without
 * editing it.
 *
 * Validation names the offending key. `"timeoutMs must be a positive integer, got
 * -1"` is actionable; `"invalid configuration"` sends someone hunting.
 */

import { ConfigurationError } from './errors.js';
import { isLogLevel, type LogLevel } from './logger.js';
import { isSupportedRevision, TARGET_REVISION, type ProtocolRevision } from './revisions.js';

export interface McpStewardConfig {
  /** Per operation time budget in milliseconds. */
  readonly timeoutMs: number;
  /** Attempts after the first, for retryable transport failures. */
  readonly retries: number;
  /** Base backoff in milliseconds, doubled per attempt. */
  readonly retryBackoffMs: number;
  /** The revision to attempt first. */
  readonly preferredRevision: ProtocolRevision;
  /** Whether to fall back to an older revision when the preferred one is refused. */
  readonly allowDowngrade: boolean;
  /** Where the ledger lives. Absent means the default location under the home directory. */
  readonly ledgerPath?: string;
  /** Where the policy file lives. */
  readonly policyPath?: string;
  readonly logLevel: LogLevel;
  /** Maximum descriptors accepted from one server, as a denial of service bound. */
  readonly maxDescriptors: number;
  /** Maximum bytes accepted from a single response. */
  readonly maxResponseBytes: number;
}

export const DEFAULT_CONFIG: McpStewardConfig = {
  timeoutMs: 30_000,
  retries: 2,
  retryBackoffMs: 250,
  preferredRevision: TARGET_REVISION,
  allowDowngrade: true,
  logLevel: 'silent',

  // Bounds rather than guesses. A server advertising more than ten thousand tools
  // is either broken or hostile, and either way the capture should stop rather
  // than exhaust memory. Same reasoning for the response size cap.
  maxDescriptors: 10_000,
  maxResponseBytes: 32 * 1024 * 1024,
};

/** A partial configuration from any one source. */
export type ConfigOverrides = Partial<McpStewardConfig>;

const ENV_PREFIX = 'MCPSTEWARD_';

/**
 * Read configuration from environment variables.
 *
 * Only recognised keys are read. An unrecognised `MCPSTEWARD_*` variable is ignored
 * rather than rejected, because failing a whole run over a stale variable somebody
 * exported months ago helps nobody.
 */
export function configFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ConfigOverrides {
  const out: Record<string, unknown> = {};

  const readNumber = (name: string, key: string): void => {
    const raw = env[`${ENV_PREFIX}${name}`];
    if (raw === undefined || raw === '') return;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new ConfigurationError(
        `${ENV_PREFIX}${name} must be a number, got ${JSON.stringify(raw)}`,
        { details: { key, source: 'environment' } },
      );
    }
    out[key] = parsed;
  };

  const readString = (name: string, key: string): void => {
    const raw = env[`${ENV_PREFIX}${name}`];
    if (raw === undefined || raw === '') return;
    out[key] = raw;
  };

  const readBoolean = (name: string, key: string): void => {
    const raw = env[`${ENV_PREFIX}${name}`];
    if (raw === undefined || raw === '') return;

    const normalized = raw.toLowerCase();
    if (!['true', 'false', '1', '0', 'yes', 'no'].includes(normalized)) {
      throw new ConfigurationError(
        `${ENV_PREFIX}${name} must be a boolean, got ${JSON.stringify(raw)}`,
        { details: { key, source: 'environment' } },
      );
    }
    out[key] = normalized === 'true' || normalized === '1' || normalized === 'yes';
  };

  readNumber('TIMEOUT_MS', 'timeoutMs');
  readNumber('RETRIES', 'retries');
  readNumber('RETRY_BACKOFF_MS', 'retryBackoffMs');
  readNumber('MAX_DESCRIPTORS', 'maxDescriptors');
  readNumber('MAX_RESPONSE_BYTES', 'maxResponseBytes');
  readString('PREFERRED_REVISION', 'preferredRevision');
  readString('LEDGER_PATH', 'ledgerPath');
  readString('POLICY_PATH', 'policyPath');
  readString('LOG_LEVEL', 'logLevel');
  readBoolean('ALLOW_DOWNGRADE', 'allowDowngrade');

  return out as ConfigOverrides;
}

function requirePositiveInteger(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(
      `${key} must be a positive integer, got ${JSON.stringify(value)}`,
      { details: { key } },
    );
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigurationError(
      `${key} must be a non negative integer, got ${JSON.stringify(value)}`,
      { details: { key } },
    );
  }
  return value;
}

function requireBoolean(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigurationError(`${key} must be a boolean, got ${JSON.stringify(value)}`, {
      details: { key },
    });
  }
  return value;
}

function requireOptionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigurationError(
      `${key} must be a non empty string when set, got ${JSON.stringify(value)}`,
      { details: { key } },
    );
  }
  return value;
}

/**
 * Validate a fully merged configuration.
 *
 * Runs after merging rather than per source, so that a low precedence bad value
 * overridden by a good one does not fail the run.
 */
export function validateConfig(candidate: ConfigOverrides): McpStewardConfig {
  const merged = { ...DEFAULT_CONFIG, ...candidate };

  const revision = merged.preferredRevision;
  if (typeof revision !== 'string' || !isSupportedRevision(revision)) {
    throw new ConfigurationError(
      `preferredRevision must be a supported protocol revision, got ${JSON.stringify(revision)}`,
      { details: { key: 'preferredRevision' } },
    );
  }

  const logLevel = merged.logLevel;
  if (typeof logLevel !== 'string' || !isLogLevel(logLevel)) {
    throw new ConfigurationError(
      `logLevel must be one of silent, error, warn, info, debug, trace, got ${JSON.stringify(logLevel)}`,
      { details: { key: 'logLevel' } },
    );
  }

  const ledgerPath = requireOptionalString(merged.ledgerPath, 'ledgerPath');
  const policyPath = requireOptionalString(merged.policyPath, 'policyPath');

  return {
    timeoutMs: requirePositiveInteger(merged.timeoutMs, 'timeoutMs'),
    retries: requireNonNegativeInteger(merged.retries, 'retries'),
    retryBackoffMs: requireNonNegativeInteger(merged.retryBackoffMs, 'retryBackoffMs'),
    preferredRevision: revision,
    allowDowngrade: requireBoolean(merged.allowDowngrade, 'allowDowngrade'),
    logLevel,
    maxDescriptors: requirePositiveInteger(merged.maxDescriptors, 'maxDescriptors'),
    maxResponseBytes: requirePositiveInteger(merged.maxResponseBytes, 'maxResponseBytes'),
    ...(ledgerPath === undefined ? {} : { ledgerPath }),
    ...(policyPath === undefined ? {} : { policyPath }),
  };
}

export interface ResolveConfigInput {
  readonly fileConfig?: ConfigOverrides;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly overrides?: ConfigOverrides;
}

/**
 * Resolve the effective configuration.
 *
 * Sources are merged in documented precedence order and the result is validated
 * once, as a whole.
 */
export function resolveConfig(input: ResolveConfigInput = {}): McpStewardConfig {
  const fromEnv = input.env === undefined ? {} : configFromEnv(input.env);

  return validateConfig({
    ...input.fileConfig,
    ...fromEnv,
    ...input.overrides,
  });
}

/**
 * Parse a configuration file's contents.
 *
 * Unknown keys are rejected rather than ignored. A configuration file is written
 * deliberately, so a key that does nothing is almost always a typo, and silently
 * ignoring `timeoutMS` when the field is `timeoutMs` produces a run that quietly
 * uses the default. This is the opposite of the environment behaviour above, and
 * the asymmetry is intentional: a stale exported variable is background noise, a
 * misspelled config key is a mistake being made right now.
 */
export function parseConfigFile(text: string, path: string): ConfigOverrides {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigurationError(`${path} is not valid JSON`, {
      details: { path },
      cause,
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigurationError(`${path} must contain a JSON object`, { details: { path } });
  }

  const known = new Set(Object.keys(DEFAULT_CONFIG).concat('ledgerPath', 'policyPath'));
  const unknown = Object.keys(parsed).filter((key) => !known.has(key));

  if (unknown.length > 0) {
    throw new ConfigurationError(
      `${path} has unknown configuration keys: ${unknown.join(', ')}`,
      { details: { path, unknownKeys: unknown } },
    );
  }

  return parsed as ConfigOverrides;
}
