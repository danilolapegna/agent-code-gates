# agent-code-gates

Mechanical git gates that block AI-written code from being declared done when it isn't.

Zero runtime dependencies. Node 18 or later. Any language, any stack.

```
  FAIL  DEBUG_RESIDUE     1 debug statement added to production source.
        src/checkout.js:88   console.log('resp', resp)   (console debug call)

  FAIL  DELIVERED_LOCK    The commit claims a release but declares no runtime status.
        (this commit)     Checkout is production-ready and works end to end.

  BLOCKED  fix the failures above, or record a single exception in the commit body.
```

---

## The problem

LLM coding agents produce code that compiles, passes the test suite, and is still
not shippable. That is not a complaint about quality. It is a description of a
specific and now very common failure mode:

- The feature is 80 percent built and the last 20 percent is a comment that says
  `// TODO: handle the empty case`.
- Three of the five planned items shipped. The summary describes the three. The
  other two are not mentioned as missing, they are simply not mentioned.
- A test was disabled in the same commit as the feature it covered, so the suite
  is green and proves nothing.
- A key was inlined because the environment variable was not set yet and the
  code needed to run.
- A module was deleted and the type checker was satisfied, while four dynamic
  call sites survived and now fail at run time.
- Nothing was ever executed, and the commit message says "production-ready".

Every one of those passes CI. Every one of them is reported as complete.

### Why prose does not fix it

The usual response is to write it down: a checklist in the contributing guide, a
paragraph in the agent's system prompt, a definition of done in the wiki. This
does not work, and the reason it does not work is structural rather than moral.
Guidance is read at the moment of least attention, competes with the actual task,
and has no consequence when skipped. Under time pressure, a rule that costs
something and enforces nothing is the first thing dropped, by humans and models
alike.

A command that exits non-zero has none of those properties. It runs every time,
it costs nothing to remember, and it cannot be skipped by being busy.

That is the entire thesis of this tool: **the check has to be a command that
fails, not a sentence someone is supposed to remember.**

### The evidence

You do not have to take the argument on faith. Run the tool over your own recent
history and read what it finds:

```bash
npx agent-code-gates --commit HEAD~1
git log --format=%H -20 | xargs -I{} npx agent-code-gates --commit {} --json \
  | grep -c '"ok": false'
```

If the answer is zero, your process already works and you do not need this. In
most repositories where an agent has been writing code for a few months, it is
not zero.

---

## Quick start

```bash
npm install --save-dev agent-code-gates
npx agent-code-gates --install-hooks
```

That is the whole setup. The next commit runs the gates.

Try it without installing anything:

```bash
npx agent-code-gates --commit HEAD    # judge your last commit
npx agent-code-gates --list           # see every gate
```

### Why the hook is `commit-msg` and not `pre-commit`

At `pre-commit` time the commit message does not exist yet. Git has staged the
tree, but the message has not been written anywhere a hook can read it, and
`.git/COMMIT_EDITMSG` still contains the *previous* commit's text.

Five of the twelve gates read the message: the release claim, the plan statuses,
the size justification, the evidence block, and the escape hatch itself. Running
them at `pre-commit` means judging the wrong text while appearing to work, which
is the exact class of failure this tool exists to prevent. At `commit-msg` time
both inputs are final. One hook, both inputs, no stale reads.

The hook is installed at `$(git rev-parse --git-dir)/hooks/commit-msg`, or into
`core.hooksPath` when your project sets one.

---

## The gates

