## レビュー結果サマリー
- 🔴 FATAL: 3件
- ⚠️ WARNING: 6件
- 📝 NOTE: 2件

## 詳細

### [FATAL] OpenAI STT 設計が roadmap と実 API 制約の両方に対して未整合
- 対象ファイル: `docs/milestone-2-design.md`, `docs/roadmap.md`
- 問題:
  `docs/roadmap.md:156-165` は M2 の STT を `gpt-4o-transcribe-diarize` 前提で定義していますが、設計書は `docs/milestone-2-design.md:460-464` で `gpt-4o-transcribe` を前提に切り替えています。その一方で `docs/milestone-2-design.md:437-443`, `477-493`, `752-766`, `1032-1040` は diarization と word-level timestamps を live transcript の必須要素として要求しています。これでは「どの endpoint / response format / chunking で、どうやって diarization と word timings を同時に満たすのか」が未定義です。特に asset-level first 方針（`451-458`）なのに、長尺音声の chunking・再結合規則もありません。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `docs/roadmap.md:156-165` は `OpenAI STT (gpt-4o-transcribe-diarize)` を明示。`docs/milestone-2-design.md:460-464` は plain transcribe に後退。`docs/milestone-2-design.md:441`, `482`, `759-765`, `1033-1034` は word-level / diarization を要求。OpenAI 公式 docs でも `gpt-4o-transcribe-diarize` は Transcriptions API 専用 model とされており、speech-to-text guide では長尺入力の chunking が必要です。現状設計にはその接続仕様がありません。
- 推奨修正:
  `gpt-4o-transcribe-diarize` を正式採用するのか、`gpt-4o-transcribe` + 別 diarization/alignment layer を採るのかを先に固定してください。その上で `endpoint`, `response_format`, `chunking_strategy`, `chunk merge`, `speaker label normalization`, `words[]` 生成方法を設計書に明記し、`transcript.schema.json` の live profile をその仕様に合わせて閉じるべきです。

### [FATAL] 並列化設計が shared artifact への競合書き込みを「安全」と誤判定している
- 対象ファイル: `docs/milestone-2-design.md`
- 問題:
  設計書は `docs/milestone-2-design.md:271-272` で `segments.json` を STT/Gemini が in-place enrichment すると書きつつ、`772-790` では各 stage が `assets.json` / `segments.json` を patch し、`793-805` では per-asset / per-segment 並列化を「safe」と定義しています。ですが `783`, `787-788` の通り複数 worker が同じ `assets.json` と `segments.json` を更新する設計なので、file lock か shard merge protocol が無い限り race condition になります。これでは Success Criteria 2 の byte-stable rerun と 5 の partial failure 保全を同時に満たせません。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `docs/milestone-2-design.md:32-40` の success criteria は deterministic rerun と partial failure 保全を要求。にもかかわらず `docs/milestone-2-design.md:783`, `787-788`, `795-805` は shared JSON patch を並列化前提で記述。`docs/milestone-2-design.md:864-868` は stable sort / reuse を idempotency rule に置いていますが、write serialization 自体は未定義です。
- 推奨修正:
  shared artifact の direct patch をやめ、stage ごとに `per-asset shard -> deterministic reducer -> atomic rename` に変更してください。少なくとも `assets.json`, `segments.json`, `gap_report.yaml` は単一 reducer だけが書く形にし、並列 worker は shard 出力のみ許可すべきです。

### [FATAL] `media-mcp` の固定インターフェースを支える派生物が設計書に揃っていない
- 対象ファイル: `docs/milestone-2-design.md`, `contracts/media-mcp.md`, `docs/roadmap.md`
- 問題:
  roadmap は `docs/roadmap.md:168-170` で「tool interface は変更なし」と固定していますが、M2 設計が明示する派生成果物は contact sheet と waveform master までです（`docs/milestone-2-design.md:186-190`, `310-339`）。一方 `contracts/media-mcp.md:56-73` の `media.list_assets` は `poster_path` を、`contracts/media-mcp.md:193-209` の `media.peek_segment` は `filmstrip_path` と `waveform_path` を、`contracts/media-mcp.md:24-36` の `media.project_summary` は `analysis_gaps` を返します。設計書は `docs/milestone-2-design.md:901-906` で waveform crop しか lazy materialization を書いておらず、poster / filmstrip / gap projection の決定的な生成規則がありません。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `docs/roadmap.md:168-170` の contract-safe 差し替え要件。`contracts/media-mcp.md:68`, `204-205`, `233-235`, `35` の response shape。`docs/milestone-2-design.md:333-339`, `901-906` は waveform だけを補っていますが、poster / filmstrip / analysis_gaps の backing rule は absent です。
