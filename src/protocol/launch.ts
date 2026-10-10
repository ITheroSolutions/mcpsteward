/**
 * Deciding exactly what to execute for a configured stdio server.
 *
 * The stdio transport never routes a server's command through a shell, because
 * the command and its arguments come from a configuration file this package did
 * not write, and a shell turns an argument containing `&` into a second command.
 * On POSIX that is the whole story.
 *
 * On Windows it is not, and getting it wrong made most real servers unreachable.
 * `npx`, `dnx` and every npm installed command are batch files (`npx.cmd`), and
 * Windows cannot execute a batch file without its command interpreter. Spawned
 * directly, `npx` fails with ENOENT, since the loader only searches for `.exe`
 * and `.com`. Every MCP server configured as `npx some-package`, which is most of
 * them, was therefore impossible to capture.
 *
 * So on Windows a batch file is run through `cmd.exe /d /s /c`, with every
 * argument escaped so the interpreter treats it as literal text. The escaping is
 * the approach used by the widely deployed cross-spawn library, reimplemented
 * here because the package carries no runtime dependencies:
 *
 * - Each argument is quoted, with backslashes and embedded quotes escaped the way
 *   the Microsoft C runtime parses them back out.
 * - Every character `cmd.exe` treats specially, the quotes included, is prefixed
 *   with `^`, so the interpreter never enters or leaves a quoted region on its own
 *   and never sees `&`, `|`, `<` or `>` as operators.
 * - For batch files the metacharacters are escaped twice. A batch file such as
 *   `npx.cmd` forwards its arguments with `%*`, and the interpreter parses that
 *   line a second time. One level of escaping survives only the first parse,
 *   after which an argument like `a"&calc&"b` would run `calc`. cross-spawn
 *   applies the second level only to shims under `node_modules/.bin`; it is
 *   applied here to every batch file, because `npx.cmd` itself forwards `%*`.
 *
 * `%` is escaped as well. The interpreter expands `%NAME%` before it processes
 * carets, but `^%NAME^%` names a variable called `NAME^`, which does not exist
 * and is left untouched, after which the carets are removed.
 *
 * Delayed expansion (`!NAME!`) is off because `/v` is never passed.
 */

import { statSync } from 'node:fs';
import { win32 } from 'node:path';

import { TransportError } from '../core/errors.js';

export interface LaunchPlan {
  /** The executable to spawn. */
  readonly file: string;
  readonly args: readonly string[];
  /** Pass the arguments to Windows exactly as built, without Node re-quoting them. */
  readonly windowsVerbatimArguments: boolean;
  /** The command resolved against PATH, when it was found. */
  readonly resolved: string | undefined;
}

export interface LaunchHost {
  readonly platform: NodeJS.Platform;
  /** The environment the command is looked up in: the operator's, not the child's. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The child's working directory, which a relative command is resolved from. */
  readonly cwd?: string;
  /** Injectable for tests. Defaults to a real filesystem check. */
  readonly isFile?: (path: string) => boolean;
}

/** Characters `cmd.exe` gives meaning to, including space and the quote itself. */
const CMD_METACHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Work out what to execute for `command` with `args` on the given host. */
export function planLaunch(
  command: string,
  args: readonly string[],
  host: LaunchHost,
): LaunchPlan {
  if (host.platform !== 'win32') {
    return { file: command, args, windowsVerbatimArguments: false, resolved: undefined };
  }

  const isFile = host.isFile ?? defaultIsFile;
  const located =
    host.cwd !== undefined && /[\\/]/.test(command) && !win32.isAbsolute(command)
      ? win32.join(host.cwd, command)
      : command;
  const resolved = resolveOnPath(located, host.env, isFile);

  if (resolved === undefined) {
    // Spawned as given, so the failure is the loader's own ENOENT, which the
    // transport reports as the command not being found.
    return { file: command, args, windowsVerbatimArguments: false, resolved };
  }

  if (!/\.(cmd|bat)$/i.test(resolved)) {
    // A real executable. Spawning it by absolute path means the lookup does not
    // depend on the child's environment, which is deliberately minimal.
    return { file: resolved, args, windowsVerbatimArguments: false, resolved };
  }

  // The resolved path is quoted rather than caret escaped. A Windows path cannot
  // contain a double quote, so quoting keeps a directory such as
  // `C:\Program Files` intact as one token. Quoting does not stop `%NAME%`
  // expansion, though, and carets are literal inside quotes, so a path containing
  // `%` could be expanded into a different file from the one just checked. Such
  // paths are vanishingly rare and are refused rather than risked.
  if (resolved.includes('%')) {
    throw new TransportError(
      `Refusing to run ${resolved} through cmd.exe: the path contains %, which the interpreter would expand.`,
      { details: { command } },
    );
  }

  const line = [`"${resolved}"`, ...args.map((arg) => escapeArgument(arg, true))].join(' ');

  return {
    file: commandInterpreter(host.env),
    // `/d` skips AutoRun commands from the registry, `/s` makes the quoting rule
    // predictable: strip exactly the outer pair of quotes and run what is inside.
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
    resolved,
  };
}