| Gate | What it catches | Default |
|---|---|---|
| `TODO_DENSITY` | `TODO`, `FIXME`, `HACK`, `XXX` added with no annotation | error |
| `DEBUG_RESIDUE` | `console.log`, `debugger`, `print()`, `pdb` in changed production source | error |
| `SKIPPED_TESTS` | `.skip`, `xit`, `test.todo`, `@pytest.mark.skip`, `[Ignore]`, `.only` added | error |
| `SECRET_SHAPED_LITERAL` | API keys, tokens, passwords, JWTs and private keys committed as literals | error |
| `COMMIT_SIZE` | Change past the review budget with no stated reason | warning |
| `PLAN_DELIVERABLES` | Items in a referenced plan the commit never accounts for | error |
| `TEST_FOR_NEW_LOGIC` | New file with branching logic that no test exercises | warning |
| `DROP_IMPACT` | Deleted file or exported symbol that surviving code still references | error |
| `EPHEMERAL_LIFECYCLE` | New table with an expiry column, no index, no cleanup, no retention policy | error |
| `SMOKE_EVIDENCE` | User-facing change with no record of the feature being exercised | warning |
| `DELIVERED_LOCK` | Release claim with no observation behind it | error |
| `PROJECT_TESTS` | The project's own suite, with environment-shaped excuses rejected | error |

Each one is explained below, including why it fires where it does and what it
deliberately does not look at.

### `TODO_DENSITY`

A comment is not work. An agent that writes `// TODO: validate the input` has not
validated the input, but everything compiles and the summary says the feature is
finished. The marker is the only trace, and nothing reads it.

Only lines this change *adds* are scanned. Flagging pre-existing debt would
surface hundreds of findings the author did not create, which is the fastest way
to teach a team to bypass a check.

A deliberate deferral stays legal. Annotate it, and it becomes a decision someone
can find:

```js
// SAFE-TODO: bulk pricing lands with the ISSUE-412 migration, not before
```

Documentation is not scanned. Planning documents are full of these words by
design.

### `DEBUG_RESIDUE`

A `console.log` in production is rarely a crash. It is noise in the log pipeline,
occasionally a customer identifier printed where it should not be, and a reliable
sign that whoever wrote the code stopped at "it worked when I ran it". Agents
produce these constantly, because printing state is how they observe their own
work.

Default rules cover statements that are unambiguously debugging artifacts.
`print()` in Python is included but suppressed on paths that are conventionally
entry points (`bin/`, `scripts/`, `cli.py`, `__main__.py`), where printing is the
program's purpose. Rules for languages whose print statement is routinely
legitimate output (Go, Java, Rust) ship disabled and can be enabled per project.

Deliberate statements are annotated with `SAFE-LOG:`. Test files are never
scanned.

### `SKIPPED_TESTS`

"All tests pass" and "all tests ran" are different claims, and only the first one
gets reported. A `.skip` added in the same commit as the feature it was supposed
to cover produces a green suite that proves nothing.

Focused markers (`it.only`) are reported for the same reason: one left in a file
silently disables every other test in it, which is a bigger hole than a single
skip. Turn that off with `includeFocused: false` if your workflow relies on it.

A genuine quarantine is annotated with `SAFE-SKIP:` and names where it is
tracked.

### `SECRET_SHAPED_LITERAL`

Agents inline credentials for a reason that is almost sympathetic: they are
optimising for the code running, and an environment variable that is not set yet
makes the code not run. So the key goes in the file, the demo works, and the key
is in git history forever.

Detection runs in two tiers. Issuer-prefixed tokens (`AKIA...`, `ghp_...`,
`sk-...`, `xox...`, PEM blocks, JWTs) are matched on shape alone. Credential
shaped assignments (`api_key`, `password`, `client_secret` and friends bound to a
literal) additionally require the value to survive a placeholder filter and carry
real entropy, so `"<your-api-key>"`, `"changeme"` and `${...}` interpolation stay
quiet.

Reported excerpts are masked, because the report itself ends up in terminals, CI
logs and pull request comments, and echoing the key verbatim would copy the leak
into all three.

A reviewed false positive is marked with `allowlist-secret:`.

### `COMMIT_SIZE`

Size is a proxy, not a defect, and this gate ships as a warning because of that.
A 900-line commit is sometimes the honest shape of a rename. Blocking it would
only teach people to reach for the bypass, and a bypass reflex costs more than
the occasional large commit.

