#!/usr/bin/env node
/**
 * The command line interface.
 *
 * ## Stream discipline
 *
 * The report goes to stdout. Everything else, including every diagnostic, every
 * warning and every error, goes to stderr. That separation is what makes
 * `mcpsteward conform x --format json | jq` work: a log line on stdout would
 * corrupt the document a caller is parsing.
 *
 * ## Exit codes are a contract
 *
 * 0 success, 1 policy or conformance failure, 2 usage error, 3 internal defect.
 * A CI job branches on these, so they may be added to but never renumbered. The
 * distinction between 1 and 3 matters: 1 means the tool worked and the machine
 * did not, 3 means the tool is broken and the result should not be trusted.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { parseConfigFile, resolveConfig, type McpStewardConfig } from '../core/config.js';
import { isEntryPoint } from '../core/entry.js';
import { isMcpStewardError, toMcpStewardError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import { collectEnvSecrets, type RedactionOptions } from '../core/redaction.js';
import { SUPPORTED_REVISIONS, TARGET_REVISION } from '../core/revisions.js';
import type { ServerRef, Severity } from '../core/types.js';
import { grade } from '../conformance/index.js';
import { launchSettingsFor } from '../discovery/configured.js';
import { discover, knownClients, type Inventory } from '../discovery/index.js';
import { Ledger } from '../ledger/index.js';
import { analyzeMigration, applyCodemod, codemodFile } from '../migration/index.js';
import { checkPolicy, EXIT_CODES, exitCodeFor, initPolicy, loadPolicy, savePolicy } from '../policy/index.js';
import { McpClient } from '../protocol/client.js';
import { HttpTransport } from '../protocol/http-transport.js';
import { StdioTransport } from '../protocol/stdio-transport.js';
import { buildReport, render, type Report, type ReportItem } from '../report/index.js';
import { createPin, diffAgainstPin, loadPin, savePin } from '../trust/index.js';
import { hasExplicitColour, parseArgs, type GlobalFlags } from './args.js';
import { COMMAND_HELP, HELP, VERSION } from './help.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTty: boolean;
  /**
   * The directory whose project level configuration (`.mcp.json`,
   * `.vscode/mcp.json`, `.cursor/mcp.json`) is inventoried alongside the user's
   * own. Defaults to the process working directory. Without it, the CLI read only
   * configuration under the home directory, so a CI job running `verify` on a
   * runner, which has none, checked nothing and passed.
   */
  readonly cwd?: string;
}

