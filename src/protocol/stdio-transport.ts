/**
 * stdio transport.
 *
 * Spawns a server as a child process and exchanges newline delimited JSON-RPC
 * over its standard streams (MS-STDIO-001).
 *
 * Three things here are easy to get wrong and are handled deliberately.
 *
 * **stderr is not an error channel.** The specification is explicit that a server
 * MAY write anything to stderr and that a client SHOULD NOT treat output there as
 * indicating a problem (MS-STDIO-003). It is captured separately, bounded, and
 * never merged into the message stream.
 *
 * **Shutdown is a sequence, not a kill.** Close stdin, wait for exit, force
 * terminate only if the server does not go (MS-STDIO-007). Servers are told to
 * exit when stdin closes, and honouring that is what keeps the common case clean.
 *
 * **On Windows, killing a process does not kill its descendants.** An MCP server
 * launched through `npx` or `cmd` is a shell that spawns the real server, so
 * killing the shell leaves the server running and holding its port or its file
 * locks. The whole tree is terminated explicitly.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { platform } from 'node:process';

import { CancellationError, TimeoutError, TransportError } from '../core/errors.js';
import { isJsonNumber, parseJsonPreservingNumbers, type JsonValue } from '../core/json-parse.js';
import { NOOP_LOGGER, type Logger } from '../core/logger.js';
import { childEnvironment, planLaunch } from './launch.js';
import { serializeForStdio } from './messages.js';

/** How long to wait for a graceful exit before forcing termination. */
const GRACEFUL_EXIT_MS = 2_000;

/** Cap on retained stderr, so a chatty server cannot exhaust memory. */
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Cap on a single line from the server.
 *
 * Without this, a server that never emits a newline makes the reader buffer grow
 * without bound. The specification's own denial of service reasoning for schema
 * depth applies equally to the framing layer.
 */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

export interface StdioTransportOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly logger?: Logger;
  readonly maxLineBytes?: number;
  /**
   * Whether the child also inherits the non secret variables that describe this
   * machine's layout, such as `PATH` and `SYSTEMROOT`. See `childEnvironment`.
   * Default true. Credentials are never inherited either way.
   */
  readonly inheritBaseEnvironment?: boolean;
}

interface PendingRequest {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export class StdioTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = '';
  private stderrChunks: string[] = [];
  private stderrBytes = 0;
  private disposed = false;
  private exited = false;
  private exitReason: string | undefined;
  private readonly logger: Logger;
  private readonly maxLineBytes: number;

  constructor(private readonly options: StdioTransportOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  }

  /** Everything the server wrote to stderr, capped. Never treated as an error. */
  get stderr(): string {
    return this.stderrChunks.join('');
  }

  get isRunning(): boolean {
    return this.child !== undefined && !this.exited;
  }

  start(): void {
    if (this.disposed) {
      throw new TransportError('Transport has been disposed');
    }
    if (this.child !== undefined) {
      throw new TransportError('Transport already started');
    }

    // Inheriting the parent environment wholesale would leak every credential
    // this process holds into an untrusted child. The child gets what the caller
    // named, plus an allowlist of variables that say where things are on this
    // machine and carry no secrets.
    const env =
      this.options.inheritBaseEnvironment === false
        ? { ...this.options.env }
        : childEnvironment(process.env, this.options.env ?? {}, platform);

    // Never route through a shell. The command and its arguments come from a
    // configuration file this package did not write. On Windows a batch file
    // such as npx.cmd can only run under cmd.exe, and planLaunch builds that
    // invocation with every argument escaped; see launch.ts.
    const plan = planLaunch(this.options.command, this.options.args ?? [], {
      platform,
      env: process.env,
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(plan.file, [...plan.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      });
    } catch (cause) {
      throw new TransportError(`Failed to spawn ${this.options.command}`, {
        details: { command: this.options.command },
        cause,
      });
    }
    this.child = child;

    // Every handler checks that it still belongs to the current child. After a
    // restart, the previous process can still deliver buffered output or a late
    // event, and letting that into the new session would corrupt it.
    const current = (): boolean => this.child === child;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      if (current()) this.onStdout(chunk);
    });

