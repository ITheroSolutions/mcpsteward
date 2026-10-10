# Threat model

What mcpsteward defends against, what it does not, and where its heuristics are weak.

This document is deliberately unflattering. A trust tool that oversells itself is worse
than no trust tool, because it converts a vague unease into a false sense of coverage,
and a person who believes they are covered stops looking. If you are deciding whether to
rely on mcpsteward as a control, read the "What this does not defend against" section
first and the rest afterwards.

`SECURITY.md` states what is in scope for a vulnerability report. This document states
what is in scope for the tool. They are consistent with each other and neither is a
substitute for the other.

**Maturity notice.** Every component described below is implemented and tested: the
canonicalization and hashing cores, discovery, the protocol client, the conformance
engine, the ledger, and the trust and drift layer. What this document describes is
therefore actual behaviour rather than intended behaviour.

That said, this is a `0.1.0`. The threat model has not been reviewed by anybody outside
the project, and no part of it has been tested against an adversary who was trying.

---

## 1. What is being protected

**The ledger.** The historical record of what each server advertised and when. Its
value is entirely in being harder to rewrite than the thing it records. A ledger that
can be quietly edited is worse than no ledger, because it launders an attacker's claim
into evidence.

**The pins.** The approved baseline for each server. A pin is the reference point every
drift comparison is made against. An attacker who can edit a pin can make any current
surface compare as unchanged, which produces silence exactly where an alarm belongs.

**The user's credentials.** mcpsteward reads client configuration files that routinely
contain live API keys, and it spawns servers with environment variables that contain
more. Every one of those values has to survive contact with a report, a log line, an
error message and an append-only ledger without appearing in any of them. This is the
highest consequence code in the package and it is treated that way.

**The accuracy of the inventory.** The headline claim of `discover` is "here is every
MCP server configured on this machine". If that list is wrong, every downstream decision
made from it is wrong. Its weaknesses are covered in section 4.

---

## 2. Adversaries considered

### A. A malicious MCP server author

Ships a server that is hostile from the first install. Wants the model to call tools it
should not, wants to read files or exfiltrate data, and wants none of that to be
obvious in the advertised surface.

### B. A server that turns malicious after approval

The tool poisoning case, and the one this package exists for. The server is benign when
you install it, review it and approve it. Later, through an auto updating dependency, a
compromised maintainer account, or a server that fetches its tool definitions from a
remote it controls, the advertised surface changes. A tool description gains an
instruction to the model. A tool gains a parameter. Nothing about the name or the
install changes, so nothing looks different in any client UI.

### C. A local attacker with filesystem access

Has read and write access to the user's home directory, which means the ledger, the
pins, the policy file, the client configs and mcpsteward's own installed code. Wants the
record to say something other than what happened.

### D. A supply chain attacker

Compromises a package the target depends on. Two variants matter. The server's own
dependency chain, which lets them change what a server does without touching its
configuration. And mcpsteward's own chain, which lets them change what the inspector
reports.

---

## 3. What mcpsteward genuinely defends against

Each item names the mechanism, so you can check it in the code rather than take it on
faith.

**Undetected mutation of an advertised surface, against adversary B.** Every descriptor
is canonicalized and hashed, hashes are combined into per category roots and a surface
merkle root, and a fresh capture's root is compared against the pin. The merkle
structure means the diff can name the exact descriptor that moved rather than only
reporting that something did. `src/core/merkle.ts`, `src/core/canonical.ts`.

**Hash collisions from ordinary JSON representation differences.** Key reordering,
`1.0` versus `1`, `1e2` versus `100`, and whitespace all canonicalize identically, so
they do not read as drift. Semantically different values never collapse together,
including integers beyond 2^53, because canonicalization works from the source number
token and never routes through an IEEE 754 double. This is a deliberate deviation from
RFC 8785 and it exists precisely so a change cannot hide inside a double's precision
loss. `DECISIONS.md` D-009.

**Second preimage forgery of a merkle proof.** Leaves are hashed with a `0x00` prefix
and internal nodes with `0x01`, per RFC 6962 section 2.1, so a leaf preimage can never
be mistaken for an internal node preimage.

