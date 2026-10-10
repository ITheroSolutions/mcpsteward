# DECISIONS.md

Every judgement call, with the alternatives rejected. Newest last.

---

## D-001: Build with `tsc` rather than tsup or a bundler

**Decision:** Compile with `tsc` via `tsconfig.build.json`. No bundler.

**Reasoning.** The package ships a library, a CLI and an MCP server entry point, all
ESM only, all Node only. A bundler earns its place when there is a browser target, a
CommonJS dual build, or a dependency graph worth tree shaking. None of those apply. `tsc`
is already required for typechecking and declaration output, so using it for emit costs
zero additional dependencies.

**Rejected:** tsup, which would add esbuild and its own configuration surface to produce
output that is equivalent for this target. Rejected: rollup, same reasoning with more
configuration. Neither is wrong, both are unjustified weight for a package whose
position is that it writes code rather than adding dependencies.

**Consequence.** Output shape mirrors the source tree, which makes the exports map
trivially predictable and makes stack traces in bug reports point at real file paths.

---

## D-002: The MCP SDK is a devDependency only, and the protocol client is written by hand

**Decision:** `@modelcontextprotocol/sdk` is a devDependency. mcpsteward implements its
own 2026-07-28 protocol client. Runtime dependencies stay at zero.

**Reasoning.** This reverses the obvious starting assumption that the SDK would be the
protocol foundation, on evidence gathered rather than preference. Two findings drove it.

First, the published SDK does not implement this revision. Version 1.30.0, the latest on
npm, was published 2026-07-27, one day before the specification was finalised. Its type
definitions reference `2025-06-18` and `2025-11-25` and contain no occurrence of
`2026-07-28`. It therefore cannot speak the revision mcpsteward exists to grade, and it
cannot host a fixture server for that revision either. Building on it would have meant
waiting on someone else's release to do the core job.

Second, and more durable, a conformance prober needs to send deliberately malformed
traffic. Rules such as MS-META-001 (server must reject a request missing required `_meta`
fields with `-32602`) and MS-HTTP-004 (server must reject a header and body mismatch with
`-32020`) can only be tested by sending exactly the request a correct SDK is designed to
make impossible. A well behaved client library is the wrong instrument for this job
regardless of which revision it supports.

The cost of writing the client by hand collapsed with this revision. Statelessness
(SEP-2575) removed the handshake, the session and stream resumability. A modern client is
now a JSON-RPC request builder plus two transports. That is a few hundred lines, not a
protocol implementation.

**Rejected:** depending on the SDK at runtime and waiting for 2026-07-28 support. This
would block the entire point of the package on an external release and would still leave
the malformed-request problem unsolved.

**Rejected:** vendoring a copy of SDK source. Licence and drift cost with no benefit,
since the parts worth having do not exist yet.

**Retained use.** The SDK stays as a devDependency for one specific purpose: it provides
a genuine, correct `2025-11-25` legacy server to test downgrade detection and era probing
against. Testing backward compatibility against a real implementation of the old era is
worth more than testing it against a fixture we wrote ourselves to match our own
assumptions.

**Consequence.** mcpsteward ships with zero runtime dependencies. A JSON Schema validator
was the one dependency ever anticipated, and it turned out not to be needed either. The
README states this plainly.

---

## D-003: Support 2026-07-28 fully and 2025-11-25 for capture only

**Decision:** Conformance grading targets `2026-07-28`. The `2025-11-25` revision is
supported for surface capture, era detection and downgrade reporting, but is not graded.

**Reasoning.** The package's stated purpose is answering whether a server correctly
implements the 2026-07-28 revision, and detecting whether a surface changed. Grading the
old revision would mean maintaining a second full rule set for a specification that is
being migrated away from, which spends the effort in the wrong place during exactly the
window when migration help is most valuable.

Capture support for the legacy era is still required, because a user pointing mcpsteward
at their machine will have servers on both eras and an inventory that silently omitted
the old ones would be misleading. Drift detection also has to work on legacy servers,
since a tool description changing under the old revision is the same security problem.

**Rejected:** grading both revisions from the start. Deferred, and worth revisiting only
if demand for grading the old revision appears.

**Rejected:** refusing to connect to legacy servers at all. That would make the inventory
lie by omission.

**Consequence.** Every capture records which revision was actually used. A downgraded
capture is never presented as a current one, per MS-LIFE-005.

