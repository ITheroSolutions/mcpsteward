/** Help text and the version string. */

export const VERSION = '0.1.1';

export const HELP = `mcpsteward ${VERSION}
Local-first MCP server inspection and trust toolkit.

USAGE
  mcpsteward <command> [target] [options]

COMMANDS
  discover              Inventory every MCP server configured on this machine
                        and in the current project (.mcp.json, .vscode/mcp.json,
                        .cursor/mcp.json). Entirely offline. Connects to nothing.

  capture <server>      Connect to a server and record what it advertises.

  conform <server>      Grade a server against the 2026-07-28 specification.

  migrate <path>        Analyse a server source tree for patterns that break
                        under 2026-07-28. With --fix, apply the codemods that
                        are safely mechanical and print a diff of the rest.

  trust <server>        Approve a server's current surface as the baseline.

  diff <server>         Compare a server's current surface against its pin.

  verify                Run the policy gate. Exits nonzero on violation.
                        Suitable for CI and pre-commit.

  ledger log            Show ledger entries.
  ledger verify         Prove the ledger chain is unbroken.
  ledger export         Write the ledger in the chosen format.

  policy init           Generate a starting policy from this machine's state.
  policy check          Evaluate the policy without the full verify pipeline.

  doctor                Report environment, detected configs, ledger and policy
                        status, and supported protocol revisions.

OPTIONS
  --format <name>       terminal, json, ndjson, markdown, sarif, html.
                        Default: terminal.
  --output <path>       Write the report to a file instead of stdout.
  --config <path>       Configuration file. Default: mcpsteward.config.json.
  --ledger <path>       Ledger file. Default: ~/.mcpsteward/surfaces.mcpsteward-ledger.
  --policy <path>       Policy file. Default: mcpsteward.policy.json.
  --log-level <level>   silent, error, warn, info, debug, trace. Default: silent.
                        Diagnostics go to stderr, never stdout.
  --timeout <ms>        Per operation time budget. Default: 30000.
  --colour, --no-colour Force colour on or off. Defaults to on only when stdout
                        is a terminal.
  --fix                 With migrate, apply safe codemods. Prints a diff and
                        writes nothing unless --yes is also passed.
  --yes, -y             Confirm a write. Required by migrate --fix.
  --help, -h            Show this help.
  --version, -v         Show the version.

EXIT CODES
  0   Success.
  1   A policy or conformance check failed. The tool worked; the machine did not.
  2   The command was used incorrectly.
  3   A defect in mcpsteward. Please report it.

PROMISES
  No cloud, no account, no telemetry. No LLM calls anywhere in the core. The only
  network access is connecting to the servers you explicitly ask it to inspect.

EXAMPLES
  mcpsteward discover
  mcpsteward conform my-server --format json
  mcpsteward migrate ./src --format sarif --output results.sarif
  mcpsteward verify --policy mcpsteward.policy.json
`;

export const COMMAND_HELP: Readonly<Record<string, string>> = {
  ledger: `mcpsteward ledger <subcommand>

  log       Show ledger entries, newest last.
  verify    Walk the hash chain and prove it unbroken. Reports the exact
            sequence number where integrity fails.
  export    Write the ledger in the chosen --format.
`,
  policy: `mcpsteward policy <subcommand>

  init      Generate a starting policy from this machine's current state. The
            generated policy passes today and catches anything new, except that
            inline credentials fail immediately.
  check     Evaluate the policy against the current inventory.
`,
};