/**
 * Run the CLI.
 *
 * Returns an exit code rather than calling `process.exit`, so the whole surface
 * is testable in process and a caller embedding it is not killed by it.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;

  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.stderr(`${messageOf(error)}\n`);
    return EXIT_CODES.usageError;
  }

  const { command, subcommand, targets, flags } = parsed;

  if (flags.version) {
    io.stdout(`${VERSION}\n`);
    return EXIT_CODES.success;
  }

  if (flags.help || command === undefined) {
    const specific = command === undefined ? undefined : COMMAND_HELP[command];
    io.stdout(specific ?? HELP);
    return command === undefined && !flags.help ? EXIT_CODES.usageError : EXIT_CODES.success;
  }

  // Colour follows the terminal unless the caller was explicit, so redirected
  // output and CI logs stay free of escape codes without anyone asking.
  const effective: GlobalFlags = {
    ...flags,
    colour: hasExplicitColour(argv) ? flags.colour : io.isTty,
  };

  const logger = createLogger({
    level: effective.logLevel,
    sink: (record) => {
      io.stderr(`${record.level}: ${record.message}\n`);
    },
    redaction: redactionFor(io),
  });

  try {
    return await dispatch(command, subcommand, targets, effective, io, logger);
  } catch (error) {
    const wrapped = toMcpStewardError(error, `running ${command}`);

    io.stderr(`${wrapped.message}\n`);

    // A usage mistake and a defect must not look the same to a CI job.
    if (wrapped.code === 'CONFIGURATION_INVALID') return EXIT_CODES.usageError;
    if (isMcpStewardError(error)) return EXIT_CODES.policyFailure;

    io.stderr('This is a defect in mcpsteward. Please report it with the command you ran.\n');
    return EXIT_CODES.internalError;
  }
}

async function dispatch(
  command: string,
  subcommand: string | undefined,
  targets: readonly string[],
  flags: GlobalFlags,
  io: CliIo,
  logger: Logger,
): Promise<number> {
  const config = await resolveCliConfig(flags, io);

  switch (command) {
    case 'discover':
      return emit(await discoverReport(flags, logger, io.cwd ?? process.cwd()), flags, io);

    case 'doctor':
      return emit(await doctorReport(flags, config, io.cwd ?? process.cwd()), flags, io);

    case 'migrate': {
      const target = targets[0];
      if (target === undefined) {
        io.stderr('migrate needs a path. Example: mcpsteward migrate ./src\n');
        return EXIT_CODES.usageError;
      }
      if (targets.includes('--fix') || flags.fix) {
        return await migrateFix(target, flags, io);
      }

      const migration = await migrateReport(target, logger);

      // A scan that read nothing is not a pass. Most often the path is wrong.
      if (migration.filesScanned === 0) {
        await emit(migration.report, flags, io);
        io.stderr(`No source files were found under ${target}.\n`);
        return EXIT_CODES.usageError;
      }

      // Failed only when something was found. This used to fail unconditionally,
      // so a CI job running migrate on a clean codebase could never pass.
      return emit(migration.report, flags, io, migration.findings > 0);
    }

    case 'capture':
    case 'conform':
    case 'trust':
    case 'diff':
      return await serverCommand(command, targets, flags, config, io, logger);

    case 'verify':
      return await verifyCommand(flags, config, io, logger);

    case 'ledger':
      return await ledgerCommand(subcommand, flags, config, io);

    case 'policy':
      return await policyCommand(subcommand, flags, config, io, logger);

    default:
      io.stderr(`Unknown command ${JSON.stringify(command)}. Run mcpsteward --help.\n`);
      return EXIT_CODES.usageError;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function discoverReport(flags: GlobalFlags, logger: Logger, cwd: string): Promise<Report> {
  const inventory = await discover({ logger, projectDirectories: [cwd] });

  return buildReport({
    kind: 'inventory',
    title: 'MCP server inventory',
    subject: `${String(inventory.summary.totalServers)} server(s) on this machine`,
    toolVersion: VERSION,
    summary: [
      { label: 'Servers', value: String(inventory.summary.totalServers) },
      { label: 'Local (stdio)', value: String(inventory.summary.local) },
      { label: 'Remote (http)', value: String(inventory.summary.remote) },
      {
        label: 'Inline credentials',
        value: String(inventory.summary.withInlineCredentials),
        ...(inventory.summary.withInlineCredentials > 0 ? { severity: 'critical' as const } : {}),
      },
      { label: 'In several clients', value: String(inventory.summary.multiplyRegistered) },
      { label: 'Clients found', value: inventory.summary.clientsFound.join(', ') || 'none' },
    ],
    sections: [
      {
        title: 'Servers',
        emptyMessage: 'No MCP servers are configured on this machine.',
        items: inventory.servers.map(serverItem),
      },
      {
        title: 'Problems',
        emptyMessage: 'Every configuration file that exists was readable.',
        items: inventory.problems.map((problem) => ({
          id: 'DISCOVERY',
          title: `Could not read ${problem.client} configuration`,
          severity: 'medium' as const,
          detail: problem.reason,
          locus: problem.configPath,
        })),
      },
    ],
    notes: notesFor(inventory),
    redaction: {},
  });
}

function serverItem(server: ServerRef): ReportItem {
  const inline = server.registrations.some((r) => r.hasInlineCredential);

  const where =
    server.endpoint.transport === 'stdio'
      ? `${server.endpoint.command} ${server.endpoint.args.join(' ')}`.trim()
      : server.endpoint.url;

  return {
    id: server.id,
    title: server.name,
    severity: inline ? 'critical' : 'info',
    detail:
      `${server.endpoint.transport}, auth ${server.authPosture}, registered in ` +
      `${server.registrations.map((r) => r.client).join(', ')}. ${where}`,
    ...(inline
      ? {
          remediation:
            'A credential is written directly into a configuration file. Replace it with an ' +
            'environment reference and rotate the exposed value.',
        }
      : {}),
    locus: server.registrations[0]?.configPath ?? '',
  };
}

function notesFor(inventory: Inventory): readonly string[] {
  const notes: string[] = [];

  if (inventory.summary.totalServers === 0) {
    notes.push(
      `Checked ${String(inventory.absentPaths.length)} known location(s) and found no ` +
        'configuration. If you expected servers here, the path for your client may differ. ' +
        'See VERIFY.md section 1 for which paths are confirmed.',
    );
  }

  return notes;
}

async function migrateReport(
  path: string,
  logger: Logger,
): Promise<{ report: Report; filesScanned: number; findings: number }> {
  const report = await analyzeMigration(path, { logger });

  const bySeverity = (severity: string): number =>
    report.findings.filter((f) => f.severity === severity).length;

  const built = buildReport({
    kind: 'migration',
    title: 'Migration analysis for the 2026-07-28 revision',
    subject: path,
    toolVersion: VERSION,
    summary: [
      { label: 'Files scanned', value: String(report.filesScanned) },
      { label: 'Findings', value: String(report.findings.length) },
      {
        label: 'Critical',
        value: String(bySeverity('critical')),
        ...(bySeverity('critical') > 0 ? { severity: 'critical' as const } : {}),
      },
      { label: 'Analysis', value: report.analysis },
    ],
    sections: [
      {
        title: 'Breaking patterns',
        emptyMessage: 'No patterns that break under 2026-07-28 were found.',
        items: report.findings.map((finding) => ({
          id: finding.patternId,
          title: finding.title,
          severity: finding.severity,
          detail: `${finding.why} Found: ${finding.snippet}`,
          remediation: finding.fix,
          location: { file: finding.file, line: finding.line },
          citation: finding.rule,
          evidence: { confidence: finding.confidence },
        })),
      },
    ],
    notes: [
      ...(report.degradedReason === undefined ? [] : [report.degradedReason]),
      ...(report.scannedCompiledOutput === true
        ? [
            'No source files were found outside dist, build and out, so the compiled output ' +
              'was scanned instead. This is normal for an installed package. File and line ' +
              'references point at the compiled files.',
          ]
        : []),
    ],
    redaction: {},
  });

  return { report: built, filesScanned: report.filesScanned, findings: report.findings.length };
}

/**
 * Apply the safe codemods to a source tree.
 *
 * Prints the diff first, always. Writes only when `--yes` was passed, because a
 * tool that rewrites somebody's source as a side effect of an exploratory command
 * has done something it cannot undo.
 *
 * Only the retired error code renumbering is mechanised. Everything else the
 * analyzer detects needs a decision the author has to make, and a codemod that
 * guessed would put its guess in a repository where it will later be assumed to
 * be deliberate.
 */
