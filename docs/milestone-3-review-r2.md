# Milestone 3 Design Review — R2

レビュー日: 2026-03-21
対象: `docs/milestone-3-design.md`, `ARCHITECTURE.md`（R1 修正後）
参照: `docs/milestone-3-review.md`（R1 レビュー結果）

## R2 レビュー結果サマリー

- 🔴 FATAL: 0 件
- ⚠️ WARNING: 0 件
- 📝 NOTE: 2 件（新規）

**判定: PASS**

---

## R1 指摘解消状況（全 9 件）

### 1. [FATAL] `approved` 遷移が ARCHITECTURE の state machine と一致せず、self-heal 不能 → ✅ 解消

修正内容:

- `ARCHITECTURE.md:195` が `critique_ready -> approved: no fatal review issues OR explicit creative override` を維持し、M3 設計側もこれに完全に揃えた
- `docs/milestone-3-design.md:541-548` が clean approval (`approval_record.status = clean`) と creative override (`approval_record.status = creative_override`) の両経路を明記
- `docs/milestone-3-design.md:722-729` で `approval_record` block が `status`, `approved_by`, `approved_at`, `override_reason`, `artifact_versions` を保持
- `docs/milestone-3-design.md:757-759` で `artifact_versions` が `timeline_version`, `review_report_version`, `review_patch_hash`, `human_notes_hash`, `style_hash` を含むことを明示
- `docs/milestone-3-design.md:770-773` で reconcile step 7 が `approval_record` の artifact version 一致を条件に `approved` を復元する
- `ARCHITECTURE.md:200-217` に canonical operator records として `approval_record` と `analysis_override` を追加

判定根拠: ARCHITECTURE の state machine と M3 設計の遷移条件が一致し、self-heal に必要な canonical record が `project_state.yaml` に永続化される。

### 2. [FATAL] `STYLE.md` / `human_notes.yaml` の state snapshot と invalidation が追従していない → ✅ 解消

修正内容:

- `docs/milestone-3-design.md:720` で artifact snapshot に `style_hash` を追加
- `docs/milestone-3-design.md:617-620` で `STYLE.md` changed → blueprint / timeline / review / approval を invalidate、state → `selects_ready`
- `docs/milestone-3-design.md:629-632` で `human_notes.yaml` changed → review / approval を invalidate、state → `timeline_drafted`
- `docs/milestone-3-design.md:665` で export bundle に optional `STYLE.md` を同梱
- `ARCHITECTURE.md:170` で `STYLE.md` を canonical artifact に明示
- `ARCHITECTURE.md:219-221` で `style_hash` と `human_notes_hash` による invalidation を宣言

判定根拠: snapshot / invalidation matrix / export bundle の 3 面すべてで `STYLE.md` と `human_notes.yaml` が追跡される。

### 3. [WARNING] `human_notes.yaml` 最低 shape では safe patch rule の approved alternative を機械的に扱えない → ✅ 解消

修正内容:

- `docs/milestone-3-design.md:508-534` で `human-notes.schema.json` の shape を拡張
  - 追加 field: `id`, `directive_type`, `clip_ids`, `approved_segment_ids`, `timeline_in_frame`, `timeline_us`
  - machine source of truth: `clip_ids`, `approved_segment_ids`, `timeline_in_frame`, `timeline_us`
  - human-readable / legacy: `clip_refs`, `timeline_tc`
- `docs/milestone-3-design.md:531-532` で `directive_type` + machine-readable anchor の両方が揃った note のみ patch safety 判定に使用する rule を明示
- `docs/milestone-3-design.md:533-534` で `directive_type` の enum を固定（`observation | replace_segment | insert_segment | remove_segment | move_segment | trim_segment`）
- `docs/milestone-3-design.md:486-491` で `replace_segment` / `insert_segment` の safe source rule を machine-readable note 前提に改訂

判定根拠: machine-readable field と directive_type により safe patch 判定が deterministic に実装可能。

### 4. [WARNING] `pacing.confirmed_preferences` が success criterion なのに contract が推奨 shape のまま → ✅ 解消

修正内容:

- `docs/milestone-3-design.md:366` で「推奨 shape ではなく固定 contract」と明記
- `docs/milestone-3-design.md:368-373` で required fields を固定: `mode`, `source`, `duration_target_sec`, `confirmed_at`
- `docs/milestone-3-design.md:372-373` で optional fields を固定: `structure_choice`, `pacing_notes`
- `docs/milestone-3-design.md:375-378` で `source` の値域（`human_confirmed | ai_autonomous`）と autonomy mode との対応 rule を定義
- 後方互換: `autonomy.mode` absent の旧 brief に対する read-time 推定 rule あり（L226-227）

判定根拠: contract が閉じ、test oracle と prompt 実装が一意に決まる。

### 5. [WARNING] `qc_status: partial` の manual override が state contract に残らない → ✅ 解消

修正内容:

- `docs/milestone-3-design.md:730-736` で `analysis_override` block を `project_state.yaml` に追加（`status`, `approved_by`, `approved_at`, `reason`, `scope`, `artifact_version`）
- `docs/milestone-3-design.md:586-589` で `/triage` start-state rule に manual override 記録を明示
- `docs/milestone-3-design.md:784-787` で `analysis_gate` が `analysis_override.artifact_version` の current 一致を条件に `partial_override` を判定
- `docs/milestone-3-design.md:610` で analysis artifact version changed 時に stale `analysis_override` を clear する rule を追加
- `docs/milestone-3-design.md:597-598` で export manifest に `analysis_override_status` を含める
- `ARCHITECTURE.md:213-217` に `analysis_override` canonical record を追加

