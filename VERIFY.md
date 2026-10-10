# Open items and known limitations

Everything in this project that a careful user should know is uncertain, and
everything that still wants confirmation from somebody who has the right client or
the right environment in front of them.

Nothing here is a bug report. These are the places where the honest answer is
"probably, and here is why it is only probably".

---

## 1. Client configuration paths that could not be confirmed

Every path in `src/discovery/clients.ts` carries a `confidence` field. The ones below
are `probable` rather than `confirmed`. They are implemented and scanned, but a wrong
path means an inventory reports a clean machine when the truth is that it looked in
the wrong place, which is the worst failure mode this component has.

**Confirmed against documentation:**

| Client | Path |
| --- | --- |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json`, `~/Library/Application Support/Claude/claude_desktop_config.json`, `~/.config/claude-desktop/claude_desktop_config.json` |
| Claude Code | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |
| VS Code | `<user dir>/Code/User/mcp.json`, shape `servers`. Also confirmed empirically: a real `discover` run located servers there and parsed them with the `servers` shape. |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` (same on Windows). Confirmed against Windsurf's own Cascade MCP docs (docs.windsurf.com/windsurf/cascade/mcp). The file does not exist until a server is first added through the Windsurf UI; its absence means no servers configured yet, not a wrong path. |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json`, falling back to `<VS Code global storage>/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`. Confirmed against Cline's own docs and cline/cline GitHub issues: Cline 4.x moved MCP settings out of the VS Code extension's globalStorage into a shared, editor-independent data directory. The legacy globalStorage file is read once on first launch to migrate, then Cline stops writing to it, so it is checked second, as a fallback for installs that have not migrated. |
| Zed | Linux/macOS: `~/.config/zed/settings.json`. Windows: `%APPDATA%\Zed\settings.json`, shape `context_servers`. Confirmed against zed-industries/zed's own `docs/src/configuring-zed.md`. The previous entry used the Linux/macOS path unconditionally on every platform, which would have silently missed every Windows Zed install. Windows uses a different path with different capitalization, not a variant of the same one. |

Claude Desktop and Claude Code were also confirmed empirically by that same run, which
detected configuration for both.

One caveat survives for VS Code. It additionally supports a workspace
`.vscode/mcp.json`, which a machine wide scan cannot enumerate without walking every
project directory. Those are found only when a directory is named explicitly.

**Probable, needing confirmation:**

| Client | Assumed path | Why it is uncertain |
| --- | --- | --- |
| Generic | `mcp.json`, `.mcp.json` in a named directory | A convention rather than anything specified. Shape assumed to match the common `mcpServers` form. |

**How to help.** Configure one MCP server in a client you actually use and run
`mcpwarden discover`, then confirm the server appears. `absentPaths` in the inventory
lists every location checked, so a path that is wrong shows up there rather than being
invisible. A corrected path is the single most useful pull request this project can
receive.

**Note on shapes.** Three distinct config shapes are handled: `mcpServers` (Claude
Desktop, Claude Code, Cursor, Windsurf, Cline), `servers` (VS Code), and
`context_servers` (Zed). If a client changes shape, its servers silently vanish from
the inventory rather than erroring, because a file with no recognised server map is a
normal and common case.

---

## 2. Unverified conformance rules

None currently. Every requirement in `SPEC-NOTES.md` was taken from specification text
with a citation.

This section lists any rule that ends up marked `UNVERIFIED`. Such a rule reports its
finding but never affects the graded score, so a rule whose grounding is uncertain can
never cost a server a grade it did not deserve.

---

## 3. Specification coverage is partial by design

`SPEC-NOTES.md` records roughly seventy normative requirements. Seventeen became graded
rules. The remainder fall into three groups, and none was silently dropped:

- Requirements that bind the client rather than the server, which a server grader has
  no standing to check.
- Requirements needing an authorization flow, which the capture path does not perform.
- Requirements needing an HTTP level probe beyond what a capture makes available.