async function migrateFix(target: string, flags: GlobalFlags, io: CliIo): Promise<number> {
  const report = await analyzeMigration(target);

  const files = [...new Set(report.findings.map((f) => f.file))]
    .map((relative) => join(target, relative))
    .sort();

  let changedFiles = 0;
  let changedLines = 0;
  const manual: string[] = [];

  for (const file of files) {
    let result;
    try {
      result = await codemodFile(file);
    } catch (error) {
      io.stderr(`${messageOf(error)}\n`);
      return EXIT_CODES.usageError;
    }

    for (const item of result.manual) {
      manual.push(`${file}:${String(item.line)}  ${item.reason}`);
    }

    if (result.edits.length === 0) continue;

    changedFiles += 1;
    changedLines += result.edits.length;

    io.stdout(`${result.diff}\n`);

    if (flags.yes) await applyCodemod(result);
  }

  if (changedLines === 0) {
    io.stderr('Nothing to fix automatically.\n');
  } else if (flags.yes) {
    io.stderr(
      `Applied ${String(changedLines)} change(s) across ${String(changedFiles)} file(s).\n`,
    );
  } else {
    io.stderr(
      `Would apply ${String(changedLines)} change(s) across ${String(changedFiles)} file(s).\n` +
        'Nothing was written. Re-run with --yes to apply.\n',
    );
  }

  if (manual.length > 0) {
    io.stderr(`\n${String(manual.length)} finding(s) need a human decision:\n`);
    for (const item of manual) io.stderr(`  ${item}\n`);
  }

  const remaining = report.findings.filter((f) => f.patternId !== 'MIG-ERROR-CODE');
  if (remaining.length > 0) {
    io.stderr(
      `\n${String(remaining.length)} other finding(s) are not safely mechanisable. ` +
        `Run mcpsteward migrate ${target} to see them with their fixes.\n`,
    );
  }

  return EXIT_CODES.success;
}