It is never graded either. `conform` against a server on `2025-11-25` reports it as not
graded, with the revision it speaks, and exits 1. An earlier version applied the rule set
for the graded revision, found that no rule applied, and scored the empty set as 100 out
of 100, grade A. Since nearly every server in the wild is still on `2025-11-25`, that
would have handed an A, and a passing CI grade gate, to almost every server a new user
inspected.

---

## D-004: Rule identifiers are stable strings, never renumbered

**Decision:** Conformance rules use ids of the form `MS-<AREA>-<NNN>`, assigned once and
never reused or renumbered, even if a rule is withdrawn.

**Reasoning.** The grade must be reproducible and rule ids will end up in users' policy
files, CI configuration and suppression lists. Renumbering silently changes the meaning
of someone's existing configuration. A withdrawn id is retired permanently rather than
recycled, exactly as the specification itself retires error codes `-32002` and `-32042`
rather than reusing them.

**Rejected:** sequential numbering across the whole registry, which forces renumbering
whenever a rule is inserted in the middle of an area.

---

## D-006: Redaction fingerprints are eight hex characters, not four

**Decision:** A redaction token is `<label>-REDACTED-<8 hex>`, for example
`sk-REDACTED-4f2a1c9b`.

**Reasoning.** Four hex characters is the common choice for a short fingerprint. Four is
enough to look right in a single report but collides at roughly even odds once a few
hundred distinct secrets are in play. A colliding fingerprint is worse than no
fingerprint, because it actively tells a reader that two different credentials are the
same one, which is the exact inference the feature exists to support. Eight characters
push the collision point far past any realistic report while keeping the token short
enough to read.

**Rejected:** four characters, for the collision reason above. **Rejected:** a full
64 character digest, which is unreadable inline and adds nothing, since correlation
needs only enough bits to be unambiguous.

**Accepted tradeoff, documented rather than hidden.** Any construction that lets a
reader correlate a secret across two reports also lets somebody holding a *candidate*
secret confirm it against a report. That is inherent, not a flaw in this choice: it is
the same property that makes correlation work. Anyone with both a report and a guessed
credential already has the credential. Stated plainly in the module documentation and
carried into the threat model.

---

## D-007: A NUL parking sentinel protects text from later patterns

**Decision:** Before any pattern runs, `redact` strips NUL bytes from the input, then
parks our own content hashes and any pre-existing redaction tokens behind
`\u0000<index>\u0000` placeholders, restoring them at the end.

**Reasoning.** Three bugs made this necessary, all caught by tests rather than by
inspection, and all with the same root cause: a later pattern consuming the output of
an earlier one.

A redaction token matches the vendor prefix pattern that produced it. `sk-REDACTED-...`
is a valid `sk-` match, so a second pass re-redacted it and produced a different
fingerprint each time, destroying the cross-report stability the whole design rests on.

The parking placeholder was itself consumed as a connection string password, because
that rule captures positionally (whatever sits between `:` and `@`) rather than by
recognising content.

Our own 64 character content hashes were eaten by the generic hex heuristic, which
would have silently destroyed ledger readability.

NUL is the right sentinel because it is the one byte that cannot legitimately appear in
a protocol string or a configuration value. Stripping input NULs first means a hostile
server cannot forge a sentinel to smuggle text past the patterns.

**Rejected:** excluding the sentinel from every pattern's character class. Correct but
fragile, since it has to be remembered for every future pattern, and a missed one fails
silently.

**Rejected:** a random per run sentinel. Marginally harder to forge, but the input NUL
strip already closes that hole, and a deterministic sentinel keeps output reproducible.

**Also added:** an `alreadyHandled` guard on every positional capture, because parking
alone does not cover a pattern that matches by position rather than by content.

---

## D-008: Some secrets are only detectable in context, and that is correct

**Decision:** Redaction does not attempt to detect a bare connection string password in
isolation. It detects it only in its `scheme://user:PASSWORD@host` position. Test
fixtures for these carry a `contextualOnly` flag and are exempt from the isolation test.

**Reasoning.** `sup3rs3cr3tpassw0rd` standing alone is indistinguishable from an
ordinary word. Any rule broad enough to catch it would redact a large fraction of
ordinary medium length text, and a report nobody can read catches nothing. What makes
such a value a credential is its position, not its content.

This is the one place where the "when in doubt, redact" default is deliberately not
applied, so it is recorded explicitly rather than left as an apparent gap. Values of
this shape that arrive through a secret named environment variable are still removed
everywhere they appear, via `collectEnvSecrets`, which is the mechanism that actually
covers this case in practice.

**Rejected:** an entropy threshold low enough to catch short passwords. Measured
against the over-redaction fixture list, it destroyed ordinary identifiers and prose.

---

