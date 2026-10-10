/**
 * Deciding whether a module is the program being run, or was merely imported.
 *
 * The command line and the MCP server each start themselves when run directly.
 * They used to decide that by checking whether the invoked path contained the
 * text `cli` or `mcp`. Every path into this package contains `mcp`, because the
 * package is called mcpsteward, so importing `mcpsteward/mcp` from any script
 * started a server on that script's standard input. The check is now exact: the
 * invoked file must be this module's own file.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isEntryPoint(moduleUrl: string): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined || process.env['VITEST'] !== undefined) return false;

  try {
    // Resolved on both sides, because a package manager's bin entry is a
    // symbolic link on POSIX, and Windows paths differ in case.
    const a = realpathSync(invoked);
    const b = realpathSync(fileURLToPath(moduleUrl));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}
