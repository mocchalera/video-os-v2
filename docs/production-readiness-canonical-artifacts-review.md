# Production Readiness Canonical Artifacts Review

## Verdict

**major-revision-required**

対象文書は、production readiness を「追加 canonical artifact と gate」で支える方向性としては妥当です。特に `audio_story_graph.json` / `continuity_graph.json` を compiler へ直結させず、`selects_candidates.yaml` / `edit_blueprint.yaml` に materialize してから deterministic compile へ渡す方針は、既存の compiler 境界と整合しています。

ただし P0 確定前の設計としては、MVP artifact set、state machine、release gate、既存 M4 package/caption/music/render 面の接続に未解決の矛盾があります。現状のまま schema / fixture 実装に入ると、P1 で gate を入れた時点で既存 demo / timeline / package 系 fixture の扱いが不明確になります。

- Critical Issues: 4
- Major Issues: 8
- Minor Issues: 5
- Missing Artifacts: 14

## Strong Points

1. **Compiler 境界を守る意思決定は正しい。** 対象文書は compiler を provider-free に保つ既存原則を明示しており（`docs/production-readiness-canonical-artifacts.md:14`, `docs/production-readiness-canonical-artifacts.md:541`）、既存 architecture の compiler input 定義（`ARCHITECTURE.md:303`, `ARCHITECTURE.md:307`）と大筋で一致している。

2. **release safety を review quality から分離する設計は必要。** 既存 architecture は fatal review と source-of-truth declaration を non-negotiable gate としている（`ARCHITECTURE.md:251`, `ARCHITECTURE.md:260`）。対象文書が `release_safety_report.yaml` で rights / privacy / delivery / package completeness まで束ねようとしている点は、M4 の QA / package plane と方向性が合う（`docs/production-readiness-canonical-artifacts.md:191`, `docs/milestone-4-design.md:1045`）。

3. **analysis coverage の first-class 化は既存 MCP と相性がよい。** `media.project_summary` は既に `analysis_gaps` を返す契約を持つ（`contracts/media-mcp.md:28`, `contracts/media-mcp.md:35`）。`analysis_coverage_report.json` を canonical gate input にすることで、この曖昧な gap 表現を artifact-backed にできる。

4. **closed schema 原則は既存方針に沿う。** `timeline.json.clip.metadata` / `marker.metadata` 以外を閉じる方針は architecture で既に決まっている（`ARCHITECTURE.md:176`, `ARCHITECTURE.md:179`）。対象文書の closed schema 方針自体は妥当。

## Critical Issues

### C1. MVP artifact set と P1 dependency が矛盾している

`source_media_manifest.json` は Required MVP ではなく Next Tier に置かれている（`docs/production-readiness-canonical-artifacts.md:30`, `docs/production-readiness-canonical-artifacts.md:48`）。しかし同じ文書内で、`analysis_coverage_report.json` の lane に `source_manifest` が含まれ（`docs/production-readiness-canonical-artifacts.md:256`）、`source_media_manifest.json` がないと coverage ready になれないと明記されている（`docs/production-readiness-canonical-artifacts.md:290`）。さらに P1 は `source_media_manifest` と `analysis_coverage_report` を同時導入する計画になっている（`docs/production-readiness-canonical-artifacts.md:439`）。

これは設計分類上の矛盾です。MVP が「5 artifact」なのか、「5 + source manifest」なのかが曖昧なままでは、P0 の exit criteria で artifact paths / producers / gate behavior に合意できません（`docs/production-readiness-canonical-artifacts.md:437`）。

**Required correction:** `source_media_manifest.json` を MVP foundational artifact に昇格するか、`analysis_coverage_report.summary.status == ready` の前提から `source_manifest` lane を外して P1 の enforce 範囲を分ける。推奨は前者。source manifest は coverage, rights, privacy, stale source detection, package provenance の根にあるため、MVP-0 foundation として扱うべきです。

### C2. state machine の作成タイミングが既存状態遷移と衝突している