/**
 * Escape one argument for `cmd.exe`, so that the program eventually receives it
 * byte for byte.
 *
 * @param doubleEscape escape metacharacters a second time, for a batch file that
 *   re-parses its arguments.
 */
export function escapeArgument(arg: string, doubleEscape: boolean): string {
  // Backslashes are literal to the C runtime except directly before a quote,
  // where they escape it. Double any run that precedes a quote, then escape the
  // quote itself.
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');

  // A trailing run of backslashes would escape the closing quote added below.
  escaped = escaped.replace(/(\\*)$/, '$1$1');

  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_METACHARACTERS, '^$1');

  if (doubleEscape) escaped = escaped.replace(CMD_METACHARACTERS, '^$1');

  return escaped;
}

/**
 * Find `command` the way the Windows command interpreter would, minus the
 * current directory.
 *
 * The current directory is deliberately not searched. Windows does search it
 * first, which is how a planted `npx.cmd` in a project directory gets run
 * instead of the real one, and mcpsteward is often run from inside a project it
 * has no reason to trust.
 */
export function resolveOnPath(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  isFile: (path: string) => boolean = defaultIsFile,
): string | undefined {
  const extensions = (lookup(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);

  const hasKnownExtension = extensions.some((ext) =>
    command.toLowerCase().endsWith(ext.toLowerCase()),
  );

  const candidatesIn = (base: string): string[] =>
    hasKnownExtension ? [base] : extensions.map((ext) => base + ext);

  // A command with a directory component is looked up exactly where it says.
  if (/[\\/]/.test(command) || win32.isAbsolute(command)) {
    return candidatesIn(command).find((candidate) => isFile(candidate));
  }

  const directories = (lookup(env, 'PATH') ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir.length > 0);

  for (const directory of directories) {
    const found = candidatesIn(win32.join(directory, command)).find((candidate) =>
      isFile(candidate),
    );
    if (found !== undefined) return found;
  }

  return undefined;
}

/** Windows environment variable names are case insensitive; a plain object is not. */
function lookup(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value !== undefined) return value;
  }
  return undefined;
}

function commandInterpreter(env: Readonly<Record<string, string | undefined>>): string {
  const comspec = lookup(env, 'ComSpec');
  if (comspec !== undefined && comspec.length > 0) return comspec;

  return win32.join(lookup(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'cmd.exe');
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Environment variables every child inherits, by name, from the operator.
 *
 * Starting a server with an empty environment is not neutral. Without `PATH` it
 * cannot find its own interpreter or subprocesses, and on Windows without
 * `SYSTEMROOT`, `APPDATA` or `USERPROFILE` a Node or Python server cannot find its
 * cache, its settings, or parts of the operating system. This is the allowlist
 * the reference MCP SDK inherits by default, plus a few that describe the same
 * machine layout. Every one of them says where things are on this machine and
 * none of them carries a credential, which is the line the stdio transport
 * exists to hold: the operator's `GITHUB_TOKEN` or `AWS_SECRET_ACCESS_KEY` still
 * never reaches a server unless its configuration names it.
 */
export const INHERITED_ENV_WIN32 = [
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMFILES',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
] as const;

export const INHERITED_ENV_POSIX = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER'] as const;

/**
 * The environment a child starts with: the inherited allowlist from `parent`,
 * overlaid with the variables the caller named explicitly.
 */
export function childEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  named: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const allow = new Set<string>(platform === 'win32' ? INHERITED_ENV_WIN32 : INHERITED_ENV_POSIX);
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    // Windows names are case insensitive; POSIX names are not.
    if (!allow.has(platform === 'win32' ? key.toUpperCase() : key)) continue;
    // An exported shell function, which the reference SDK also skips.
    if (value.startsWith('()')) continue;
    env[key] = value;
  }

  return { ...env, ...named };
}