Rules that would depend on specification pages not yet incorporated are deferred rather
than invented. A grader that guesses at a requirement is worse than one that admits a
gap, because a wrong citation is indistinguishable from a right one to anybody who does
not already know the answer.

---

## 4. The MCP SDK does not implement this revision

`@modelcontextprotocol/sdk@1.30.0`, the latest published version, was released
2026-07-27, one day before the 2026-07-28 specification was finalised, and references
only `2025-06-18` and `2025-11-25`. It contains no occurrence of `2026-07-28`.

This is why the protocol client is hand written and why the package carries zero runtime
dependencies. See `DECISIONS.md` D-002. The SDK is retained as a devDependency because it
provides a real legacy server to test downgrade behaviour against.

**Worth revisiting if** a 2026-07-28 capable SDK ships. Even then it would apply to the
transport layer only, never to the conformance prober, which must send deliberately
malformed requests. That is precisely what a correct client library exists to prevent.

---

## 5. Repository and disclosure metadata

`package.json` carries `github.com/ITheroSolutions/mcpwarden` for `repository`,
`homepage` and `bugs`. The same URL appears as `informationUri` in the SARIF renderer
and in the `CHANGELOG.md` compare link. All three move together if the repository is
ever renamed.

**Resolved (2026-08-16):** keep both. GitHub private vulnerability reporting is the
primary route, and the mailbox in `SECURITY.md` stays as a fallback for anyone who does
not have or want a GitHub account. See `SECURITY.md` for the current wording.

---

## 6. Package contents

The published tarball was unpacked and installed into a scratch project as a real
dependency rather than merely listed, and exercised there.

| Check | Result |
| --- | --- |
| Top level files | `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`, `dist/` only |
| Tests, fixtures or specifications inside | none |
| Ledger, pin or captured surface files inside | none |
| Runtime dependencies of the installed package | `{}` |
| `import { ... } from '@itherosolutions/mcpwarden'` | resolves |
| `import { inventory } from '@itherosolutions/mcpwarden/api'` | resolves |
| Type declarations | present for every entry point |
| `dist/cli/index.js --version` | prints the version |
| `dist/cli/index.js discover --format json` | valid JSON |
| `dist/mcp/index.js` answering `server/discover` | correct result, identifies as `mcpwarden` |

CI runs the same inspection on every push, including a positive check that the required
entry points are present. An earlier version of that check matched the bare word
`ledger` and so flagged `dist/ledger/index.js`, which is compiled source rather than
captured data. A check that cries wolf on every build is a check people learn to ignore,
so the pattern now matches only captured state: `.mcpwarden-ledger`, `.pin.json` and
`.surface.json`.

---

## 7. Servers that require sign in cannot be inspected

A server that answers HTTP 401 or 403 is reported as requiring sign in, with its host,
and is not retried. mcpwarden does not perform OAuth or any interactive sign in. See
`DECISIONS.md` D-015 for why.

This is not a corner case. On the first real machine mcpwarden was run against, roughly a
third of the configured servers were hosted services that require OAuth, which is typical
of any large vendor's hosted MCP endpoint.

**What works today:** a server whose configuration supplies its credential as a header
or environment value, directly or through `${env:NAME}` filled from your environment.

**What would change it:** a sign in design of its own, covering which hosts may be
contacted, where tokens live, and how they are protected. Not a transport change.

---

## 8. Configuration placeholders only the owning client can fill

Placeholders written by VS Code, Cursor and Claude Code are filled from your
environment: `${env:NAME}`, `${NAME}`, `${NAME:-default}` and `${userHome}`. VS Code's
`${input:...}` prompts you inside VS Code and cannot be filled anywhere else. A value
using one is left out, and an argument using one stops the launch with a message naming
it. `${workspaceFolder}` is treated the same way, since outside an editor there is no
workspace.

Claude Desktop does not expand placeholders at all. A literal `${...}` in a Claude
Desktop configuration is expanded here anyway; that is almost always a value copied
from another client's documentation, and is recorded here in case it is not.