- 推奨修正:
  `poster_path`, `filmstrip_path`, `analysis_gaps` をどう満たすかを設計書に追加してください。方法は 2 択です。1) deterministic derivative として正式生成する。2) tool contract 側で optional convenience field として明文化し、未生成時の返却ルールを契約に追記する。現状のままでは live backend が contract-safe か判定できません。

### [WARNING] `analysis_policy.yaml` が machine-readable contract と言いながら schema / validator を持っていない
- 対象ファイル: `docs/milestone-2-design.md`, `docs/milestone-1-review.md`
- 問題:
  設計書は `docs/milestone-2-design.md:495-523`, `606-618` で `analysis_policy.yaml` を determinism と cost control の中核に置いていますが、Phase 1 deliverables（`986-995`）に schema がなく、required subfields も prose のままです。M1 レビューで指摘した「analysis policy が untracked」という問題を、schema 化なしで再導入しています。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `docs/milestone-1-review.md:35-43` は policy を machine-readable にせよと指摘。`docs/milestone-2-design.md:617-618` も「connector code に隠してはならない」と同趣旨ですが、`docs/milestone-2-design.md:986-995` に `schemas/analysis-policy.schema.json` がありません。
- 推奨修正:
  `schemas/analysis-policy.schema.json` を Phase 1 deliverable に追加し、`classification`, `sampling`, `vlm`, `stt`, `quality_thresholds`, `parallelism`, `gap_policy`, `cache` の required/optional を確定してください。policy hash は schema-valid な merged policy に対してのみ計算するべきです。

### [WARNING] ffmpeg scene detection のコマンド・閾値が設計として十分に固定されていない
- 対象ファイル: `docs/milestone-2-design.md`, `docs/roadmap.md`
- 問題:
  `docs/milestone-2-design.md:249-257` は `select='gt(scene,threshold)'` を採ると書いていますが、`threshold` の既定値、PTS の取得方法、cut merge / min segment duration、black/freeze/silence heuristic の具体パラメータがありません。さらに policy defaults（`557-576`）や quality thresholds（`608-615`）にも scene threshold が入っていません。これでは別実装者が同じ設計書から同じ segmentation を再現できません。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `docs/roadmap.md:157` は ffmpeg/ffprobe が `segments.json` を出すことを要求。`docs/milestone-2-design.md:32-35` は deterministic outputs を要求。しかし `docs/milestone-2-design.md:251-256` は heuristic 名だけで、固定パラメータは absent です。
- 推奨修正:
  設計書に canonical command / filter set を記載し、最低でも `scene_threshold`, `min_segment_duration_us`, `merge_gap_us`, `blackdetect threshold`, `silencedetect threshold`, `freeze duration threshold` を `analysis_policy` 側の明示フィールドにしてください。

### [WARNING] Gemini connector の input / output contract が「adapter detail」で逃げられており実装差分を吸収できない
- 対象ファイル: `docs/milestone-2-design.md`, `docs/roadmap.md`
- 問題:
  `docs/milestone-2-design.md:370-375` は request wiring を intentionally hidden としていますが、M2 で必要なのは SDK の細部ではなく、どの input unit を送るのか、どの structured shape を期待するのか、parse failure をどう gap に落とすのかという contract です。現状は `sampled frames or a short proxy clip`（`352-354`）としか書いておらず、`summary/tags/interest_points/quality_flags` の response schema も未固定です。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `docs/roadmap.md:158-170` は Gemini を live connector として接続しつつ tool interface 不変を要求。`docs/milestone-2-design.md:396-412` は normalization ルールだけで、provider response envelope は absent。Google 公式 docs でも video input は sampling FPS と File API / inline の選択が first-order parameter です。
- 推奨修正:
  `Gemini request contract` を設計書に追加し、`input mode`, `model id or snapshot`, `max frames / resolution`, `prompt template hash`, `expected JSON schema`, `parse-retry policy`, `gap fallback` を固定してください。

