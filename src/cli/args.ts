/**
 * Argument parsing.
 *
 * Hand written rather than pulled from a dependency. The surface is small (flags,
 * one subcommand, one optional target) and the package's whole position is that it
 * carries no runtime dependencies, so importing an argument parser to save eighty
 * lines would be a poor trade.
 *
 * Unknown flags are errors, not warnings. A mistyped `--fromat json` that silently
 * fell back to terminal output would produce a CI job parsing prose as JSON.
 */

import { ConfigurationError } from '../core/errors.js';
import { isLogLevel, type LogLevel } from '../core/logger.js';
import { isReportFormat, type ReportFormat } from '../report/index.js';

export interface GlobalFlags {
  readonly format: ReportFormat;
  readonly colour: boolean;
  readonly logLevel: LogLevel;
  readonly timeoutMs: number;
  readonly configPath?: string;
  readonly ledgerPath?: string;
  readonly policyPath?: string;
  readonly output?: string;
  readonly help: boolean;
  readonly version: boolean;
  readonly yes: boolean;
  /** Apply safe codemods rather than only reporting. */
  readonly fix: boolean;
}

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly subcommand: string | undefined;
  /** Positional arguments after the command and subcommand. */
  readonly targets: readonly string[];
  readonly flags: GlobalFlags;
}

const FLAGS_WITH_VALUES = new Set([
  '--format',
  '--log-level',
  '--timeout',
  '--config',
  '--ledger',
  '--policy',
  '--output',
]);

const BOOLEAN_FLAGS = new Set([
  '--fix',
  '--no-colour',
  '--no-color',
  '--colour',
  '--color',
  '--help',
  '-h',
  '--version',
  '-v',
  '--yes',
  '-y',
]);

/** Commands that take a subcommand rather than a target. */
const SUBCOMMAND_COMMANDS = new Set(['ledger', 'policy']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];

  let format: ReportFormat = 'terminal';
  let colour: boolean | undefined;
  let logLevel: LogLevel = 'silent';
  let timeoutMs = 30_000;
  let configPath: string | undefined;
  let ledgerPath: string | undefined;
  let policyPath: string | undefined;
  let output: string | undefined;
  let help = false;
  let version = false;
  let yes = false;
  let fix = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';

    if (!argument.startsWith('-')) {
      positionals.push(argument);
      continue;
    }

    // Support both `--format json` and `--format=json`.
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);

    const readValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;

      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new ConfigurationError(`${name} requires a value`, { details: { flag: name } });
      }

      index += 1;
      return next;
    };

    if (!FLAGS_WITH_VALUES.has(name) && !BOOLEAN_FLAGS.has(name)) {
      throw new ConfigurationError(
        `Unknown option ${name}. Run mcpsteward --help to see available options.`,
        { details: { flag: name } },
      );
    }

    switch (name) {
      case '--format': {
        const value = readValue();
        if (!isReportFormat(value)) {
          throw new ConfigurationError(
            `--format must be one of terminal, json, ndjson, markdown, sarif, html. Got ${JSON.stringify(value)}.`,
            { details: { flag: name } },
          );
        }
        format = value;
        break;
      }

      case '--log-level': {
        const value = readValue();
        if (!isLogLevel(value)) {
          throw new ConfigurationError(
            `--log-level must be one of silent, error, warn, info, debug, trace. Got ${JSON.stringify(value)}.`,
            { details: { flag: name } },
          );
        }
        logLevel = value;
        break;
      }

      case '--timeout': {
        const value = Number(readValue());
        if (!Number.isFinite(value) || value <= 0) {
          throw new ConfigurationError('--timeout must be a positive number of milliseconds', {
            details: { flag: name },
          });
        }
        timeoutMs = value;
        break;
      }

      case '--config':
        configPath = readValue();
        break;
      case '--ledger':
        ledgerPath = readValue();
        break;
      case '--policy':
        policyPath = readValue();
        break;
      case '--output':
        output = readValue();
        break;

      case '--no-colour':
      case '--no-color':
        colour = false;
        break;
      case '--colour':
      case '--color':
        colour = true;
        break;

      case '--help':
      case '-h':
        help = true;
        break;
      case '--version':
      case '-v':
        version = true;
        break;
      case '--yes':
      case '-y':
        yes = true;
        break;
      case '--fix':
        fix = true;
        break;

      /* c8 ignore next 2 -- unreachable: the membership check above covers it */
      default:
        break;
    }
  }

  const command = positionals[0];
  const takesSubcommand = command !== undefined && SUBCOMMAND_COMMANDS.has(command);
  const subcommand = takesSubcommand ? positionals[1] : undefined;
  const targets = positionals.slice(takesSubcommand ? 2 : 1);

  return {
    command,
    subcommand,
    targets,
    flags: {
      format,
      // Colour defaults to whether stdout is a terminal, decided by the caller.
      colour: colour ?? false,
      logLevel,
      timeoutMs,
      help,
      version,
      yes,
      fix,
      ...(configPath === undefined ? {} : { configPath }),
      ...(ledgerPath === undefined ? {} : { ledgerPath }),
      ...(policyPath === undefined ? {} : { policyPath }),
      ...(output === undefined ? {} : { output }),
    },
  };
}

/** True when the caller passed an explicit colour preference either way. */
export function hasExplicitColour(argv: readonly string[]): boolean {
  return argv.some((a) => ['--colour', '--color', '--no-colour', '--no-color'].includes(a));
}