What it actually buys is a forced sentence. Writing `Why monolith: the generated
client and its call sites have to move together` takes ten seconds and is the
difference between a reviewer who knows what to look for and one who scrolls.

Set `severity: "error"` if you want it to block.

### `PLAN_DELIVERABLES`

The most expensive habit in agent-assisted work is the silent omission. Given a
five-item plan, an agent delivers three, writes a summary about the three, and
never mentions the other two. Nothing said is false. Two items simply stop
existing, and absence is the one thing a reader cannot notice.

So the gate makes absence loud. If the commit points at a plan file, every open
item in it needs an explicit word: `DONE`, `PARTIAL`, `NOT-STARTED` or `SKIPPED`.
Saying `NOT-STARTED` costs nothing. Saying nothing is how work disappears.

```
feat: checkout tax rules

Plan: docs/checkout-plan.md
- Apply regional tax rules at checkout: DONE
- Send the confirmation email: NOT-STARTED, waiting on template copy
- Record the order in the audit log: PARTIAL, writes but does not redact
```

Items already checked off in the plan file are treated as reported: the file is
the tracker, and re-declaring closed items in every commit would be busywork.

### `TEST_FOR_NEW_LOGIC`

Agents write tests enthusiastically when asked and almost never when not. The
result is a repository where the suite is green, the coverage number looks
respectable because the old code is well covered, and the module added this week
has never been executed by anything but the author's happy path.

Fires only on *new* files containing *branching* logic. A constants file, a
barrel re-export or a type declaration has nothing to test. Coverage is satisfied
by a sibling test file in any common naming convention, or by any test in the
repository that references the module.

Ships as a warning. An untested new module is a smell, and smells belong in the
report, not in the way. Acknowledge a deliberate gap in the file with
`test-debt-ack:`.

### `DROP_IMPACT`

Deleting is the operation agents are worst at, because the evidence that a
deletion is safe lives everywhere except the file being deleted. The usual shape:
remove a module, fix whatever the type checker complains about, declare it done.
Dynamic references, string-keyed lookups, tests and untyped call sites survive,
and they fail at run time rather than at build time.

Two searches run per removed path, both tuned hard against noise:

- Import specifiers are **resolved** against the importing file rather than
  string-matched, so deleting `src/lib/utils.ts` does not flag every other
  `./utils` in the repository.
- Exported symbols are matched as whole words, and any symbol still defined
  somewhere else is dropped from the search entirely, which is what makes a
  move-and-rename land clean instead of drowning in false positives.

Comment-only references and documentation do not count. Renames are checked too:
the old path stops existing, and imports of it break.

### `EPHEMERAL_LIFECYCLE`

A column called `expires_at` is a promise, and the promise is usually kept in
exactly one place: the read query filters on it. The rows stay. Nothing fails,
nothing alerts, and eighteen months later a table of one-time tokens is the
largest object in the database and a four-millisecond query takes four seconds.

The fix is nearly free when the migration is written and expensive at any later
moment, because the cleanup job needs a maintenance window and the index needs
one on a table that is now large. So three things belong in the same migration as
the table:

```sql
-- Retention: rows are kept for 24 hours past expiry
-- Cleanup: the nightly reaper in ops/reaper.py removes expired rows
CREATE TABLE login_tokens (
  id uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX login_tokens_expires_at_idx ON login_tokens (expires_at);
```

Plain SQL, no vendor extensions assumed. Scheduling primitives differ between
databases, so a comment declaring where cleanup runs counts, as long as it says
where. Migrations that only alter an existing table are ignored: their lifecycle
was decided elsewhere.

### `SMOKE_EVIDENCE`

A component that mounts is not a feature that works. The evidence offered for
user-facing work is almost always mount-shaped: "renders", "no console errors",
"builds clean". All three are true of a screen showing an empty list because the
query returned nothing, and of a screen that will throw the moment the deployed
backend answers instead of the local stub.

So the gate asks for three things a mount cannot fake:

```
## Smoke evidence
data: real
success criteria: the orders table shows 3 rows and the total reads 148.20
url: https://app.example.com/orders
```