判定根拠: override 情報が永続化され、self-heal / `/status` / `/export` で debug run と policy violation を区別できる。

### 6. [WARNING] `/export` の allowed start state と manifest 必須項目が噛み合っていない → ✅ 解消

修正内容:

- `docs/milestone-3-design.md:578` と `docs/milestone-3-design.md:596` で `/export` の allowed start state を `critique_ready` 以降に統一
- `docs/milestone-3-design.md:661` で M3 の `/export` を "review bundle" に明確化

判定根拠: R1 が示した 2 択のうち option 1（start state を `critique_ready` 以降に絞る）を採用。`critique_ready` 以降なら `review_report_version` は必ず存在するため、manifest contract が閉じる。

### 7. [WARNING] Test strategy が既存テスト群との共存と failure path を十分にカバーしていない → ✅ 解消

修正内容:

- `docs/milestone-3-design.md:1043-1044` で「既存の schema validator / compiler / M2 suite の上に積み増す」と明記
- `docs/milestone-3-design.md:1044-1052` で CI lane を 3 層に分離（always-on CI / fixture render lane / manual smoke）
- R1 が求めた 4 failure-injection case の充足状況:
  - `media-mcp failure` → L1087 slash command test に含む ✓
  - `post-run hash mismatch` → L1088 promote 中止テストとして含む ✓
  - `analysis partial override persistence` → L1098 project state test に含む ✓
  - `approved / creative_override persistence` → L1099 project state test に含む ✓

判定根拠: 既存 suite との共存構造と failure path coverage の両方が設計に反映された。

### 8. [NOTE] Draft-then-promote と deterministic preflight の分離は gate 4-7 と整合している → ✅ 維持

確認結果:

- `docs/milestone-3-design.md:128-143` の draft-then-promote、`160-166` の runtime invariants、`461-469` の compile/render/QC は agent から分離された deterministic step のまま
- ARCHITECTURE gates 4-7 との整合は維持されている

### 9. [NOTE] `footage-triager` の evidence access pattern は M2 handoff と media-mcp contract に概ね沿っている → ✅ 維持

確認結果:

- `docs/milestone-3-design.md:101-105` で raw `03_analysis/*.json` 直読みは fixture/debug と validator 補助に限定する rule を維持
- `media-mcp` が creative reasoning の主入口であることを再確認（L273）

---

## 新規指摘

### [NOTE] `projects/_template/06_review/human_notes.yaml` テンプレートが設計上の新 shape を反映していない

- 対象ファイル: `projects/_template/06_review/human_notes.yaml`
- 問題:
  テンプレートには旧来の `clip_refs`, `timeline_tc`, `observation`, `severity` のコメントしかなく、M3 設計が追加した `id`, `directive_type`, `clip_ids`, `approved_segment_ids`, `timeline_in_frame`, `timeline_us` がコメント例に含まれていない。
- 影響度: 低。schema ファイル（`human-notes.schema.json`）が実装時に canonical shape を強制するため、テンプレートの不整合は operator の初期体験に影響する程度。
- 推奨: Phase 1 実装時にテンプレートを更新する。

### [NOTE] `projects/_template/project_state.yaml` テンプレートが最小 subset に留まっている

- 対象ファイル: `projects/_template/project_state.yaml`
- 問題:
  設計は「現在 shape はこの schema の最小 subset とし、後方互換に保つ」（L756）と明記しているため意図的だが、`approval_record`, `analysis_override`, `style_hash`, `human_notes_hash` がテンプレートにコメントすらない。
- 影響度: 低。runtime が reconcile 時に欠損 field を初期化する設計になっている。
- 推奨: テンプレートにコメント形式で full shape を示すと、operator の理解が向上する。

---

## ARCHITECTURE.md との整合チェック

| チェック項目 | 結果 |
| --- | --- |
| State machine 遷移条件（L183-197） | ✅ M3 設計と一致 |
| Canonical artifacts 一覧（L157-170） | ✅ `STYLE.md` 追加済み |
| Canonical operator records（L200-217） | ✅ `approval_record` + `analysis_override` 追加済み |
| Hash-based invalidation（L219-221） | ✅ `style_hash` + `human_notes_hash` 言及 |
| Non-negotiable gates（L223-232） | ✅ M3 設計が agent/engine 分離を維持 |
| Schema strictness policy（L176-179） | ✅ M3 additive extension のみ |
| Time representation（L243-265） | ✅ human_notes に `timeline_in_frame`, `timeline_us` を追加 |

---

## 実装準備判定

**PASS**

根拠:

1. R1 の FATAL 2 件が完全に解消された
2. R1 の WARNING 5 件がすべて解消された
3. R1 の NOTE 2 件の良好な設計が維持されている
4. ARCHITECTURE.md との整合に問題がない
5. 新規指摘は NOTE 2 件のみで、いずれも Phase 1 実装時に自然に解消される軽微な事項
6. Contract Rule（additive extension のみ）が守られている
7. Test strategy が既存 suite との共存と failure path coverage を備えている

M3 設計は実装開始可能な状態にある。