既存 state machine は `intent_locked -> media_analyzed` を「ingest + shot graph + transcripts + contact sheets ready」で進め、`media_analyzed -> selects_ready` は `selects_candidates.yaml written` で進む（`ARCHITECTURE.md:186`, `ARCHITECTURE.md:188`）。対象文書は `audio_story_graph.json` と `continuity_graph.json` を「Produced before `media_analyzed`」としつつ、`audio_story_graph` は `media_analyzed -> selects_ready` の条件とも書いている（`docs/production-readiness-canonical-artifacts.md:89`, `docs/production-readiness-canonical-artifacts.md:90`）。`continuity_graph` も `Produced before media_analyzed` かつ `selects_ready` 前の requirement になっている（`docs/production-readiness-canonical-artifacts.md:130`, `docs/production-readiness-canonical-artifacts.md:131`）。

この二重表現だと、graph が `media_analyzed` の成立条件なのか、`selects_ready` への planning gate なのかが不定です。`analysis_coverage_report.json` も `Created during intent_locked -> media_analyzed` かつ `Required before media_analyzed` とされる（`docs/production-readiness-canonical-artifacts.md:248`, `docs/production-readiness-canonical-artifacts.md:249`）ため、state transition 上で「作成中の report が同時に遷移条件」になります。

**Required correction:** `media_analyzed` の意味を拡張するのか、`analysis_ready` / `planning_ready` のような中間 gate にするのかを P0 で決める。推奨は既存 state enum を増やさず、`media_analyzed` は raw analysis artifact 完了、`project_state.gates.analysis_gate` と `planning_gate` が graph/coverage の readiness を表す構成にすること。

### C3. release_safety_report が P4 なのに final render gate として即時必須化されている

対象文書は `release_safety_report.yaml` を Required MVP に置く（`docs/production-readiness-canonical-artifacts.md:39`）一方、実装ロードマップでは P4 で schema / preflight を追加するとしている（`docs/production-readiness-canonical-artifacts.md:498`, `docs/production-readiness-canonical-artifacts.md:508`）。さらに gate integration では final render/package finalization の blocker に `release_safety_report.yaml.summary.status == blocked` と `checks[].severity == fatal` を入れている（`docs/production-readiness-canonical-artifacts.md:379`, `docs/production-readiness-canonical-artifacts.md:380`）。

これは導入順として危険です。既存 architecture は final render gate を timeline schema, fatal review, source-of-truth declaration 等で既に定義している（`ARCHITECTURE.md:251`, `ARCHITECTURE.md:260`）。P4 まで artifact が存在しないなら、P1-P3 で final render をどう扱うかが未定義です。`delivery_profile.yaml` / `source_media_manifest.json` も release safety input だが、delivery profile は Next Tier/P4 扱いです（`docs/production-readiness-canonical-artifacts.md:49`, `docs/production-readiness-canonical-artifacts.md:197`）。

**Required correction:** P1-P3 では `release_safety_report` を report-only / absent-ok にし、P4 で `packaging_gate` に昇格する migration path を明記する。Required MVP に置くなら P1 に下げる必要がありますが、implementation cost と既存 package 未成熟度を考えると P4 enforcement が妥当です。

### C4. 既存 M4 caption/music/package artifacts との所有境界が未定義

既存 schema には `caption-approval.schema.json`, `music-cues.schema.json`, `package-qa-report.schema.json`, `package-manifest.schema.json` があり、`project_state.artifact_hashes` にも `caption_approval_hash`, `music_cues_hash`, `qa_report_hash`, `package_manifest_hash`, `packaging_projection_hash` が存在する（`schemas/project-state.schema.json:86`, `schemas/project-state.schema.json:91`）。対象文書は `release_safety_report.yaml` の check category に `caption_audio` を入れている（`docs/production-readiness-canonical-artifacts.md:218`）が、caption approval / music cues / package QA / package manifest を safety report が読むのか、再判定するのか、単に参照するのかが曖昧です。