async function serverCommand(
  command: string,
  targets: readonly string[],
  flags: GlobalFlags,
  config: McpStewardConfig,
  io: CliIo,
  logger: Logger,
): Promise<number> {
  const name = targets[0];
  if (name === undefined) {
    io.stderr(`${command} needs a server name. Run mcpsteward discover to see what is configured.\n`);
    return EXIT_CODES.usageError;
  }

  const inventory = await discover({ logger, projectDirectories: [io.cwd ?? process.cwd()] });
  const server = inventory.servers.find((s) => s.name === name || s.id === name);

  if (server === undefined) {
    io.stderr(
      `No configured server named ${JSON.stringify(name)}. ` +
        `Run mcpsteward discover to see the ${String(inventory.servers.length)} server(s) found.\n`,
    );
    return EXIT_CODES.usageError;
  }

  const client = clientFor(server, config, logger, io);

  try {
    const captured = await client.capture(server, server.endpoint.transport);

    switch (command) {
      case 'capture': {
        const ledger = new Ledger(ledgerPathFor(flags, config), { logger });
        const entry = await ledger.append({ surface: captured.surface, toolVersion: VERSION });

        io.stderr(`Recorded as ledger entry ${String(entry.sequence)}.\n`);
        return await emit(captureReport(captured.surface, entry.surfaceRoot), flags, io);
      }

      case 'conform': {
        const report = grade(captured);
        // Not graded fails too. The question conform answers is whether this
        // server implements the graded revision, and for a server on another
        // revision the answer is no, which a CI job must not read as a pass.
        const failed = report.grade.status === 'not-graded' || report.grade.mustFailed > 0;
        return await emit(conformReport(server, report), flags, io, failed);
      }

      case 'trust': {
        const pin = createPin(captured.surface, { approvedBy: whoami(io) });
        const path = pinPathFor(server.id);

        await savePin(path, pin);
        io.stderr(`Pinned ${server.name} at ${pin.surfaceRoot}.\nWrote ${path}\n`);

        return EXIT_CODES.success;
      }

      case 'diff': {
        const path = pinPathFor(server.id);

        let pin;
        try {
          pin = await loadPin(path);
        } catch {
          io.stderr(
            `${server.name} has never been approved, so there is nothing to compare against.\n` +
              `Review what it advertises, then run: mcpsteward trust ${server.name}\n`,
          );
          return EXIT_CODES.usageError;
        }

        const drift = diffAgainstPin(captured.surface, pin, {
          otherSurfaces: [],
        });

        return await emit(driftReport(server, drift), flags, io, drift.events.length > 0);
      }

      /* c8 ignore next 2 -- unreachable: dispatch only routes these four */
      default:
        return EXIT_CODES.internalError;
    }
  } finally {
    await client.dispose();
  }
}

