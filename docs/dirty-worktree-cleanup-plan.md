# Dirty Worktree Cleanup Plan

作成日: 2026-04-27
対象: `/Users/operator/Dev/video-os-v2-spec`

## 調査方針

- read-only 調査として `git status --short`, `git diff`, `git diff --cached`, `git log -20 --oneline --decorate`, 未追跡ファイルの閲覧だけを実施した。
- このレポート作成以外の編集、`git add`, `git commit`, `git restore`, `git clean`, `git config` 変更、push/rebase/reset は実施していない。
- `git status --short | wc -l` は `103`。下記「完全 status list」はその 103 行をそのまま整形したもの。

## 直近コミットとの関係

直近 20 commits は大きく 2 系統に分かれる。

- `0e12125` から `8fadfec` までは P1-P4d production-readiness / canonical artifact 本筋。`source_media_manifest`, `analysis_coverage_report`, `audio_story_graph`, `continuity_graph`, `release_safety_report`, `delivery_profile`, `confidence_calibration_report`, `segment_search_index` が中心。
- `2c70346` 以前は editor 系列。`feat(editor): NLE-grade UI with AI workspace (Phase 0-5)`, `feat(editor-v3): P0 fixes + P1 bidirectional sync`, `docs + fix: Editor v3 design + source-based playback + bugfixes` などが並ぶ。

今回の dirty worktree は、P1-P4d 直後に残った本筋外の WIP と見てよい。主な続き先は以下。

- OSS readiness: 公開前の repo hygiene。直近 P1-P4d とは別だが、公開準備として独立 commit 可能。
- render/package: `09_output/final.mp4` を最終成果物にする導線。M4/package 既存テストの延長で、P4d 本筋とは別の packaging UX 変更。
- editor v3 / exact preview parity: `2c70346`, `ef49a58`, `a7ac181` 以前の editor 系統の続編。ProgramMonitor と final render の一致設計、RenderSpec、preview job service、caption/effect/filtergraph 共有化が中心。
- VLM rerun fixes: Gemini JSON MIME と peak detector model alias。過去の VLM rerun / connector fix 系。
- tmp cleanup: rokutaro family montage の生成 thumbnails/contact sheets。Git 管理から外すべきローカル生成物。

## 完全 status list

