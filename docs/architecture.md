# Architecture

How mcpsteward is put together, and why each part is the shape it is.

This document is written for an engineer evaluating whether the guarantees are real.
It assumes you will disagree with some of the choices, so every one of them names the
alternative that was rejected and what it would have cost.

Two documents sit next to this one. `docs/formats.md` specifies the on disk formats
precisely enough to write an independent verifier. `docs/threat-model.md` states what
this design does not protect you from, which is at least as important as what it does.

---

## 1. The pipeline

Everything mcpsteward does runs through one pipeline. The first five stages are shared.
The last stage forks: the same captured, canonicalized, hashed surface either gets
graded against the specification, or gets recorded and diffed against a pin.

```
  STAGE 1                STAGE 2           STAGE 3
  discover               connect           capture surface
  (offline, passive)     (network)         (network)
  +----------------+     +-----------+     +---------------------+
  | read client    |     | stdio:    |     | era probe           |
  | config files   |     |  spawn    |     | server/discover     |
  | parse per      | --> |  child    | --> | tools/list          |
  | client format  |     | http:     |     | prompts/list        |
  | normalise      |     |  POST +   |     | resources/list      |
  | deduplicate    |     |  SSE      |     | resources/templates |
  | classify auth  |     +-----------+     | (paginated)         |
  +----------------+                       +---------------------+
         |                                            |
         | ServerRef[]                                | raw JSON text
         |                                            v
         |                                 STAGE 4
         |                                 canonicalize
         |                                 +---------------------------+
         |                                 | parse preserving number   |
         |                                 |   tokens (not JSON.parse) |
         |                                 | sort keys, minimal escape |
         |                                 | normalise number tokens   |
         |                                 +---------------------------+
         |                                            |
         |                                            | canonical text
         |                                            v
         |                                 STAGE 5
         |                                 hash
         |                                 +---------------------------+
         |                                 | per descriptor  (SHA-256) |
         |                                 | per category    (merkle)  |
         |                                 | surface root    (merkle)  |
         |                                 +---------------------------+
         |                                            |
         v                                            v
  inventory report            +-------------------------------------------+
                              |                                           |
                              v                                           v
                    STAGE 6a  conformance                  STAGE 6b  ledger and drift
                    +---------------------------+          +--------------------------+
                    | run rule registry against |          | append entry, hash       |
                    |   surface + evidence      |          |   chained to the previous|
                    | weight MUST over SHOULD   |          | diff current root        |
                    | drop UNVERIFIED from score|          |   against the pin        |
                    | letter grade              |          | classify + risk score    |
                    +---------------------------+          +--------------------------+
```

### Stage 1: discover

Passive and entirely offline. `src/discovery/` walks the known configuration paths of
Claude Desktop, Claude Code, Cursor, VS Code with Copilot, Windsurf, Cline, Zed, and
the generic `mcp.json` convention, parses each client's format, and normalises every
entry into one `ServerRef`.

Three things happen here that are worth naming.

**Deduplication is by identity, not by name.** The same server registered in four
clients is one server with four registration sites. Identity is the command plus its
arguments for stdio, and the normalised URL for HTTP. Name is deliberately excluded,
because the same server is routinely registered under different names in different
clients and treating those as distinct would inflate the inventory and split one
server's history across several pins. See `identityOf` in `src/discovery/parse.ts`.

**Inline credentials are detected structurally.** A value is flagged when its key name
matches the secret name pattern and the value is neither an environment reference
(`${VAR}`, `$VAR`, `%VAR%`, empty) nor too short to be a credential. Nothing is
inferred by connecting to anything, and the value itself is never retained: only an
eight character SHA-256 fingerprint, which is enough to tell whether two config files
hold the same credential without either file's content ever reaching a report.

**Auth posture can be `unknown`, and that is a real answer.** A server with no visible
credentials may still authenticate through an ambient mechanism discovery cannot see.
Reporting `none` there would overstate what was actually established.

Stage 1 opens no sockets and spawns no processes. That property is asserted by a test,
not just by inspection.

### Stage 2: connect

`src/protocol/stdio-transport.ts` and `src/protocol/http-transport.ts` implement one
narrow `Transport` interface: send a JSON-RPC message, get a parsed value back, be
disposable.

The stdio transport is the one with sharp edges, and each is handled deliberately:

- **No shell, except where Windows leaves no choice.** `shell: false` on the spawn. The
  command and its arguments come from a configuration file this package did not write,
  and routing through a shell would turn an argument containing a semicolon into
  arbitrary code execution. A Windows batch file such as `npx.cmd` can only run under
  `cmd.exe`, so `src/protocol/launch.ts` resolves the command against `PATH` itself and,
  for a batch file only, builds a `cmd.exe` invocation with every argument escaped
  twice. D-013 explains why twice.