## D-009: Numbers canonicalize from their source token, deviating from RFC 8785

**Decision:** Canonicalization follows RFC 8785 for structure, ordering and string
escaping, but deviates on numbers. Numbers are normalised from the original source
token into a scientific form, with no `Number` conversion anywhere in the path.

**Reasoning.** RFC 8785 serialises numbers using ECMAScript `Number::toString`, which
means round tripping through an IEEE 754 double. For a canonicalization scheme aimed
at interoperability that is the right call. For a trust ledger it is a correctness
bug.

`9007199254740993` and `9007199254740992` are different integers. Both become
`9007199254740992` as doubles. If canonicalization routes through a double, a tool
schema can change in a way a double cannot represent and the surface hash will not
move. A ledger that cannot see a change is not a ledger.

This is a hard correctness requirement, and it is the reason the package carries its own
JSON parser rather than using `JSON.parse`.

Canonical forms: `1`, `1.0` and `1.000` become `1e0`. `100`, `1e2` and `1.0E+2` become
`1e2`. `0.1` becomes `1e-1`. `9007199254740993` becomes `9.007199254740993e15` with
every digit intact. Negative zero becomes `0`, matching RFC 8785, because JSON offers
no distinction between the two that a consumer could act on and treating them as
different would move the hash on a round trip through almost any JSON library.

**Rejected:** strict RFC 8785 compliance. It would make mcpsteward's hashes match other
JCS implementations, which is worth something, but only by accepting silent blindness
to a class of change this package exists to detect. Correctness wins over
interoperability here, and the deviation is documented rather than hidden so an
independent verifier can reproduce it.

**Rejected:** storing the raw token and comparing tokens directly. That would make
`1.0` and `1` compare as different, producing constant false drift on servers that
serialise numbers differently between releases.

**Consequence.** `docs/formats.md` must specify the number rule precisely enough for
an independent verifier, since this is where mcpsteward departs from a published
standard.

---

## D-010: The parser rejects duplicate object keys rather than resolving them

**Decision:** `parseJsonPreservingNumbers` throws on a duplicate object key.

**Reasoning.** RFC 8259 permits duplicate keys and leaves the behaviour to the
implementation. Every available choice is defensible in isolation and indefensible
here: last-wins and first-wins produce different hashes for byte identical input, so
whichever is picked, two conforming implementations of the ledger format would
disagree about what a document hashes to.

Rejecting is the only option that keeps the format independently verifiable, which
`docs/formats.md` promises.

**Rejected:** last-wins, matching `JSON.parse`. Familiar, but it silently discards data
a server actually sent, and a hostile server could use it to hide a tool definition
from the ledger while a more permissive client still sees it.

---

## D-011: Content hashes carry a `sha256:` prefix

**Decision:** Every hash is rendered as `` sha256:<64 hex> `` rather than bare hex.

**Reasoning.** Two reasons, one forward looking and one immediate.

Algorithm agility: a bare digest is unlabelled, so a future move to a different hash
would silently produce values indistinguishable from the old ones in existing ledgers.

More immediately, redaction's high entropy heuristic redacts hex runs of 32 characters
or more, and a surface merkle root is exactly 64 hex characters. Without a marker, our
own hashes were being eaten before they reached a report, which the tests caught. The
prefix is what makes a hash recognisable as a trusted own-value.

**Rejected:** exempting all 64 character hex runs from redaction. That would carve a
hole a hostile server could drive a credential through by padding it to 64 characters.

---

## D-005: `no-console` is an error, not a warning

**Decision:** ESLint forbids `console` across the source tree.

**Reasoning.** stdout is an MCP transport. On stdio, a single stray `console.log`
anywhere in the library corrupts the protocol stream of the self hosted MCP server, and
the failure mode is a confusing parse error in someone else's client rather
than an obvious bug here. The library gets a logger abstraction with a no op default, and
only the CLI renderer and the MCP server entry point are permitted to write to a stream
directly.

**Rejected:** a warning. Warnings do not fail continuous integration, and this is a
correctness constraint rather than a style preference.

---

## D-012: The era probe attempts the handshake rather than assuming from the error code

**Decision:** When `server/discover` fails with anything other than a recognised
modern error, the client attempts the legacy `initialize` handshake. If it succeeds,
the server is legacy and the capture records `2025-11-25`. If it is refused, the
server is modern and merely non conforming, and the capture proceeds as modern.