```text
A  .github/ISSUE_TEMPLATE/bug_report.md
A  .github/ISSUE_TEMPLATE/feature_request.md
A  .github/pull_request_template.md
A  .github/workflows/ci.yml
M  .gitignore
A  CODE_OF_CONDUCT.md
A  CONTRIBUTING.md
A  LICENSE
M  README.md
A  SECURITY.md
A  docs/oss-readiness.md
M  editor/client/package-lock.json
M  editor/client/package.json
 M editor/client/src/App.tsx
 M editor/client/src/components/AppShell.tsx
 M editor/client/src/components/ClipBlock.tsx
 M editor/client/src/components/ClipLayer.tsx
 M editor/client/src/components/DiffPanel.tsx
 M editor/client/src/components/EditorLayout.tsx
 M editor/client/src/components/PreviewPlayer.tsx
 M editor/client/src/components/ProgramMonitor.tsx
 M editor/client/src/components/PropertyPanel.tsx
 M editor/client/src/components/Timeline.tsx
 M editor/client/src/components/TrackHeader.tsx
 M editor/client/src/components/TrackLane.tsx
 M editor/client/src/components/TransportBar.tsx
 M editor/client/src/hooks/useDiff.ts
 M editor/client/src/hooks/useEditorKeyboard.ts
 M editor/client/src/hooks/usePlayback.ts
 M editor/client/src/hooks/useProjectSync.ts
 M editor/client/src/hooks/useSourcePlayback.ts
 M editor/client/src/hooks/useTimeline.ts
 M editor/client/src/types.ts
 M editor/client/src/utils/draw.ts
 M editor/client/src/utils/editor-helpers.ts
M  editor/package-lock.json
M  editor/package.json
 M editor/server/index.ts
 M editor/server/routes/media.ts
 M editor/server/routes/preview.ts
 M editor/server/services/watch-hub.ts
 M editor/shared/timeline-validation.ts
M  package-lock.json
M  package.json
M  runtime/commands/package.ts
M  runtime/commands/render.ts
 M runtime/connectors/gemini-vlm.ts
 M runtime/connectors/vlm-peak-detector.ts
A  runtime/packaging/deliverable.ts
M  runtime/packaging/manifest.ts
 M runtime/render/assembler.ts
 M runtime/render/pipeline.ts
M  schemas/timeline-ir.schema.json
M  scripts/init-project.ts
 M scripts/regen-ax1-captions.ts
M  tests/e2e-m4.test.ts
M  tests/package-assembler.test.ts
M  tests/public-cli.test.ts
 M tests/render-pipeline.test.ts
D  tmp/rokutaro-posters-all.jpg
D  tmp/rokutaro-thumbs/39B2F532-BEAD-45B3-B316-531EED5BB9A0.MP4.jpg
D  tmp/rokutaro-thumbs/IMG_0117.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_0359.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_0543.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_0601.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_0805.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_0944.mov.jpg
D  tmp/rokutaro-thumbs/IMG_0953.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_0997.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_1004.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_1163.mov.jpg
D  tmp/rokutaro-thumbs/IMG_1199.mov.jpg
D  tmp/rokutaro-thumbs/IMG_1311.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_1470.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_2481.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_2733.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_3941.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_4149.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_4178.mov.jpg
D  tmp/rokutaro-thumbs/IMG_4342.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_4719.mov.jpg
D  tmp/rokutaro-thumbs/IMG_4742.mov.jpg
D  tmp/rokutaro-thumbs/IMG_6015.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_6482.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_6570.mov.jpg
D  tmp/rokutaro-thumbs/IMG_6645.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_7014.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_7040.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_7167.MOV.jpg
D  tmp/rokutaro-thumbs/IMG_8681.mov.jpg
D  tmp/rokutaro-thumbs/VID_20201024_082154.mov.jpg
D  tmp/rokutaro-thumbs/contact-sheet-labeled.jpg
D  tmp/rokutaro-thumbs/contact-sheet.jpg
D  tmp/rokutaro-thumbs/final-mid.jpg
 M tsconfig.json
?? docs/editor-preview-render-parity-design.md
?? editor/server/services/preview-job-service.ts
?? editor/shared/caption-style-tokens.ts
?? editor/shared/filtergraph.ts
?? editor/shared/render-spec.ts
?? editor/tests/
?? projects/demo/project_state.yaml
?? scripts/render-ax1-promo.ts
```

## カテゴリ別分類と処置提案

### 1. OSS readiness

Files:

- `.github/ISSUE_TEMPLATE/bug_report.md`: public issue template。private media/API key 添付禁止を明記。
- `.github/ISSUE_TEMPLATE/feature_request.md`: feature request template。affected area と private data 注意。
- `.github/pull_request_template.md`: validate/test/build と public repo safety checklist。
- `.github/workflows/ci.yml`: Node 22, `npm ci`, `npm run validate`, `npm test`, `npm run build`。
- `.gitignore`: `tmp/`, `/editor-*.png` を ignore へ追加。
- `CODE_OF_CONDUCT.md`: Contributor Covenant 2.1 ベースの行動規範。
- `CONTRIBUTING.md`: setup, PR checklist, repo boundaries。
- `LICENSE`: MIT License。
- `README.md`: `.env.local` 非管理、`09_output/final.mp4`, validate scope, OSS links, MIT 反映。
- `SECURITY.md`: private advisory / credentials / media handling。
- `docs/oss-readiness.md`: publish 前 checklist。
- `package.json`, `package-lock.json`: root package に `license: MIT`、`validate` を `projects/demo` に限定、`validate:all-local` 追加。一部 lock dependency patch bump が混入。
- `editor/package.json`, `editor/package-lock.json`, `editor/client/package.json`, `editor/client/package-lock.json`: editor packages に `license: MIT`。lock に patch bump / optional wasm dependency が混入。

