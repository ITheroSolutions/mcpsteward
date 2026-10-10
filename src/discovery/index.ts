/**
 * The shadow MCP inventory.
 *
 * Answers the question an operations person actually has: how many MCP servers
 * are configured on this machine, which clients load them, which are remote,
 * which carry inline credentials, and which are unknown to policy.
 *
 * Entirely passive. Nothing here connects to anything, so an inventory is safe to
 * run on a machine you do not fully trust and cannot itself wake a server up.
 */

import { readFile } from 'node:fs/promises';

import { toMcpStewardError } from '../core/errors.js';
import { NOOP_LOGGER, type Logger } from '../core/logger.js';
import type { AuthPosture, ServerRef } from '../core/types.js';
import { knownClients, projectConfigCandidates, type ClientDefinition } from './clients.js';
import { deduplicate, parseClientConfig, type ParsedRegistration } from './parse.js';

export * from './clients.js';
export * from './parse.js';

export interface DiscoveryOptions {
  readonly logger?: Logger;
  /** Override the client list. Used by tests against a fixture filesystem. */
  readonly clients?: readonly ClientDefinition[];
  /** Additional directories to scan for project local configuration. */
  readonly projectDirectories?: readonly string[];
  /** Server ids the policy allows. Used only to mark inventory entries. */
  readonly policyAllowlist?: readonly string[];
}

/** A configuration file that exists but could not be used. */
export interface DiscoveryProblem {
  readonly configPath: string;
  readonly client: string;
  readonly reason: string;
}

export interface Inventory {
  readonly servers: readonly ServerRef[];
  /** Files that were read successfully. */
  readonly scannedPaths: readonly string[];
  /** Files that exist but are malformed. */
  readonly problems: readonly DiscoveryProblem[];
  /** Paths checked that did not exist. Useful for explaining an empty inventory. */
  readonly absentPaths: readonly string[];
  readonly summary: InventorySummary;
}

export interface InventorySummary {
  readonly totalServers: number;
  readonly byTransport: Readonly<Record<'stdio' | 'http', number>>;
  readonly byAuthPosture: Readonly<Partial<Record<AuthPosture, number>>>;
  readonly withInlineCredentials: number;
  readonly remote: number;
  readonly local: number;
  /** Servers registered in more than one client. */
  readonly multiplyRegistered: number;
  /** Servers absent from the policy allowlist, when one was supplied. */
  readonly unknownToPolicy: number;
  readonly clientsFound: readonly string[];
}

/**
 * Scan a machine for configured MCP servers.
 *
 * A file that does not exist is not a problem; a file that exists and is
 * unparseable is. The distinction matters because "you have no MCP servers" and
 * "your Cursor config is corrupt so I could not tell" are very different answers
 * and an inventory that conflated them would be actively misleading.
 */
export async function discover(options: DiscoveryOptions = {}): Promise<Inventory> {
  const logger = options.logger ?? NOOP_LOGGER;
  const clients = options.clients ?? knownClients();

  const candidates: ClientDefinition[] = [...clients];
  for (const directory of options.projectDirectories ?? []) {
    candidates.push(...projectConfigCandidates(directory));
  }

  const registrations: ParsedRegistration[] = [];
  const scannedPaths: string[] = [];
  const absentPaths: string[] = [];
  const problems: DiscoveryProblem[] = [];
  const clientsFound = new Set<string>();

  for (const client of candidates) {
    for (const configPath of client.paths) {
      let text: string;

      try {
        text = await readFile(configPath, 'utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (code === 'ENOENT' || code === 'ENOTDIR') {
          absentPaths.push(configPath);
          continue;
        }

        // A permission error is worth reporting rather than hiding: it means
        // there may be servers here that the inventory cannot see.
        problems.push({
          configPath,
          client: client.id,
          reason:
            code === 'EACCES' || code === 'EPERM'
              ? 'permission denied'
              : toMcpStewardError(error, 'reading configuration').message,
        });
        continue;
      }

      scannedPaths.push(configPath);

      try {
        const parsed = parseClientConfig(text, client, configPath);
        if (parsed.length > 0) clientsFound.add(client.id);
        registrations.push(...parsed);
      } catch (error) {
        // One malformed file must not abort the whole inventory. The rest of the
        // machine is still worth reporting, and the problem is recorded so the
        // result is never silently partial.
        const wrapped = toMcpStewardError(error, 'parsing configuration');
        logger.warn('could not parse a client configuration', { configPath });
        problems.push({ configPath, client: client.id, reason: wrapped.message });
      }
    }
  }

  const servers = deduplicate(registrations);
  const allowlist = new Set(options.policyAllowlist ?? []);

  return {
    servers,
    scannedPaths,
    problems,
    absentPaths,
    summary: summarise(servers, [...clientsFound], options.policyAllowlist === undefined ? undefined : allowlist),
  };
}

function summarise(
  servers: readonly ServerRef[],
  clientsFound: readonly string[],
  allowlist: ReadonlySet<string> | undefined,
): InventorySummary {
  const byTransport = { stdio: 0, http: 0 };
  const byAuthPosture: Partial<Record<AuthPosture, number>> = {};

  let withInlineCredentials = 0;
  let multiplyRegistered = 0;
  let unknownToPolicy = 0;

  for (const server of servers) {
    byTransport[server.endpoint.transport] += 1;
    byAuthPosture[server.authPosture] = (byAuthPosture[server.authPosture] ?? 0) + 1;

    if (server.registrations.some((r) => r.hasInlineCredential)) withInlineCredentials += 1;
    if (server.registrations.length > 1) multiplyRegistered += 1;

    if (allowlist !== undefined && !allowlist.has(server.id) && !allowlist.has(server.name)) {
      unknownToPolicy += 1;
    }
  }

  return {
    totalServers: servers.length,
    byTransport,
    byAuthPosture,
    withInlineCredentials,
    // "Remote" is the operationally meaningful distinction: a stdio server runs
    // code on this machine, an HTTP server sends data off it. Both are risks,
    // but they are different risks and an operator triages them differently.
    remote: byTransport.http,
    local: byTransport.stdio,
    multiplyRegistered,
    unknownToPolicy,
    clientsFound: [...clientsFound].sort(),
  };
}