- **Environment isolation.** The child receives the values its own configuration entry
  supplies, placeholders such as `${env:NAME}` filled, plus a short allowlist of
  variables that describe the machine rather than the user. Never the parent
  environment wholesale: inheriting would leak every credential this process holds into
  a server that may be hostile. D-014.
- **stderr is not an error channel.** The specification says a server may write
  anything there and a client should not read it as a problem. It is captured
  separately, capped at 64 KiB, and never merged into the message stream.
- **Shutdown is a sequence, not a kill.** Close stdin, wait, force terminate only if
  the server does not go. On Windows the whole process tree is terminated, because
  killing a process there does not kill its descendants and an MCP server launched
  through `npx` is a shell wrapping the real server.
- **Bounded framing.** A single line is capped, so a server that never emits a newline
  cannot make the read buffer grow without limit.

### Stage 3: capture surface

`src/protocol/client.ts` probes which protocol era the server speaks, calls
`server/discover` where the revision provides it, then walks `tools/list`,
`prompts/list`, `resources/list` and `resources/templates/list` with pagination.

Two design points matter downstream.

**A downgrade is never invisible.** `revisionRequested` and `revisionUsed` are
recorded separately on every surface. A capture that fell back to `2025-11-25` is
never presented as a current one.

**Evidence is kept alongside the surface.** A `ServerSurface` carries descriptors and
hashes. A `CaptureEvidence` carries the raw list results, the negotiation outcome, and
the error codes returned by methods that failed. Conformance grades things the surface
deliberately does not hold, such as whether a `tools/list` result included `ttlMs` and
`cacheScope`. Discarding the raw results would force a second capture to grade one, and
a second capture is a second point in time, which would make the grade and the ledger
entry describe different observations.

### Stage 4 and 5: canonicalize and hash

Covered in full in sections 2 and 3 below.

### Stage 6a: conformance grading

The rule registry runs against `{ surface, evidence }`. Covered in section 4.

### Stage 6b: ledger append and drift diff

Covered in section 5. Implemented in `src/ledger/index.ts` and `src/trust/index.ts`,
though not yet reachable from a command line.

---

## 2. The merkle design

`src/core/merkle.ts`. Three hash levels: per descriptor, per category, and a root.

| Level | What it covers | Built from |
| --- | --- | --- |
| Descriptor | one tool, prompt, resource or resource template | SHA-256 over the descriptor's canonical JSON |
| Category | all tools, or all prompts, and so on | merkle root over descriptor hashes, sorted by identity |
| Surface root | the whole advertised surface | merkle root over `node(hash(categoryName), categoryRoot)` for each present category |

A flat digest over the whole surface would answer "did anything change" and nothing
else. The tree lets a diff point at exactly which descriptor moved, and lets an
inclusion proof show that a specific tool definition was present in a specific ledger
entry without republishing the entire surface, which matters when the surface is itself
the sensitive part.

### Leaf and node domain separation

Leaves are hashed with a `0x00` prefix, internal nodes with `0x01`. This is RFC 6962
section 2.1 and it is not decoration.

Without the prefixes, an attacker who controls a leaf value can supply a value that is
itself the concatenation of two child hashes. The tree then verifies against a root it
should not, because a leaf hash and an internal node hash are computed the same way and
nothing distinguishes one from the other. That is the standard second preimage attack
on merkle trees. The one byte prefix makes the two hash computations live in disjoint
domains, so no leaf preimage can ever be mistaken for a node preimage.

Both `merkleLeaf` and `merkleNode` hash the raw 32 bytes decoded from the hex, not the
hex text, so an independent verifier must decode before hashing.

### Odd trailing nodes are promoted, not duplicated

When a level has an odd number of nodes, the last one is carried unchanged to the next
level. It is not paired with a copy of itself.

Duplication is the Bitcoin construction and it admits a known collision. Consider a
level `[a, b, c]`. Under duplication it pairs as `[node(a,b), node(c,c)]`. Now consider
a level `[a, b, c, c]`, which is a genuinely different descriptor list with four
members. It pairs as `[node(a,b), node(c,c)]`, the same. Two different surfaces produce
the same root, which means a server could add a duplicate of an existing tool and the
ledger would not see it. Promotion has no such ambiguity: every distinct leaf list
produces a distinct tree shape.

### Descriptors are sorted by identity before hashing