**The odd node collision that the Bitcoin merkle construction admits.** An odd trailing
node is promoted, not duplicated, so `[a, b, c]` and `[a, b, c, c]` do not share a root.
Under duplication they do, which would let a server add a duplicate tool invisibly.

**A description change being misread as a removal plus an addition.** Descriptor
identity is stored separately from content hash. A tool whose description changed is
recognised as the same tool with different content, which is the tool poisoning signal.
Collapsing the two would bury the single most important finding in ordinary churn.

**A rewritten, reordered, inserted or missing entry in the ledger, and a write cut off
part way.** `ledger verify` reports each with the sequence number where integrity
fails, through the sequence numbers and the `previousHash` chain. It does **not** detect
the most recent entries being cleanly removed: what remains is a shorter chain that is
still consistent. `ledger verify` prints the entry count and the head hash so they can
be recorded somewhere other than the ledger file, which is the only thing that shows a
shortened chain. See section 4.1.

**A duplicate object key smuggling a definition past the ledger.** The parser rejects
duplicate keys rather than resolving them. Under last-wins resolution a hostile server
could hide a tool definition from the hash while a more permissive client still parsed
and used it. `DECISIONS.md` D-010.

**Denial of service through pathological input.** Nesting bounded at 512 levels, single
lines bounded, stderr bounded, a repeating pagination cursor refused rather than
followed. A hostile server cannot blow the stack, exhaust memory or hang a capture
indefinitely.

**Credentials reaching output, against all four adversaries.** Every outbound string
passes through `redact`. Seventeen vendor key prefix families, PEM private key blocks,
JSON Web Tokens in both their signed three segment and encrypted five segment forms,
bearer and basic authorization values, connection string userinfo, secret shaped
assignments, values drawn from secret named environment variables, and a generic high
entropy catch-all for base64 and hex runs. A secret shaped assignment is redacted whole
even when an earlier step had already redacted part of its value: the first real token
this was run against had four of its five segments caught and the fifth printed, and
every fixture is now tested for surviving fragments, not only for the whole secret.
`ServerRef` carries environment variable *names* only; values never enter the type that
gets rendered.

**Inline credentials in client configs being missed, against a user's own mistake.**
Detection is structural: a secret named key whose value is not an environment reference
and is long enough to be a credential, in `env`, in `headers`, or in the endpoint URL's
query string. Names are recognised in upper snake case, camelCase and hyphenated form,
so `API_KEY`, `userToken` and `X-Api-Key` all count, and a JWT in a query string is
recognised by its shape whatever it is called. The value is never stored, only an eight
character fingerprint, so the finding can be reported and correlated across files
without the credential ever entering a report.

**Command injection through a configured server command.** The stdio transport spawns
with `shell: false`. An argument containing a semicolon is an argument, not a command.

There is one exception, and it is the most security sensitive code in the transport. On
Windows, a batch file such as `npx.cmd` cannot run without `cmd.exe`, so it is run
through `cmd.exe /d /s /c` with every argument escaped. `npx.cmd` re-parses its
arguments with `%*`, so the escaping is applied twice; one level would let an argument
such as `a"&calc&"b` run `calc` on the second parse. The current directory is never
searched for the command, and a batch file whose path contains `%` is refused. This is
tested on Windows against a batch file shaped like `npx.cmd`, with forty hostile
arguments including eight injection attempts, none of which runs. `src/protocol/launch.ts`,
`DECISIONS.md` D-013.

**Credential leakage into a spawned server's environment.** The child receives the values
its own configuration entry supplies, plus an allowlist of variables that describe the
machine layout (`PATH`, `SYSTEMROOT`, `APPDATA`, `TEMP` and similar), never the parent
environment wholesale. A hostile server cannot read credentials that belong to unrelated
servers, or the operator's own tokens, simply by being launched. Its own configured
values are a different matter: it is their intended recipient, and the operator's MCP
client already gives them to it. Those values are never stored on the inventory, so they
cannot reach a report, a ledger entry or a log line. `DECISIONS.md` D-014.

**Orphaned processes.** On Windows the whole process tree is terminated, because killing
a process there leaves its descendants running, and an MCP server launched through `npx`
is a shell wrapping the real server.

