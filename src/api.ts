/**
 * The programmatic API.
 *
 * Designed from the outside in, as though written by the third party developer who
 * has to use it rather than by the person who wrote the internals. The faculties
 * are all individually importable, but almost nobody wants to assemble a
 * transport, a client, a capture and a grader by hand just to answer "is this
 * server still what I approved".
 *
 * ## Cancellation and progress
 *
 * Every operation that can take longer than an instant accepts an `AbortSignal`
 * and an optional progress callback. Cancellation is distinguished from a timeout
 * throughout: a `CancellationError` means the caller changed their mind, a
 * `TimeoutError` means this package gave up. A host embedding this is going to
 * report those differently.
 *
 * ## Resource safety
 *
 * `dispose` is idempotent and using a session after disposal throws a typed error
 * rather than hanging or silently doing nothing. Child processes are killed as a
 * tree, so nothing is left running.
 */

import { grade, type ConformanceReport } from './conformance/index.js';
import {
  ConfigurationError,
  ServerChangedError,
  ToolNotApprovedError,
  TransportError,
} from './core/errors.js';
import { NOOP_LOGGER, type Logger } from './core/logger.js';
import type {
  DriftReport,
  LedgerEntry,
  ServerRef,
  ServerSurface,
  TrustPin,
} from './core/types.js';
import { environmentNamesFor, launchSettingsFor } from './discovery/configured.js';
import { discover, type DiscoveryOptions, type Inventory } from './discovery/index.js';
import { Ledger } from './ledger/index.js';
import { analyzeMigration, type AnalyzeOptions, type MigrationReport } from './migration/index.js';
import { checkPolicy, type PolicyInput, type PolicyResult } from './policy/index.js';
import type { Policy } from './core/types.js';
import {
  McpClient,
  type CaptureProgress,
  type CaptureResult,
  type ToolCallOptions,
  type ToolCallResult,
} from './protocol/client.js';
import { HttpTransport } from './protocol/http-transport.js';
import { StdioTransport } from './protocol/stdio-transport.js';
import { createPin, diffAgainstPin, diffSurfaces, type DiffOptions } from './trust/index.js';

/** Options shared by every operation that talks to a server. */
export interface OperationOptions {
  /** Cancel the operation. Distinct from a timeout throughout. */
  readonly signal?: AbortSignal;
  /** Per request time budget in milliseconds. Defaults to 30000. */
  readonly timeoutMs?: number;
  readonly logger?: Logger;
  /** Called as each stage of a capture completes. */
  readonly onProgress?: (event: CaptureProgress) => void;
  /**
   * Environment variables to pass to a stdio server, on top of what the server's
   * own configuration entry supplies when the `ServerRef` came from `inventory()`.
   *
   * Configuration placeholders such as `${env:NAME}` are filled only from here.
   * The library never reads the host process's environment on the caller's
   * behalf, and never hands a server that environment wholesale, because that
   * would leak every credential the host happens to hold into a program it did
   * not write.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/** Most severe first, for ordering changes in an error. */
const RISK_ORDER: readonly string[] = ['critical', 'high', 'medium', 'low'];

/**
 * A live connection to one server.
 *
 * Hold one of these to capture repeatedly without paying to start the server each
 * time. Always `dispose` it, ideally in a `finally`.
 */
export class ServerSession {
  private disposed = false;

  private constructor(
    private readonly client: McpClient,
    readonly server: ServerRef,
  ) {}

  /** Open a session against a server reference. */
  static open(server: ServerRef, options: OperationOptions = {}): ServerSession {
    const logger = options.logger ?? NOOP_LOGGER;
    const timeoutMs = options.timeoutMs ?? 30_000;

    // What the server's own configuration supplies, when the ServerRef came from
    // inventory(). Placeholders are filled only from `options.env`: the library
    // never reads the host process environment on the caller's behalf.
    const explicit = options.env ?? {};
    const settings = launchSettingsFor(server, explicit, explicit);

    if (server.endpoint.transport === 'stdio') {
      const transport = new StdioTransport({
        command: server.endpoint.command,
        args: settings.args,
        env: settings.env,
        logger,
        ...(server.endpoint.cwd === undefined ? {} : { cwd: server.endpoint.cwd }),
      });

      transport.start();

      return new ServerSession(
        new McpClient(transport, {
          timeoutMs,
          logger,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        }),
        server,
      );
    }

    return new ServerSession(
      new McpClient(new HttpTransport({ url: server.endpoint.url, headers: settings.headers, logger }), {
        timeoutMs,
        logger,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      }),
      server,
    );
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new TransportError(
        'This session has been disposed. Open a new one rather than reusing it.',
        { details: { serverId: this.server.id } },
      );
    }
  }