推定意図:

- OSS 公開準備。README と policy docs と CI を整える作業。
- `validate` を demo 限定にしたのは、ignored/local project outputs を CI に巻き込まない意図。
- lockfile patch bump は `npm install` の副作用の可能性が高く、OSS readiness 本体とは分離して確認したい。

推奨処置: **commit**, ただし lockfile patch bump は **保留** または別 commit。

Commit message 案:

```text
chore(oss): add public repository readiness docs

Add MIT license, contribution/security/conduct docs, issue and PR templates,
and CI baseline for validate/test/build. Document public data boundaries.
```

Allowlist:

- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/pull_request_template.md`
- `.github/workflows/ci.yml`
- `.gitignore` の `tmp/` と `/editor-*.png` hunks
- `CODE_OF_CONDUCT.md`
- `CONTRIBUTING.md`
- `LICENSE`
- `README.md` の OSS / env / test / output directory 更新
- `SECURITY.md`
- `docs/oss-readiness.md`
- `package.json` の `license`, `validate`, `validate:all-local`
- `editor/package.json` の `license`
- `editor/client/package.json` の `license`

Risk:

- `.gitignore tmp/` は既に tracked な `tmp/` 削除とセットで扱わないと、tracked binary が残る。
- README の `09_output/final.mp4` 記述は runtime/package 実装と同時に入れないと、文書だけ先行して不整合になる。
- lockfile patch bump は CI 再現性に影響するため、OSS docs と同一 commit に混ぜるとレビューが濁る。

### 2. tmp generated binary cleanup

Files:

- `tmp/rokutaro-posters-all.jpg`
- `tmp/rokutaro-thumbs/*.jpg` 34 files

推定意図:

- rokutaro montage / media analysis の一時 poster, thumbnail, contact sheet, intermediate JPEG。Git 管理すべき成果物ではない。
- すべて staged deletion。`.gitignore` に `tmp/` が追加されているため、今後の再発防止と一致している。

推奨処置: **commit + gitignore へ**。

Commit message 案:

```text
chore(repo): stop tracking temporary media thumbnails

Remove generated rokutaro thumbnail/contact-sheet binaries from Git and
ignore tmp/ outputs going forward.
```

Allowlist:

- `.gitignore` の `tmp/` hunk
- `tmp/rokutaro-posters-all.jpg`
- `tmp/rokutaro-thumbs/39B2F532-BEAD-45B3-B316-531EED5BB9A0.MP4.jpg`
- `tmp/rokutaro-thumbs/IMG_0117.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_0359.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_0543.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_0601.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_0805.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_0944.mov.jpg`
- `tmp/rokutaro-thumbs/IMG_0953.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_0997.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_1004.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_1163.mov.jpg`
- `tmp/rokutaro-thumbs/IMG_1199.mov.jpg`
- `tmp/rokutaro-thumbs/IMG_1311.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_1470.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_2481.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_2733.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_3941.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_4149.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_4178.mov.jpg`
- `tmp/rokutaro-thumbs/IMG_4342.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_4719.mov.jpg`
- `tmp/rokutaro-thumbs/IMG_4742.mov.jpg`
- `tmp/rokutaro-thumbs/IMG_6015.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_6482.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_6570.mov.jpg`
- `tmp/rokutaro-thumbs/IMG_6645.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_7014.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_7040.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_7167.MOV.jpg`
- `tmp/rokutaro-thumbs/IMG_8681.mov.jpg`
- `tmp/rokutaro-thumbs/VID_20201024_082154.mov.jpg`
- `tmp/rokutaro-thumbs/contact-sheet-labeled.jpg`
- `tmp/rokutaro-thumbs/contact-sheet.jpg`
- `tmp/rokutaro-thumbs/final-mid.jpg`

Risk:

- これらを消す commit は binary 履歴削除ではない。Git history から完全に消す必要がある場合は別途 repository rewrite 判断が必要。
- `tmp/` 全体 ignore は正しいが、将来 intentional fixture を `tmp/` 配下に置きたい場合は allowlist が必要。

### 3. runtime final deliverable / packaging

Files:

- `runtime/commands/package.ts`: `publishFinalVideo()` を呼び、QA 後に `09_output/final.mp4` を発行。result に `deliverablePath` 追加。
- `runtime/commands/render.ts`: render artifacts list に `09_output/final.mp4` 追加。
- `runtime/packaging/deliverable.ts`: `PUBLISHED_OUTPUT_DIR`, `PUBLISHED_FINAL_VIDEO`, `getPublishedFinalVideoPath`, `publishFinalVideo` 新規。
- `runtime/packaging/manifest.ts`: engine-render manifest の final video path を `07_package/video/final.mp4` 固定から optional override へ。
- `scripts/init-project.ts`: 新規 project に `09_output` を作成。
- `tests/e2e-m4.test.ts`, `tests/package-assembler.test.ts`, `tests/public-cli.test.ts`: `deliverablePath` と `09_output/final.mp4` の存在確認。
- `README.md`: 「書き出し先」セクションで `projects/<project-id>/09_output/final.mp4` を user-facing final と宣言。

推定意図:

- `07_package/` を内部 package/QA 用に残し、ユーザー向け最終動画の保存先を `09_output/final.mp4` に統一する。
- M4 packageCommand 既存テストへの自然な拡張。

推奨処置: **commit**。OSS readiness とは分離する。

Commit message 案:

```text
feat(package): publish final deliverable to 09_output

Copy the QA-approved final video to projects/<id>/09_output/final.mp4,
include the path in package results, and cover the flow in M4/package tests.
```

Allowlist:

- `runtime/commands/package.ts`
- `runtime/commands/render.ts`
- `runtime/packaging/deliverable.ts`
- `runtime/packaging/manifest.ts`
- `scripts/init-project.ts`
- `tests/e2e-m4.test.ts`
- `tests/package-assembler.test.ts`
- `tests/public-cli.test.ts`
- `README.md` の `## 書き出し先` hunk

Risk:

- `publishFinalVideo(absDir, finalVideoSourcePath!)` は `finalVideoSourcePath` が必ずセットされる前提。package failure path / release safety failure path との相互作用をテストで確認する必要がある。
- manifest の final path が `09_output` に変わることで、既存の downstream が `07_package/video/final.mp4` を期待している場合に影響する。
- `09_output/final.mp4` は generated binary なので `.gitignore` の `projects/*` 境界と矛盾しないか確認が必要。

### 4. schema strictness

Files:

- `schemas/timeline-ir.schema.json`: root と nested object に `additionalProperties: false` を追加。

推定意図:

- TimelineIR schema の余分な field を拒否して contract を硬くする。production-readiness の schema-first 方針には合う。

推奨処置: **保留**。

理由:

- 1 file だけだが blast radius が大きい。editor v3 側は `metadata.render`, caption tracks, transitions などの柔軟な拡張を追加しており、schema strictness と衝突する可能性がある。
- P1-P4d 本筋の schema changes とも関係しうるため、単独で validation suite を通してから判断するべき。

Commit message 案:

```text
fix(schema): reject unknown timeline fields

Tighten TimelineIR validation by disallowing unknown root and nested fields.
```

Allowlist:

- `schemas/timeline-ir.schema.json`

Risk:

- demo/local project timeline に余分な operational metadata が残っている場合、`npm run validate` が壊れる。
- editor でまだ schema に反映していない caption/overlay/effect metadata を保存すると reject される可能性。

### 5. editor v3 exact preview parity

Files:

- `docs/editor-preview-render-parity-design.md`: ProgramMonitor と final MP4 を単一 `RenderSpec` で一致させる設計。exact preview, source fallback, caption/style/filtergraph/audio parity, CI criteria を記述。
- `editor/server/services/preview-job-service.ts`: project ごとの single-flight preview queue。RenderSpec から ffmpeg preview artifact と `preview.json` を生成。WebSocket broadcast 用 state を返す。
- `editor/server/routes/preview.ts`: 旧単純 preview API を RenderSpec + PreviewJobService ベースに置換。`/preview/status` と `/preview/previews/:filename` 追加。
- `editor/server/index.ts`: `PreviewJobService` を生成し `render.changed` WebSocket broadcast へ接続。
- `editor/server/services/watch-hub.ts`: `render.changed` に preview metadata を追加し `05_timeline/previews/preview.json` を watch。
- `editor/shared/render-spec.ts`: TimelineIR + source map + caption approval を render-ready spec へ正規化。hash, captions, effects, audio mastering defaults を含む。
- `editor/shared/filtergraph.ts`: preview/final 共通の ffmpeg video filter/effect/transition builder。
- `editor/shared/caption-style-tokens.ts`: caption style preset から ASS force_style と CSS style を生成。
- `editor/shared/timeline-validation.ts`: caption track validation を追加。
- `editor/tests/parity/*`: filter parity の常時 test と `PARITY=1` gated heavy SSIM/LUFS comparison。
- `runtime/render/assembler.ts`: clip metadata から transform/effects を抽出し、final render も shared filtergraph を使う。
- `runtime/render/pipeline.ts`: `buildAspectRatioFitFilter` を shared filtergraph builder 経由へ変更し、transform filter builder を追加。
- `tests/render-pipeline.test.ts`: shared filtergraph output へ期待値変更。
- `tsconfig.json`: `editor/shared/**/*.ts` を root build 対象に追加。
- `scripts/regen-ax1-captions.ts`: caption force_style を shared caption preset builder へ変更。
- `editor/client/src/App.tsx`, `EditorLayout.tsx`, `ProgramMonitor.tsx`, `PreviewPlayer.tsx`, `TransportBar.tsx`, `usePlayback.ts`, `useProjectSync.ts`: exact rendered preview playback, stale/hash/revision validation, WebSocket render events, auto-preview after save。
- `editor/client/src/types.ts`, `editor/client/src/utils/editor-helpers.ts`, `editor/client/src/utils/draw.ts`, `ClipBlock.tsx`, `TrackLane.tsx`, `PropertyPanel.tsx`, `DiffPanel.tsx`, `useDiff.ts`, `useTimeline.ts`: caption track support, caption edit UI, content diff, caption lane colors。
- `editor/client/src/useSourcePlayback.ts`, `editor/server/routes/media.ts`: media transcode fallback / browser-compatible playback fixes。
- `editor/client/src/components/AppShell.tsx`, `ClipLayer.tsx`, `Timeline.tsx`, `TrackHeader.tsx`, `useEditorKeyboard.ts`, `usePlayback.ts` adjacent changes: exact preview / caption lane integration side effects。

推定意図:

- editor v3 続編。`feat(editor): NLE-grade UI with AI workspace`, `feat(editor-v3): P0 fixes + P1 bidirectional sync` の後続で、ProgramMonitor exact preview と final render parity を実装しようとしている。
- コメントに `FATAL-1`, `MAJOR-2`, `Phase 5 review R1` などが残っており、設計レビュー指摘の修正 WIP と推定。

推奨処置: **保留**。commit するなら複数 commit に分割。

分割 commit 案:

```text
docs(editor): define preview render parity architecture
```

Allowlist: `docs/editor-preview-render-parity-design.md`

```text
feat(editor): add RenderSpec-based exact preview service
```

Allowlist: `editor/shared/render-spec.ts`, `editor/shared/filtergraph.ts`, `editor/shared/caption-style-tokens.ts`, `editor/server/services/preview-job-service.ts`, `editor/server/routes/preview.ts`, `editor/server/index.ts`, `editor/server/services/watch-hub.ts`, `editor/tests/parity/*`, `tsconfig.json`

```text
feat(editor): play exact preview artifacts in ProgramMonitor
```

Allowlist: `editor/client/src/App.tsx`, `editor/client/src/components/EditorLayout.tsx`, `editor/client/src/components/ProgramMonitor.tsx`, `editor/client/src/components/PreviewPlayer.tsx`, `editor/client/src/components/TransportBar.tsx`, `editor/client/src/hooks/usePlayback.ts`, `editor/client/src/hooks/useProjectSync.ts`, `editor/client/src/types.ts`

```text
feat(editor): support caption lanes and caption editing
```

Allowlist: `editor/client/src/components/ClipBlock.tsx`, `DiffPanel.tsx`, `PropertyPanel.tsx`, `TrackLane.tsx`, `editor/client/src/hooks/useDiff.ts`, `useTimeline.ts`, `editor/client/src/utils/draw.ts`, `editor/client/src/utils/editor-helpers.ts`, `editor/shared/timeline-validation.ts`

```text
fix(editor): improve source media browser playback fallback
```

Allowlist: `editor/server/routes/media.ts`, `editor/client/src/hooks/useSourcePlayback.ts`

Risk:

- 大きすぎる。preview server, client playback, final render, caption editing, schema/build scope が同時に動いているため、単一 commit は不可。
- root `tsconfig.json` に `editor/shared/**/*.ts` を含めると、runtime build が editor shared の Node/browser 境界に依存する。
- preview job service は ffmpeg/libass/font 環境に依存する。CI default test と heavy `PARITY=1` の切り分けが重要。
- exact preview の stale/hash 判定が厳しすぎると常に source fallback になり、緩すぎると古い preview を exact と誤表示する。
- final render が shared filtergraph に寄ることで、従来の `scale+pad:black` 期待値と output encoding が変わる。

### 6. editor package metadata / lockfile drift

Files:

- `editor/package.json`, `editor/client/package.json`: `license: MIT`。
- `editor/package-lock.json`: `license: MIT`, `path-to-regexp` 0.1.12 -> 0.1.13。
- `editor/client/package-lock.json`: `license: MIT`, Tailwind optional wasm deps追加, `postcss`/`vite` patch bump。
- `package-lock.json`: root `license: MIT`, `picomatch`, `postcss`, `vite`, `yaml` patch bump。

推定意図:

- package metadata は OSS readiness の一部。
- lock patch bump は `npm install` などによる incidental dependency refresh の可能性が高い。

推奨処置: **保留**。

理由:

- `license` だけなら OSS readiness commit に含めてよい。
- patch bump は security/freshness の意図があるなら別 commit。意図がないなら revert candidate。

Commit message 案:

```text
chore(deps): refresh lockfiles after OSS metadata update
```

Allowlist:

- lockfile の package metadata / dependency bump hunks。ただし `npm ci` 再現確認後。

Risk:

- CI の package cache / install 解決が変わる。
- root/editor/client の lock drift を一緒に入れると、OSS docs のレビュー対象が広がる。

### 7. runtime VLM connector fixes

Files:

- `runtime/connectors/gemini-vlm.ts`: Gemini request に `responseMimeType: "application/json"` を追加。
- `runtime/connectors/vlm-peak-detector.ts`: default model alias を `gemini-2.0-flash` から `gemini-2.5-flash` に変更。

推定意図:

- VLM rerun 時の JSON output 安定化と現行 Gemini model への切り替え。過去の VLM analysis rerun / connector fix の続き。

推奨処置: **commit**, ただし editor/render parity とは分離。

Commit message 案:

```text
fix(vlm): request JSON responses from Gemini peak analysis