function captureReport(surface: Parameters<typeof createPin>[0], root: string): Report {
  return buildReport({
    kind: 'inventory',
    title: 'Surface capture',
    subject: surface.server.name,
    toolVersion: VERSION,
    summary: [
      { label: 'Revision used', value: surface.revisionUsed },
      { label: 'Descriptors', value: String(surface.descriptors.length) },
      { label: 'Surface root', value: root },
      { label: 'Duration', value: `${String(surface.durationMs)}ms` },
    ],
    sections: [
      {
        title: 'Advertised surface',
        emptyMessage: 'This server advertises nothing.',
        items: surface.descriptors.map((descriptor) => ({
          id: descriptor.hash.slice(7, 15),
          title: descriptor.identity,
          severity: 'info' as const,
          detail: `${descriptor.category}, content hash ${descriptor.hash}`,
        })),
      },
    ],
    notes:
      surface.revisionUsed === surface.revisionRequested
        ? []
        : [
            `Requested ${surface.revisionRequested} but the server only supports ` +
              `${surface.revisionUsed}. This capture reflects the older revision.`,
          ],
    redaction: {},
  });
}

function conformReport(server: ServerRef, report: ReturnType<typeof grade>): Report {
  return buildReport({
    kind: 'conformance',
    title: `Conformance against ${TARGET_REVISION}`,
    subject: server.name,
    toolVersion: VERSION,
    summary: [
      report.grade.letter === null
        ? { label: 'Grade', value: 'Not graded', severity: 'high' as const }
        : {
            label: 'Grade',
            value: report.grade.letter,
            ...(report.grade.mustFailed > 0 ? { severity: 'high' as const } : {}),
          },
      {
        label: 'Score',
        value: report.grade.score === null ? 'none' : `${String(report.grade.score)} / 100`,
      },
      { label: 'Revision spoken', value: report.revision },
      {
        label: 'MUST failed',
        value: String(report.grade.mustFailed),
        ...(report.grade.mustFailed > 0 ? { severity: 'critical' as const } : {}),
      },
      { label: 'SHOULD failed', value: String(report.grade.shouldFailed) },
      { label: 'Not applicable', value: String(report.grade.notApplicable) },
    ],
    sections: [
      {
        title: 'Findings',
        emptyMessage:
          report.grade.status === 'not-graded'
            ? 'No findings, because no rule was graded. See the note below.'
            : 'This server satisfies every rule that applies to it.',
        items: report.findings.map((finding) => ({
          id: finding.ruleId,
          title: finding.title,
          severity: finding.severity,
          detail: finding.detail,
          remediation: finding.remediation,
          citation: finding.citation.sep ?? finding.citation.section,
          ...(finding.locus === undefined ? {} : { locus: finding.locus }),
        })),
      },
    ],
    notes: [
      ...(report.grade.reason === undefined ? [] : [report.grade.reason]),
      ...(report.unverified.length === 0
        ? []
        : [
            `${String(report.unverified.length)} rule(s) reported but were excluded from the ` +
              'score because they are not yet grounded in fetched specification text.',
          ]),
    ],
    redaction: {},
  });
}

function driftReport(server: ServerRef, drift: ReturnType<typeof diffAgainstPin>): Report {
  const severityOf = (risk: string): Severity =>
    risk === 'critical' ? 'critical' : risk === 'high' ? 'high' : risk === 'medium' ? 'medium' : 'low';

  return buildReport({
    kind: 'drift',
    title: 'Drift against the approved surface',
    subject: server.name,
    toolVersion: VERSION,
    summary: [
      { label: 'Approved', value: drift.pinnedAt },
      { label: 'Compared', value: drift.comparedAt },
      {
        label: 'Changes',
        value: String(drift.events.length),
        ...(drift.events.length > 0 ? { severity: 'high' as const } : {}),
      },
      { label: 'Unchanged', value: String(drift.unchanged) },
    ],
    sections: [
      {
        title: 'Changes since approval',
        emptyMessage: 'Nothing has changed since this server was approved.',
        items: drift.events.map((event) => ({
          id: event.kind,
          title: `${event.category} ${event.identity}`,
          severity: severityOf(event.risk),
          detail: event.summary,
          remediation:
            'If this change is expected, re-approve with: mcpsteward trust ' + server.name,
          evidence: { risk: event.risk, factors: event.riskFactors.join('; ') },
        })),
      },
    ],
    notes: [
      'Risk scoring is a heuristic that orders attention. It is not a security guarantee.',
    ],
    redaction: {},
  });
}