Within each category, descriptors are sorted by identity before the merkle root is
built. The wire order a server happened to return them in has no effect on the root.

This is required, not cosmetic. Deterministic ordering from `tools/list` is only a
SHOULD in the specification (rule MS-TOOL-002), so a fully conforming server may
legitimately return its tools in a different order between two calls. If order fed the
root, every such server would report drift on every capture, and a drift signal that
fires constantly is a drift signal nobody reads. The trust layer must treat reordering
as no change, because the specification says it is no change.

The consequence is stated plainly: mcpsteward cannot detect a change that consists only
of reordering. That is the correct behaviour under the specification and it is recorded
here so nobody has to rediscover it.

### Descriptor identity is separate from content hash

`Descriptor` carries both an `identity` (the tool name, or the resource URI) and a
`hash` (SHA-256 over its canonical form). Identity answers "which tool is this". The
hash answers "has it changed".

Collapsing the two would be the single most damaging simplification available here.
Without the split, a tool whose description was edited reads as a removal of the old
tool plus an addition of a new one. That is exactly backwards, because a description
change on an existing, already approved tool is the highest signal event this package
looks for. Tool poisoning works by changing the text the model reads while the name and
the schema stay put. A diff that renders that as `removed: search` plus
`added: search` buries the finding in noise that looks like ordinary churn.

### Empty and absent categories

The empty tree root is SHA-256 of the empty string, so a category with zero descriptors
still has a well defined root. Categories with no descriptors are **omitted** from
`byCategory` rather than mapped to that value, which keeps "advertises no prompts at
all" distinguishable from "advertises an empty prompt list".

The category name is folded into the surface root via `node(hash(name), categoryRoot)`,
so the same descriptor list appearing under two different categories cannot collapse to
the same surface root.

### Duplicate identities are refused

Two descriptors with the same identity in the same category means the server advertised
the same tool twice. Which one is authoritative is undefined, so there is no honest
hash for that surface and `computeSurfaceHashes` throws rather than picking one.

---

## 3. Canonicalization

`src/core/canonical.ts` and `src/core/json-parse.ts`.

The property that matters is narrow and absolute: **two inputs hash the same if and
only if they are semantically the same JSON value.** Everything else in this section is
in service of that.

RFC 8785, the JSON Canonicalization Scheme, is followed in spirit: object keys sorted
by UTF-16 code unit, no insignificant whitespace, minimal string escaping, stable
Unicode handling, no locale sensitivity anywhere. The key comparator is written out by
hand rather than relying on the default `Array.prototype.sort` behaviour, so the
requirement stays visible to the next person who refactors it and so it is obvious that
`localeCompare`, which would make hashes depend on the machine's locale, is not in use.

### The number deviation, and why

RFC 8785 serialises numbers using ECMAScript `Number::toString`, which means round
tripping every number through an IEEE 754 double. For an interoperability standard that
is the right call. For a trust ledger it is a correctness bug.

`9007199254740993` and `9007199254740992` are different integers. Both become
`9007199254740992` as doubles. If canonicalization routes through a double, a tool
schema can change in a way a double cannot represent, and the surface hash will not
move. A ledger that cannot see a change is not a ledger.

So mcpsteward ships its own JSON parser. `parseJsonPreservingNumbers` returns every
number as a `JsonNumber` carrying its exact source token, and the canonicalizer
normalises that token as a decimal string with no `Number` conversion anywhere in the
path.

The canonical form is normalised scientific notation: sign, one significant digit, an
optional fractional remainder, `e`, and a signed decimal exponent.

| Input tokens | Canonical form |
| --- | --- |
| `1`, `1.0`, `1.000` | `1e0` |
| `100`, `1e2`, `1.0E+2` | `1e2` |
| `0`, `-0`, `0.0` | `0` |
| `0.1` | `1e-1` |
| `9007199254740993` | `9.007199254740993e15` |

Semantically identical values collapse to the same form. Semantically distinct values
never do, however many digits they carry. Leading zeros are stripped, trailing zeros
move into the exponent, and the digit string is never truncated.

Negative zero canonicalises to `0`, matching RFC 8785. JSON offers no distinction
between the two that a consumer could act on, and treating them as different would move
the hash on a round trip through almost any JSON library, producing false drift.

The cost of the deviation is stated openly: mcpsteward's hashes will not match other JCS
implementations. Interoperability was traded for the ability to see a class of change
this package exists to detect. `docs/formats.md` specifies the number rule precisely
enough for an independent verifier to reproduce it, which is the obligation that
deviation creates. See `DECISIONS.md` D-009.

### Duplicate object keys are rejected

