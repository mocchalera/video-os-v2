## M3 Phase 1-2 実装レビュー結果
- 判定: FAIL
- FATAL: 3件
- WARNING: 2件
- NOTE: 2件

## FATAL

### 1. analysis gate / analysis override / analysis invalidation の意味論が設計書どおりに実装されていない
- 対象ファイル: `runtime/state/reconcile.ts`, `runtime/commands/triage.ts`, `tests/commands.test.ts`
- 問題:
  `reconcile()` は `validateProject(project)` も `media.project_summary.qc_status` も使わず、`03_analysis/assets.json` と `03_analysis/segments.json` の存在だけで `analysis_gate = ready` と判定している。さらに `artifact_hashes.analysis_artifact_version` を snapshot に一度も materialize していないため、設計で要求されている analysis invalidation と `analysis_override.artifact_version` 照合が成立しない。
- 根拠:
  `runtime/state/reconcile.ts:178`-`199` は `brief/selects/blueprint/...` の hash しか snapshot せず、`analysis_artifact_version` を一切埋めていない。一方で `runtime/state/reconcile.ts:305`-`306` と `runtime/state/reconcile.ts:393`-`395` はその未設定 field を invalidation / override stale 判定に使っている。
  `runtime/state/reconcile.ts:467`-`484` は `qc_status` ではなくファイル存在だけで `analysis_gate` を開けている。設計は `validateProject(project)` 実行と `media.project_summary.qc_status` ベースの gate を要求している (`docs/milestone-3-design.md:765`-`770`, `docs/milestone-3-design.md:783`-`787`, `docs/milestone-3-design.md:104`-`106`)。
  `tests/commands.test.ts:131`-`136` は schema-invalid な簡易 `03_analysis/assets.json` を書き、`tests/commands.test.ts:736`-`747` はその状態で `/triage` happy path を通している。さらに `tests/commands.test.ts:811`-`821` は `analysis_override` に必須の `artifact_version` を持たない override を成功ケースとして固定している。
  再現確認でも `analysis_override.artifact_version = "analysis-v1"` を持つ project を `reconcile()` すると `analysis_artifact_version: null` のまま `analysis_override_status: "stale"` になった。
- 影響:
  `qc_status: partial` / `blocked` の analysis でも `/triage` が進めてしまう。analysis 更新時に `selects / blueprint / timeline / review` を deterministic に stale 化できず、manual override の resume/self-heal も壊れる。
- 推奨修正:
  `03_analysis/assets.json.artifact_version` もしくは `media.project_summary.artifact_version` を `artifact_hashes.analysis_artifact_version` に取り込み、`reconcile()` で `validateProject(project)` と `project_summary.qc_status` を使って `analysis_gate` を導出する。`partial_override` は `qc_status == partial` かつ `analysis_override.artifact_version == analysis_artifact_version` のときだけ許可し、その failure path を test で固定する。

### 2. `blocked` state を reconcile が復元できず、blocked project が `blueprint_ready` に self-heal される
- 対象ファイル: `runtime/state/reconcile.ts`
- 問題:
  schema と `ARCHITECTURE.md` には `blocked` が state machine に含まれているが、`reconstructState()` と `STATE_ORDER` には `blocked` が実質存在せず、gate を見た post-process もない。そのため `planning_gate` / `compile_gate` が blocked でも `current_state` は `blueprint_ready` に戻る。
- 根拠:
  `runtime/state/reconcile.ts:212`-`221` の `STATE_ORDER` には `blocked` がない。`runtime/state/reconcile.ts:239`-`243` は blueprint があって timeline がない場合に必ず `blueprint_ready` を返し、`runtime/state/reconcile.ts:414`-`447` でも gate から `blocked` へ写像していない。
  設計は `blueprint_ready -> blocked` と `blocked -> blueprint_ready` を runtime state transition に含めている (`docs/milestone-3-design.md:799`-`813`)。`ARCHITECTURE.md` の state machine も同じ (`ARCHITECTURE.md:185`-`191`)。
  再現確認では `planning_gate: "blocked"` の project を `current_state: blocked` で保存しても、`reconcile()` 結果は `reconciled_state: "blueprint_ready"` になった。
- 影響:
  multi-session resume の再開地点が壊れる。`/status` が blocked project を正しく案内できず、Phase 3 以降の gate-driven flow と不整合になる。
- 推奨修正:
  `validateProject` / gate 計算後に `blocked` を state reconstruction に反映する。少なくとも `blueprint_ready` 相当の artifact があり、`compile_gate == blocked` または `planning_gate == blocked` のときは `blocked` を優先して self-heal する test を追加する。

### 3. draft/promote が multi-artifact で原子的ではなく、concurrent edit guard も欠落している
- 対象ファイル: `runtime/commands/shared.ts`, `runtime/commands/intent.ts`
- 問題:
  `draftAndPromote()` は draft を順番に `renameSync()` するだけで、途中失敗時の rollback がない。`/intent` のような 2 artifact promote では前半だけ canonical 化される可能性がある。さらに設計書が要求する preflight hash / post-run hash 照合が未実装で、agent 実行中の upstream concurrent edit を検出できない。
