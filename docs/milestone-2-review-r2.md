## R2 レビュー結果サマリー
- 🔴 FATAL: 0件（新規0 / 残存0）
- ⚠️ WARNING: 2件（新規2 / 残存0）
- 📝 NOTE: 1件（新規1 / 残存0）

R1 の 11 指摘はすべて解消されている。修正後レビューでは新規 FATAL は見つからなかったが、派生物パス命名と `media.project_summary` 集約規則に warning が残るため、判定は `CONDITIONAL PASS` とする。

## R1 指摘解消状況

### [FATAL 1] OpenAI STT — 解消
- `docs/milestone-2-design.md:568-643` で `POST /v1/audio/transcriptions`、`gpt-4o-transcribe-diarize`、`diarized_json`、client-side chunking、chunk merge、speaker normalization、`word_timing_mode` まで固定された。
- `docs/roadmap.md:156-159` の M2 connector 方針とも一致しており、R1 時点の `gpt-4o-transcribe` への後退は解消された。
- 現行の OpenAI Speech-to-Text guide でも `gpt-4o-transcribe-diarize` と `diarized_json` は有効で、30秒超音声では `chunking_strategy` が必要とされている。設計書は canonical run を client-side 25秒以下 chunk に固定しているため、この制約とも整合する。
  - 参照: https://platform.openai.com/docs/guides/speech-to-text

### [FATAL 2] 並列化 — 解消
- `docs/milestone-2-design.md:316-317` と `docs/milestone-2-design.md:1024-1079` が map shard -> single-writer reducer -> atomic rename に切り替わっており、R1 の shared JSON in-place patch は除去された。
- canonical artifact の direct write を reducer のみに限定しているため、`assets.json` / `segments.json` / `gap_report.yaml` の race condition は設計上解消されている。

### [FATAL 3] media-mcp 派生物 — 解消
- `docs/milestone-2-design.md:357-419` で contact sheet / poster / filmstrip / waveform backing rules が追加された。
- `docs/milestone-2-design.md:1113-1117` と `docs/milestone-2-design.md:1205-1211` で `analysis_gaps` の projection と MCP response field への接続が明文化された。
- これにより `contracts/media-mcp.md:24-35`, `contracts/media-mcp.md:56-70`, `contracts/media-mcp.md:193-209` の主要派生 field は設計レベルで裏付けられる。

### [WARNING 1] `analysis_policy.yaml` contract — 解消
- `docs/milestone-2-design.md:660-709` で `schemas/analysis-policy.schema.json` を前提に required root / nested fields が固定された。
- `docs/milestone-2-design.md:1302-1318` でも Phase 1 deliverable に schema と validator 更新が追加されている。

### [WARNING 2] ffmpeg scene detection 固定度 — 解消
- `docs/milestone-2-design.md:264-301` で canonical detector command set が追加され、`scene_threshold`, `min_segment_duration_us`, `merge_gap_us`, `blackdetect_*`, `silencedetect_*`, `freezedetect_*` の defaults も固定された。
- R1 が問題視していた「どの filter/threshold で segmentation するか不明」という点は解消されている。

### [WARNING 3] Gemini contract 未固定 — 解消
- `docs/milestone-2-design.md:456-479` が input mode、model snapshot、frame cap、prompt hash、expected JSON schema、parse-retry policy、gap fallback まで固定している。
- `docs/milestone-2-design.md:501-516` で output normalization も閉じており、R1 の「adapter detail で逃げている」状態ではなくなった。

### [WARNING 4] byte-stable rerun の固定要素不足 — 解消
- Success Criteria 2 に canonical request tuple が追加され (`docs/milestone-2-design.md:34-36`)、`run_manifest.json` も snapshot / response format / prompt hash / chunking strategy / request hash を保持する (`docs/milestone-2-design.md:157-170`)。
- `docs/milestone-2-design.md:1147-1157` と `docs/milestone-2-design.md:795-796` で cache key / request hash の必須要素も補強されている。