M4 設計では `caption_approval.json` と `music_cues.json` を compiler が timeline へ materialize し、render engine は投影済み timeline を実行する責務分担がある（`docs/milestone-4-design.md:741`, `docs/milestone-4-design.md:830`）。対象文書が `audio_story_graph` を `/caption` と `/package` の node ref source とするだけでは（`docs/production-readiness-canonical-artifacts.md:85`）、既存 caption/music canonical artifacts との関係が足りません。

**Required correction:** `release_safety_report.yaml` は既存 `caption_approval.json`, `music_cues.json`, `package-qa-report.json`, `package_manifest.json` の pass/freshness/hash を参照する aggregate gate と定義し、caption/music/timing の source of truth を奪わないことを明記する。

## Major Issues

### M1. `analysis_gate`, `compile_gate`, `planning_gate` の語彙が既存 schema とずれている

対象文書は `analysis_gate`, `compile_gate`, `review_gate`, `packaging_gate` を future projection として提案している（`docs/production-readiness-canonical-artifacts.md:397`, `docs/production-readiness-canonical-artifacts.md:400`）。しかし既存 `project-state.schema.json` の gates は別定義で、対象文書の status enum とそのまま一致しません（`schemas/project-state.schema.json:57`, `schemas/project-state.schema.json:70`）。また `analysis_coverage_report` は `planning_gate` を制御すると書くが、projection list には `planning_gate` がない（`docs/production-readiness-canonical-artifacts.md:250`, `docs/production-readiness-canonical-artifacts.md:397`）。

**Fix:** gate vocabulary table を追加し、既存 gates への mapping と migration を明記する。`planning_gate` を使うなら projection list に追加する。

### M2. `blocker` と `fatal` の責務境界が曖昧

既存 architecture は unresolved blocker で compile を止め、fatal review で final render を止める（`ARCHITECTURE.md:251`, `ARCHITECTURE.md:253`）。対象文書は release safety check severity に `blocker` と `fatal` を入れる（`docs/production-readiness-canonical-artifacts.md:217`）が、`blocker` が compile blocker なのか package blocker なのかが曖昧です。rights/privacy unknown は `blocker` から public delivery で `fatal` へ上がるとされる（`docs/production-readiness-canonical-artifacts.md:223`）が、これは review fatal ではなく release fatal です。

**Fix:** `unresolved_blockers.yaml` の `blocker` は planning/compile、`review_report.yaml.fatal_issues` は editorial approval、`release_safety_report.checks[].severity` は package/release に限定する、と明記する。

### M3. `artifact_version` policy が既存 MCP / schema と統一されていない

media-mcp は全 response に `project_id` と `artifact_version` を含める設計（`contracts/media-mcp.md:7`, `contracts/media-mcp.md:10`）。既存 analysis artifacts も `artifact_version` を持つものが多い一方、`caption-approval.schema.json` や `music-cues.schema.json` は `version` と `base_timeline_version` は持つが `artifact_version` は持たない（`schemas/caption-approval.schema.json:7`, `schemas/caption-approval.schema.json:18`, `schemas/music-cues.schema.json:7`, `schemas/music-cues.schema.json:16`）。対象文書は新 artifact に `version` と `artifact_version` の両方を要求するが、互換ポリシーがない（`docs/production-readiness-canonical-artifacts.md:96`, `docs/production-readiness-canonical-artifacts.md:255`）。

**Fix:** `version` = schema version、`artifact_version` = analysis corpus/projection generation version、`base_timeline_version` = timeline binding、と用途を分離する。package plane artifact へ `artifact_version` を入れるかは統一判断が必要。

### M4. JSONL append-only の削除・訂正・privacy takedown が未設計

`editorial_preference_memory.jsonl` は append-only で supersession を表す（`docs/production-readiness-canonical-artifacts.md:175`, `docs/production-readiness-canonical-artifacts.md:179`）。しかし privacy confirmation、release waiver、人間の氏名、好み、却下理由が入る可能性があり、削除要求・誤記訂正・機密化・migration の運用が未定義です。Malformed line が fatal という方針（`docs/production-readiness-canonical-artifacts.md:183`）も、長期運用ログでは脆い。