  /** Capture what the server currently advertises. */
  async capture(): Promise<ServerSurface> {
    this.assertUsable();
    return (await this.client.capture(this.server, this.server.endpoint.transport)).surface;
  }

  /** Capture, retaining the evidence a conformance grade needs. */
  async captureWithEvidence(): Promise<CaptureResult> {
    this.assertUsable();
    return await this.client.capture(this.server, this.server.endpoint.transport);
  }

  /** Capture and grade in one step. */
  async conform(): Promise<{ surface: ServerSurface; report: ConformanceReport }> {
    this.assertUsable();

    const captured = await this.client.capture(this.server, this.server.endpoint.transport);
    return { surface: captured.surface, report: grade(captured) };
  }

  /**
   * Call one tool on this connection.
   *
   * Checks nothing about the server first. To call only what was approved, use
   * {@link callApproved}. Sent exactly once and never retried, because a tool can
   * change things; after a timeout, whether it ran is unknown.
   */
  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>> = {},
    options: ToolCallOptions = {},
  ): Promise<ToolCallResult> {
    this.assertUsable();
    return await this.client.callTool(name, args, options);
  }

  /**
   * Call one tool, only if the server still matches `pin`.
   *
   * The comparison and the call happen on this same connection, one straight
   * after the other, so the server that was checked is the one that answers. A
   * check on one connection followed by a call on a fresh one would let a server
   * that changes between starts pass the check and then run something else.
   *
   * Nothing is sent to the tool when the server has changed in any way, or when
   * the approval has no tool by that name.
   *
   * @throws ConfigurationError when the pin belongs to another server.
   * @throws ServerChangedError when anything differs from the pin.
   * @throws ToolNotApprovedError when the pinned surface has no such tool.
   */
  async callApproved(
    pin: TrustPin,
    name: string,
    args: Readonly<Record<string, unknown>> = {},
    options: ToolCallOptions & DiffOptions = {},
  ): Promise<ApprovedToolCall> {
    this.assertUsable();

    if (pin.serverId !== this.server.id) {
      throw new ConfigurationError('This approval belongs to a different server', {
        details: { key: 'pin', serverId: this.server.id, pinServerId: pin.serverId },
      });
    }

    const surface = await this.capture();
    const report = diffAgainstPin(surface, pin, options);

    if (report.events.length > 0) {
      const changes = [...report.events]
        .sort((a, b) => RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk))
        .map((event) => ({
          kind: event.kind,
          category: event.category,
          identity: event.identity,
          risk: event.risk,
          summary: event.summary,
        }));

      throw new ServerChangedError(
        `The server changed since it was approved (${String(changes.length)} change(s)), so the tool call was not sent`,
        { details: { serverId: this.server.id, changes } },
      );
    }

    const approved = surface.descriptors.some(
      (descriptor) => descriptor.category === 'tool' && descriptor.identity === name,
    );
    if (!approved) {
      throw new ToolNotApprovedError(`The approval has no tool named ${name}`, {
        details: { serverId: this.server.id, tool: name },
      });
    }

    const result = await this.client.callTool(name, args, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    return { result, surface, report };
  }

  /**
   * Release the server process or connection.
   *
   * Idempotent. Safe to call in a `finally` alongside an explicit call.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.client.dispose();
  }

  /** Whether this session has been disposed. */
  get isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * Run a function with a session, disposing it afterwards no matter what.
 *
 * The shape most callers want. It is very easy to write a `try` that leaks a
 * child process on the error path, and on Windows that process survives the test
 * run and breaks the next one.
 */
export async function withServer<T>(
  server: ServerRef,
  fn: (session: ServerSession) => Promise<T>,
  options: OperationOptions = {},
): Promise<T> {
  const session = ServerSession.open(server, options);

  try {
    return await fn(session);
  } finally {
    await session.dispose();
  }
}

