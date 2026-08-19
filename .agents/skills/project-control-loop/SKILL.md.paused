---
name: project-control-loop
description: Use this skill when auditing, developing, testing, fixing, or tracking a software project through Project Loop Harness with SQLite memory, evidence-backed status, and a generated HTML dashboard.
---

# Project Control Loop Skill

## Core principle

The dashboard is not the source of truth.
The source of truth is `.project-loop/project.db`, with `.project-loop/events.jsonl` as an append-only audit log.
Generated `dashboard.html` is a human-only review artifact. Agents should not
read or parse it for project state; use `pcl` JSON commands, reports, evidence
paths, or `.project-loop/dashboard/dashboard-data.json` for machine context.

Never edit generated HTML directly.
Never write SQL directly unless the human explicitly asks for database maintenance.
Use the `pcl` CLI for state changes.

## Required behavior

When this skill is invoked:

1. Read `AGENTS.md`, `CLAUDE.md` if present, and `pcl.yaml`.
   When the user asked for review or audit only, keep the whole run read-only:
   use inspection commands such as `doctor`, `validate`, `next`, `audit check`,
   `feature read`, and `test list`; do not render, generate reports, or mutate
   state unless explicitly requested. State in the handoff that nothing changed.
2. Run `pcl doctor` or `pcl validate` if project-loop state may be stale.
3. Use `pcl next` to determine the next harness action when ambiguous.
   When the lifecycle route or command syntax itself is unclear, run
   `pcl guide --json` once, or `pcl guide <topic> --json` for `start`,
   `direct`, `finish`, `dashboard`, or `recover`, before probing multiple help
   pages. Do not add a guide lookup to routine work whose route is already
   clear.
   When current intent already names a Task or Goal, bind routing with
   `pcl next --target <T-XXXX|G-XXXX>`. Unbound multi-Goal ambiguity returns
   `select_target`; choose the matching ID and rerun with `--target`.
4. When the user has already supplied explicit implementation intent and no
   active work exists, pass that intent literally to `pcl start`; do not create
   an extra human gate merely to register it.
5. Perform the smallest valid next step.
6. Record state through `pcl` commands.
7. Run `pcl validate` after state changes.
8. Run `pcl render` after validation.
9. Report evidence, not just conclusions.

`pcl.yaml` `commands.*` values are arbitrary shell commands, not npm script
names or make targets. Run the configured command string exactly as written;
do not assume `npm run <key>` or another wrapper exists for a key like
`lint` or `test`. Before treating a configured command as acceptance proof,
confirm that its paths and operands exercise the current Feature surface; a
green command for another app or a missing-path `|| echo` fallback is not proof.

## Adoption and setup safety

When initializing or auditing a target project, use the same inspect-first
discipline expected from a careful project setup:

1. Inspect existing `AGENTS.md`, `CLAUDE.md`, `pcl.yaml`, `.agents/`, and
   existing test/build commands before proposing changes.
2. In a non-empty project, prefer `pcl init --dry-run --json` before `pcl init`.
3. Treat the dry-run output as the adoption plan: explain which files would be
   created, updated, skipped, or overwritten.
4. Do not use `pcl init --force` unless the human explicitly approves replacing
   generated templates.
5. After initialization, tune `pcl.yaml` commands, discovery paths, permissions,
   and human gates to the actual repository.
6. Verify the installed harness with `pcl doctor --strict`, `pcl validate
   --strict`, and `pcl render`.
7. Treat `installation_skill_drift` as an instruction/runtime compatibility
   finding. Review `pcl init --refresh-skill --dry-run --json`, then apply the
   targeted refresh only with operator authority; it preserves the replaced
   Skill by hash and does not refresh config or workflow templates.

Keep always-loaded files compact. Put procedures in skills, docs, workflow
templates, or reports instead of duplicating long instructions across
`AGENTS.md`, `CLAUDE.md`, and project memory.

## Test-first delivery

Use `pcl story` and `pcl test` as the durable TDD/BDD layer. Free-form testing
docs are useful, but they are not the source of truth once Project Loop Harness
is initialized.

