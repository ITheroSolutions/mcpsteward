# On disk formats

This document specifies the ledger and pin formats precisely enough that someone
could write an independent verifier without reading the mcpsteward source.

That matters more than it might appear. A trust format only one implementation can
check is not a trust format: if the tool that wrote the ledger is the only thing
that can validate it, then the ledger proves nothing that the tool's own claim did
not already prove. Everything below is normative.

An independent verifier written from this document is welcome, and is the point.

## Contents

1. [Content hashes](#1-content-hashes)
2. [Canonical JSON](#2-canonical-json)
3. [Descriptor hashing](#3-descriptor-hashing)
4. [The merkle tree](#4-the-merkle-tree)
5. [The ledger](#5-the-ledger)
6. [Trust pins](#6-trust-pins)
7. [Worked example](#7-worked-example)
8. [Verifying independently](#8-verifying-independently)

---

## 1. Content hashes

Every hash in every format is written as:

```
sha256:<64 lowercase hexadecimal characters>
```

The prefix is mandatory and part of the value. A bare digest is not a valid content
hash and a verifier must reject it.

Two reasons. Algorithm agility, so a future change of hash is distinguishable
rather than silently producing values that look identical to the old ones. And
mcpsteward's own redaction pass treats a `sha256:` prefixed string as a trusted
value it must not touch, while a bare 64 character hex run matches its high entropy
heuristic and would be destroyed before reaching a report.

The digest is SHA-256 as specified in FIPS 180-4, over the UTF-8 encoding of the
canonical text defined in section 2.

---

## 2. Canonical JSON

Canonicalization follows RFC 8785 (JSON Canonicalization Scheme) in structure, with
one deliberate and normative deviation on numbers.

### 2.1 Structure

- Object keys are sorted ascending by UTF-16 code unit. This is a plain code unit
  comparison, never a locale aware one: a locale aware sort would make a hash
  depend on the machine that computed it.
- No whitespace is emitted anywhere.
- Arrays preserve their order. Order is meaningful in an array and must not be
  normalised.
- `null`, `true` and `false` are emitted as those literals.

### 2.2 Strings

Minimal escaping. The following are escaped and nothing else is:

| Character | Emitted as |
| --- | --- |
| `"` | `\"` |
| `\` | `\\` |
| U+0008 | `\b` |
| U+000C | `\f` |
| U+000A | `\n` |
| U+000D | `\r` |
| U+0009 | `\t` |
| Any other code point below U+0020 | `\u00xx`, lowercase hex |

Every other character, including all non ASCII, is emitted literally as UTF-8. The
forward slash is **not** escaped. Lone surrogates are passed through unchanged
rather than replaced, because canonicalization must never alter the content it
exists to measure.

### 2.3 Numbers, the deviation

**This is where mcpsteward departs from RFC 8785, deliberately.**

RFC 8785 serialises numbers using ECMAScript `Number::toString`, which means
routing every number through an IEEE 754 double. For an interoperability oriented
canonicalization scheme that is the right call. For a trust ledger it is a
correctness bug: `9007199254740993` and `9007199254740992` are different integers
that both become `9007199254740992` as doubles, so a tool schema could change in a
way a double cannot represent and the surface hash would not move.

A ledger that cannot see a change is not a ledger.

So numbers are normalised **from the source token**, with no floating point
conversion at any point.

Given a JSON number token matching the RFC 8259 grammar:

```
token   = [ "-" ] int [ frac ] [ exp ]
```

1. Extract the sign, the integer digits, the fraction digits, and the exponent.
   An absent exponent is `0`.
2. Concatenate the integer and fraction digits into one digit string, and subtract
   the fraction length from the exponent.
3. Strip leading zeros from the digit string.
4. If no digits remain, the value is zero. **Emit `0`.** This is the only form for
   zero: `0`, `-0`, `0.0` and `0e100` all canonicalize to `0`. Negative zero
   collapses to zero, matching RFC 8785, because JSON offers no distinction between
   them that a consumer could act on.
5. Strip trailing zeros from the digit string, adding one to the exponent for each.
6. Add `digits.length - 1` to the exponent.
7. Emit `<sign><first digit>[.<remaining digits>]e<exponent>`.

The exponent is written in decimal with a leading `-` when negative and no `+` when
positive.

| Input tokens | Canonical form |
| --- | --- |
| `0`, `-0`, `0.0`, `0e100` | `0` |
| `1`, `1.0`, `1.000` | `1e0` |
| `-1` | `-1e0` |
| `100`, `1e2`, `1.0E+2`, `1.00e2` | `1e2` |
| `0.1`, `1e-1` | `1e-1` |
| `1.5`, `1.50`, `15e-1` | `1.5e0` |
| `12345` | `1.2345e4` |
| `0.000123` | `1.23e-4` |
| `9007199254740993` | `9.007199254740993e15` |
| `123456789012345678901234567890` | `1.2345678901234567890123456789e29` |

Semantically identical values collapse to one form. Semantically distinct values
never do, however many digits they carry.

### 2.4 Parsing rules

The parser is strict RFC 8259. It rejects comments, trailing commas, single quotes,
unquoted keys, leading zeros, a leading `+`, a bare or trailing decimal point,
`NaN`, `Infinity`, unescaped control characters in strings, and any trailing
content after the top level value.

**Duplicate object keys are rejected**, not resolved. RFC 8259 permits them and
leaves the behaviour to the implementation, but last-wins and first-wins produce
different hashes for byte identical input, so any choice would make two conforming
verifiers disagree. Rejecting is the only option that keeps the format checkable.

Nesting is bounded at 512 levels. Deeper input is rejected rather than allowed to
exhaust the stack.

---

## 3. Descriptor hashing

A **descriptor** is one advertised item: a tool, a prompt, a resource, or a
resource template.

Its **identity** is read from a category specific field:

| Category | Identity field |
| --- | --- |
| `tool` | `name` |
| `prompt` | `name` |
| `resource` | `uri` |
| `resourceTemplate` | `uriTemplate` |

A descriptor with no identity is rejected. Identity and content hash are kept
separate on purpose: identity answers "which tool is this", the hash answers "has
it changed". Without the split, an edited description would read as a removal plus
an addition rather than as a modification, which is exactly the signal that matters
most.

A descriptor's **content hash** is:

```
sha256(canonical(descriptor JSON))
```

over the entire descriptor object exactly as the server sent it, canonicalized per
section 2.

Its **key**, used in maps throughout both formats, is:

```
<category>:<identity>
```

for example `tool:get_weather`.

---

## 4. The merkle tree

### 4.1 Domain separation

Leaves and internal nodes are hashed with distinct prefixes, per RFC 6962 section
2.1:

```
leaf(v)        = sha256( 0x00 || raw_digest_bytes(v) )
node(l, r)     = sha256( 0x01 || raw_digest_bytes(l) || raw_digest_bytes(r) )
```

`raw_digest_bytes` means the 32 decoded bytes of the hex digest, not the ASCII of
the hex string and not the `sha256:` prefix.

Without these prefixes an attacker who controls a leaf value could supply a value
that is itself the concatenation of two child digests, producing a tree that
verifies against a root it should not. This is the standard second preimage attack.

### 4.2 Building a root

Given an ordered list of content hashes:

1. If the list is empty, the root is `sha256("")`, that is
   `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
2. Map every element through `leaf`.
3. While more than one node remains, pair them left to right and replace each pair
   with `node(left, right)`.
4. **An odd trailing node is promoted unchanged to the next level.** It is not
   duplicated.
5. The single remaining node is the root.

Step 4 is normative and differs from the Bitcoin construction. Duplicating the last
node admits a collision where `[a, b, c]` and `[a, b, c, c]` produce the same root,
which would let two different descriptor lists be indistinguishable. Promotion has
no such ambiguity.

### 4.3 Surface hashes

Three levels are computed over a captured surface.

**Per descriptor.** As section 3.

**Per category.** For each category that has at least one descriptor:

1. Take that category's descriptors.
2. Sort them ascending by identity, using UTF-16 code unit comparison.
3. Build a merkle root over their content hashes.

Sorting is required. The specification only *recommends* deterministic ordering
from `tools/list` (a SHOULD, not a MUST), so a conforming server may legitimately
return its tools in a different order between calls, and treating that as a change
would produce constant false drift.

A category with no descriptors is **omitted entirely**, not mapped to the empty
root. That keeps "advertises no prompts" distinguishable from "advertises an empty
prompt list".

**The surface root.** For each present category, in the fixed order `tool`,
`prompt`, `resource`, `resourceTemplate`, compute:

```
node( sha256(utf8(category_name)), category_root )
```

The category name is hashed as **raw UTF-8 bytes**, not wrapped in JSON quotes. So
`tool` hashes the four bytes `tool`, giving
`sha256:7c9bbe5ec9b3fb774e8fa0f54247e93c34ddf8e5d16fe3073420de0ae81a262d`.

Then build a merkle root over that ordered list. Folding the category name in
prevents the same descriptor list under two different categories from producing
the same surface root.

A surface containing two descriptors with the same key is rejected. Which one is
authoritative is undefined, so there is no honest hash for it.

---

## 5. The ledger

### 5.1 File layout

UTF-8 text. One JSON value per line, terminated by `\n`. No line contains an
embedded newline.

Line 1 is the header. Every subsequent non empty line is an entry, in ascending
sequence order.

Newline delimited so a reader never has to hold the whole file in memory and an
interrupted write damages exactly one line.

### 5.2 Header

```json
{ "magic": "mcpsteward-ledger", "version": 1, "createdAt": "<ISO 8601 UTC>" }
```

A verifier must reject a file whose `magic` is not exactly `mcpsteward-ledger`, and
must reject a `version` it does not implement rather than attempting a best effort
read.

### 5.3 Entry

```json
{
  "sequence": 0,
  "timestamp": "2026-08-04T00:00:00.000Z",
  "serverId": "4f5b452d",
  "revisionUsed": "2026-07-28",
  "transport": "stdio",
  "surfaceRoot": "sha256:...",
  "descriptorHashes": { "tool:get_weather": "sha256:..." },
  "toolVersion": "0.1.0",
  "durationMs": 42,
  "previousHash": "sha256:...",
  "entryHash": "sha256:..."
}
```

`sequence` starts at 0 and increases by exactly 1 with no gaps.

`revisionUsed` is the revision the server **actually spoke**, which is not
necessarily the one requested. A capture that fell back to an older revision
records the older one here.

### 5.4 The genesis hash

The `previousHash` of entry 0 is a fixed constant:

```
GENESIS = sha256( utf8("mcpsteward-ledger/v1/genesis") )
        = sha256:2fe8269467a2d234aca03035f5f6dab4a4ecbd4d9c4c7b0b20beea650a486865
```

The input is the **raw UTF-8 bytes** of that string. It is not wrapped in JSON
quotes and not otherwise canonicalized, because it is a fixed label rather than a
JSON value.

A fixed constant rather than an empty string, so entry 0 is bound to this format
and version. A ledger cannot be re-headed by deleting the first entry and
presenting the second as the beginning.

### 5.5 Entry hash

`entryHash` is computed over the canonical form of an object containing **exactly
these ten fields** and no others:

```
sequence, timestamp, serverId, revisionUsed, transport,
surfaceRoot, descriptorHashes, toolVersion, durationMs, previousHash
```

That is, the entry with `entryHash` itself removed. Canonicalization sorts keys, so
the order listed here does not affect the result.

```
entryHash = sha256( canonical( { ...entry without entryHash } ) )
```

`durationMs` and `sequence` are JSON numbers and are canonicalized per section 2.3,
so `42` becomes `4.2e1` in the hashed text.

### 5.6 Verification algorithm

```
previous := GENESIS
for index, entry in entries:
    reject unless entry has all ten fields with correct types
    reject unless entry.sequence == index
    reject unless entry.previousHash == previous
    reject unless entry.entryHash == sha256(canonical(entry without entryHash))
    previous := entry.entryHash
accept
```

A verifier must report the **sequence number** at which verification failed. "The
ledger is corrupt" is not actionable; "entry 41 does not chain to entry 40" is.

An empty ledger, header only, is valid.

### 5.7 What this does and does not prove

It proves the chain is **internally consistent**: no entry has been modified,
removed, reordered or inserted without also recomputing every subsequent entry.

It does **not** prove the ledger is complete. Removing the last entries, cleanly at a
line boundary, leaves a shorter chain that this algorithm accepts, because nothing
inside the file records how long it should be. The entry count and the `entryHash` of
the last entry identify the whole chain; a verifier that wants to detect a shortened
ledger has to compare them with values recorded somewhere else.

It does **not** prove the ledger is authentic. Nothing here is signed, notarised,
or anchored outside the file. Anyone who can write the file can delete it and
rebuild a complete, perfectly self consistent chain from sequence 0, and this
algorithm will accept it. See `docs/threat-model.md` section 4.1.

### 5.8 Compaction

Compaction retains the most recent N entries per server and **re-chains them from
genesis**, reassigning sequence numbers from 0 so the result verifies as a valid
ledger in its own right.

It cannot preserve the link back to discarded history. Compaction is therefore an
explicit, irreversible loss of provenance, and must never be automatic.

---

## 6. Trust pins

One JSON object per file.

```json
{
  "serverId": "a1b2c3d4",
  "surfaceRoot": "sha256:...",
  "descriptorHashes": { "tool:get_weather": "sha256:..." },
  "fieldHashes": {
    "tool:get_weather": {
      "description": "sha256:...",
      "input": "sha256:...",
      "rest": "sha256:..."
    }
  },
  "revisionUsed": "2026-07-28",
  "approvedAt": "2026-08-04T00:00:00.000Z",
  "approvedBy": "reviewer",
  "note": "reviewed the tool descriptions"
}
```

`note` is optional. `fieldHashes` is optional, and absent from pins written before it
existed. Every other field is required.

A pin stores **hashes only**, never descriptor content. A pin should not be a copy
of a server's surface sitting in a file, both because it would be large and because
it would duplicate data whose whole point is to live at the server.

`approvedBy` is self reported free text. It is not authenticated and must never be
treated as a security control.

### 6.1 Field hashes

`fieldHashes` maps each descriptor key to hashes of its parts, so a diff can say
*which* part of a descriptor changed without the pin storing any of it. Each part is
hashed exactly as a whole descriptor is, `sha256` over its canonical JSON (section
3), with the same `sha256:` prefix:

| Key | Hashes | Present when |
| --- | --- | --- |
| `description` | the value of `description` | the descriptor has one |
| `input` | the value of `inputSchema` for a tool, `arguments` for a prompt | the descriptor has one |
| `rest` | the descriptor object with `description` and the input field removed | always |

A key is omitted, not set to null, when the part is absent. Two descriptors whose
`description` keys are both absent therefore compare equal on that part.

What a pin still cannot say is how the old text read, since it holds no text. A diff
against a pin therefore checks the *current* text for signs of poisoning. A diff
between two full captures, which have content on both sides, can compare the text
directly. Neither the pin nor the ledger stores descriptor content.

---

## 7. Worked example

A surface with one tool:

```json
{ "name": "ping_host", "description": "Pings a host.", "timeoutMs": 1000 }
```

**Canonical form.** Keys sorted, no whitespace, `1000` normalised to `1e3`:

```
{"description":"Pings a host.","name":"ping_host","timeoutMs":1e3}
```

**Descriptor hash.** `sha256` of those bytes, prefixed.

**Descriptor key.** `tool:ping_host`.

**Category root.** One descriptor, so the root is `leaf(descriptor_hash)`, that is
`sha256(0x00 || 32 raw bytes of descriptor_hash)`.

**Surface root.** One present category, so:

```
entry := node( sha256(utf8("tool")), category_root )
root  := leaf(entry)
```

with `sha256(utf8("tool"))` being
`sha256:7c9bbe5ec9b3fb774e8fa0f54247e93c34ddf8e5d16fe3073420de0ae81a262d`.

Note the two distinct hashings: `entry` is built with `node`, then that single
element list is passed through the root construction, which applies `leaf` to it.

---

## 8. Verifying independently

A verifier needs, in order:

1. A strict RFC 8259 parser that preserves number tokens as text. Using a language's
   built in JSON parser will produce wrong hashes for any integer beyond 2^53 and
   for many decimal fractions, because it will have already converted them to
   floating point. This is the single most likely source of a mismatch.
2. The canonicalizer of section 2.
3. SHA-256.
4. The merkle construction of section 4, being careful about the raw digest bytes
   in section 4.1 and the promotion rule in step 4 of section 4.2.
5. The chain walk of section 5.6.

If an independent implementation disagrees with mcpsteward about a hash, the number
handling in section 2.3 is the first place to look, and the second is whether raw
digest bytes rather than hex characters are being fed into the merkle prefixes.

Disagreements are worth reporting. A format that two implementations read
differently has a defect in its specification, and this document is the thing at
fault until proven otherwise.