/**
 * Inventory the MCP servers configured on this machine.
 *
 * Entirely offline. Connects to nothing, so it is safe on a machine you do not
 * fully trust and cannot itself start a server.
 */
export async function inventory(options: DiscoveryOptions = {}): Promise<Inventory> {
  return await discover(options);
}

/** Capture a server's surface, opening and closing a session around it. */
export async function captureServer(
  server: ServerRef,
  options: OperationOptions = {},
): Promise<ServerSurface> {
  return await withServer(server, async (session) => await session.capture(), options);
}

/** Capture and grade a server against the specification. */
export async function conformServer(
  server: ServerRef,
  options: OperationOptions = {},
): Promise<{ surface: ServerSurface; report: ConformanceReport }> {
  return await withServer(server, async (session) => await session.conform(), options);
}

/** Capture a server and pin what it advertises as approved. */
export async function trustServer(
  server: ServerRef,
  approvedBy: string,
  options: OperationOptions & { readonly note?: string } = {},
): Promise<TrustPin> {
  const surface = await captureServer(server, options);

  return createPin(surface, {
    approvedBy,
    ...(options.note === undefined ? {} : { note: options.note }),
  });
}

/** Capture a server and compare it against a pin. */
export async function diffServer(
  server: ServerRef,
  pin: TrustPin,
  options: OperationOptions & DiffOptions = {},
): Promise<{ surface: ServerSurface; report: DriftReport }> {
  const surface = await captureServer(server, options);
  return { surface, report: diffAgainstPin(surface, pin, options) };
}

/**
 * Start a server, confirm it still matches `pin`, call one tool, and stop it.
 *
 * The check and the call share one connection; see
 * {@link ServerSession.callApproved}. `timeoutMs` and `signal` cover the whole
 * operation's requests; `callTimeoutMs` sets a separate budget for the tool call
 * itself, which often takes longer than listing tools does.
 */
export async function callApprovedTool(
  server: ServerRef,
  pin: TrustPin,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
  options: OperationOptions & DiffOptions & { readonly callTimeoutMs?: number } = {},
): Promise<ApprovedToolCall> {
  return await withServer(
    server,
    async (session) =>
      await session.callApproved(pin, name, args, {
        ...(options.weights === undefined ? {} : { weights: options.weights }),
        ...(options.otherSurfaces === undefined ? {} : { otherSurfaces: options.otherSurfaces }),
        ...(options.callTimeoutMs === undefined ? {} : { timeoutMs: options.callTimeoutMs }),
      }),
    options,
  );
}

/** What {@link callApprovedTool} and {@link ServerSession.callApproved} return. */
export interface ApprovedToolCall {
  /** What the tool returned. */
  readonly result: ToolCallResult;
  /** What the server advertised when it was checked, just before the call. */
  readonly surface: ServerSurface;
  /** The comparison against the pin. Always free of changes when this is returned. */
  readonly report: DriftReport;
}

/** Append a captured surface to a ledger. */
export async function recordCapture(
  ledgerPath: string,
  surface: ServerSurface,
  toolVersion: string,
): Promise<LedgerEntry> {
  return await new Ledger(ledgerPath).append({ surface, toolVersion });
}

/** Verify a ledger's hash chain. */
export async function verifyLedger(
  ledgerPath: string,
): Promise<ReturnType<Ledger['verify']>> {
  return await new Ledger(ledgerPath).verify();
}

/** Evaluate a policy against a machine's state. */
export function evaluatePolicy(policy: Policy, input: PolicyInput): PolicyResult {
  return checkPolicy(policy, input);
}

/** Analyse a source tree for patterns that break under 2026-07-28. */
export async function analyzeSourceTree(
  path: string,
  options: AnalyzeOptions = {},
): Promise<MigrationReport> {
  return await analyzeMigration(path, options);
}

export { diffSurfaces, createPin, environmentNamesFor };

export type {
  CaptureProgress,
  CaptureResult,
  ConformanceReport,
  DiffOptions,
  DriftReport,
  Inventory,
  LedgerEntry,
  MigrationReport,
  Policy,
  PolicyResult,
  ServerRef,
  ServerSurface,
  ToolCallOptions,
  ToolCallResult,
  TrustPin,
};
