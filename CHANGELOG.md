# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Within a major version, two things are treated as public API and will not break
without a major bump: the `--json` output shape, and the gate contract
(`id`, `title`, `description`, `severity`, `defaults`, `appliesTo`, `run`).

## [0.1.0] - 2026-02-14

First release.

### Added

- Twelve stack-agnostic gates, each individually enable-able, configurable and
  severity-adjustable:
  - `TODO_DENSITY`, unannotated deferral markers in added lines.
  - `DEBUG_RESIDUE`, print, log and breakpoint calls in changed production
    source, with per-language rules and entry-point suppression.
  - `SKIPPED_TESTS`, skip, todo and focus markers across common frameworks.
  - `SECRET_SHAPED_LITERAL`, issuer-prefixed tokens and credential-shaped
    assignments, with placeholder filtering and masked reporting.
  - `COMMIT_SIZE`, oversized changes with no stated reason.
  - `PLAN_DELIVERABLES`, open items in a referenced plan the commit never
    accounts for.
  - `TEST_FOR_NEW_LOGIC`, new branching modules no test exercises.
  - `DROP_IMPACT`, deleted paths and symbols that surviving code still
    references, with resolved import specifiers and moved-symbol suppression.
  - `EPHEMERAL_LIFECYCLE`, new tables with an expiry column and no index,
    cleanup or retention policy.
  - `SMOKE_EVIDENCE`, user-facing changes with no record of the feature being
    exercised.
  - `DELIVERED_LOCK`, release claims with no runtime observation behind them.
  - `PROJECT_TESTS`, the project's own suite, with environment-shaped skip
    reasons rejected.
- Command line with `--list`, `--json`, `--gate`, `--staged`, `--commit`,
  `--message-file`, `--strict`, `--verbose`, `--config`, `--cwd` and
  `--no-color`.
- `--install-hooks`, writing a `commit-msg` hook that respects `core.hooksPath`
  and refuses to overwrite a hook it did not write.
- `--init`, writing a starter `.agentgatesrc.json`.
- Strict configuration validation: unknown gate ids, unknown option names and
  wrong types are hard errors rather than silent no-ops.
- Documented escape hatch, `agent-code-gates-skip: <GATE_ID> <reason>`, limited
  to one gate per commit and reported in every output format.
- Programmatic API, including support for passing custom gates to `runGates`.
- Zero runtime dependencies; tests run on `node --test` with no dev
  dependencies.

[0.1.0]: https://github.com/danilolapegna/agent-code-gates/releases/tag/v0.1.0
