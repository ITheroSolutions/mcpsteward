# Security Policy

## Supported versions

mcpsteward is pre 1.0. Only the latest published minor version receives security
fixes. Once 1.0 ships, the latest two minor versions will be supported.

## Reporting a vulnerability

Report privately. Do not open a public issue for a security problem.

Use GitHub private vulnerability reporting on the repository, under the Security
tab, "Report a vulnerability". If that is unavailable, email
ithero.services@gmail.com with `mcpsteward security` in the subject line.

Please include:

- the version of mcpsteward and the Node version
- what you did, what you expected, and what happened
- a minimal reproduction if you have one
- whether the issue exposes data, and roughly what kind

Do not include real credentials in a report. If a secret leaked into output, send
the shape of it rather than the value.

## What to expect

- acknowledgement within three working days
- an initial assessment, including whether it is accepted as a vulnerability, within
  ten working days
- a fix or a documented mitigation before public disclosure, coordinated with you
- credit in the release notes unless you ask otherwise

## Scope

The following are in scope and treated as high severity:

- **Secret disclosure.** Any path where a credential encountered during discovery or
  capture reaches a report, a ledger entry, a log line, an error message, or the
  terminal. Redaction is the single highest consequence component in this package.
- **Ledger forgery.** Any way to modify, reorder, truncate or replace ledger entries
  and still have `mcpsteward ledger verify` report the chain as valid.
- **False trust.** Any way to make a changed server surface compare as unchanged
  against a pin, or to make a failing conformance check report as passing.
- **Unexpected network access.** Any network request during `discover`, `ledger
  verify`, or `policy check`, or to a host other than the server explicitly named for
  inspection. This includes automatic dereferencing of a `$ref` in a tool schema,
  which the specification forbids by default.
- **Code execution from untrusted input.** Any path where parsing a client config, a
  server surface, a ledger, or a policy file leads to execution.

## Out of scope

- The risk scoring heuristic being wrong about a given tool. It is documented as a
  heuristic, not a guarantee, and its weights are configurable.
- Conformance rules marked `UNVERIFIED`. These are excluded from the graded score
  precisely because they are not yet grounded in fetched specification text.
- Vulnerabilities in an MCP server you point mcpsteward at. Report those to that
  server's maintainer.
- The behaviour of a server that is itself hostile toward its own clients, beyond
  mcpsteward correctly reporting what that server advertised.

## Threat model

`docs/threat-model.md` states what this tool defends against, what it does not, and
where the heuristics are weak. Read it before relying on mcpsteward as a control.