**Unexpected network access during passive operations.** `discover` opens no sockets and
spawns no processes; it reads files and parses them. This is asserted by a test, not by
inspection. Grading reads no clock, no random source and no network, so the same server
plus the same tool version yields the same grade.

**Invented conformance requirements.** Every rule carries a specification citation and
the type system refuses to compile one that does not. Rules that could not be grounded
in fetched specification text are marked `UNVERIFIED`, are excluded from the graded
score, and are listed in `VERIFY.md`.

---

## 4. What mcpsteward does not defend against

This is the section that matters. Read all of it.

### 4.1 A local attacker who rewrites the ledger from entry zero

**This is the largest single gap in the design and it is structural, not a bug.**

The ledger chain proves internal consistency. It does not prove authenticity. Nothing in
it is externally anchored, notarised, signed by a key the attacker cannot reach, or
witnessed by any party other than the machine that wrote it.

An attacker with write access to the ledger file, and with the ability to run mcpsteward
or reimplement its documented format, can delete the file and rebuild a complete chain
from sequence zero. Every entry will hash correctly. Every `previousHash` will match.
`ledger verify` will report the chain as valid, because by its own definition it is
valid. The record will say whatever the attacker wants, including that a poisoned tool
description was there all along and was approved.

The same attacker needs far less to hide recent history: removing the last entries at a
line boundary leaves a shorter chain that verifies. The only defence available today is
manual. `ledger verify` prints the entry count and head hash, and a copy of those kept
somewhere the attacker cannot write, a ticket, a commit, another machine, shows both a
shortened and a rebuilt ledger.

The same attacker can edit a pin, at which point any current surface compares as
unchanged and drift detection reports silence.

The same attacker controls the local clock, so timestamps in the ledger are worth
exactly as much as the attacker's cooperation.

The same attacker can modify mcpsteward's own installed code, at which point every
guarantee in section 3 is void.

This is not solvable within the project's constraints. A signing key stored next to the
ledger protects against nothing that the chain does not already cover, and there is no
hosted service, no account and no network anchor available to bind to. The mitigation is
operational, not technical, and it is listed in section 6.

**Read the guarantee correctly:** the ledger raises the cost of quietly editing history
in place, and makes casual tampering and partial corruption detectable. It does not make
history unforgeable by someone who owns the machine.

### 4.2 The risk heuristic being wrong

Drift risk scoring is a heuristic and is labelled as one everywhere it is rendered.

It is wrong in both directions. It can rate a genuinely dangerous change as medium
because the new text avoids every phrase the poisoning markers look for and the tool's
schema does not mention filesystem, network, shell or credential access. A careful
attacker who has read `src/trust/markers.ts` can write around all of it. It can rate a
harmless copy edit as high because the tool happens to touch a path, or as critical
because an honest description mentions a `.env` file. Its weights are configurable,
which means the number is a function of your configuration as much as of the change.

Do not gate a deployment solely on a risk tier. A `medium` is not a statement that
something is safe; it is a statement that a set of documented keyword and structural
weights summed to a number in a particular band.

`SECURITY.md` puts "the risk scoring heuristic being wrong about a given tool" out of
scope for vulnerability reports, and this is why.

### 4.3 A server that behaves differently for mcpsteward than for a real client

**There is no attestation anywhere in this design.**

Nothing binds the surface mcpsteward observed to the surface your agent will actually be
given. A server can trivially distinguish a probe from ordinary use: by process
environment, by timing, by the exact sequence of calls mcpsteward makes, by whether
`server/discover` was called at all, by how quickly the connection is torn down, or
simply by serving benign definitions on the first N connections and poisoned ones
afterwards.

A server that wants to pass inspection and misbehave in production will do so, and
mcpsteward will faithfully record the clean surface it was shown. The ledger entry will
be an accurate record of a lie.

There is no cryptographic identity for MCP servers to attest to, and mcpsteward cannot
invent one unilaterally. This gap closes only if the protocol grows server attestation.

### 4.4 Anything about what a tool does when it is called

**Only the advertised surface is captured. Nothing about behaviour is.**