For user-visible behavior changes:

1. Make or identify the feature with `pcl feature add` or `pcl feature read`.
2. Capture behavior as a user story with `pcl story draft`, then review or
   approve it before implementation when feasible.
3. Plan at least one behavior-facing test case with `pcl test plan`.
4. Prefer a red-green-refactor loop: reproduce the missing/failing behavior,
   record `pcl test fail`, `pcl test missing`, or `pcl test block` when useful,
   implement the smallest change, then record `pcl test pass` with evidence.
   If the human corrects an acceptance condition, preserve the correction as
   history: `pcl test waive TC-OLD --reason "..."`, then plan a replacement
   Test. Never edit the old condition into a different meaning.
5. Use explicit evidence: command output, artifact paths, screenshots, commits,
   reports, or verifier notes that another operator can inspect.
   Treat every registered evidence source path as write-once. A rerun writes a
   new uniquely named artifact, registers a new Evidence ID, and uses
   `pcl test reverify` when a passing Test needs stronger proof. Never overwrite
   a file already named by an Evidence manifest.
6. Run `pcl validate --strict` after terminal test states and before calling the
   loop done.

Record durable Stories and Tests for semantic corrections, reproducible
failures, and cross-viewport or cross-environment contracts. Do not create a
new PCL Test for every local CSS value nudge or equivalent implementation-only
adjustment. When one run changes both a product and a reusable shared Skill,
track them as distinct Features or Tasks and link each to its own evidence.

## Direct implementation loop (default)

For a single well-scoped implementation task, the durable-state path below is
sufficient. Do not start a workflow run just because `pcl next` recommends
one; workflow runs add queued jobs you must later close out.

Follow this order. Replace every placeholder ID with the ID returned by the
preceding command; do not invent IDs.

1. Register the user's literal intent. `pcl start` creates the Goal and Task:

   ```bash
   pcl start "<literal user intent>"
   ```

2. Add the Feature, or use `pcl feature read F-XXXX` when it already exists:

   ```bash
   pcl feature add --name "..." --surface "..." --description "..."
   ```

3. Draft the Story, then obtain explicit approval or record an explicit waiver.
   Approval and waiver are human-semantic decisions; never infer either one:

   ```bash
   pcl story draft --feature F-XXXX --actor "..." --goal "..." --expected-behavior "..."
   pcl story approve US-XXXX --summary "..."
   # Or, only when explicitly authorized:
   pcl story waive US-XXXX --reason "..."
   ```

4. Plan at least one behavior-facing Test linked to that Story:

   ```bash
   pcl test plan --feature F-XXXX --story US-XXXX --type acceptance --scenario "..." --expected "..."
   ```

5. Implement the smallest change, run the configured project QA commands, and
   save their reviewable output as a project artifact. Register that file with
   `--copy` so the Evidence manifest pins its bytes and SHA-256. Keep the
   returned `E-XXXX`:

   ```bash
   pcl evidence add --file artifacts/acceptance.txt --summary "..." --command "..." --copy
   ```

6. Pass the Test and finish the Feature with that canonical Evidence ID. Both
   terminal commands require `--summary`:

   ```bash
   pcl test pass TC-XXXX --summary "..." --evidence-id E-XXXX
   pcl test reverify TC-XXXX --summary "..." --evidence-id E-NEW --completion-policy completion-policy.json
   pcl feature status F-XXXX --status done --summary "..." --evidence-id E-XXXX
   ```

   Keep `pcl test pass` idempotent for an already-passing Test. Use
   `pcl test reverify` only when an approved legacy Test must explicitly adopt
   a stronger target-bound Evidence Set and completion-policy receipt.

7. Mark the Task created by `pcl start` terminal after its acceptance work is
   complete. Do not leave a child Task active when closing its Goal:

   ```bash
   pcl task status T-XXXX done --reason "..."
   ```

8. Emit a completion packet bound to the Goal. Continue only when its outcome
   is `COMPLETED_VERIFIED` or `COMPLETED_WITH_RISK`; keep the packet's returned
   Evidence ID, shown here as `E-PACKET`:

   ```bash
   pcl finish --emit-packet --goal G-XXXX
   ```