A success criterion that only says "renders" or "no errors" is rejected. Name the
content.

Deferring is a legitimate engineering decision. Leaving it unsaid is not:

```
## Smoke evidence
PENDING-VERIFY: the totals row against production data, once the tax service ships
owner: @maria
```

Ships as a warning, because it fires on a file-path signal rather than on
something the author chose to write, and the path list needs tuning per project.
Promote it to `error` once `gates.SMOKE_EVIDENCE.paths` matches your layout.

### `DELIVERED_LOCK`

This is the gate the rest of the tool exists to support.

Every other check catches a defect in code. This one catches a defect in the
*claim about* the code, which is the failure that actually costs money. An agent
finishes a feature, sees a green build, and writes "production-ready". Nothing
ran. Nobody looked. The sentence is free to write, it is what the human reads,
and it is wrong often enough that the human eventually stops reading any of them.

The fix is not to ban the sentence. It is to price it.

**Claiming a release** costs an observation:

```
feat: order totals

RUNTIME-VERIFIED

## Runtime observation
data: real
observed: the totals row reads 148.20 and the tax line shows 21 percent
url: https://app.example.com/orders
```

**Being honest** costs one token and a short handoff:

```
feat: order totals

CODE-COMPLETE, RUNTIME-UNVERIFIED

## Runtime handoff
cannot-run: this environment has no staging credentials
owner: @maria
to-verify: open /orders and confirm the tax line shows a value, not a dash
```

Honest is cheap. Dishonest is expensive. The gate never has to judge anyone's
intent.