mcpsteward does not intercept tool calls, does not see arguments, does not see results,
does not proxy traffic, and keeps no call log. A tool named `get_weather`, described as
returning the weather, with an input schema of `{ city: string }`, can read your SSH
keys and post them to a remote every time it is called. Its descriptor hash will be
stable forever and mcpsteward will report no drift, correctly, because the advertised
surface genuinely did not change.

This is worth stating bluntly because the product's framing invites the opposite
assumption. "No drift since your last approval" means the description text, the schema
and the tool list are byte for byte identical to what you approved. It does not mean the
server is behaving, has not been compromised, or is doing what it says.

If you need behavioural control, you need a runtime interception layer between the model
and the server. mcpsteward is not one and does not aspire to be one.

### 4.5 A pin approving a surface nobody read

**The most likely real world failure of this tool is social, not technical.**

`mcpsteward trust` pins whatever the server currently advertises. It records
`approvedBy` as free text, self reported, never verified against anything. It does not
require you to read anything, does not show a diff on first pin because there is nothing
to diff against, and does not measure whether you understood what you approved.

The realistic sequence is that a user installs a server with forty tools, runs
`mcpsteward trust`, and thereby converts an unexamined surface into an approved baseline.
From that moment the tool reports "matches your pin" indefinitely, and that message is
read as "this is fine". A poisoned description present at pin time is silently blessed
forever.

mcpsteward detects *change from a baseline*. It has no opinion whatsoever about whether
the baseline was any good.

### 4.6 Time of check versus time of use

A capture is a point in time. A server can change one second after the capture, before
the agent's first call. Watch mode, when it exists, narrows the window; it cannot close
it. Any control built on periodic capture has a window, and the window is the interval.

### 4.7 The inventory is a floor, not a total

Discovery finds servers by reading known configuration file paths for a fixed list of
clients. It therefore misses, by construction:

- clients not on the list, and clients that change their config location in a future
  release
- servers configured through a mechanism that is not a config file, such as a command
  line flag, an editor extension's own storage, a managed policy, or an environment
  variable
- servers running inside containers, VMs, WSL, remote development hosts, or another
  user account on the same machine
- servers a process spawns dynamically without any persistent registration

For a feature whose pitch is "the shadow MCP inventory", this is a real limitation and
it should be read as such. The count mcpsteward reports is a lower bound on the servers
configured on the machine. Treating it as a complete asset inventory is a mistake.
Paths that could not be confirmed against a vendor source are recorded in `VERIFY.md`
rather than presented as established.

### 4.8 Server identity is weaker than it looks

Deduplication and pin identity for a stdio server are derived from its command and
arguments. That has consequences that cut against the tool's purpose:

- `npx some-server@latest` is a stable identity that can resolve to entirely different
  code tomorrow. The `ServerRef` will not move. Only the captured surface will, and only
  if the change is visible in the advertised surface at all.
- A wrapper script keeps its identity while changing everything it launches.
- mcpsteward does not hash the server's binary, its lockfile, its package integrity, or
  anything else about the code that runs. It hashes what the running code says about
  itself.

For an HTTP server, identity is the normalised URL. Whatever is behind that URL can be
replaced entirely without the identity moving.

### 4.9 Running `capture` executes the server

`discover` is passive and safe to run against an untrusted machine state. **`capture`,
`conform`, `trust` and `diff` are not.** For a stdio server, capturing means spawning the
configured command as a child process on your machine, with whatever environment you
pass it. There is no sandbox, no seccomp profile, no container, no filesystem
restriction. The mitigations that exist (no shell, environment allowlist, bounded output,
process tree cleanup) reduce the blast radius of a *sloppy* server. They do not contain a
*hostile* one.

Inspecting a stdio MCP server means running it. If you would not run a server, do not
capture it, and be aware that a `capture --all` across a discovered inventory runs every
one of them.

### 4.10 mcpsteward's own supply chain

The package currently has zero runtime dependencies, with one JSON Schema validator
anticipated for schema conformance work. That is a genuinely small attack surface and it
was a deliberate choice. It is not zero. An attacker who compromises the published
package, the registry account, or the JSON Schema validator can make the inspector lie,
and the inspector lying is a strictly better position for an attacker than any individual
server lying.