**Fix:** append-only 本体とは別に `redaction_log.jsonl` または compaction/migration command を定義する。loader は malformed line を fatal にする前に last-known-good offset と quarantine を出せるようにする。

### M5. P1 で `audio_story_graph` を上げない選択の比較が不足

P1 は `source_media_manifest + analysis_coverage_report` とされる（`docs/production-readiness-canonical-artifacts.md:439`）。これは安全導入として妥当だが、production rough-cut quality への即効性は `audio_story_graph` の方が高い可能性があります。README の E2E flow では analysis 後すぐ `/triage` / `/blueprint` に進む（`README.md:137`, `README.md:146`）ため、coverage だけ入れても selection quality は改善しません。

**Fix:** P1A = source+coverage foundation、P1B = audio_story_graph pilot の 2-track 案を明記する。dialogue/music-driven fixture に限り audio_story_graph を report-only で先行導入する案を比較対象に入れる。

### M6. search index の canonical/derived 境界が media-mcp contract と未接続

対象文書は search index を derived とし、absence は compile/render を block しないとする（`docs/production-readiness-canonical-artifacts.md:345`, `docs/production-readiness-canonical-artifacts.md:353`）。一方 media-mcp の `media.search_segments` は evidence に `embedding` を含める契約を既に出している（`contracts/media-mcp.md:176`, `contracts/media-mcp.md:203`）。search-dependent triage が full-autonomy mode で使われる場合、stale index を許容すると candidate selection の再現性が崩れます。

**Fix:** search-derived results を canonical artifacts に採用する時は、`selects_candidates.yaml.provenance` に search manifest hash / embedding model / stale policy を保存する。

### M7. frame-accurate sync と timezone が source manifest に不足

`source_media_manifest` の item fields は `mtime`, `media_kind`, rights/privacy 等に留まる（`docs/production-readiness-canonical-artifacts.md:286`）。しかし multi-camera / phone media / NLE roundtrip では capture timestamp timezone, timecode track, sample rate, start_time offset, rotation, VFR/CFR, audio drift basis が必要です。Architecture は machine-readable time と frame fields を重視している（`ARCHITECTURE.md:277`, `ARCHITECTURE.md:294`）。

**Fix:** source manifest に `capture_started_at`, `capture_timezone`, `timecode_start`, `timecode_format`, `sample_rate`, `duration_us`, `frame_rate_mode`, `rotation`, `audio_video_offset_ms`, `clock_source` を候補として入れる。

### M8. dirty worktree safe introduction は現実的だが、現在の repo 状態に対する具体 gate が薄い

対象文書は dirty worktree 対応として isolated commits, status capture, dry-run/report-only を挙げる（`docs/production-readiness-canonical-artifacts.md:551`, `docs/production-readiness-canonical-artifacts.md:557`）。ただし現状は README/schema/package/editor/render まで広範な未コミット変更があり、対象 doc 自体も未追跡です。P0 の exit criteria が「No implementation files changed」だけでは、既存 dirty worktree 内でどの差分を baseline とみなすか判定できません（`docs/production-readiness-canonical-artifacts.md:436`）。

**Fix:** P0 に `git status --short` snapshot artifact を docs/review または issue に貼る、phase-owned file allowlist を作る、既存 dirty changes を前提に enforcement を feature flag off で入れる、を明記する。

## Minor Issues

1. `release_safety_report.yaml.summary.status` が `blocked` なのに gate 文では `summary.status != pass` と `checks[].severity == fatal` が併用されており、`pass_with_waiver` の扱いが読み取りにくい（`docs/production-readiness-canonical-artifacts.md:202`, `docs/production-readiness-canonical-artifacts.md:216`）。

2. `audio_story_graph` の node prefix `UTT_`, `SPK_`, `AE_`, `BGM_` は既存 transcript/audio-events/music schemas の ID と衝突しうる。namespace は artifact-local か cross-artifact global か明記が必要（`docs/production-readiness-canonical-artifacts.md:97`）。