### [WARNING] byte-stable rerun を掲げる割に model snapshot / request hash の固定要素が不足している
- 対象ファイル: `docs/milestone-2-design.md`
- 問題:
  `docs/milestone-2-design.md:34-35` は same inputs / same policy / same connector versions なら byte-stable と宣言していますが、cache key（`855-860`）には model snapshot, prompt template hash, chunking strategy, provider-side response format が明示されていません。`run_manifest.json` に model name を持つ（`157-160`）だけでは alias drift を防げず、clean rebuild の安定性は担保されません。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `docs/milestone-2-design.md:32-35`, `508`, `855-860`。`docs/milestone-2-design.md:372-374`, `462-464` は model alias を書くだけで snapshot pinning を要求していません。OpenAI model docs も alias と snapshot を分けて扱っています。
- 推奨修正:
  cache key と provenance の必須要素に `model_snapshot`, `prompt_hash`, `response_format`, `chunking_strategy`, `ffmpeg_version` を追加し、rebuild determinism を「cache reuse」ではなく「same canonical request」で定義し直すべきです。

### [WARNING] `qc_status: partial` の operator override は現行 state machine に存在しない例外遷移
- 対象ファイル: `docs/milestone-2-design.md`, `ARCHITECTURE.md`
- 問題:
  設計書は `docs/milestone-2-design.md:102-106` で `qc_status: partial` から explicit operator override により M3 へ進める含みを持たせていますが、`ARCHITECTURE.md:165-167` の state machine は `intent_locked -> media_analyzed` を「ingest + shot graph + transcripts + contact sheets ready」のときだけ許可しています。partial override は architecture 上の例外遷移として定義されていません。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `ARCHITECTURE.md:165-167` の strict transition。`docs/milestone-2-design.md:98-106` は M2 handoff rule として override を追加。
- 推奨修正:
  override を正式に許すなら `ARCHITECTURE.md` の state machine と gate 文言を更新してください。許さないなら、設計書側から override 文言を削除して debug/manual smoke 専用状態に限定すべきです。

### [WARNING] Success Criteria 5 を証明する failure-injection テストが test strategy に入っていない
- 対象ファイル: `docs/milestone-2-design.md`
- 問題:
  Success Criteria 5 は `docs/milestone-2-design.md:39-40` で partial failure と gap report を要求していますが、Test Gates（`44-61`）と Test Strategy（`908-969`）には retry exhaustion, provider timeout, derivative write failure などを意図的に起こして `gap_report.yaml`, `qc_status`, `analysis_gaps` を検証するテスト lane がありません。manual smoke だけでは regression guard になりません。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `docs/milestone-2-design.md:812-849` は partial failure handling を detailed に書いている一方、`924-956` の integration / e2e checks は happy path 中心です。
- 推奨修正:
  provider-mock lane に failure injection ケースを追加し、少なくとも `STT failure`, `Gemini timeout`, `contact sheet write failure`, `retry exhausted` の 4 ケースで `gap_report.yaml` と `media.project_summary` の派生値を assert してください。

### [NOTE] `confidence` / `provenance` は有用だが shared sub-schema が無く、後続で drift しやすい
- 対象ファイル: `docs/milestone-2-design.md`
- 問題:
  `docs/milestone-2-design.md:288-290`, `705-723` は confidence/provenance を各 field に付ける方向性として妥当ですが、必須キーの共通定義がありません。このままだと `segments`, `transcript`, 将来の `selects` で微妙に別 vocabulary が増えやすいです。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  M2 設計書は provenance を「connector, model/method, policy hash, run metadata」と prose で説明しますが、schema-level `$defs` は未提示です。
- 推奨修正:
  `provenance-record` と `confidence-record` の shared `$defs` を先に定義し、artifact 間で同じ key set を再利用する形に寄せると M3 の reasoning が安定します。

### [NOTE] `analysis_status` と `qc_status` の語彙差は crosswalk を付けた方が実装がぶれにくい
- 対象ファイル: `docs/milestone-2-design.md`
- 問題:
  `docs/milestone-2-design.md:678-684` の asset-level `analysis_status` は `pending|ready|partial|skipped|failed`、`837-845` の project-level `qc_status` は `ready|partial|blocked` です。責務が違うこと自体は問題ありませんが、crosswalk が無いため repository 実装ごとに集約規則がずれやすいです。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  status vocabulary が 2 系統あり、どの asset-state 組み合わせで project summary を `ready / partial / blocked` にするかは prose だけです。
- 推奨修正:
  設計書に `asset statuses -> project qc_status` の集約表を 1 つ追加してください。`failed + ready mix => partial か blocked か` のような境界条件を先に潰しておくべきです。
