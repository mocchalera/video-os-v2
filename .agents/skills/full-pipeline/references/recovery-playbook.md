# Recovery Playbook

## Scope

- このファイルは `full-pipeline` 実行中の代表的な failure から、どの stage に戻るかを決めるための手引き
- 原則は単純で、**壊れた artifact の owner skill に戻す**
- downstream patch で隠蔽せず、earliest failing gate から再実行する

## TOC

- Schema validation failure
- API key / credential failure
- ffmpeg / ffprobe failure
- Compile gate failure
- Review FATAL
- Stale artifact / resume mismatch
- Package QA failure

## Schema Validation Failure

### Symptoms

- `VALIDATION_FAILED`
- `parse_error`
- AJV の schema error
- `scripts/compile-timeline.ts` の post-compile validation failure

### Recovery Rule

- 壊れた artifact を手で継ぎ足さず、その artifact の owner skill を再実行する
- owner を直したら、その artifact より downstream を全部やり直す

### Artifact Owner Map

| Artifact | Owner skill | 戻る Gate |
| --- | --- | --- |
| `01_intent/creative_brief.yaml` | `design-intent` | Gate 2 |
| `01_intent/unresolved_blockers.yaml` | `design-intent` | Gate 3 |
| `03_analysis/assets.json` | `analyze-footage` | Gate 1 |
| `03_analysis/segments.json` | `analyze-footage` | Gate 1 |
| `03_analysis/gap_report.yaml` | `analyze-footage` | Gate 1 |
| `04_plan/selects_candidates.yaml` | `select-clips` | Gate 4 |
| `04_plan/edit_blueprint.yaml` | `build-blueprint` | Gate 5 |
| `04_plan/uncertainty_register.yaml` | `build-blueprint` | Gate 5 |
| `05_timeline/timeline.json` | `compile-timeline` | Gate 6 |
| `06_review/review_report.yaml` | `review-roughcut` | Gate 7 |
| `06_review/review_patch.json` | `review-roughcut` | Gate 8 |
| `07_package/qa-report.json` | `render-video` | Gate 10 |
| `07_package/package_manifest.json` | `render-video` | Gate 10 |

## API Key / Credential Failure

### Symptoms

- `GEMINI_API_KEY environment variable is required`
- `OPENAI_API_KEY environment variable is required`
- `GROQ_API_KEY environment variable is required`
- API 401 / 403
- `scripts/analyze.ts` の warning で VLM stage skip が出る

### Recovery Rule

- まず **どの provider が落ちたか** を user に明示する
- つぎに repo に実在する skip path だけを使う
- degraded 実行にした場合は、Gate 1 を再評価し、analysis quality が落ちたことを user に伝える

### Supported Bypass Paths In This Repo

- VLM が使えない
  - `scripts/analyze.ts` は `GEMINI_API_KEY` が無いと VLM を自動 skip する
  - 明示的にやるなら `--skip-vlm`
- STT が使えない
  - `--skip-stt`
- diarization だけ落ちる
  - `--skip-diarize`
- peak detection を飛ばしたい
  - `--skip-peak`
- 02_media symlink が原因なら
  - `--skip-media-link`

### Return Point

- analyze 系の credential failure は Gate 1 に戻る
- degraded analysis のまま進む場合、必要なら `analysis_override` を更新してから Gate 4 へ進む

## ffmpeg / ffprobe Failure

### Symptoms

- `ffmpeg` / `ffprobe` command failure
- source probe failure
- render pipeline failed
- scene detect / derivative generation / audio extract で例外

### Cut The Problem First

- binary 起動前に落ちる
  - 環境問題の可能性が高い。`ffmpeg` / `ffprobe` の導入や PATH を直す
- 特定 media file だけで落ちる
  - 素材破損、非対応 codec、truncate の可能性が高い。Gate 0 に戻る
- compile 後の package render で落ちる
  - `assembly.mp4`、caption、music cue、render policy の問題を疑う。Gate 9 に留まる

### Recovery Rule

- source probe / segment / derivative failure
  - `analyze-footage` を再実行する
  - 同じ file で再現するなら Gate 0 に戻って素材を差し替える
- render failure
  - `05_timeline/assembly.mp4`
  - `07_package/caption_approval.json`
  - `07_package/music_cues.json`
  - `04_plan/edit_blueprint.yaml` の caption / music policy
  - を点検してから `render-video` を再実行する

## Compile Gate Failure

### Symptoms

- `Compile gate BLOCKED. Unresolved blockers exist.`
- `/review` が `Compile gate is blocked` で止まる
- `project_state.yaml` 上で `compile_gate: blocked`

### Recovery Rule

- `unresolved_blockers.yaml` に `status: blocker` がある
  - `design-intent` に戻る
- `uncertainty_register.yaml` に `status: blocker` がある
  - `build-blueprint` に戻る
- user が temporary assumption で進めたい
  - brief / blockers / uncertainty register にその前提を明示してから Gate 3 or Gate 5 を再評価する

### Do Not

- blocker を残したまま compile や review を強行しない
- 会話の中だけで assumption を持ち、artifact に書き戻さない

## Review FATAL

### Symptoms

- `fatal_issues` が 1 件以上
- `summary_judgment.status: blocked`
- `review_gate: blocked`

### Recovery Order

1. `review_patch.json` が safe で localized な修正か確認する
2. safe なら Gate 8 を回す
3. safe でないなら root cause を `review_report.yaml` から読む

### Return Target By Root Cause

- 局所 trim / move / replace で直る
  - Gate 8: `compile-timeline --patch` -> Gate 7: `review-roughcut`
- beat 設計、pacing、coverage が悪い
  - Gate 5: `build-blueprint` -> Gate 6 -> Gate 7
- clip choice が弱い、根拠不足、must-have coverage 不足
  - Gate 4: `select-clips` -> Gate 5 -> Gate 6 -> Gate 7
- message / audience / must-have そのものが曖昧
  - Gate 2: `design-intent` からやり直す

### Default Rule

- patch 不可能で report が message/coherence failure を指すなら、まず Gate 4 まで戻す

## Stale Artifact / Resume Mismatch

### Symptoms

- file はあるのに内容が古い
- upstream artifact を直したあと downstream artifact だけ残っている
- `reconcile.ts` の invalidation matrix 上 stale になる変更が入っている

### Recovery Rule

- brief または analysis 変更
  - Gate 4 から再開
- selects または `STYLE.md` 変更
  - Gate 5 から再開
- blueprint 変更
  - Gate 6 から再開
- timeline または `human_notes.yaml` 変更
  - Gate 7 から再開
- caption approval / music cues / QA report 変更
  - Gate 9 から再開

## Package QA Failure

### Symptoms

- `qa-report.json.passed: false`
- `QA checks failed - cannot transition to packaged`

### Recovery Rule

- fail した check 名を見て Gate 9 に戻る
- 代表例
  - `loudness_target_valid` 失敗
    - audio mix / supplied final を調整して `render-video`
  - `package_completeness_valid` 失敗
    - missing artifact を揃えて `render-video`
  - `caption_density_valid` / `caption_alignment_valid` 失敗
    - caption artifact を直して `render-video`
  - `duration_policy_valid` 失敗
    - strict duration に収まるよう upstream edit を見直し、必要なら Gate 5 か Gate 6 に戻る