RFC 8259 permits duplicate keys and leaves the resolution to the implementation. Every
available choice is defensible in isolation and indefensible here: last-wins and
first-wins produce different hashes for byte identical input, so two conforming
implementations of this format would disagree about what a document hashes to.

Rejecting is the only option that keeps the format independently verifiable. It also
closes a smuggling path: under last-wins, a hostile server could hide a tool definition
from the ledger while a more permissive client still parsed and used it. See
`DECISIONS.md` D-010.

### Other parser properties

Strict RFC 8259 throughout: no comments, no trailing commas, no `NaN`, no `Infinity`,
no single quotes, no leading zeros, no leading plus, no unescaped control characters in
strings. Nesting is bounded at 512 levels, because a hostile server can otherwise send
`[[[[[...]]]]]` and blow the stack. Lone surrogates pass through unchanged rather than
being replaced, so canonicalization never alters the content it is supposed to be
measuring.

### The `sha256:` prefix on every hash

Hashes are rendered as `sha256:<64 hex>`, never bare hex. Two reasons.

Algorithm agility: an unlabelled digest means a future move to a different hash
function would produce values indistinguishable from the old ones inside existing
ledgers.

More immediately, the redaction module's high entropy heuristic redacts hex runs of 32
characters or more, and a surface merkle root is exactly 64 hex characters. Without the
marker, mcpsteward's own hashes were being eaten before they reached a report, which the
tests caught. The prefix is what lets the redactor recognise a hash as a trusted own
value. Exempting all 64 character hex runs instead would carve a hole a hostile server
could drive a credential through by padding it to length. See `DECISIONS.md` D-011.

### The convenience path is deliberately lossy, and says so

`canonicalizeValue` accepts a JavaScript value for things this package constructs
itself, such as ledger entries. By the time a value reaches it, any large integer has
already been through a double and the original token is gone. Rather than silently
rounding, it **throws** on an unsafe integer and tells the caller to canonicalize from
the original JSON text instead. Anything that arrived from a server must use
`canonicalizeJsonText`.

---

## 4. Why every rule is deterministic

`src/conformance/`. Four properties, each enforced by something stronger than
intention.

**No LLM anywhere in the core.** Not for rule evaluation, not for description analysis,
not for risk scoring. This is a product constraint, not a limitation. A finding that
came from a model is a finding that may not reproduce, cannot be traced to a
requirement, and cannot be argued with. An optional local model plugin is contemplated
for semantic analysis, and if it is ever built it will live behind a separate entry
point, be disabled by default, and never be required for any core function.

**Every rule carries a spec citation, enforced by the type system.** `ConformanceRule`
requires a `citation` field, so a rule invented from memory does not compile. This is
the invariant that keeps the package honest. A tool that reports plausible fiction is
worse than one with fewer rules, because a finding nobody can trace to a requirement is
a finding nobody can act on. `SPEC-NOTES.md` is the source of truth; where a rule and
that file disagree, the rule is wrong.

**UNVERIFIED rules report but never affect the score.** A rule marked `UNVERIFIED` is
plausible but was not grounded in fetched specification text. It still runs, it still
appears in the report, and it is listed in `VERIFY.md` for a human to confirm, but it
contributes nothing to `earned` or `possible`. This is the mechanism that lets the
registry be honest about uncertainty instead of quietly omitting a rule or quietly
letting it move someone's grade.

**Grading reads no clock and no random source.** Nothing in `grade()` touches
`Date.now`, `Math.random`, the filesystem or the network. The same server plus the same
tool version yields the same grade, byte for byte. A grade that drifts between runs
cannot be used as evidence, and evidence is the entire point of producing one.

Two further properties of the grading model:

*Rules are capability driven.* A server that does not declare `prompts` is not failed
for prompt rules; it reports `not-applicable`. No false failures for unclaimed features.

*MUST dominates and caps the letter.* MUST carries a weight of 10, SHOULD carries 2,
MAY carries 0. Beyond the weighting, a single MUST failure caps the letter at C
regardless of the percentage, two caps it at D, three or more at F. A server can
satisfy every SHOULD in the specification and still be unusable if it does not
implement `server/discover`, so letting a high percentage paper over a mandatory
failure would make the letter meaningless. `not-applicable` and `inconclusive` count
neither for nor against; a rule that could not be tested is not a rule the server
failed.

`docs/rules.md` is generated from the registry rather than hand written, so it cannot
drift from the code.

---

## 5. The ledger format rationale