    child.stderr.on('data', (chunk: string) => {
      if (current()) this.onStderr(chunk);
    });

    // A write to a server that has already died raises EPIPE on stdin. Without a
    // listener that is an uncaught exception that takes the whole CLI down; the
    // exit handler below is what reports the death.
    child.stdin.on('error', (error) => {
      this.logger.debug('server stdin closed', { message: error.message });
    });

    child.on('error', (error) => {
      if (!current()) return;

      // No pid means the process never started. That is final: mark it exited so
      // every request fails at once with the reason, rather than each one being
      // written to a process that does not exist and timing out long after.
      if (child.pid === undefined) {
        const code = (error as NodeJS.ErrnoException).code;
        this.exited = true;
        this.exitReason =
          code === 'ENOENT'
            ? `could not be started: the command ${JSON.stringify(this.options.command)} was not found`
            : `could not be started: ${error.message}`;

        this.failAll(
          new TransportError(`Server ${this.exitReason}`, {
            cause: error,
            details: { command: this.options.command, code },
          }),
        );
        return;
      }

      this.failAll(new TransportError(`Child process error: ${error.message}`, { cause: error }));
    });

    child.on('exit', (code, signal) => {
      if (!current()) return;

      this.exited = true;
      this.exitReason =
        signal === null ? `exited with code ${String(code)}` : `killed by signal ${signal}`;

      this.logger.debug('server process exited', { code, signal });

      // A server that dies mid capture must not leave a caller awaiting forever.
      this.failAll(
        new TransportError(
          `Server process ${this.exitReason} while requests were in flight${this.stderrTail()}`,
          { details: { code, signal, stderr: this.stderr.slice(-2000) } },
        ),
      );
    });
  }

  /**
   * Start the server again after it has exited.
   *
   * Some handshake era servers crash outright when sent a method they do not
   * recognise, and the era probe's `server/discover` is exactly that. The
   * client restarts the server and proceeds straight to the legacy handshake,
   * since crashing on the probe is itself proof the server is not modern. Only
   * valid once the previous process has exited.
   */
  restart(): void {
    if (this.disposed) throw new TransportError('Transport has been disposed');
    if (this.child !== undefined && !this.exited) {
      throw new TransportError('Cannot restart a server that is still running');
    }

    this.child = undefined;
    this.exited = false;
    this.exitReason = undefined;
    this.buffer = '';
    // A later crash should report its own output, not the previous one's.
    this.stderrChunks = [];
    this.stderrBytes = 0;

    this.start();
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;

    for (;;) {
      const newline = this.buffer.indexOf('\n');

      if (newline === -1) {
        if (this.buffer.length > this.maxLineBytes) {
          this.failAll(
            new TransportError(
              `Server sent more than ${String(this.maxLineBytes)} bytes without a newline`,
            ),
          );
          this.buffer = '';
        }
        return;
      }

      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);

      if (line.length > 0) this.onMessage(line);
    }
  }

  private onMessage(line: string): void {
    let message: JsonValue;

    try {
      message = parseJsonPreservingNumbers(line);
    } catch (cause) {
      // A server that writes non JSON to stdout has violated MS-STDIO-002. That
      // is a finding the conformance engine reports, not a reason to tear down
      // the transport, so the line is dropped and recorded.
      this.logger.warn('server wrote a non JSON line to stdout', { length: line.length });
      void cause;
      return;
    }

    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.logger.warn('server wrote a JSON value that is not an object to stdout');
      return;
    }

    const record = message as Record<string, JsonValue>;
    const rawId = record['id'];

    if (rawId === undefined) {
      // A notification. Request scoped notifications are not needed for surface
      // capture, so they are logged and discarded rather than queued.
      this.logger.trace('notification received', { method: record['method'] });
      return;
    }

    const key = idKeyFromJson(rawId);

    if (key === undefined) {
      this.logger.warn('response carried an id that is neither a string nor a number');
      return;
    }

    const waiter = this.pending.get(key);

    if (waiter === undefined) {
      this.logger.warn('response for an unknown request id', { id: key });
      return;
    }

    this.pending.delete(key);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  private onStderr(chunk: string): void {
    // Bounded, and never interpreted. MS-STDIO-003 is explicit that stderr
    // output does not indicate an error condition.
    if (this.stderrBytes >= MAX_STDERR_BYTES) return;

    this.stderrChunks.push(chunk);
    this.stderrBytes += chunk.length;
  }

  /**
   * Send a request and await its response.
   *
   * @param timeoutMs time budget for this request alone.
   * @param signal caller cancellation, distinct from a timeout.
   */
  async request(
    message: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const child = this.child;

    if (child === undefined || this.exited) {
      throw new TransportError(
        this.exitReason === undefined
          ? 'Transport is not running'
          : `Transport is not running: server ${this.exitReason}${this.stderrTail()}`,
      );
    }

    const id = message['id'];
    if (id === undefined || (typeof id !== 'string' && typeof id !== 'number')) {
      throw new TransportError('A request must carry a string or number id');
    }

    const key = idKey(id);

    return new Promise<JsonValue>((resolve, reject) => {
      const settle = (fn: () => void): void => {
        this.pending.delete(key);
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        fn();
      };

      const onAbort = (): void => {
        settle(() => {
          reject(new CancellationError('Request cancelled by the caller'));
        });
      };

      if (signal?.aborted === true) {
        reject(new CancellationError('Request cancelled before it was sent'));
        return;
      }

      const timer = setTimeout(() => {
        settle(() => {
          reject(
            new TimeoutError(`Request timed out after ${String(timeoutMs)}ms`, {
              details: { timeoutMs, method: message['method'] },
            }),
          );
        });
      }, timeoutMs);

      // Deliberately not unref'd. This timer's only job is to settle a promise a
      // caller is awaiting, so it has to be able to hold the event loop open. If
      // it cannot, and it is the last thing scheduled, which is exactly what
      // happens when the server process has already died, Node drains the loop
      // and exits mid await instead of timing out. Every settle path clears it,
      // so it holds the loop only while a request is genuinely outstanding.

      this.pending.set(key, {
        resolve: (value) => {
          settle(() => {
            clearTimeout(timer);
            resolve(value);
          });
        },
        reject: (error) => {
          settle(() => {
            clearTimeout(timer);
            reject(error);
          });
        },
        timer,
      });

      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

      try {
        child.stdin.write(serializeForStdio(message));
      } catch (cause) {
        settle(() => {
          clearTimeout(timer);
          reject(new TransportError('Failed to write to the server stdin', { cause }));
        });
      }
    });
  }

  /**
   * Send a notification: a message with no id, which gets no response.
   *
   * `request` refuses a message without an id, correctly, since it would wait
   * for a reply that never comes. Notifications need their own path.
   */
  notify(message: Record<string, unknown>): Promise<void> {
    const child = this.child;

    if (child === undefined || this.exited) {
      return Promise.reject(
        new TransportError(
          this.exitReason === undefined
            ? 'Transport is not running'
            : `Transport is not running: server ${this.exitReason}${this.stderrTail()}`,
        ),
      );
    }

    try {
      child.stdin.write(serializeForStdio(message));
    } catch (cause) {
      return Promise.reject(new TransportError('Failed to write to the server stdin', { cause }));
    }

    return Promise.resolve();
  }

  /**
   * The last few lines the server wrote to stderr, as a sentence to append to a
   * report that it died.
   *
   * A server that exits on start almost always says why on stderr, as in
   * "DATA_DIR is not set", and "exited with code 1" alone sends the reader
   * off to reproduce the failure by hand. Everything here passes through the
   * error constructor, which redacts, so a server that prints its own
   * connection string does not leak it into the report.
   */
  private stderrTail(): string {
    const lines = this.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) return '';

    const tail = lines.slice(-3).join(' / ');
    return `. Its last output was: ${tail.length > 400 ? `...${tail.slice(-400)}` : tail}`;
  }

  private failAll(error: Error): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();

    for (const waiter of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  /**
   * Shut down, leaving no orphaned processes.
   *
   * Idempotent: calling it twice is not an error, which matters because a
   * `finally` block and an explicit close frequently both run.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const child = this.child;
    if (child === undefined) return;

    this.failAll(new TransportError('Transport disposed while requests were in flight'));

    if (this.exited) return;

    // Step one: close stdin. Servers SHOULD exit on end of file, and this is the
    // only portable graceful signal (MS-STDIO-007).
    try {
      child.stdin.end();
    } catch {
      // Already closed. Nothing to do.
    }

    const exitedGracefully = await this.waitForExit(GRACEFUL_EXIT_MS);
    if (exitedGracefully) return;

    this.logger.debug('server did not exit on stdin close, terminating');
    this.killTree(child);

    await this.waitForExit(GRACEFUL_EXIT_MS);
  }

  private waitForExit(ms: number): Promise<boolean> {
    const child = this.child;
    /* c8 ignore next */
    if (child === undefined) return Promise.resolve(true);
    if (this.exited) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      // Not unref'd, for the same reason as the request timeout above: it
      // resolves a promise `dispose` is awaiting. The child's exit handler
      // clears it, so it cannot outlive the wait it bounds.
      const timer = setTimeout(() => {
        resolve(false);
      }, ms);

      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Terminate the child and every descendant.
   *
   * On Windows this is not optional. An MCP server is commonly launched through
   * `npx` or `cmd`, which spawns the real server as a grandchild. Killing only
   * the direct child leaves that grandchild running, holding its port and its
   * file handles, and the next capture then fails for reasons that look nothing
   * like the actual cause. `taskkill /T` walks the tree.
   */
  private killTree(child: ChildProcessWithoutNullStreams): void {
    const pid = child.pid;

    if (pid === undefined) {
      child.kill('SIGKILL');
      return;
    }

    if (platform === 'win32') {
      try {
        // Synchronous and fire and forget: dispose must not hang on this, and a
        // failure here is already the exceptional path.
        const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
        });
        killer.on('error', () => {
          child.kill('SIGKILL');
        });
      } catch {
        child.kill('SIGKILL');
      }
      return;
    }

    // POSIX: escalate. SIGTERM lets a well behaved server clean up; SIGKILL is
    // the backstop for one that ignores it.
    child.kill('SIGTERM');

    const escalation = setTimeout(() => {
      if (!this.exited) child.kill('SIGKILL');
    }, GRACEFUL_EXIT_MS);

    escalation.unref();
  }
}

function idKey(id: string | number): string {
  return typeof id === 'number' ? `n:${String(id)}` : `s:${id}`;
}

/**
 * Derive the correlation key from an id that came back off the wire.
 *
 * This cannot reuse {@link idKey} directly. Responses are parsed with
 * `parseJsonPreservingNumbers`, so a numeric id arrives as a `JsonNumber` carrying
 * its source token rather than as a JavaScript number. Passing that object to
 * `idKey` yields `s:[object Object]`, which matches nothing, and every request
 * silently times out despite the server answering correctly.
 *
 * The token is normalised through `Number` so that a server echoing `1.0` for a
 * request sent as `1` still correlates. Request ids are small integers, so there
 * is no precision concern here, unlike in the canonicalization path.
 */
function idKeyFromJson(id: JsonValue): string | undefined {
  if (typeof id === 'string') return `s:${id}`;

  if (isJsonNumber(id)) {
    const numeric = Number(id.token);
    return Number.isFinite(numeric) ? `n:${String(numeric)}` : undefined;
  }

  return undefined;
}
