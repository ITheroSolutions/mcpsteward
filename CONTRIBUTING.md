# Contributing to mcpsteward

## Ground rules

mcpsteward makes three promises that constrain every contribution:

1. **No cloud, no account, no telemetry.** The only network access at runtime is
   connecting to the MCP servers the user explicitly asked to inspect.
2. **No LLM calls in the core.** Every rule and every detection is deterministic and
   explainable. This is the differentiator, not a limitation.
3. **Secrets never leak.** Nothing that looks like a credential reaches a report, a
   ledger entry, a log line, or an error message.

A change that weakens any of these will not be merged, however useful it is otherwise.

## Getting started

```bash
npm install
npm run verify
```

`verify` runs typecheck, lint, test and build in that order. It must pass before you
open a pull request, and it must pass at every commit on your branch.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Type check without emitting |
| `npm run lint` | ESLint over the whole tree |
| `npm run lint:fix` | ESLint with autofix |
| `npm run test` | Run the suite once |
| `npm run test:watch` | Watch mode |
| `npm run coverage` | Coverage with thresholds enforced |
| `npm run build` | Emit `dist` via tsc |
| `npm run verify` | All of the above, in order |

## Adding a conformance rule

This is the most common contribution and it has the strictest bar.

A rule is only acceptable if it is grounded in specification text that someone actually
fetched. Rules invented from memory are worse than missing rules, because a tool that
reports plausible fiction is not usable as evidence.

Every rule must carry:

- a stable id, never reused or renumbered once released
- the applicable protocol revisions
- a normative level of MUST, SHOULD or MAY, matching the specification's own wording
- the requirement in one sentence
- a **citation** naming the specification section or SEP that justifies it
- a confidence level
- a remediation note written for the developer who has to fix it

The type system enforces the citation field: a rule without one does not compile.

If you cannot ground a rule in fetched specification text, mark it confidence
`UNVERIFIED`. It will report but will be excluded from the graded score and listed in
`VERIFY.md`. That is the correct home for a plausible but unconfirmed requirement.

Update `SPEC-NOTES.md` in the same pull request. `SPEC-NOTES.md` is the source of truth
for every protocol claim in the codebase. If the code and `SPEC-NOTES.md` disagree, the
code is wrong.

Every rule needs at least one passing fixture and one failing fixture, built from the
fixture server harness in `test/fixtures`. A rule with only one of the two is not done.

## Testing expectations

- Tests must pass at every commit. Never leave the repository broken.
- Never hit a real external MCP server in a test. Use the fixture harness.
- Write tests that would catch a regression, not tests that raise a coverage number.
- Redaction and the canonicalization and hashing core carry a higher bar than the rest
  of the package. Being wrong about either is worse than not shipping the feature.

## Dependencies

Do not add a dependency without justifying it in `DECISIONS.md`, including the
alternatives you rejected. Prefer writing eighty lines to adding a package.

The current runtime dependency budget is deliberately near zero. Read the relevant
entry in `DECISIONS.md` before proposing an addition.

## Writing style

This applies to code, comments, documentation, commit messages, CLI output strings,
error messages and report templates.

- No em dashes.
- No hyphens used as sentence punctuation. Hyphenated compound words such as
  local-first and append-only are fine.
- No emojis.

Commit message bodies use hyphens between words rather than spaces.

## Commits and pull requests

- Commit after every meaningful unit of work.
- Write a descriptive commit message. Explain why, not only what.
- Keep a pull request to one coherent change.
- Update `CHANGELOG.md` under `Unreleased` for anything user visible.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating
you agree to uphold it.