> **Status: implemented and exposed.** `src/ledger/index.ts` implements the format
> described below, including append, chain verification and compaction, covered by 34
> tests and a seeded byte corruption fuzz. It is reachable from the command line as
> `ledger log`, `ledger verify` and `ledger export`.
>
> This section is the rationale. The normative specification, precise enough to write
> an independent verifier against, is `docs/formats.md`.

### The intended entry

```ts
interface LedgerEntry {
  sequence: number;                            // monotonic, from zero, no gaps
  timestamp: string;                           // ISO 8601, always UTC
  serverId: string;
  revisionUsed: ProtocolRevision;
  transport: TransportKind;
  surfaceRoot: ContentHash;
  descriptorHashes: Record<string, ContentHash>;
  toolVersion: string;
  durationMs: number;
  previousHash: ContentHash;                   // or the genesis constant at sequence 0
  entryHash: ContentHash;                      // over the canonical form of all the above
}
```

### Why these fields

`sequence` and `previousHash` together are the chain. Sequence makes a gap or a
reordering detectable independently of the hashes, so corruption can be reported as
"entry 47 is missing" rather than only as "the chain broke somewhere". `previousHash`
makes a rewritten middle entry invalidate every entry after it.

`surfaceRoot` is what the chain is really protecting. `descriptorHashes` is carried
alongside it so a diff can localise a change without needing the original surface, and
so an inclusion proof can be checked against an entry in isolation.

`toolVersion` is recorded because the canonicalization rules are part of what a hash
means. If a future version changes how a number token normalises, an entry written by
the old version must remain verifiable against the old rules rather than silently
failing under the new ones.

`revisionUsed` and `transport` are recorded because the same server can be captured two
ways and the answers are not required to be identical. An entry that did not say how it
was obtained would be evidence of nothing in particular.

`durationMs` is operational rather than security relevant. It is in the hashed set
anyway, because a field outside the hash is a field an attacker can edit freely, and
carving exceptions into what is covered is how chained logs acquire holes.

### Why append-only and hash chained rather than signed

A signature needs a key, a key needs somewhere to live, and a key on the same disk as
the ledger protects against nothing that the chain does not already cover. This
absolute constraints rule out a hosted service, an account and a network anchor, so
there is no third party to notarise against and no external timestamp to bind to.

The honest consequence, stated here and expanded in the threat model: **the chain
proves internal consistency, not authenticity.** It detects truncation, reordering, a
rewritten middle entry and a missing entry. It does not detect an attacker with write
access who rebuilds the entire chain from entry zero, because that attacker can produce
a chain that is perfectly self consistent and says whatever they want. Making that case
detectable requires exporting roots to somewhere the attacker cannot reach, which is an
operational practice mcpsteward can document but cannot enforce.

### Intended durability properties

Atomic append, so a process killed mid write leaves the previous valid chain intact
rather than a half entry that fails verification. A versioned on disk header, so a
format change is a version bump rather than a mystery parse error. A verify operation
that walks the chain and names the exact sequence number where integrity fails.
Truncation, a rewritten middle entry, a reordered entry and a missing entry each
produce a distinct typed error naming what is wrong, because "ledger corrupt" is not an
actionable message.

Compaction, if it happens at all, must preserve verifiability. A documented decision not
to compact is an acceptable outcome and is preferable to a compaction scheme that
quietly breaks the chain.

---

## 6. Cross cutting: redaction

`src/core/redaction.ts` is not a pipeline stage. It is a boundary. Every string leaving
this package toward a report, a log line, a ledger entry or an error message passes
through `redact` first.

Two properties are held in deliberate tension. **Never leak:** when in doubt, redact,
because a false positive costs a reader some context and a false negative costs a user
their credential. **Stay useful:** output preserves the shape of what was removed and
carries a stable fingerprint, so `sk-REDACTED-4f2a1c9b` in Monday's report and in
Friday's report is recognisably the same key without either report ever holding it.

Ordering inside `redact` is load bearing and runs from most specific to least: park our
own hashes and previously emitted tokens behind a NUL sentinel, then exact known
secrets longest first, PEM blocks, connection string userinfo, authorization schemes,
seventeen vendor key prefixes, JSON Web Tokens, secret shaped assignments, and finally
the generic high entropy catch-all. The parking step exists because three separate bugs
had the same root cause: a later pattern consuming the output of an earlier one. See
`DECISIONS.md` D-007.

The ledger's append-only nature raises the stakes here specifically. A secret written
into a report can be deleted. A secret written into a hash chained ledger cannot be
removed without invalidating every entry after it.

What redaction does not cover, and the confirmation oracle the fingerprint creates, are
in `docs/threat-model.md`.