Nothing in mcpsteward verifies mcpsteward.

### 4.11 The conformance grade is not a security signal

An A grade means a server correctly implements the 2026-07-28 specification. A perfectly
conforming server can be entirely malicious. A non conforming server can be entirely
benign and merely behind on migration.

This misreading is likely enough to name explicitly, because a letter grade rendered next
to a server name reads as a trust rating to almost everyone who sees it. It is an
interoperability measurement. Nothing more.

### 4.12 Correctness limits on the rules themselves

Rules are grounded in specification text that was fetched, but a rule can still encode a
wrong reading of a correct quotation. `UNVERIFIED` rules are excluded from the score and
listed in `VERIFY.md`, which handles the known unknowns; it does nothing about a rule
that is confidently wrong. `SECURITY.md` puts `UNVERIFIED` rule behaviour out of scope
for vulnerability reports for this reason.

### 4.13 Hashes are not portable to other JCS implementations

Because of the number deviation in section 3, mcpsteward's canonical form is not RFC 8785
output. An independent verifier must implement the documented number rule, not reach for
an off the shelf JCS library. If someone writes a verifier against stock JCS, it will
disagree with mcpsteward on any surface containing a number that a double cannot represent
exactly, and the disagreement will look like tampering. `docs/formats.md` exists to
prevent that, and it is load bearing.

---

## 5. Where the heuristics are weak, specifically

### 5.1 Drift risk scoring is a heuristic, not a guarantee

Covered in 4.2. Restated here because it belongs in this list: the score is a weighted
sum over configurable weights, keyed on structural signals such as whether a tool's
schema suggests filesystem, network, shell or credential access. It is documented in
full so you can judge it. It is not a security guarantee and is never presented as one.

### 5.2 Redaction cannot see a bare connection string password

`sup3rs3cr3tpassw0rd` standing alone is indistinguishable from an ordinary word. Any
rule broad enough to catch it would redact a large fraction of ordinary medium length
text, and a report nobody can read catches nothing. What makes such a value a credential
is its position, not its content.

So redaction catches it in `scheme://user:PASSWORD@host` position and not otherwise. In
practice the case is covered by a different mechanism: `collectEnvSecrets` takes the
values of environment variables whose names look secret and removes those exact values
everywhere they appear, regardless of shape. That works when the credential arrived
through an environment variable, which is the common case. It does not work when the
credential is a bare literal that mcpsteward has never seen in a named position.

This is the one place where the "when in doubt, redact" default is deliberately not
applied. It is recorded as a decision rather than left as an apparent gap.
`DECISIONS.md` D-008.

### 5.3 The redaction fingerprint is a confirmation oracle

A redaction token is `<label>-REDACTED-<8 hex>`, where the hex is the leading bytes of
SHA-256 over the secret. That is what makes the same credential recognisable across two
reports, which is the feature.

It also means that anyone holding a *candidate* secret can hash it and confirm whether
it appears in a report. The fingerprint does not let anyone recover a secret, since that
requires inverting SHA-256. It does let them verify a guess.

This is inherent rather than incidental: any construction that supports correlation also
supports confirmation. The argument for accepting it is that anyone with both a report
and a correctly guessed credential already has the credential. The argument against it is
that an attacker with a list of candidate credentials and access to a shared report can
learn which of them are live, and that is a real if narrow capability. The tradeoff is
accepted and documented rather than hidden. `DECISIONS.md` D-006.

Eight hex characters were chosen over four because four collides at roughly even odds
across a few hundred secrets, and a colliding fingerprint actively misleads by telling a
reader two different credentials are the same one.

### 5.4 Redaction is pattern based, so novel credential shapes get through

The vendor prefix list covers seventeen families and will always be behind. A credential
from a vendor not on the list, with no recognisable prefix, under 32 characters, and not
sitting under a secret named key or in a userinfo position, passes through untouched. The
generic entropy heuristics require a mix of character classes and a minimum run length,
both of which were tuned against an over-redaction fixture list so that reports stay
readable. Every one of those tuning decisions is a hole of a specific shape.

A secret split across a JSON structure, or encoded in a way that does not present as
base64 or hex, is not detected at all.

