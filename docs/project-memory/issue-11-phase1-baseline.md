# Issue #11 — Phase 1 A0/A1 baseline at exact base

- exact base: `372b26891a6ef833121fd35ad688eb428cfd8715`
- toolchain: Node 22.23.1 / npm 10.9.8 / ffmpeg+ffprobe 8.1.2
- execution isolation: repo-external task-owned proper mirror with independent
  Git index, hardlinked dependency-tree contents, and dedicated `TMPDIR`
- canonical aggregate SHA-256 before run:
  `76e9334d93aecfcd93a7cb5069cdd439bf09d719ccab42ee2351f95326cbb105`
- canonical aggregate SHA-256 after run: identical
  (`76e9334d93aecfcd93a7cb5069cdd439bf09d719ccab42ee2351f95326cbb105`)

## Outcome

### A0 — BLOCKED before timeline generation

The first valid public CLI compile of the frozen human-fixed Day2 inputs exited
1 at the narrative-arc contract. The current exact base requires
`apex_beat.required_roles=[hero]`, while the frozen blueprint has
`[support]`; selects also contain legacy eligible beat IDs absent from the
current blueprint. No new timeline was produced.

Because frozen inputs cannot be repaired without invalidating the A0 control,
a second successful compile and byte-equality claim are impossible. This is not
reported as PASS. Repository fixtures independently cover repeated
byte-identical compile output, but they do not replace the blocked Day2 A0.

### A1 — COMPILE_BLOCKED / HOLD

A fresh temporary copy removed exactly:

- one `human_golden_order` list entry;
- seven exact `candidate_plan` blocks;
- 33 deleted lines total, zero added lines.

No other blueprint policy or canonical file changed. Override patch SHA-256:
`45409be9e63b1a35fac18cc0f802a950d9b08f4296c9b9ecb983910c553f8253`.

The single valid A1 public CLI compile exited 1 at the same upstream
narrative-arc contract before scoring/assembly. The inherited timeline hash
remained `ac2755a6d25a491838f874f2861ab99a0a4cc1ddcf4f4549fd117a7d44020a30`;
it is not A1 output.

Coverage remains selects=`failed`, analysis=`blocked`. Therefore:

> 接地失敗下の観測であり、auto assemblyの評価としては未確定。

The kickoff preset and cut-density/max-shot policy were not exercised, so this
run provides no Phase 2.5 attribution.

## Measured and unmeasured

Measured:

- public CLI failure stage and exit code;
- A1 override exact diff and hash;
- compile wall clock through the failure (0.97 s);
- canonical aggregate before/after hashes;
- inherited timeline byte invariance.

Unmeasured:

- successful A0 timeline byte equality on Day2;
- any A1 auto-assembled timeline or reviewable preview;
- cold source-to-first-preview duration;
- optional Qwen/CLAP/Marlin/VLM behavior inside A1 (compile did not invoke them);
- human structural change metrics (no explicit human comparison input supplied).

A fresh cold full-pipeline run was not started: it would require a new project
intent/analysis execution and potentially external provider use beyond the
frozen A0/A1 compile experiment. No wall-clock was invented; the 10-minute
target is UNVERIFIED/HOLD.