3. `continuity_graph` の `same_subject` と privacy-sensitive anonymous entity の関係が曖昧。anonymous cluster が同一人物推定として扱われるなら public release で privacy risk になる（`docs/production-readiness-canonical-artifacts.md:139`, `docs/production-readiness-canonical-artifacts.md:144`）。

4. `confidence calibration` は fields 案があるが、既存 `analysis-common.schema.json` の `confidence-record` / `provenance-record` との exact mapping が書かれていない（`docs/production-readiness-canonical-artifacts.md:314`, `docs/production-readiness-canonical-artifacts.md:320`）。

5. `segment_search_index.json` と `segment_text_index.json` と `segment_embedding_manifest.json` の hash ownership が未定義。derived artifact でも reproducibility のため manifest hash は必要（`docs/production-readiness-canonical-artifacts.md:342`, `docs/production-readiness-canonical-artifacts.md:344`）。

## Missing Artifacts

1. **`source_media_manifest.json` as MVP foundation**: Next Tier ではなく P1 gate の根。`capture_timezone`, `timecode_start`, VFR/CFR, sample rate, A/V offset, rotation を含める。

2. **`caption_plan.json` or explicit caption source/approval mapping**: 既存 `caption_approval.json` はあるが、`audio_story_graph` node refs から caption generation/approval/render へどう渡るかがない。speech caption, authored overlay, telop timing を分ける必要がある。

3. **`title_overlay_plan.json` / telop timing lane**: `caption_approval.text_overlays` は存在するが、テロップの story role, safe area, animation, exact timing approval を production readiness artifact として扱うか未定。

4. **`rights_license_register.yaml`**: music, stock footage, SFX, font, user-provided media, generated assets の license を operator declaration と machine-checkable fields に分ける artifact が必要。

5. **`release_forms_register.yaml`**: 人物・場所・未成年・顧客事例の同意書 status、承認者、scope、expiry、evidence path を管理する artifact がない。

6. **`privacy_face_review_report.yaml`**: face/person clusters, minors/sensitive context, blur/anonymization requirement, human confirmation status を release safety の input として分離すべき。

7. **`identity_alias_register.yaml`**: 人物固有名、speaker label、face cluster、字幕表記名、匿名化名の対応表がない。STT diarization と continuity graph の橋渡しに必要。

8. **`emotion_tone_map.json`**: creative brief の emotion curve と material-reading tone risks はあるが、segment/audio/story node 単位の tone/emotion を canonical に束ねる artifact がない。

9. **`voice_quality_report.json`**: 声質変化、音割れ、ノイズ、遠い声、speaker consistency、diarization confidence の production risk を audio_story_graph だけに埋めると gate しにくい。

10. **`sfx_jingle_cues.json`**: `music_cues.json` は BGM cue に寄っており、ジングル/SE/SFX library の rights/timing/ducking/provenance がない。

11. **`delivery_profiles/*.yaml`**: 単一 `delivery_profile.yaml` では platform ごとの差分が弱い。YouTube, Shorts, Instagram, internal review, client handoff で profile を複数持てる構造が必要。

12. **`sync_quality_report.json`**: frame-accurate sync, A/V drift, transcript alignment, caption alignment, multicam offset を coverage と package QA の間で追跡する artifact がない。

13. **`revenue_distribution.yaml`**: commercial/public release で music/stock/creator revenue split が問題になる場合の declaration artifact がない。MVP 外でよいが release safety の blind spot。

14. **`artifact_migration_log.jsonl`**: `artifact_version` migration, JSONL compaction, schema upgrade, redaction/takedown を追跡する artifact がない。

## Phase 順序の代替案

### Option A: 現行案を修正して P1 foundation first