**Reasoning.** Building the 2025-11-25 fixture on the official SDK immediately
exposed a real bug: the client captured three tools from a genuine legacy server
while recording `revisionUsed: 2026-07-28`. A legacy server happily answers an era
ambiguous method such as `tools/list` while ignoring the modern `_meta` it does not
understand, so the capture succeeded and the ledger would have recorded a revision
the server does not speak. That is precisely the failure this project exists to avoid:
never silently present a downgraded capture as a current one.

The first fix over-corrected. Treating every non modern error code as legacy meant
a modern server that simply failed to implement `server/discover`, which is a MUST
and therefore a server worth inspecting, was misclassified and its capture aborted
when the handshake failed. Three conformance tests caught it. Being unable to
inspect a non conforming server is a worse failure than the one being fixed, since
that server is the entire point of the tool.

The probe result is genuinely ambiguous and the specification says so: a legacy
server and a modern server missing the method both answer `-32601`, and
MS-STDIO-008 is explicit that fallback MUST NOT be keyed to a specific code.
Attempting the handshake resolves the ambiguity with evidence instead of a guess.

**Rejected:** assuming legacy on any non modern error. Breaks inspection of non
conforming modern servers.

**Rejected:** assuming modern always. This is the original bug, and it silently
mislabels legacy captures, which corrupts the ledger.

**Rejected:** asking the user. Discovery and capture must work unattended in CI.

**Consequence.** One extra round trip against a server that answers `-32601` to
`server/discover`. That is a server already violating a MUST, so the cost falls
exactly where it should.

---

## D-013: Batch files run through cmd.exe on Windows, with arguments escaped twice

**Decision:** On Windows, a configured command is resolved against `PATH` and `PATHEXT`
before spawning. A real executable is spawned directly by absolute path. A batch file
(`.cmd` or `.bat`) is run through `cmd.exe /d /s /c`, with every argument quoted and every
`cmd.exe` metacharacter escaped with `^`, twice.

**Reasoning.** Most MCP servers are configured as `npx some-package`, and on Windows
`npx` is `npx.cmd`. Windows cannot execute a batch file without its command interpreter,
and a direct spawn fails with ENOENT because the loader searches only for `.exe` and
`.com`. Before this, 11 of 13 local servers on the first real machine it was run on
could not be started at all.

The escaping follows the approach of the cross-spawn library. It is doubled because
`npx.cmd` forwards its arguments with `%*`, which makes `cmd.exe` parse them a second
time; one level of escaping survives only the first parse. cross-spawn applies the
second level only to shims under `node_modules/.bin`, which would leave `npx.cmd` itself
exposed.

The current directory is not searched, although Windows searches it first, so a planted
`npx.cmd` in a project directory cannot shadow the real one. A batch file whose path
contains `%` is refused: quoting does not stop `%NAME%` expansion, and such paths are
too rare to justify the risk.

**Rejected:** `shell: true`. Node would build the command line without escaping it for
`cmd.exe`, which is the injection this transport exists to prevent.

**Rejected:** taking a dependency on cross-spawn. The package carries no runtime
dependencies, and the part needed is small enough to own and test directly.

**Consequence.** The only place a configured command line is ever interpreted by a
shell is `src/protocol/launch.ts`, and it is tested on Windows against a batch file
shaped like `npx.cmd` with forty hostile arguments, including eight injection attempts.

---

## D-014: A server receives what its own configuration supplies

**Decision:** When connecting, a server receives the environment values and HTTP
headers from its own configuration entry, with `${env:NAME}`, `${NAME}`,
`${NAME:-default}` and `${userHome}` filled from the operator's environment. It also
inherits a short allowlist of variables describing the machine layout (`PATH`,
`SYSTEMROOT`, `APPDATA`, `TEMP` and similar), which is the reference MCP SDK's default
set plus a few of the same kind. Nothing else from the operator's environment reaches
it.

**Reasoning.** Discovery originally recorded only the names of configured variables and,
at connect time, looked those names up in mcpsteward's own environment. So a server
configured with `DATA_DIR=C:\data` started without it and exited, and a server with no
`PATH` could not start its own subprocesses. mcpsteward could not inspect servers its
operator's clients run without trouble.

Handing a server its own configuration is not a disclosure. It is the intended recipient,
and the operator's MCP client already gives it the same values. What must not happen is
the operator's *other* secrets reaching it, and that still does not: `GITHUB_TOKEN` in
the operator's shell reaches a server only if that server's configuration references it.

The values are never stored on the `ServerRef`. They are kept in a `WeakMap` keyed by the
parsed endpoint, so they cannot be serialised into an inventory, report, ledger entry or
log line by accident.