9. Close the direct-route Goal with the completed packet Evidence, then
   audit, validate, and render:

   ```bash
   pcl goal close G-XXXX --summary "..." --evidence-id E-PACKET
   pcl audit check --json
   pcl validate --strict
   pcl render
   ```

   Do not ignore an `audit check` failure merely because validation passes.
   Inspect whether the mismatch affects current completion proof, a healthy
   copied artifact's mutable source, or superseded historical Evidence, and
   report that distinction until the runtime classifies it directly.

For a Workflow-backed route, close the Goal with an approved Verification:

```bash
pcl verification record --run WR-XXXX --result approved --reason "..."
pcl goal close G-XXXX --summary "..." --verification V-XXXX
```

`--verification` accepts a Verification entity ID such as `V-0001`, not a
free-text verdict, report path, Evidence ID, or summary. The Verification must
be approved and belong to a Workflow Run for the Goal. Do not create an empty
Workflow Run merely to close a direct-route Goal; use the completion packet
route above.

### Evidence flag compatibility

`--evidence-id E-XXXX` is the canonical terminal-proof input. It references an
existing Evidence row, so create the Evidence first and pass the returned ID.
Never pass `E-XXXX` through `--evidence`; that flag does not resolve an
Evidence ID.

Legacy `--evidence "..."` remains a compatibility input for older scripts. It
records the supplied raw string as inline Evidence and may emit a deprecation
warning. It is not hash-pinned artifact proof and does not satisfy enforced
lifecycle integrity. `--evidence` and `--evidence-id` are mutually exclusive;
prefer `--evidence-id` for all new terminal transitions.

Reserve `pcl loop run ...` for coverage sweeps across a goal, defect repair
loops, regression passes, or work that is split across multiple agent jobs.

## Normal commands

```bash
pcl init --dry-run --json
pcl doctor
pcl doctor --strict
pcl validate
pcl validate --strict
pcl next
pcl loop status
pcl update check
pcl render
pcl export csv
```

## State mutation commands

```bash
pcl goal create --title "..."
pcl feature add --name "..." --surface "..." --description "..."
pcl story draft --feature F-0001 --actor "..." --goal "..." --expected-behavior "..."
pcl story approve US-0001 --summary "..."
pcl test plan --feature F-0001 --story US-0001 --type acceptance --scenario "..." --expected "..."
pcl evidence add --file artifacts/acceptance.txt --summary "..." --command "..." --copy
pcl test pass TC-0001 --summary "..." --evidence-id E-0001
pcl feature status F-0001 --status done --summary "..." --evidence-id E-0001
pcl defect open --feature F-0001 --severity high --expected "..." --actual "..."
```

## Loop commands

Use loop commands to create workflow runs and queued agent jobs:

```bash
pcl loop run feature_coverage --goal G-0001
pcl loop run defect_repair --defect D-0001
pcl loop run regression_loop --goal G-0001
pcl jobs list
pcl jobs read J-0001
```

If you start a workflow run, you own closing it out:

1. Read each queued job with `pcl jobs list` and `pcl jobs read J-XXXX`.
2. Produce each job's output as an agent-output evidence file.
3. Ingest each output with `pcl ingest-agent-run`.
4. Re-run `pcl validate --strict` and `pcl render`.
5. Run `pcl next`. If the remaining action is a human decision — for
   example recording a `pcl verification record` for the workflow run —
   report it as the pending next action and stop. Do not approve or record
   the verification yourself.

## Agent handoff commands

Council Profile is opt-in for ambiguous or high-risk work. Direct remains the
default for clear tasks. Council output is advisory Evidence, never approval or
proof, and no returned command is executed automatically:

