# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-10

### Added

- When a server only speaks a specification revision newer than this version
  understands, the error says so and prints the command to update mcpsteward.
- README section on updating.
- A logo, shown at the top of the README.

## [0.1.0] - 2026-10-10

First release.

### Added

- `mcpsteward discover`: an offline inventory of every MCP server configured on the
  machine, across Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Cline and
  Zed. A server registered in several clients is reported once, with every place it
  is registered. Credentials written inline into a configuration file, whether in
  `env`, in `headers` or in the endpoint URL's query string, are flagged with an
  eight character fingerprint. The credential itself never appears in any output.
- `mcpsteward capture`: connects to a server over stdio or HTTP and records what it
  advertises (tools, prompts, resources and resource templates), along with the
  protocol revision it actually spoke. Each server is started the way its own client
  starts it, with the environment values and headers from its configuration entry and
  `${env:NAME}` style placeholders filled, but never with the rest of your
  environment. On Windows, servers launched through `npx` and other batch files work,
  with every argument escaped against command injection. Servers on the previous
  revision are captured over stdio and over HTTP, including those that use sessions,
  and one that crashes when asked `server/discover` is restarted and captured anyway.
  A server that requires sign in is reported as exactly that, and a server that exits
  on start is reported with what it printed.
- `mcpsteward conform`: grades a server against the 2026-07-28 MCP specification
  with 17 rules, each citing the specification section or SEP that justifies it. A
  single MUST failure caps the letter grade regardless of score. A server that speaks
  a different revision is reported as not graded, and the command fails, rather than
  being scored against rules that do not apply to it.
- `mcpsteward trust` and `mcpsteward diff`: approve a server's current surface as a
  baseline, then detect later changes descriptor by descriptor, saying which part
  changed (description, input schema, or other fields) and giving each a risk tier.
  Critical is reserved for new or changed text a model will read that carries a sign
  of tool poisoning, such as hidden Unicode, an `<IMPORTANT>` instruction tag, a
  direction to keep something from the user, or a reference to a credential file.
  The pin stores hashes only, never a server's content.
- `mcpsteward ledger log`, `ledger verify` and `ledger export`: an append only, hash
  chained record of every capture. `verify` names the exact entry where integrity
  fails, and prints the entry count and head hash to record elsewhere, since a chain
  with its most recent entries removed still verifies. The format is specified in
  `docs/formats.md` precisely enough to write an independent verifier.
- `mcpsteward policy init`, `policy check` and `verify`: a policy gate for CI and
  pre commit hooks, covering allowlists and denylists, forbidden auth postures,
  inline credentials, unpinned servers, a minimum grade and a maximum drift risk.
  Exits nonzero on any violation.
- `mcpsteward migrate`: finds 12 patterns in server source code that break under
  2026-07-28, in TypeScript or JavaScript, including an installed package's compiled
  code. `--fix` applies the one change that is safely mechanical, renumbering
  retired error codes, prints the diff, and writes nothing without `--yes`. Exits 0
  when clean, 1 with findings, and 2 when there is nothing to scan.
- `mcpsteward doctor`: reports the environment, every configuration location
  checked, and the state of the ledger and policy.
- Reports in terminal, JSON, NDJSON, Markdown, SARIF and HTML formats. Secrets are
  redacted once, before any format is rendered.
- A programmatic API at `mcpsteward/api`.
- `mcpsteward-mcp`: mcpsteward as an MCP server exposing six tools, so an assistant can
  inspect the other servers it has been given. Speaks 2026-07-28 and also completes
  the older `initialize` handshake that current clients send. Tested against the
  official MCP SDK client.
- Zero runtime dependencies. No telemetry, no account, no cloud service, and no
  network access except to the servers you ask it to inspect.

[Unreleased]: https://github.com/ITheroSolutions/mcpsteward/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/ITheroSolutions/mcpsteward/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ITheroSolutions/mcpsteward/releases/tag/v0.1.0