A placeholder only the owning client can fill, such as VS Code's `${input:...}`, is left
out. In an argument it stops the launch with a message naming it, because starting the
server with the literal text would only produce a confusing failure inside it.

**Rejected:** keeping the names only behaviour. It made mcpsteward unable to inspect
exactly the servers most worth inspecting, and the credential it protected was going to
the server anyway.

**Rejected:** inheriting the operator's whole environment, as some clients do. That is
the leak the transport exists to prevent.

**Consequence.** The library API fills placeholders only from the `env` a caller passes
explicitly; it never reads the host environment on the caller's behalf.

---

## D-015: Sign in required is its own outcome, and sign in is not attempted

**Decision:** An HTTP 401 or 403 raises `AuthenticationRequiredError`, before the body is
interpreted, and is not retried. mcpsteward does not perform OAuth or any interactive sign
in.

**Reasoning.** Most hosted MCP servers refuse unauthenticated requests, each with a body
in its own format. Parsed as protocol messages, those bodies produced reports like
"returned neither a result nor an error", which sent people looking for a bug that did
not exist. The status is the one signal every server agrees on.

Performing OAuth would mean contacting authorization servers other than the server being
inspected, which breaks the promise that mcpsteward only connects to what it is asked to
inspect, and storing tokens, which is a credential store this package would then have to
defend. Both deserve a design of their own rather than being added to a transport.

**Consequence.** A server that requires OAuth cannot currently be captured. A server
authenticated by a header or token in its configuration, or in the operator's
environment through a placeholder, can be. The limitation is stated in `VERIFY.md` and
the README rather than left for a user to discover.

---

## D-016: Drift says which part changed, and critical needs evidence

**Decision:** A pin records, alongside each descriptor's hash, a hash of each of its
parts: the description, the input schema (or a prompt's arguments), and everything
else. A diff reports which part changed. Critical is reserved for a new or changed
item whose model facing text carries a sign of poisoning: hidden Unicode, an
instruction tag such as `<IMPORTANT>`, a direction to keep something from the user or
to ignore other instructions, steering about other tools, or a reference to a
credential file. The base weight of a description change drops from 8 to 4, so a
plain reword is medium, or high on a tool that touches the filesystem, network or
shell.

**Reasoning.** Pinning one real release of a browser automation MCP server and
diffing a later real release against it produced seventeen critical events, all
labelled "description changed". Two things were wrong. A pin stored only whole
descriptor hashes, so every change was reported as a description change, the highest
weighted classification, with no evidence; in fact seventeen tools had changed their
input schema and two their description. And any change to a tool mentioning the
network multiplied into critical, so a legitimate upgrade was indistinguishable from
an attack. An alarm that fires on every upgrade is one nobody reads.

Per part hashes keep the property that a pin stores no content. The poisoning signs
are checked on the current text, the only text a pin can see, including the text
inside the input schema, where parameter descriptions are as good a hiding place as
the description.

**Rejected:** storing descriptor content in the pin, which would let a diff compare
text directly. A pin should not be a copy of a server's surface sitting in a file.

**Rejected:** a model judging whether a description is malicious. No model calls in the
core.

**Consequence.** The same real upgrade now reports no critical events: seventeen
schema changes and eight new tools at high, two description changes, four metadata
only changes and eight removals. Pins written before this carry no field hashes; a
diff against one says the changed part is unknown rather than guessing, and trusting
the server again records them.

---

## D-017: The project is named mcpsteward

**Decision:** The project, the npm package, the repository and the installed command
are all `mcpsteward`. Rule identifiers carry the prefix `MS-`.

**Reasoning.** The project was built under a different name. npm refused that name at
publish time as too similar to an existing, unrelated package: npm treats names that
differ only by punctuation as the same name, and applies that check only on upload, so
the name had looked available throughout.

Two remedies were available. Publishing under a scope would have kept the old name, at
the cost of an install line and import paths that differ from the name of the command.
A new name keeps everything aligned: one word for the package, the command, the
repository and the configuration files. Nothing had been published and no user had
data in the old format, so the rename cost nothing that a later one would not cost more.

The new name was checked before use against the npm registry including every hyphen,
underscore and dot variant, against GitHub repositories, against PyPI, and against the
com, dev and io domains. It was unused in all of them.

**Rejected:** a scoped package under the old name, for the reason above.

**Consequence.** The ledger header's magic string and therefore the genesis hash carry
the new name. `docs/formats.md` states both, and a test pins them to the code. Rule
identifiers were renamed from their original prefix before first publication, which is
the only point at which D-004's rule that identifiers are never renumbered allows it.