- P0: docs/schema proposals。MVP set を `source_media_manifest + analysis_coverage_report + audio_story_graph + continuity_graph + editorial_preference_memory + release_safety_report` に修正。ただし release safety enforcement は P4。
- P1: `source_media_manifest` + `analysis_coverage_report` を report-only から start。既存 fixture は gate disabled で byte-stable。
- P2: `audio_story_graph`。
- P3: `continuity_graph` + preference memory。
- P4: release safety + delivery profile + search/eval。

**推奨:** 最も安全。大量 dirty worktree と既存 package/render 未成熟を考えると、foundation を先に固定すべき。

### Option B: P1B で `audio_story_graph` を先行 pilot

- P1A: minimal source manifest + coverage skeleton。
- P1B: dialogue/music-driven fixtures 限定で `audio_story_graph` を作り、`selects_candidates.yaml` に node refs を materialize。
- P2: coverage gate enforcement。
- P3/P4: continuity/preference/release。

**利点:** rough-cut quality への効果が早い。  
**欠点:** source/coverage の policy が固まる前に graph schema が肥大化する。

### Option C: Release safety first

- P1: package plane の `release_safety_report` + `delivery_profile` を既存 M4 artifacts の aggregate として先に作る。
- P2: source/coverage。
- P3: graphs。

**非推奨:** 既存 M4 review でも package path/QA measurement の未成熟が指摘されており、先に aggregate gate を作ると placeholder safety になりやすい。

## 未解決事項への提言

対象文書の `Unresolved Decisions` には明示項目が7件しかないため、8件目は同文書内で gate 化可否が未決定の `confidence calibration` として扱う。

### 1. STT/diarization provider matrix

- Option 1: OpenAI audio primary + pyannote diarization fallback + Groq STT fallback。
- Option 2: provider-agnostic interface を先に固定し、project runtime で provider pinning のみ行う。
- Option 3: fixture/eval で provider acceptance matrix を作り、delivery profile が minimum confidence を選ぶ。

**推奨:** Option 2 + minimal Option 3。`runtime/project.runtime.yaml` は OpenAI audio + diarization enabled、embedding は Gemini preview を指す（`runtime/project.runtime.yaml:30`, `runtime/project.runtime.yaml:35`）。schema は provider を baked-in せず、`provenance.provider`, `model`, `connector_version`, `diarization_confidence_floor` を記録する。

### 2. face/privacy detection responsibility boundary

- Option 1: continuity graph は anonymous subject clusters のみ。identity confirmation は別 artifact。
- Option 2: continuity graph に confirmed identity まで持たせるが public release は human approval 必須。
- Option 3: face/privacy report が subject cluster と release action を所有し、continuity graph は refs のみ。

**推奨:** Option 3。continuity graph は editing continuity、privacy/face report は release risk に責務を分ける。

### 3. embedding provider pinning

- Option 1: runtime config の `gemini-embedding-2-preview` をそのまま pin。
- Option 2: search manifest に provider/model/dimensions/hash を pin し、runtime config は default に留める。
- Option 3: local embeddings only に寄せて reproducibility を優先。

**推奨:** Option 2。preview provider は将来変わるため、canonical source ではなく derived manifest hash で再現性を担保する。

### 4. rights responsibility boundary

- Option 1: release safety が rights pass/fail を直接判定。
- Option 2: rights register は operator declarations、release safety は missing/stale/incompatible を機械判定。
- Option 3: rights は完全に human checklist とし、artifact 化しない。

**推奨:** Option 2。法的判断は人間責任、機械は declared fields と delivery profile の整合性だけを見る。

### 5. human approval UI

- Option 1: CLI-only first。
- Option 2: editor panel first。
- Option 3: CLI approval record を canonical にし、editor panel は後で同じ command/API を呼ぶ。

**推奨:** Option 3。P1-P2 は CLI で実装し、approval identity は `approved_by`, `approved_at`, `scope`, `artifact_hash` を必須にする。

### 6. canonical vs derived search

- Option 1: search index は常に derived。stale でも compile/render は止めない。
- Option 2: search-dependent triage では stale search を blocker にする。
- Option 3: full-autonomy mode のみ stale search を blocker、interactive mode は warning。