- 根拠:
  `runtime/commands/shared.ts:153`-`206` は全 draft validate 後に `fs.renameSync()` を 1 件ずつ実行し、途中 failure 時も既に promote 済みの file を戻さない。`runtime/commands/shared.ts:160`-`180` と `runtime/commands/intent.ts:152`-`179` は validate 失敗時の atomicity は見ているが、promote failure / hash mismatch path は扱っていない。
  設計は「両方 valid でも promote しない」「validate 成功時のみ canonical path に promote」「preflight hash と post-run hash がズレたら promote を中止」と明記している (`docs/milestone-3-design.md:128`-`140`, `docs/milestone-3-design.md:232`, `docs/milestone-3-design.md:900`-`901`)。
- 影響:
  `/intent` で `creative_brief.yaml` だけ新しく、`unresolved_blockers.yaml` は旧版のままという中途半端な canonical state を作りうる。operator が別 session で upstream artifact を更新した場合も無検知で上書きされる。
- 推奨修正:
  preflight 時点の upstream hash snapshot を保持し、promote 直前に再照合する。multi-artifact promote は temporary staging directory か rollback 付き 2-phase commit にして、1 file でも fail したら canonical side を元に戻す。promote failure / concurrent edit mismatch の test を追加する。

## WARNING

### 1. M3 で新規作成する brief に必須の `autonomy.mode` を schema / command が強制していない
- 対象ファイル: `schemas/creative-brief.schema.json`, `runtime/commands/intent.ts`
- 問題:
  設計は「M3 で新規に確定する brief では `mode` を必須 field」としているが、schema では `autonomy.required` が `may_decide` / `must_ask` のみで、`mode` は optional のまま。command 側 type も `mode?` になっている。
- 根拠:
  `schemas/creative-brief.schema.json:129`-`155`, `runtime/commands/intent.ts:55`-`58`, `docs/milestone-3-design.md:208`-`214`
- 影響:
  `/intent` が M3 authored brief を旧 shape のまま確定できてしまい、後続 phase が inference fallback に依存する。
- 推奨修正:
  schema を後方互換 branch 付きにするか、少なくとも `/intent` の promote 前 repair で `mode` を必須にする。`mode` 欠落 brief を `/intent` が reject する test を追加する。

### 2. テストは happy path に寄っており、今回の致命傷を検出できていない
- 対象ファイル: `tests/state.test.ts`, `tests/commands.test.ts`
- 問題:
  command/state test は validation failure のみを見ており、promote failure, post-run hash mismatch, real `qc_status: partial|blocked`, `analysis_artifact_version` 変更, `blocked` state resume を見ていない。加えて `/triage` happy path は schema-valid analysis fixture ではなく、存在チェックしか満たさない stub を前提にしている。
- 根拠:
  `tests/commands.test.ts:493`-`541` は validation failure しか扱わず、rename failure / concurrent edit を見ていない。`tests/commands.test.ts:131`-`136` の analysis stub は `assets.schema.json` 互換ではないが、`tests/commands.test.ts:736`-`747` の `/triage` success に使われている。設計は slash command test に `partial analysis gate refusal` と `post-run hash mismatch 時の promote 中止` を要求している (`docs/milestone-3-design.md:1060`-`1094`)。
- 影響:
  現在の PASS は設計準拠の証明になっておらず、state reconcile / gate / promote の regressions を防げない。
- 推奨修正:
  `validateProject()` を通る real analysis fixture で `/triage` をテストし、`qc_status: partial` 拒否、matching `analysis_override.artifact_version` 成功、analysis version invalidation、promote failure rollback、post-run hash mismatch abort、blocked state self-heal を追加する。

## NOTE

### 1. reviewed Phase 1-2 command wrappers 自体は `timeline.json` や final media を直接書いていない
- 対象ファイル: `runtime/commands/intent.ts`, `runtime/commands/triage.ts`, `runtime/commands/shared.ts`
- 確認:
  reviewed commands が promote する canonical artifact は `01_intent/*` と `04_plan/selects_candidates.yaml` に限定されており、`timeline.json` や final media を直接 mutate していない。`ARCHITECTURE.md` の「Only compiler mutates timeline.json」「No agent writes final media directly」には現時点では反していない (`ARCHITECTURE.md:223`-`230`)。

### 2. 既存 fixture / 型チェックは現状壊れていない
- 確認:
  `npx vitest run` は PASS（14 files, 494 tests, 2026-03-21 実行）、`npx tsc --noEmit` も PASS。
  `tests/state.test.ts` では sample brief の `autonomy.mode` absent と sample blueprint の `confirmed_preferences` absent が通っており、M1/M2 fixture 互換性は現状維持されている。

## 総合判定

FAIL

理由は、Phase 2 の中核である `/triage` の analysis gate と、Phase 1 の中核である `project_state` reconcile / invalidation / blocked resume が、設計書の意味論にまだ到達していないため。テストと型チェックは通っているが、主に existence-based shortcut のためで、設計準拠の safety を示していない。