Set Gemini response MIME type to JSON and update the peak detector default
model alias for current VLM reruns.
```

Allowlist:

- `runtime/connectors/gemini-vlm.ts`
- `runtime/connectors/vlm-peak-detector.ts`

Risk:

- Gemini model availability / pricing / output qualityは環境依存。2026-04-27 時点の checkout では妥当そうだが、実運用前に API smoke が必要。
- default model alias の変更は既存 projects の analysis reproducibility に影響する。

### 8. AX1 promo / caption scripts

Files:

- `scripts/render-ax1-promo.ts`: AX-1 participant voice promo の standalone render script。local source `/Users/operator/Downloads/AX-1_参加者の声/D4887.MP4` を参照し、`09_output/ax1_promo_v5` を生成する例。
- `scripts/regen-ax1-captions.ts`: shared caption style token を使って force_style を生成するよう変更。

推定意図:

- AI Reboot Academy / AX1 promo 用の個別制作スクリプト。shared caption style 化の影響を受けている。

推奨処置: **保留** または **revert (discard)**。

理由:

- `render-ax1-promo.ts` は個人ローカルパスと具体的素材に依存しており、OSS readiness とは相性が悪い。
- script を残すなら `examples/` 扱いにする、素材パスを env/config 化する、公開不可素材がないか確認する必要がある。
- `regen-ax1-captions.ts` の shared style 化は editor/render parity commit と一緒なら意味があるが、単独だと `editor/shared` 依存を増やす。

Risk:

- private/local path と参加者素材名が public repo に混入する。
- root build が `scripts/**/*.ts` を含むため、untracked script が commit されると compile/import 境界に影響する。

### 9. projects/demo project_state

Files:

- `projects/demo/project_state.yaml`

推定意図:

- demo project の runtime state。`current_state: critique_ready`, gates, artifact hashes, `last_updated: 2026-04-27T02:43:23.513Z` を含む。
- P2/P4d 付近の demo self-heal / package gate 状態が生成された可能性。

推奨処置: **保留**。

理由:

- `projects/demo/` は Git 管理対象候補だが、`project_state.yaml` が canonical fixture なのか runtime output なのか判断が必要。
- `last_updated` を含むため、byte-stable demo policy と衝突しやすい。

Risk:

- commit すると demo validation の初期 state が変わる。
- discard すると直近 local demo/package 実験の状態証跡を失う可能性。

### 10. AppShell / ClipLayer / Timeline / TrackHeader / keyboard small editor adjacencies

Files:

- `editor/client/src/components/AppShell.tsx`
- `editor/client/src/components/ClipLayer.tsx`
- `editor/client/src/components/Timeline.tsx`
- `editor/client/src/components/TrackHeader.tsx`
- `editor/client/src/hooks/useEditorKeyboard.ts`

推定意図:

- diff stat は小さい。caption lanes / exact preview / layout integration に伴う型・表示・操作の追随と推定。

推奨処置: **保留**。editor v3 commit 分割時に該当 hunk の意味を再確認して含める。

Risk:

- 小変更でも timeline interaction に影響するため、editor UI smoke なしで単独 commit しない。

## commit 順序提案

推奨順序:

1. **tmp generated binary cleanup**
   - まず tracked binary 削除と `tmp/` ignore を確定して、以後の status を軽くする。
2. **OSS readiness docs and templates**
   - policy/CI/docs を独立。lockfile bump は必要なら後段に分離。
3. **runtime final deliverable to `09_output`**
   - README の output path 記述はここに含める。package/render/tests を一括。
4. **VLM connector fixes**
   - 2 file の小さい runtime connector fix。model smoke の後。
5. **editor preview/render parity docs**
   - 設計 doc だけ先に commit。
6. **editor shared RenderSpec/filtergraph/caption style + preview service**
   - server/shared/test/tsconfig の foundation。
7. **editor ProgramMonitor exact playback**
   - client playback/UI integration。
8. **editor caption lanes/editing**
   - caption track UI と diff/timeline validation。
9. **editor media playback fallback**
   - media transcode fallback は別 commit。
10. **schema strictness / demo project_state / AX1 scripts**
    - ユーザー判断後。原則最後、または discard。

依存関係:

- `runtime final deliverable` は `README.md` の output path hunk と依存。
- `editor ProgramMonitor exact playback` は `editor shared RenderSpec/filtergraph/caption-style` と `preview-job-service` に依存。
- `scripts/regen-ax1-captions.ts` と `runtime/render/*` は `editor/shared/caption-style-tokens.ts` / `filtergraph.ts` に依存。
- `schema strictness` は editor caption/render metadata と衝突する可能性があるため、editor commits 後に validation する。

## revert / discard 候補

- `scripts/render-ax1-promo.ts`: local/private source path を含む。公開 repo に入れるなら要設計変更。現状は discard 候補。
- lockfile patch bumps: `license` 以外の dependency bump が意図不明なら discard 候補。
- `projects/demo/project_state.yaml`: generated state なら discard 候補。ただし canonical fixture 化する判断があるなら保留。
- `schemas/timeline-ir.schema.json`: strictness 自体は有益だが、今の mixed WIP では衝突リスクが高い。即 discard ではなく保留。

## gitignore 提案

既存 staged `.gitignore` hunk は妥当。

- `tmp/`: thumbnails/contact sheets/posters など生成物を除外。
- `/editor-*.png`: local visual debug screenshots を除外。

追加で検討する候補:

- `projects/*/09_output/`: 既に `projects/*` ignore があるため不要の可能性が高い。ただし `projects/demo/09_output` を生成する場合は demo allowlist と衝突しないか確認。
- `projects/*/05_timeline/previews/`: exact preview artifacts は生成物。`projects/*` ignore で通常はカバーされるが、`projects/demo/` が allowlist されているため demo 配下生成物が status に出るなら追加 ignore を検討。
- `projects/demo/project_state.yaml`: generated runtime state と決めるなら ignore。canonical fixture とするなら ignore しない。

## 次アクション優先順位

### P0

- tracked `tmp/` binary 削除 + `tmp/` ignore の commit。
- OSS readiness の docs/templates/license/CI を lockfile bump と切り離して commit。
- `09_output/final.mp4` packaging commit のテスト実行計画を作る。最低限 `npm test -- tests/e2e-m4.test.ts tests/package-assembler.test.ts tests/public-cli.test.ts` 相当。

### P1

- VLM connector 2 file を API smoke 可能なタイミングで commit。
- editor parity は docs-only commit から開始し、shared foundation / server / client / caption UI / media fallback に分割。
- lockfile bump の意図確認。security bump なら別 commit、 incidental なら戻す判断。

### P2

- `schemas/timeline-ir.schema.json` strictness を validation suite と editor save/load smoke 後に判断。
- `projects/demo/project_state.yaml` を canonical fixture にするか generated state として捨てるか決める。
- `scripts/render-ax1-promo.ts` を公開 repo に入れるなら local path と素材名の扱いを設計し直す。不要なら discard。

## 確認が必要な保留事項

- MIT `LICENSE` の copyright holder は `Mocchalera` で確定か。
- `package-lock.json` / editor lockfiles の patch bump は意図した依存更新か、`npm install` 副作用か。
- `projects/demo/project_state.yaml` は canonical demo fixture として管理するか、runtime generated として捨てるか。
- `schemas/timeline-ir.schema.json` の `additionalProperties: false` は editor v3 caption/effect metadata と同時に通せるか。
- `scripts/render-ax1-promo.ts` は公開 repo に入れるべき artifact か。local path / private media 前提なら捨てるべき。
- editor exact preview parity は今回の dirty cleanup で commit まで進めるか、続編 branch に隔離するか。
