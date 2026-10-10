# mcpwarden

Know what your MCP servers are advertising, and prove it has not changed.

**No cloud. No account. No telemetry. No LLM calls anywhere in the core.** Every
finding is deterministic and carries a specification citation you can check.

If this saves you time and you want to support the work, there is a
[pay what you want link](https://buy.stripe.com/14A7sFf24cCY6mZb4cfYY00). Entirely
optional, the tool is free either way.

```bash
npm install -g @itherosolutions/mcpwarden
mcpwarden discover
```

The package is published under a scope because npm reserves names that differ only by
punctuation, and an unrelated package called `mcp-warden` already exists. The command
it installs is plain `mcpwarden`.

Or run from source:

```bash
git clone https://github.com/ITheroSolutions/mcpwarden.git
cd mcpwarden
npm install
npm run build
npm link
mcpwarden discover
```

---

## What it does

`mcpwarden` answers two questions about any Model Context Protocol server.

**Conformance.** Does this server correctly implement the 2026-07-28 MCP
specification, and if not, what exactly is wrong and how is it fixed?

**Trust.** What surface did this server advertise, has it changed since you approved
it, and can you prove what it looked like at any point in time?

Both run on one core: discover the servers configured on a machine, connect, capture
what they advertise, canonicalize it, hash it. Conformance grades that surface
against specification rules. The ledger records it in a tamper evident append-only
log and diffs it against a pinned baseline.

## Why it exists

The 2026-07-28 specification is the largest revision since the protocol launched.
SEP-2575 alone removed the `initialize` handshake, removed sessions, removed `ping`
and `logging/setLevel`, made `server/discover` mandatory, replaced
`resources/subscribe` with `subscriptions/listen`, and removed SSE resumability.
Thousands of servers need migrating, and "does mine actually comply" is currently
answered by reading a changelog and hoping.

Separately, and more durably: most MCP deployments keep no record of which tool
definitions were active during a session. A remote server can serve a benign tool
description on the day you approve it and a different one a week later, and nothing
on your machine would know. That is tool poisoning, and it is invisible after the
fact without a baseline. Existing scanners are static and point in time. Nothing
keeps a durable local provenance record.

## Sixty second quickstart

```bash
# What MCP servers are on this machine? Reads local config, connects to nothing.
mcpwarden discover

# Grade one against the specification.
mcpwarden conform my-server

# Approve what it advertises today.
mcpwarden trust my-server

# Later: has it changed?
mcpwarden diff my-server
```

`discover` is the one to run first. On a typical developer machine it finds more
than people expect, and it reports any credential written directly into a
configuration file, which is the finding most worth acting on immediately.

## The two workflows

### Grade a server

```bash
mcpwarden conform my-server
mcpwarden conform my-server --format json | jq '.sections[].items[].id'
```

Every finding carries the specification section or SEP that justifies it and a
remediation written for whoever has to fix it. A single MUST failure caps the letter
grade regardless of score, because "mostly implements a mandatory requirement" is not
a thing.

Grading is reproducible. Nothing reads a clock, a random source, or the network, so
the same server and the same tool version always produce the same grade. That is what
makes a grade usable as evidence.

### Pin and detect drift

```bash
mcpwarden capture my-server     # record the surface in the ledger
mcpwarden trust my-server       # approve it as the baseline
mcpwarden diff my-server        # later: what changed?
mcpwarden ledger verify         # is the log itself intact?
```

Drift is classified, not merely counted: a tool added or removed, its description,
schema or other fields changed after approval, a parameter newly required, a name
that collides with another server, the protocol revision changing. The pin stores
only hashes, one per part of each tool, so it can say which part changed without
keeping a copy of anything.

Tool poisoning presents as changed text: the name stays and the text the model reads
is replaced. But every legitimate release rewords its tools too, so a changed
description alone is medium, or high on a tool that touches the filesystem, network
or shell. Critical is reserved for new or changed text that carries a sign of
poisoning: hidden Unicode, an `<IMPORTANT>` style instruction tag, a direction to keep
something from the user or ignore other instructions, or a reference to a credential
file such as an SSH key. Upgrading a real browser automation server between two
releases produces no critical events; a planted instruction does.

## Migrating a server to 2026-07-28

```bash
mcpwarden migrate ./src
mcpwarden migrate ./src --format sarif --output results.sarif
```

Twelve patterns that break under the new revision, each with the specific fix rather
than a pointer at the changelog. With the TypeScript compiler available, detection
runs on a real AST, for JavaScript as well as TypeScript; without it, a line oriented
pass runs and its findings are labelled lower confidence and say so.

It matches method names as exact strings and only MCP specific identifiers, so a word
like "Scraping" or a variable called `sessionId` is not a finding. Pointed at an
installed package, which ships only compiled code, it scans `dist` and says so.

Exits 0 when nothing is found, 1 when something is, and 2 when the path contains no
source at all.

## CI integration

```yaml
name: MCP policy
on: [push, pull_request]

jobs:
  mcpwarden:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - run: npx @itherosolutions/mcpwarden verify --policy mcpwarden.policy.json

      - run: npx @itherosolutions/mcpwarden migrate ./src --format sarif --output mcpwarden.sarif
        if: always()

      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: mcpwarden.sarif
```

`verify` inventories the MCP configuration committed to the repository, such as
`.mcp.json`, `.vscode/mcp.json` and `.cursor/mcp.json`, alongside anything under the
runner's home directory. So in CI it checks the servers your project ships, and fails
on a credential written into one of them.

Generate a starting policy with `mcpwarden policy init`. It passes on the machine it
came from, with one deliberate exception: inline credentials fail immediately.

## CLI reference

| Command | What it does |
| --- | --- |
| `discover` | Inventory every MCP server configured on this machine and in the current project. Offline. |
| `capture <server>` | Connect and record what a server advertises, into the ledger. |
| `conform <server>` | Grade a server against the 2026-07-28 specification. |
| `migrate <path>` | Analyse a source tree for patterns that break under 2026-07-28. |
| `trust <server>` | Approve a server's current surface as the baseline. |
| `diff <server>` | Compare a server against its pin. |
| `verify` | Run the policy gate. Exits nonzero on violation. |
| `ledger log` | Show ledger entries. |
| `ledger verify` | Prove the ledger chain is unbroken. |
| `ledger export` | Write the ledger in the chosen format. |
| `policy init` | Generate a starting policy from this machine's state. |
| `policy check` | Evaluate the policy. |
| `doctor` | Environment, detected configs, ledger and policy status. |

### Global options

| Option | Default | Meaning |
| --- | --- | --- |
| `--format <name>` | `terminal` | `terminal`, `json`, `ndjson`, `markdown`, `sarif`, `html` |
| `--output <path>` | stdout | Write the report to a file |
| `--config <path>` | `mcpwarden.config.json` | Configuration file |
| `--ledger <path>` | `~/.mcpwarden/surfaces.mcpwarden-ledger` | Ledger file |
| `--policy <path>` | `mcpwarden.policy.json` | Policy file |
| `--log-level <level>` | `silent` | `silent`, `error`, `warn`, `info`, `debug`, `trace` |
| `--timeout <ms>` | `30000` | Per operation time budget |
| `--colour`, `--no-colour` | auto | Defaults to on only when stdout is a terminal |
| `--fix` | off | With `migrate`, apply the safe codemods. Prints a diff; writes nothing without `--yes`. |
| `--yes`, `-y` | off | Confirm a write. Required by `migrate --fix`. |

The report goes to stdout and every diagnostic goes to stderr, including at
`--log-level trace`, so `mcpwarden conform x --format json | jq` is always safe.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | A policy or conformance check failed. The tool worked; the machine did not. |
| `2` | The command was used incorrectly, or a config or policy file is malformed. |
| `3` | A defect in mcpwarden. Please report it. |

These are a contract. They may be added to but never renumbered.

## Configuration

`mcpwarden.config.json`, all keys optional:

| Key | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | `30000` | Per operation time budget |
| `retries` | `2` | Attempts after the first, for transport failures only |
| `retryBackoffMs` | `250` | Base backoff, doubled per attempt |
| `preferredRevision` | `2026-07-28` | Revision to attempt first |
| `allowDowngrade` | `true` | Whether to fall back to an older revision |
| `ledgerPath` | `~/.mcpwarden/...` | Where the ledger lives |
| `policyPath` | `mcpwarden.policy.json` | Where the policy lives |
| `logLevel` | `silent` | Diagnostic verbosity |
| `maxDescriptors` | `10000` | Denial of service bound per server |
| `maxResponseBytes` | `33554432` | Denial of service bound per response |

Precedence, lowest to highest: built in defaults, config file, `MCPWARDEN_*`
environment variables, per call options. An unknown environment variable is ignored;
an unknown config file key is rejected, because a config file is written deliberately
and a silently ignored typo produces a run that quietly uses the default.

## Policy

`mcpwarden.policy.json`:

| Key | Meaning |
| --- | --- |
| `version` | Must be `1` |
| `allowServers` | Server names permitted |
| `denyServers` | Server names forbidden |
| `requiredAuthPosture` | Permitted values from `none`, `env`, `inline`, `oauth`, `unknown` |
| `minimumGrade` | `A` through `F` |
| `maximumDriftRisk` | `low`, `medium`, `high`, `critical` |
| `allowUnpinnedServers` | Whether a server with no approval may exist |
| `failOnInlineCredentials` | Whether a credential in a config file fails the build |

An unset key imposes no requirement. A check that could not run for lack of input is
reported rather than silently passing, so a green gate that only checked half the
policy cannot be mistaken for one that checked all of it.

## Programmatic use

```js
import { inventory, conformServer, withServer } from '@itherosolutions/mcpwarden/api';

const machine = await inventory();

for (const server of machine.servers) {
  const { report } = await conformServer(server, { timeoutMs: 10_000 });
  console.log(server.name, report.grade.letter ?? 'not graded');
}
```

Every operation takes an `AbortSignal` and an optional progress callback.
Cancellation stays distinct from a timeout throughout. `dispose` is idempotent, using
a session after disposal throws a typed error, and child processes are killed as a
tree so nothing is left running.

Five runnable examples are in [`examples/`](examples).

## Use it from your AI client

mcpwarden is also an MCP server, so an assistant can inspect the other servers it has
been given. Add it to any MCP client as a stdio server:

```json
{
  "mcpServers": {
    "mcpwarden": { "command": "npx", "args": ["-y", "-p", "@itherosolutions/mcpwarden", "mcpwarden-mcp"] }
  }
}
```

It offers six tools: `discover_servers`, `verify_ledger` and `check_policy`, which read
local files and connect to nothing, and `capture_surface`, `check_conformance` and
`diff_against_trust`, which start the server being inspected. Output is redacted the
same way the command line's is.

It speaks `2026-07-28`, and also completes the older `initialize` handshake, because
that is what MCP clients actually send today. It is tested against the official MCP
SDK client and graded A by its own conformance engine.

## What this does not do

Stated plainly, because a security tool that overclaims is worse than none.

**It does not prove your ledger is authentic.** The hash chain proves the log is
internally consistent: no entry was modified, removed or reordered without
recomputing everything after it. It is not signed and not anchored anywhere outside
the file. Anyone who can write the file can delete it and rebuild a complete, self
consistent chain from scratch, and verification will accept it. Removing only the most
recent entries also passes, since a shorter chain is still consistent. `ledger verify`
prints the entry count and head hash; keeping those somewhere other than the ledger
file is what lets you notice either.

**It does not attest what a server does.** Only the advertised surface is captured. A
tool whose descriptor never changes can still do anything at call time, and a server
could serve mcpwarden one surface and a real client another. There is no attestation
in the protocol to prevent that.

**Its risk scores are heuristics.** The drift risk weighting is pattern matching on
names and descriptions. It orders your attention. It is not a security guarantee, and
every weight is configurable precisely because it is a judgement rather than a
measurement.

**A pin records that somebody approved a surface, not that anybody read it.** That is
the weakest link in the whole design.

**It cannot inspect a server that requires you to sign in.** Most hosted MCP servers
use OAuth, and mcpwarden does not sign in to anything: doing so would mean contacting
sign in servers you did not ask it to, and storing tokens. Such a server is reported as
requiring sign in, clearly, rather than as a failure. A server authenticated by a
header or token in its own configuration, including one filled from your environment
with `${env:NAME}`, works. On the first real machine it was run against, this covered
roughly a third of the configured servers.

`docs/threat-model.md` is the honest, unflattering version of this section.

## Comparison with static scanners

Existing MCP scanners check a server's declared surface once, at a point in time,
usually against a list of suspicious patterns.

mcpwarden overlaps there and differs in three ways. Findings are traceable: every
rule cites a specification section, so a result can be checked rather than believed.
Nothing is inferred by a model, so results are reproducible and explainable. And the
ledger gives a *durable* record, which is the part a point in time scan structurally
cannot provide: detecting that a description changed requires knowing what it was
before.

What a static scanner may do better is heuristic judgement about whether a tool looks
malicious. mcpwarden deliberately does not attempt that, because doing it well needs
a model, and a model in the core would cost the determinism everything else rests on.

## On dependencies

**Zero runtime dependencies.**

The published MCP SDK does not implement the 2026-07-28 revision: version 1.30.0
shipped 2026-07-27, one day before the specification was finalised, and references
only `2025-06-18` and `2025-11-25`. Beyond that, a conformance prober has to send
deliberately malformed requests, because a rule like "the server must reject a request
whose headers disagree with its body" can only be tested by sending exactly the
request a correct client library is built to make impossible.

So the protocol client is hand written. The stateless rewrite made that cheap: with no
handshake, no session and no resumability, a modern MCP client is a JSON-RPC request
builder plus two transports.

TypeScript is an optional peer dependency, used only by `migrate` for AST analysis.
Without it, `migrate` degrades to a labelled lower confidence pass.

## Supported revisions

| Revision | Support |
| --- | --- |
| `2026-07-28` | Full. Capture, conformance grading, drift, policy. |
| `2025-11-25` | Capture, era detection and downgrade reporting. Not graded. |

A capture always records which revision was actually spoken. A downgraded capture is
never presented as a current one, and never graded: `conform` against a server on
`2025-11-25` reports it as not graded, with the revision it speaks, and exits 1.

Expect that for most servers today. The published MCP SDK predates `2026-07-28`, so
nearly every server in the wild still speaks `2025-11-25`. Their surfaces can be
captured, pinned and diffed like any other; only the grade waits for them to migrate.

## Documentation

| File | Contents |
| --- | --- |
| [`docs/rules.md`](docs/rules.md) | Every conformance rule and migration pattern, generated from the registry |
| [`docs/formats.md`](docs/formats.md) | The ledger and pin formats, specified for an independent verifier |
| [`docs/architecture.md`](docs/architecture.md) | The pipeline, the merkle design, why every rule is deterministic |
| [`docs/threat-model.md`](docs/threat-model.md) | What this defends against and what it does not |
| [`SPEC-NOTES.md`](SPEC-NOTES.md) | Every normative requirement with its citation |
| [`DECISIONS.md`](DECISIONS.md) | Every judgement call, with the alternatives rejected |
| [`VERIFY.md`](VERIFY.md) | Open items and known limitations |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to add a rule, and the bar it must clear |
| [`SECURITY.md`](SECURITY.md) | Disclosure process and in scope threats |

## Licence

MIT