async function verifyCommand(
  flags: GlobalFlags,
  config: McpStewardConfig,
  io: CliIo,
  logger: Logger,
): Promise<number> {
  const path = policyPathFor(flags, config);

  let policy;
  try {
    policy = await loadPolicy(path);
  } catch {
    io.stderr(
      `No policy at ${path}.\nGenerate a starting policy with: mcpsteward policy init\n`,
    );
    return EXIT_CODES.usageError;
  }

  const inventory = await discover({ logger, projectDirectories: [io.cwd ?? process.cwd()] });
  const result = checkPolicy(policy, { inventory });

  const report = buildReport({
    kind: 'policy',
    title: 'Policy gate',
    subject: path,
    toolVersion: VERSION,
    summary: [
      {
        label: 'Result',
        value: result.passed ? 'pass' : 'fail',
        ...(result.passed ? {} : { severity: 'critical' as const }),
      },
      { label: 'Servers evaluated', value: String(result.serversEvaluated) },
      { label: 'Violations', value: String(result.violations.length) },
    ],
    sections: [
      {
        title: 'Violations',
        emptyMessage: 'Every configured server satisfies the policy.',
        items: result.violations.map((violation) => ({
          id: violation.kind,
          title: violation.kind,
          severity: violation.severity,
          detail: violation.detail,
          locus: violation.serverId,
        })),
      },
    ],
    notes: result.notEvaluated,
    redaction: {},
  });

  await write(render(report, flags.format, { colour: flags.colour }), flags, io);
  return exitCodeFor(result);
}

async function ledgerCommand(
  subcommand: string | undefined,
  flags: GlobalFlags,
  config: McpStewardConfig,
  io: CliIo,
): Promise<number> {
  const ledger = new Ledger(ledgerPathFor(flags, config));

  switch (subcommand) {
    case 'verify': {
      // Not a pass: a ledger somebody expected to be here and is not is exactly
      // what verification exists to notice. But it is said plainly, rather than
      // as a failed verification quoting a file system error.
      if (!(await ledger.exists())) {
        io.stderr(
          `No ledger at ${ledgerPathFor(flags, config)}.\n` +
            'Nothing has been captured on this machine yet, or the file has been removed.\n' +
            'Record a first entry with: mcpsteward capture <server>\n',
        );
        return EXIT_CODES.policyFailure;
      }

      const result = await ledger.verify();

      if (result.valid) {
        io.stdout(
          `Ledger is intact. ${String(result.entryCount)} entries verified.\n` +
            (result.headHash === undefined
              ? ''
              : `Head: ${result.headHash}\n` +
                'Record the entry count and head somewhere other than this file. Removing the most\n' +
                'recent entries leaves a shorter chain that still verifies; only a recorded head shows it.\n'),
        );
        return EXIT_CODES.success;
      }

      io.stderr(
        `Ledger verification FAILED.\n` +
          (result.brokenAt === undefined ? '' : `Broken at sequence ${String(result.brokenAt)}.\n`) +
          `${result.reason ?? 'unknown reason'}\n`,
      );
      return EXIT_CODES.policyFailure;
    }

    case 'log':
    case 'export': {
      // A ledger that has never been written is not an error. It is the state
      // every machine starts in, and reporting it as an internal defect would
      // be alarming and wrong.
      if (!(await ledger.exists())) {
        io.stdout(
          flags.format === 'json' || subcommand === 'export'
            ? '[]\n'
            : 'No ledger yet. Run mcpsteward capture <server> to record a surface.\n',
        );
        return EXIT_CODES.success;
      }

      const entries = await ledger.readEntries();

      if (flags.format === 'json' || subcommand === 'export') {
        io.stdout(`${JSON.stringify(entries, null, 2)}\n`);
        return EXIT_CODES.success;
      }

      for (const entry of entries) {
        io.stdout(
          `${String(entry.sequence).padStart(5)}  ${entry.timestamp}  ${entry.serverId}  ${entry.surfaceRoot}\n`,
        );
      }

      if (entries.length === 0) io.stdout('The ledger is empty.\n');
      return EXIT_CODES.success;
    }

    default:
      io.stderr(COMMAND_HELP['ledger'] ?? '');
      return EXIT_CODES.usageError;
  }
}

