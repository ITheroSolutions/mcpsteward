/**
 * What a server's own configuration entry says to hand it when it starts.
 *
 * A server's configuration typically sets environment variables for it
 * (`DATA_DIR`, `DATABASE_URL`, an API key) and, for a remote server, request headers.
 * mcpsteward originally recorded only the *names*, and at connect time looked the
 * names up in its own environment instead. So a server whose configuration said
 * `DATA_DIR=C:\data` was started without it, exited, and could not be
 * inspected, even though the operator's own MCP client starts it fine.
 *
 * Each server now receives the values from its own configuration entry, which is
 * exactly what the operator's MCP client gives it. That is not a new disclosure:
 * the server is the intended recipient of its own configuration. What the stdio
 * transport exists to prevent is different and still holds: the operator's
 * *other* environment variables never reach a server unless its configuration
 * names them.
 *
 * The values never become part of a {@link ServerRef}. They are held in a
 * `WeakMap` keyed by the parsed endpoint object, so they cannot be serialised into
 * an inventory, a report, a ledger entry or a log line by accident, and they live
 * only as long as the inventory that parsed them. A `ServerRef` built any other
 * way, for example deserialised from JSON, simply has none, and connecting falls
 * back to the previous behaviour.
 *
 * Placeholders are filled the way the clients that write them do:
 *
 * - `${env:NAME}`, used by VS Code and Cursor.
 * - `${NAME}` and `${NAME:-default}`, used by Claude Code.
 * - `${userHome}`, used by VS Code.
 *
 * Anything else, `${input:...}` in particular, can only be filled by the client
 * that owns the configuration, usually by prompting. Such a value is left out
 * rather than passed through literally.
 */

import { TransportError } from '../core/errors.js';
import type { ServerEndpoint, ServerRef } from '../core/types.js';

export interface ConfiguredValues {
  readonly env: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
}

const configured = new WeakMap<ServerEndpoint, ConfiguredValues>();

/** Record the values a configuration entry supplies. Called by the parser only. */
export function rememberConfiguredValues(endpoint: ServerEndpoint, values: ConfiguredValues): void {
  configured.set(endpoint, values);
}

/** Everything needed to connect to a server the way its own client would. */
export interface LaunchSettings {
  /** Arguments with placeholders filled. Stdio only. */
  readonly args: readonly string[];
  /** Environment for the child. Stdio only. */
  readonly env: Record<string, string>;
  /** Request headers. HTTP only. */
  readonly headers: Record<string, string>;
  /** Placeholders that could not be filled, so the corresponding value was left out. */
  readonly unresolved: readonly string[];
}

/**
 * Work out how to start or reach `server`.
 *
 * @param lookupEnv where placeholders and unconfigured names are looked up: the
 *   operator's environment for the CLI, only the caller's explicit `env` for the
 *   library API.
 * @param explicitEnv variables the caller passes directly, which win over the
 *   configuration.
 * @throws TransportError when an argument depends on a placeholder that cannot be
 *   filled, since starting the server with the literal text would only produce a
 *   confusing failure inside it.
 */
export function launchSettingsFor(
  server: ServerRef,
  lookupEnv: Readonly<Record<string, string | undefined>>,
  explicitEnv: Readonly<Record<string, string>> = {},
): LaunchSettings {
  const values = configured.get(server.endpoint);
  const unresolved: string[] = [];

  const fill = (raw: string): string | undefined => {
    const result = resolvePlaceholders(raw, lookupEnv);
    if (result.value === undefined) unresolved.push(...result.unresolved);
    return result.value;
  };

  if (server.endpoint.transport === 'http') {
    const headers: Record<string, string> = {};
    for (const [name, raw] of Object.entries(values?.headers ?? {})) {
      const value = fill(raw);
      if (value !== undefined) headers[name] = value;
    }
    return { args: [], env: {}, headers, unresolved };
  }

  const args = server.endpoint.args.map((raw) => {
    const value = fill(raw);
    if (value === undefined) {
      throw new TransportError(
        `Cannot start ${server.name}: its configuration passes ${raw} as an argument, ` +
          'which only the client that owns this configuration can fill in.',
        { details: { server: server.name } },
      );
    }
    return value;
  });

  const env: Record<string, string> = {};
  for (const name of server.endpoint.envNames) {
    const raw = values?.env[name];
    const value = raw === undefined ? undefined : fill(raw);
    const fallback = lookup(lookupEnv, name);

    if (value !== undefined) env[name] = value;
    else if (fallback !== undefined) env[name] = fallback;
  }

  return { args, env: { ...env, ...explicitEnv }, headers: {}, unresolved };
}

/**
 * Fill the placeholders in one configured value.
 *
 * All or nothing: a value with any placeholder that cannot be filled comes back
 * `undefined`, because half a connection string is worse than none.
 */
export function resolvePlaceholders(
  raw: string,
  env: Readonly<Record<string, string | undefined>>,
): { readonly value: string | undefined; readonly unresolved: readonly string[] } {
  const unresolved: string[] = [];

  const value = raw.replace(/\$\{([^}]*)\}/g, (whole, inner: string) => {
    const fromEnv = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(inner);
    if (fromEnv !== null) {
      const found = lookup(env, fromEnv[1] ?? '');
      if (found !== undefined) return found;
      unresolved.push(whole);
      return whole;
    }

    if (inner === 'userHome') {
      const home = lookup(env, 'USERPROFILE') ?? lookup(env, 'HOME');
      if (home !== undefined) return home;
      unresolved.push(whole);
      return whole;
    }

    const shell = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/.exec(inner);
    if (shell !== null) {
      const found = lookup(env, shell[1] ?? '') ?? shell[2];
      if (found !== undefined) return found;
      unresolved.push(whole);
      return whole;
    }

    // ${input:...}, ${workspaceFolder} and anything else only the owning client
    // understands.
    unresolved.push(whole);
    return whole;
  });

  return { value: unresolved.length === 0 ? value : undefined, unresolved };
}

/** Exact match first, then case insensitive, since Windows names are. */
function lookup(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;

  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value !== undefined) return value;
  }
  return undefined;
}