The opposite failure also matters: over-redaction destroys evidence. A report in which a
legitimate identifier was eaten by the entropy heuristic is a report in which a finding
became unreadable.

### 5.5 Inline credential detection is structural and therefore partial

`isInlineCredential` flags a value when its key name matches the secret pattern, or when
the value looks like an `Authorization` header value, and the value is at least eight
characters and is not an environment reference. That misses a live credential stored
under a key named something unremarkable, and misses a short one. It also cannot tell a
placeholder from a real key, so a config full of `REPLACE_ME_WITH_YOUR_TOKEN` values will
be reported as carrying inline credentials.

### 5.6 Auth posture classification is inference from a config file

`none` means "no credentials were visible in the configuration". A server may
authenticate through an ambient mechanism discovery cannot see. `oauth` is inferred from
the substring `oauth` appearing in the URL, which is a naming convention rather than a
protocol fact. `unknown` is returned rather than guessing when nothing can be
established, and that is the honest answer rather than a defect.

### 5.7 Name collision detection is string comparison

Detecting two servers advertising confusingly similar tool names is a lexical
comparison. It will miss a semantic impersonation with a dissimilar name, and will flag
legitimate cases where two servers genuinely offer a `search` tool. It is a prompt to
look, not a finding.

### 5.8 Reordering is invisible by design

Because descriptors are sorted by identity before hashing, a change consisting only of
reordering does not register. That is required, since deterministic `tools/list` ordering
is only a SHOULD in the specification and treating reordering as drift would fire on
conforming servers constantly. It is still, technically, a change mcpsteward cannot see.

---

## 6. Residual risk, and what to do in addition

If you run mcpsteward and nothing else, you have a local, unauthenticated,
self-witnessed record of what a set of servers claimed about themselves at various
points in time, plus a specification compliance grade. That is genuinely useful and it
is considerably less than "MCP security".

Do these things as well.

**Get the ledger roots off the machine.** This is the single highest value addition and
it directly addresses 4.1. Copy the current merkle root and the head entry hash into
something the local attacker cannot rewrite: a git repository with signed commits pushed
to a remote, a WORM bucket, an internal log pipeline, or a chat channel with retention.
An attacker who rebuilds the local chain then produces a chain that disagrees with the
copies, and the disagreement is the detection. mcpsteward cannot enforce this. Nothing in
the local design substitutes for it.

**Store the ledger and pins with restrictive permissions**, and treat write access to
them as equivalent to the ability to falsify the record, because it is.

**Actually read the surface before you pin it.** A pin is only worth the review that
preceded it. Spend the attention on tool descriptions and input schemas for any server
with filesystem, network, shell or credential reach. If you are pinning forty tools
without reading them, you are recording a baseline rather than approving one, and you
should not later read "no drift" as reassurance.

**Pin exact versions rather than `@latest`.** mcpsteward hashes what a server says, not
the code that says it. Version pinning and a lockfile are how you constrain the code.
Combining both gives you something neither provides alone.

**Move inline credentials into environment references and rotate anything found
inline.** A credential in a config file that mcpsteward found is a credential that may
already be in a git history or a synced folder. Rotate it rather than only relocating it.

**Run servers with the least environment and least filesystem access they can work
with.** mcpsteward's environment allowlist limits what it passes; it has no control over
what the client that actually uses the server passes, and the client is usually far more
generous.

**Use a runtime interception or policy layer if you need behavioural control.** Section
4.4 is not a gap mcpsteward will ever close. Something has to sit between the model and
the server and inspect calls.

**Treat the conformance grade as an interoperability measurement.** Do not let a letter
next to a server name become a trust rating in anyone's head, including your own.

**Do not capture a server you would not run.** Section 4.9. Capture executes it.

**Review `VERIFY.md`.** It holds the config paths that could not be confirmed, the
`UNVERIFIED` rules, and everything else awaiting human confirmation. It is a real list
of known gaps, not a formality.

---

## 7. Reporting

Security issues go through the private process in `SECURITY.md`, not a public issue.
Secret disclosure, ledger forgery, false trust, unexpected network access, and code
execution from parsing untrusted input are all in scope and treated as high severity. Do
not include real credentials in a report; send the shape rather than the value.