**推奨:** Option 3。interactive と automated local mode の差を既存 architecture は区別している（`ARCHITECTURE.md:127`, `ARCHITECTURE.md:138`）。

### 7. graph mutation workflow

- Option 1: graph を controlled command で直接編集。
- Option 2: `*_graph_patch.jsonl` を append し、materializer が graph view を再生成。
- Option 3: human_notes から毎回 graph regenerate。

**推奨:** Option 2。direct edit は provenance が崩れ、full regenerate は既存 refs が壊れやすい。patch log + materialized graph hash が最も安全。

### 8. provider confidence calibration

- Option 1: confidence calibration は eval-only、gate に使わない。
- Option 2: delivery profile が opt-in した時だけ release gate。
- Option 3: analysis gate に常時入れる。

**推奨:** Option 2。対象文書の方針（`docs/production-readiness-canonical-artifacts.md:331`, `docs/production-readiness-canonical-artifacts.md:332`）を維持し、MVP compile を止めない。

## 推奨修正リスト（P0確定前にdocに反映すべきもの）

1. `source_media_manifest.json` を MVP foundation に昇格し、Required MVP 表・P1・coverage lane・release safety input の矛盾を解消する。

2. state machine の定義を修正する。`media_analyzed` の意味を変えないなら、graph/coverage は `project_state.gates.analysis_gate` / `planning_gate` で管理し、`Produced before media_analyzed` と `media_analyzed -> selects_ready required` の二重条件をやめる。

3. `release_safety_report.yaml` の phase と enforcement を分離する。P4 までは report-only、P4 で `approved -> packaged` gate に昇格、と明記する。

4. existing M4 artifacts との境界を追加する。`caption_approval.json`, `music_cues.json`, `package-qa-report.json`, `package_manifest.json`, `handoff_resolution` を release safety の inputs とし、再判定ではなく aggregate/freshness gate にする。

5. artifact versioning policy を追加する。`version`, `artifact_version`, `base_timeline_version`, `artifact_hashes`, `provenance.hash` の用途を表にする。

6. JSONL append-only の correction/redaction/migration policy を追加する。

7. Missing Artifacts のうち `caption_plan`, `rights_license_register`, `privacy_face_review_report`, `delivery_profiles`, `sync_quality_report` を Next Tier 以上に上げる。

8. search index が triage に影響した場合の manifest hash persistence を `selects_candidates.yaml.provenance` requirement として追加する。

## Implementation Cost Estimate

| Item | Cost | Notes |
| --- | --- | --- |
| `source_media_manifest.json` schema + fixtures + ingest generation | M | Existing `source-map` / assets flow と接続できるが、timezone/timecode/rights fields を決める必要あり。 |
| `analysis_coverage_report.json` + report-only gate | M | analysis stages は既に分かれているが、lane required/optional policy が必要。 |
| coverage enforcement in `project_state.gates` | L | 既存 state reconcile / CLI / fixtures への影響が広い。 |
| `audio_story_graph.json` builder + projection | L | STT/diarization/audio-events/BGM 統合、refs materialization、review checks が必要。 |
| `continuity_graph.json` builder + correction workflow | XL | face/privacy/entity clustering と human correction 境界が重い。 |
| `editorial_preference_memory.jsonl` loader + approval command | M | JSONL 自体は軽いが conflict, malformed, redaction policy が必要。 |
| `release_safety_report.yaml` aggregate gate | L | package QA, handoff resolution, delivery profile, rights/privacy, caption/music を束ねるため blast radius が広い。 |
| `delivery_profiles/*.yaml` | M | render/package QA mapping と platform presets が必要。 |
| rights/privacy/release-form registers | L | UI/approval/legal responsibility boundary が絡む。 |
| search index manifest + stale policy | M | derived artifact だが provider pinning/hash/provenance が必要。 |
| preview/render parity integration impact | L | `RenderSpec` / filtergraph / preview artifact hash と release safety freshness を接続する必要がある。 |