### [WARNING 5] `qc_status: partial` override — 解消
- `docs/milestone-2-design.md:106-110` で `qc_status: partial` は debug/manual smoke 用であり、`intent_locked -> media_analyzed` gate を満たさないと明記された。
- `ARCHITECTURE.md:163-167` の state machine と矛盾しない。

### [WARNING 6] failure-injection test 不足 — 解消
- `docs/milestone-2-design.md:1235-1249` の provider-mock integration lane に `STT failure`, `Gemini timeout`, `contact sheet write failure`, `retry exhausted` が追加されている。
- Success Criteria 5 を regression guard するテスト lane は R1 より明確になった。

### [NOTE 1] shared sub-schema 不足 — 解消
- `docs/milestone-2-design.md:858-871` で `schemas/analysis-common.schema.json` の `confidence-record` / `provenance-record` が shared `$defs` として定義された。

### [NOTE 2] `analysis_status` と `qc_status` の crosswalk 不足 — 解消
- `docs/milestone-2-design.md:916-922` が asset-level vocabulary を固定し、`docs/milestone-2-design.md:1128-1136` が asset mix -> project `qc_status` の crosswalk table を追加している。

## 新規指摘

### [WARNING] 派生物パスのテンプレートが stable ID の prefix を二重付与している
- `asset_id` はすでに `AST_<...>`、`segment_id` はすでに `SEG_<...>` である (`docs/milestone-2-design.md:211-215`)。
- しかし poster / filmstrip / waveform crop の path rule は `03_analysis/posters/AST_<asset_id>.jpg` (`docs/milestone-2-design.md:382`)、`03_analysis/filmstrips/SEG_<segment_id>.png` (`docs/milestone-2-design.md:400`)、`03_analysis/waveforms/SEG_<segment_id>.png` (`docs/milestone-2-design.md:1208-1209`) と記されている。
- これを文字通り実装すると `AST_AST_xxx.jpg` / `SEG_SEG_xxx.png` になり、`contracts/media-mcp.md:68`, `contracts/media-mcp.md:204-205` の example ともズレる。
- 推奨修正: `<asset_id>.jpg` / `<segment_id>.png` に正規化し、segment waveform path を canonical field に持つのか lazy-resolved convenience path に留めるのかも同時に揃える。

### [WARNING] `media.project_summary` の集約規則が `qc_status` / `analysis_gaps` 以外は未規定
- `contracts/media-mcp.md:31-35` の response には `transcripts_available`, `contact_sheets_available`, `top_motifs`, `qc_status`, `analysis_gaps` がある。
- しかし設計書が derivation rule を明記しているのは `analysis_gaps` と `qc_status` だけで (`docs/milestone-2-design.md:1113-1136`, `docs/milestone-2-design.md:1205-1211`)、他 3 field の deterministic aggregation rule がない。
- 特に `top_motifs` はランキング対象、tie-break、max 件数が未定義で、repository 実装ごとに結果が揺れる余地がある。
- 推奨修正: `media.project_summary` の field ごとに `any/all` 判定と sort / tie-break を設計書で閉じる。

### [NOTE] Success Criteria 5 と詳細 `qc_status` 規則の wording が少しずれている
- `docs/milestone-2-design.md:40-41` は partial failure の結果を `qc_status: partial` と書いている。
- 一方で詳細規則は `blocked` も返し得る (`docs/milestone-2-design.md:1121-1136`)。たとえば dialogue asset の transcript 欠落が blocking policy に触れる場合は `blocked` になる。
- 実装規則としては詳細 section の方が十分具体的なので blocker ではないが、acceptance wording は `partial` または `blocked` に揃えた方が誤読が減る。

## 実装準備判定
CONDITIONAL PASS

- 各 Phase の deliverable は `docs/milestone-2-design.md:1302-1409` でかなり明確になっており、R1 時点の FATAL は解消されている。
- ffmpeg / Gemini / OpenAI connector の repository-bound contract は実装着手可能な粒度まで固定された。
- テスト戦略も reducer determinism、failure injection、M1 loop 接続までカバーできている。
- ただし実装前または実装開始直後に、派生物 path template と `media.project_summary` 集約規則だけは文言修正してから進めた方が安全。