async function policyCommand(
  subcommand: string | undefined,
  flags: GlobalFlags,
  config: McpStewardConfig,
  io: CliIo,
  logger: Logger,
): Promise<number> {
  const path = policyPathFor(flags, config);

  switch (subcommand) {
    case 'init': {
      const inventory = await discover({ logger, projectDirectories: [io.cwd ?? process.cwd()] });
      const policy = initPolicy(inventory);

      await savePolicy(path, policy);

      io.stderr(
        `Wrote ${path}\n` +
          `Allowlisted ${String(policy.allowServers?.length ?? 0)} server(s) already configured here.\n` +
          'Inline credentials fail immediately, so run mcpsteward verify to see whether any exist.\n',
      );
      return EXIT_CODES.success;
    }

    case 'check':
      return await verifyCommand(flags, config, io, logger);

    default:
      io.stderr(COMMAND_HELP['policy'] ?? '');
      return EXIT_CODES.usageError;
  }
}

async function doctorReport(
  flags: GlobalFlags,
  config: McpStewardConfig,
  cwd: string,
): Promise<Report> {
  const inventory = await discover({ projectDirectories: [cwd] });
  const ledgerPath = ledgerPathFor(flags, config);
  const ledger = new Ledger(ledgerPath);

  const ledgerStatus = (await ledger.exists())
    ? await (async (): Promise<string> => {
        const result = await ledger.verify();
        return result.valid
          ? `intact, ${String(result.entryCount)} entries`
          : `BROKEN at sequence ${String(result.brokenAt ?? -1)}`;
      })()
    : 'not created yet';

  const policyPath = policyPathFor(flags, config);
  const policyStatus = await fileExists(policyPath) ? 'present' : 'not created yet';

  const clientRows: ReportItem[] = knownClients().map((client) => {
    const found = client.paths.filter((p) => inventory.scannedPaths.includes(p));

    return {
      id: client.id,
      title: client.displayName,
      severity: 'info' as const,
      detail:
        found.length > 0
          ? `configuration found at ${found.join(', ')}`
          : `no configuration at ${client.paths.join(', ')}`,
      ...(client.confidence === 'probable'
        ? {
            remediation:
              'This path is not confirmed against documentation. If you use this client and it ' +
              'is not detected, the path may be wrong. See VERIFY.md section 1.',
          }
        : {}),
    };
  });

  return buildReport({
    kind: 'inventory',
    title: 'mcpsteward doctor',
    subject: `${platform()}, Node ${process.version}`,
    toolVersion: VERSION,
    summary: [
      { label: 'Node', value: process.version },
      { label: 'Platform', value: platform() },
      { label: 'Servers found', value: String(inventory.summary.totalServers) },
      { label: 'Ledger', value: ledgerStatus, ...(ledgerStatus.startsWith('BROKEN') ? { severity: 'critical' as const } : {}) },
      { label: 'Policy', value: policyStatus },
      { label: 'Graded revision', value: TARGET_REVISION },
      { label: 'Revisions spoken', value: [...SUPPORTED_REVISIONS].join(', ') },
    ],
    sections: [
      { title: 'Client configuration locations', emptyMessage: 'none', items: clientRows },
      {
        title: 'Paths',
        emptyMessage: 'none',
        items: [
          { id: 'ledger', title: 'Ledger', severity: 'info', detail: ledgerPath },
          { id: 'policy', title: 'Policy', severity: 'info', detail: policyPath },
        ],
      },
    ],
    notes: [
      'mcpsteward makes no network requests except to servers you explicitly ask it to inspect.',
      'discover, ledger verify and policy check never connect to anything at all.',
    ],
    redaction: {},
  });
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

function clientFor(
  server: ServerRef,
  config: McpStewardConfig,
  logger: Logger,
  io: CliIo,
): McpClient {
  // The server gets what its own configuration entry supplies, with placeholders
  // such as ${env:NAME} filled from the operator's environment, exactly as its
  // own client would start it. Nothing else from the operator's environment
  // reaches it beyond the machine layout allowlist; see launch.ts.
  const settings = launchSettingsFor(server, io.env);
  if (settings.unresolved.length > 0) {
    logger.info('configuration placeholders only the owning client can fill were left out', {
      server: server.name,
      placeholders: settings.unresolved,
    });
  }

  if (server.endpoint.transport === 'stdio') {
    const transport = new StdioTransport({
      command: server.endpoint.command,
      args: settings.args,
      env: settings.env,
      logger,
      ...(server.endpoint.cwd === undefined ? {} : { cwd: server.endpoint.cwd }),
    });

    transport.start();
    return new McpClient(transport, { timeoutMs: config.timeoutMs, logger });
  }

  return new McpClient(
    new HttpTransport({ url: server.endpoint.url, headers: settings.headers, logger }),
    { timeoutMs: config.timeoutMs, logger },
  );
}

async function resolveCliConfig(flags: GlobalFlags, io: CliIo): Promise<McpStewardConfig> {
  const path = flags.configPath ?? 'mcpsteward.config.json';

  let fileConfig = {};
  try {
    fileConfig = parseConfigFile(await readFile(path, 'utf8'), path);
  } catch (error) {
    // An explicitly named config that cannot be read is an error. A missing
    // default one is simply the common case.
    if (flags.configPath !== undefined) throw error;
  }

  return resolveConfig({
    fileConfig,
    env: io.env,
    overrides: { timeoutMs: flags.timeoutMs, logLevel: flags.logLevel },
  });
}

function defaultHome(): string {
  return join(homedir(), '.mcpsteward');
}

function ledgerPathFor(flags: GlobalFlags, config: McpStewardConfig): string {
  return flags.ledgerPath ?? config.ledgerPath ?? join(defaultHome(), 'surfaces.mcpsteward-ledger');
}

function policyPathFor(flags: GlobalFlags, config: McpStewardConfig): string {
  return flags.policyPath ?? config.policyPath ?? 'mcpsteward.policy.json';
}

/**
 * Where a pin lives.
 *
 * Always under the home directory, deliberately not configurable yet. A pin is
 * machine local approval state rather than project configuration, and putting it
 * in a repository would invite committing an approval that only one person made.
 */
function pinPathFor(serverId: string): string {
  return join(defaultHome(), 'pins', `${serverId}.pin.json`);
}

function whoami(io: CliIo): string {
  return io.env['USER'] ?? io.env['USERNAME'] ?? 'unknown';
}

function redactionFor(io: CliIo): RedactionOptions {
  // Anything the operator is holding in a secret named environment variable is
  // removed from every string this process emits, whether or not it matches a
  // vendor pattern.
  return { extraSecrets: collectEnvSecrets(io.env) };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Render and write a report, then choose an exit code. */
async function emit(
  report: Report,
  flags: GlobalFlags,
  io: CliIo,
  failed = false,
): Promise<number> {
  await write(render(report, flags.format, { colour: flags.colour }), flags, io);
  return failed ? EXIT_CODES.policyFailure : EXIT_CODES.success;
}

async function write(text: string, flags: GlobalFlags, io: CliIo): Promise<void> {
  if (flags.output === undefined) {
    io.stdout(text);
    return;
  }

  await writeFile(flags.output, text, 'utf8');
  io.stderr(`Wrote ${flags.output}\n`);
}

/* c8 ignore start -- the process entry point is exercised by subprocess tests */
if (isEntryPoint(import.meta.url)) {
  const code = await run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    isTty: process.stdout.isTTY,
  });

  process.exitCode = code;
}
/* c8 ignore stop */