It fires only on unambiguous release phrases ("production-ready", "works end to
end", "shipped to production", "ready for users"), never on the bare words
*shipped* or *delivered*, which are ordinary vocabulary in commerce and logistics
code. Negated claims do not fire.

**What it cannot do:** it cannot know whether the observation you wrote is true.
It makes the claim traceable to a person and a URL. That is what a mechanical
check can honestly promise, and pretending otherwise would be the same failure it
is built to catch.

### `PROJECT_TESTS`

Runs the project's own suite, and refuses one specific excuse.

The excuse is: "the test runner would not start, so the tests were skipped." That
sentence describes a broken environment, which is a bug with a fix, usually a
one-line one. It is never a property of the change being committed. Left
unchallenged it becomes the default: the suite stops running, stays green in
everyone's memory, and nobody notices for weeks.

So the skip directive is honoured for reasons of **scope** and rejected for
reasons of **environment**:

```
agent-code-gates-skip: PROJECT_TESTS documentation only, no executable code   accepted
agent-code-gates-skip: PROJECT_TESTS the runner cannot boot in this container  rejected
```

The command comes from `gates.PROJECT_TESTS.command`, or from the `test` script
in `package.json` when there is a real one.

---

## Configuration

Drop a `.agentgatesrc.json` at the repository root. Everything is optional.

```json
{
  "ignore": ["legacy/**", "**/*.generated.ts"],
  "evidenceDirs": [".gates-evidence"],
  "strict": false,
  "gates": {
    "SMOKE_EVIDENCE": {
      "severity": "error",
      "paths": ["app/views/**", "resources/js/**"]
    },
    "COMMIT_SIZE": { "maxFiles": 8, "maxLines": 800 },
    "DEBUG_RESIDUE": { "rules": { "goPrint": true } },
    "PROJECT_TESTS": { "command": "make test", "timeoutMs": 600000 },
    "EPHEMERAL_LIFECYCLE": { "enabled": false }
  }
}
```

Generate a starter file with `agent-code-gates --init`.

### Top level

| Key | Type | Meaning |
|---|---|---|
| `ignore` | `string[]` | Globs never scanned. `node_modules`, `dist`, `build`, `vendor`, lockfiles and minified files are always ignored. |
| `evidenceDirs` | `string[]` | Directories searched for evidence blocks, in addition to the commit message. Default `[".gates-evidence"]`. |
| `strict` | `boolean` | Treat warnings as blocking. Same as `--strict`. |
| `gates` | `object` | Per-gate options, keyed by gate id. |

Glob syntax is `*` (within a path segment), `**` (across segments) and `?` (one
character). Anything else is literal.

### Every gate accepts

| Key | Type | Meaning |
|---|---|---|
| `enabled` | `boolean` | Turn the gate off entirely. |
| `severity` | `"error"` or `"warning"` | Whether a failure blocks the commit. |

### Per-gate options

| Gate | Option | Default |
|---|---|---|
| `TODO_DENSITY` | `tokens` | `["TODO", "FIXME", "HACK", "XXX"]` |
| | `annotation` | `"SAFE-TODO"` |
| | `includeTests` | `true` |
| | `sourceOnly` | `true` |
| | `exclude` | `[]` |
| `DEBUG_RESIDUE` | `rules` | `console`, `debugger`, `pythonDebugger`, `pythonPrint`, `phpDump` on; `goPrint`, `javaPrint`, `rustPrint` off |
| | `annotation` | `"SAFE-LOG"` |
| | `exclude` | `[]` |
| `SKIPPED_TESTS` | `annotation` | `"SAFE-SKIP"` |
| | `includeFocused` | `true` |
| | `sourceOnly` | `true` |
| | `exclude` | `[]` |
| `SECRET_SHAPED_LITERAL` | `minLength` | `12` |
| | `annotation` | `"allowlist-secret"` |
| | `exclude` | example, sample, template and dist files |
| | `allow` | `[]` (regular expressions) |
| `COMMIT_SIZE` | `maxFiles` | `5` |
| | `maxLines` | `500` |
| | `justification` | `"Why monolith:"` |
| | `listFiles` | `8` |
| `PLAN_DELIVERABLES` | `planFilePattern` | `"plan"` |
| | `statuses` | `["DONE", "PARTIAL", "NOT-STARTED", "NOT STARTED", "SKIPPED"]` |
| | `matchThreshold` | `0.5` |
| `TEST_FOR_NEW_LOGIC` | `minBranches` | `2` |
| | `annotation` | `"test-debt-ack"` |
| | `exclude` | declarations, migrations, generated files |
| `DROP_IMPACT` | `minSymbolLength` | `4` |
| | `ignoreSymbols` | generic names such as `index`, `config`, `handler` |
| | `includeDocs` | `false` |
| | `exclude` | archive and backup paths |
| | `maxFindingsPerPath` | `6` |
| `EPHEMERAL_LIFECYCLE` | `paths` | migration directories |
| | `retentionKeyword` | `"Retention"` |
| | `cleanupKeyword` | `"Cleanup"` |
| `SMOKE_EVIDENCE` | `paths` | common user-facing directories and component extensions |
| | `heading` | `"Smoke evidence"` |
| | `requireDeployedUrl` | `true` |
| `DELIVERED_LOCK` | `observationHeading` | `"Runtime observation"` |
| | `handoffHeading` | `"Runtime handoff"` |
| | `minObservationLength` | `12` |
| | `requireDeployedUrl` | `true` |
| `PROJECT_TESTS` | `command` | `null` (falls back to `npm test`) |
| | `timeoutMs` | `300000` |
| | `outputLines` | `25` |

Configuration is validated strictly. An unknown gate id, an unknown option name
or a wrong type is a hard error with exit code 2, never a silent shrug. The
failure mode of leniency is worse than the failure mode of strictness: a team
believes a gate is configured, the option never takes effect, and the gate waves
through exactly what it was added to catch.

---

## The escape hatch

One line in the commit body skips exactly one gate:

```
fix: restore checkout during the incident

agent-code-gates-skip: PROJECT_TESTS the payment sandbox is down, re-running at 09:00
```

Four rules, and each one defends the same idea.

1. **A reason is required.** A gate name alone is rejected. The reason is the
   entire artifact: it is what a reviewer reads and what the author has to look
   at while typing.
2. **One at a time.** Two directives in one commit fail the run. One is an
   exception; several is a bypass wearing an exception's clothes.
3. **It is reported loudly.** Every skip appears in the output, in CI logs, and
   in the JSON under `directives`. Nothing about it is quiet.
4. **`PROJECT_TESTS` inspects its own reason** and rejects environment-shaped
   excuses, because "the runner would not start" is the excuse that becomes
   permanent.

### Why an escape hatch at all

Because the alternative is worse. A gate with no exit is a gate people route
around: `--no-verify`, which disables every hook the repository has, including
the ones nobody was trying to skip. A documented, single-use, loudly-reported
exception keeps the pressure valve inside the system where it leaves a trace.

There is also `AGENT_CODE_GATES_SKIP=1 git commit ...`, which turns the hook off
for one commit. It exists for the same reason, and it is visible in shell
history rather than invisible in a config file.

---

## Calibration

**A noisy gate trains people to bypass it.** After the third false positive,
`--no-verify` becomes muscle memory, and at that point the tool is worse than
nothing: it costs time and provides no protection, while everyone believes it is
providing protection.

Every gate here is therefore built around one rule: **fire on a structural
signal, not on a guess.**

That principle produced specific, deliberate decisions:

- **Only added lines are scanned.** Pre-existing debt is not this commit's fault,
  and reporting it buries the finding that is.
- **Import references are resolved, not string-matched.** `DROP_IMPACT`
  understands relative paths so it cannot confuse two files with the same name.
- **A symbol still defined elsewhere is not an orphan.** Moving a file is not a
  deletion, and a gate that cannot tell the difference is useless during any
  refactor.
- **`DELIVERED_LOCK` fires on a sentence the author wrote,** not on a directory
  they touched. Its false-positive rate is close to zero because the trigger is a
  deliberate claim.
- **`COMMIT_SIZE` and `TEST_FOR_NEW_LOGIC` are warnings.** Both measure proxies.
  Blocking on a proxy is how you get a bypass reflex.
- **Bare "shipped" and "delivered" never trigger anything.** They are ordinary
  domain vocabulary in commerce, logistics and messaging code.
- **`print()` is suppressed on entry-point paths**, `.only` can be switched off,
  and print rules for languages where printing is normal ship disabled.
- **Documentation is not scanned** for deferral or skip markers. Planning
  documents contain those words on purpose.
- **A detector's own test fixtures need exempting.** This repository's
  `.agentgatesrc.json` excludes `test/**` from `SKIPPED_TESTS` and
  `SECRET_SHAPED_LITERAL`, because its fixtures contain those patterns as data.
  If you build detectors, you will need the same exemption.

If a gate is noisy in your codebase, tune it or turn it off. A gate that is off
is honest. A gate that is bypassed by reflex is a lie you tell yourself in every
standup.

---

## Command line

```
agent-code-gates [options]

  --staged                 Evaluate the staged change (default)
  --commit <ref>           Evaluate a finished commit, for CI or an audit
  --message-file <path>    Read the commit message from a file (hooks pass "$1")
  --cwd <path>             Run against a repository other than the current one

  --gate <ID>              Run only this gate; repeatable
  --list                   List every gate with its default severity
  --config <path>          Use a config file other than .agentgatesrc.json

  --json                   Machine-readable result on stdout
  --verbose                Show messages for passing and skipped gates too
  --no-color               Disable ANSI colour (also honours NO_COLOR)
  --strict                 Treat warnings as blocking

  --install-hooks          Write the commit-msg hook into this repository
  --init                   Write a starter .agentgatesrc.json
  --force                  Allow --install-hooks and --init to overwrite
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Every gate that ran is satisfied. |
| `1` | At least one gate is blocking this change. |
| `2` | The tool could not run: bad arguments, bad configuration, not a repository. |

The distinction between `1` and `2` is load-bearing. A `2` means fix the
pipeline; a `1` means fix the code. Conflating them produces the worst outcome
available: a broken setup that reports clean.

### Gates that need the commit message

When run as `--staged` without `--message-file`, there is no commit message to
read, and `COMMIT_SIZE`, `PLAN_DELIVERABLES`, `SMOKE_EVIDENCE` and
`DELIVERED_LOCK` are skipped with that stated as the reason. This is why the
installed hook is `commit-msg`. In CI, use `--commit <ref>`, where the message
always exists.

---

## Continuous integration

```yaml
name: gates

on:
  pull_request:
  push:
    branches: [main]

jobs:
  agent-code-gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npx --yes agent-code-gates --commit ${{ github.event.pull_request.head.sha || github.sha }}
```

`fetch-depth: 0` matters: the gates diff a commit against its parent, and a
shallow clone may not have one.

To have CI hold a higher bar than local commits, add `--strict` there and leave
the hook permissive. Warnings then block a merge without blocking a work in
progress commit.

For a review bot, take the JSON:

```bash
npx agent-code-gates --commit "$SHA" --json > gates.json
jq -r '.gates[] | select(.blocking) | .findings[] | "\(.file):\(.line) \(.excerpt)"' gates.json
```

---

## Writing your own gate

A gate is a plain object with two functions. Nothing is registered, subclassed or
decorated: `runGates` takes an array, and your gate behaves exactly like a
built-in one, including configuration merging, the escape hatch and severity
handling.

### The contract

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | Stable identifier. Uppercase with underscores by convention; it is what users write in config and in skip directives. |
| `title` | `string` | yes | Short human name. |
| `description` | `string` | yes | One sentence, shown by `--list`. |
| `severity` | `"error"` or `"warning"` | yes | Default consequence of a failure. |
| `defaults` | `object` | no | Configurable options. The shape here *is* the validation schema. |
| `appliesTo(ctx)` | `boolean` | yes | Is this gate relevant to this change? Keep it cheap. |
| `run(ctx)` | result or promise | yes | The check. May be async. |
| `needsCommitMessage` | `boolean` | no | Skip the gate when no message is available. |
| `honorsSkipDirective` | `boolean` | no | Set `false` to inspect the skip directive yourself. |

`run` returns:

```js
{
  status: 'pass' | 'fail' | 'skip',
  message: 'what happened and what to do about it',
  findings: [{ file, line, excerpt, detail }],   // optional
}
```

The runner maps `fail` to blocking or non-blocking using severity. A gate that
throws is reported as an error and blocks, so a bug in a gate can never be read
as a pass.

### What the context gives you

| Member | Type | Notes |
|---|---|---|
| `changedFiles` | `array` | `{ path, status, oldPath, insertions, deletions, binary }`. Status is `A`, `M`, `D` or `R`. |
| `addedLines` | `array` | `{ file, line, text }`, with real file line numbers. |
| `stats` | `object` | `{ files, insertions, deletions, linesChanged }`. |
| `commitMessage` | `string` | Full message. `hasCommitMessage` says whether there is one. |
| `readFile(path)` | `string` | Content as it will be committed (the index, not the working tree). |
| `readFileBefore(path)` | `string` | Content before this change. The only way to see a deleted file. |
| `readTracked(path)` | `string` | Cached read of any tracked file, for repository-wide searches. |
| `listRepoFiles()` | `string[]` | Surviving tracked files, ignore list applied. |
| `evidenceDocuments()` | `array` | `{ text, source }` for the message and every evidence file. |
| `isTestPath(path)` | `boolean` | Recognises test conventions across ecosystems. |
| `isSourcePath(path)` | `boolean` | Program source rather than documentation or data. |
| `config.gates[id]` | `object` | Your resolved options. |

### A complete example

Catching a real failure: a feature flag introduced with no way to ever remove it.

```js
// gates/flag-without-owner.js
import { excerpt } from 'agent-code-gates';

const FLAG = /\b(?:featureFlag|isEnabled|useFlag)\s*\(\s*['"]([\w.-]+)['"]/;

export default {
  id: 'FLAG_WITHOUT_OWNER',
  title: 'Feature flag with no owner or removal date',
  description: 'A new feature flag that nobody is on the hook for deleting.',
  severity: 'warning',

  defaults: {
    annotation: 'flag-owner',
    exclude: [],
  },

  appliesTo(ctx) {
    return ctx.addedLines.some((added) => FLAG.test(added.text));
  },

  run(ctx) {
    const { annotation } = ctx.config.gates[this.id];
    const findings = [];

    for (const added of ctx.addedLines) {
      const match = added.text.match(FLAG);
      if (!match) continue;

      const lines = ctx.readFile(added.file).split('\n');
      const above = lines[added.line - 2] ?? '';
      if (above.includes(`${annotation}:`)) continue;

      findings.push({
        file: added.file,
        line: added.line,
        excerpt: excerpt(added.text),
        detail: `flag "${match[1]}" has no owner`,
      });
    }

    if (findings.length === 0) {
      return { status: 'pass', message: 'every new flag names an owner', findings: [] };
    }

    return {
      status: 'fail',
      message:
        `${findings.length} new feature flag(s) with nobody accountable for removing them. ` +
        `Add a comment above each one: \`${annotation}: @who, remove after 2026-06-01\`.`,
      findings,
    };
  },
};
```

Run it alongside the built-ins:

```js
// scripts/gates.js
import {
  buildContext, loadConfig, runGates, renderHuman, exitCodeFor, gateRegistry,
} from 'agent-code-gates';
import flagWithoutOwner from '../gates/flag-without-owner.js';

const { config } = loadConfig(process.cwd());
const ctx = buildContext({ cwd: process.cwd(), mode: 'commit', ref: 'HEAD', config });
const run = await runGates(ctx, { gates: [...gateRegistry, flagWithoutOwner] });

console.log(renderHuman(run, { color: true }));
process.exit(exitCodeFor(run));
```

### Guidelines that matter more than the API

- **Scan added lines, not whole files.** Debt the author did not create is noise.
- **Pick a structural trigger.** "This file was added" is a fact. "This code
  looks risky" is a guess, and guesses generate bypasses.
- **Say what to do, in the message.** A gate that reports a problem without a fix
  is a gate people learn to ignore.
- **Give it an escape hatch.** An inline annotation costs you five lines and buys
  every user a way to be right when you are wrong.
- **Test the failing case.** A detector that has never seen a true positive is
  unproven. Both directions, every gate, no exceptions.

---

## Programmatic API

Everything the CLI does is exported from the package root: `buildContext`,
`loadConfig`, `runGates`, `renderHuman`, `renderJson`, `renderList`,
`exitCodeFor`, `gateRegistry`, `installHook`, plus the text and glob helpers
gates are built from. See `src/index.js`.

---

## What this is not

- **Not a linter.** It has no opinion about style, formatting or naming. Use
  ESLint, Ruff, gofmt or whatever your language provides.
- **Not a security scanner.** `SECRET_SHAPED_LITERAL` catches the common case of
  a credential pasted into source. It is not a replacement for secret scanning,
  dependency auditing or SAST.
- **Not a test framework.** `PROJECT_TESTS` runs yours.
- **Not a lie detector.** `DELIVERED_LOCK` cannot verify that your observation is
  true. It makes the claim traceable to a person and a URL, and makes the honest
  status cheaper than the dishonest one. That is the honest limit of a
  mechanical check, and overstating it would be the same failure the tool exists
  to catch.

---

## Contributing

```bash
git clone https://github.com/danilolapegna/agent-code-gates
cd agent-code-gates
node --test
node bin/agent-code-gates.js --commit HEAD
```

No build step, no dependencies to install. A new gate needs a module in
`src/gates/`, an entry in `src/gates/index.js`, a test file with both a passing
and a failing fixture, and a row in the table above.

---

## License

MIT. Copyright (c) 2026 Danilo Lapegna. See [LICENSE](LICENSE).