```bash
pcl --json profile prepare council.discovery --target task:T-XXXX --brief E-XXXX --output /tmp/council-request.json
pcl --json profile fixture-run --request /tmp/council-request.json --status completed --output-dir /tmp/council-output
pcl --json profile ingest --request /tmp/council-request.json --bundle /tmp/council-output/profile-output-bundle.json --dry-run
pcl --json profile ingest --request /tmp/council-request.json --bundle /tmp/council-output/profile-output-bundle.json
pcl --json profile authorize --revoke EV-XXXXXXXXXXXX --actor "human:owner" --source-kind cockpit --source-ref "cockpit:<task-id>" --reason "Withdraw scope"
```

Real network or paid use requires separate hash-bound human authorization that
names providers, data classes, budget, and expiry. Never infer a route override,
candidate selection, or authorization. Never send secrets, credentials,
production data, or full transcripts. Validate with `--dry-run` first; preserve
`partial`, `budget_exhausted`, `failed`, and `skipped` as factual safe stops.

By default, generate prompts and adapter command templates, then ingest the
resulting output as evidence:

```bash
pcl prompt job J-0001
pcl agent command J-0001 --adapter manual
pcl agent command J-0001 --adapter codex_exec
pcl agent command J-0001 --adapter claude_manual
pcl agent command J-0001 --adapter generic_shell
pcl ingest-agent-run .project-loop/evidence/agent-runs/J-0001/output.md
```

## Guarded executor commands

Workflow command steps are dry-run by default. Execution requires an approved
template and explicit `--execute`:

```bash
pcl workflow verify --template feature_coverage
pcl workflow guard --template feature_coverage
pcl workflow guard --template feature_coverage --execute
```

## Automatic executor commands

Use the guarded executor only when workflow automation is explicitly intended.
Agent adapters launch only with `--allow-agent-exec`:

```bash
pcl loop execute workflow_id
pcl loop execute workflow_id --agent-adapter generic_shell --allow-agent-exec
```

## Autonomous continuation and progress orientation

After every completed slice or meaningful state change, run `pcl next --json`.
If the action is inside the approved goal and `run_policy=agent_safe`, execute
it and keep looping instead of returning a terminal status update. A
`safe_to_run=false` action without `requires_human=true` is not automatically a
human gate: review the command and continue when it is a normal in-scope state
transition. Stop only for a real human decision, an external blocker, an
explicit user boundary, or an operation that separately requires approval.

Every progress handoff must make orientation immediate with four facts:

- **Now:** current milestone and active task;
- **Done:** the slice just completed and its evidence;
- **Next:** the concrete next action already being taken;
- **Human needed:** `none`, or the exact decision required.

Do not make the human ask what is happening or run routine CLI commands to
advance a known agent-safe loop.

## Dashboard presentation moments

Rendering and presenting are different. Render routinely and silently; present
only at those four review moments. Present the dashboard after plan approval, a
major milestone, a blocking human decision, and goal closure.

At each presentation moment:

1. Run validation before `pcl render` whenever possible.
2. Use `pcl` JSON state to prepare the explanation; never parse dashboard HTML
   as machine context.
3. If the host provides a visual or file side panel, open the generated
   dashboard in that host. Otherwise, provide the dashboard path.
4. Tell the operator exactly what to review using the same orientation words:
   **Now, Done, Next, Human needed, and Risks**. When nothing needs the human,
   say so instead of directing them to empty tables.

## Human gates

Escalate to the human only when ambiguity changes one of:

- user-visible behavior;
- data handling;
- permissions/security;
- rollout strategy;
- destructive operation;
- external dependency;
- business rule;
- acceptance criteria.

Do not ask questions whose answer can be found in code, tests, docs, `AGENTS.md`, `CLAUDE.md`, or `pcl.yaml`.

When `pcl next` returns an action that requires a human decision, report the
pending action and stop; never satisfy a human gate on the human's behalf.
The human normally responds in the conversation or Cockpit; do not require
them to run `pcl`. On a later turn, an agent may record that explicit decision
only when the receipt names the human approver, the agent/system recorder, and
the conversation or Cockpit source reference separately.

## Done criteria

A loop is not complete until:

- relevant state is updated through `pcl`;
- evidence exists;
- validation passes;
- dashboard has been regenerated;
- verifier result is recorded or human escalation is opened;
- pending human decisions are reported as such, not self-approved;
- next action is clear.
