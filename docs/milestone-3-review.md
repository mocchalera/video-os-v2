## レビュー結果サマリー
- 🔴 FATAL: 2件
- ⚠️ WARNING: 5件
- 📝 NOTE: 2件

## 詳細

### [FATAL] `approved` 遷移が ARCHITECTURE の state machine と一致せず、しかも self-heal 不能
- 対象ファイル: `docs/milestone-3-design.md`, `ARCHITECTURE.md`
- 問題:
  `ARCHITECTURE.md:193-195` は `critique_ready -> approved` を「fatal issue なし」または「explicit creative override」で許可していますが、M3 設計は `docs/milestone-3-design.md:519-520`, `729-730` で「`fatal_issues` が空で operator が accept した場合のみ `approved`」に狭めています。さらに M3 設計は `docs/milestone-3-design.md:636-689` で `project_state.yaml` を ledger 扱いにしつつ、起動時に filesystem から highest stable state を再計算するとしていますが、`approved` を成立させた人間承認/creative override の事実を保持する canonical field が `project_state` schema shape にありません。これでは architecture 上の override 経路を再現できず、`approved` を session 復帰時に監査・復元できません。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `ARCHITECTURE.md:188-195` の state machine、`docs/milestone-3-design.md:111-115` の「`approved` までの gate を artifact と state の双方で追跡」、`docs/milestone-3-design.md:623-632` の `approval_status` を含む export manifest、`docs/milestone-3-design.md:641-677` の `project_state` shape には approval/override 専用 block がありません。
- 推奨修正:
  `project_state.yaml` に `approval` block を追加し、少なくとも `status`, `accepted_at`, `accepted_by`, `accepted_review_report_version`, `accepted_timeline_version`, `mode: clean|creative_override`, `override_reason` を持たせてください。あわせて `docs/milestone-3-design.md` の `approved` 遷移を `ARCHITECTURE.md` と同じ「no fatal review issues OR explicit creative override」に戻すべきです。別 artifact に分けるなら `approval_record.yaml` を canonical artifact として明記してください。

### [FATAL] `STYLE.md` / `human_notes.yaml` を input にしているのに、state snapshot と invalidation が追従していない
- 対象ファイル: `docs/milestone-3-design.md`, `ARCHITECTURE.md`, `docs/roadmap.md`, `projects/_template/STYLE.md`
- 問題:
  M3 設計は `blueprint-planner` が `STYLE.md` を入力に取り (`docs/milestone-3-design.md:330-335`)、`roughcut-critic` が `human_notes.yaml` と `STYLE.md` を優先参照すると定義しています (`docs/milestone-3-design.md:419-425`, `488-496`)。しかし `project_state` snapshot には `human_notes_hash` はある一方で `style_hash` がなく (`docs/milestone-3-design.md:651-658`)、downstream invalidation rules も brief / analysis / selects / blueprint / timeline しか見ていません (`docs/milestone-3-design.md:571-587`)。このままでは STYLE 更新後に stale blueprint/review を検出できず、human notes 更新後にも review を再生成すべきかが state machine に反映されません。M3.5 handoff の前提である `STYLE.md` / `human_notes.yaml` の round-trip も不完全です。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `ARCHITECTURE.md:161-169` は `human_notes.yaml` を canonical artifact に含めています。`docs/roadmap.md:231-237` は M3.5 前提として `human_notes.yaml` と `STYLE.md` を明示しています。にもかかわらず `docs/milestone-3-design.md:614-618` の export bundle には `STYLE.md` が含まれず、`docs/milestone-3-design.md:815-817` の reproducibility / auditability requirement とも衝突します。
- 推奨修正:
  `project_state.yaml` に `style_hash` を追加し、`human_notes_hash` とあわせて invalidation matrix に組み込んでください。最低限、`STYLE.md` 変更時は blueprint / timeline / review を stale 扱い、`human_notes.yaml` 変更時は review を stale 扱いにする必要があります。さらに `/export` review bundle には `STYLE.md` を条件付きで必ず同梱すべきです。

### [WARNING] `human_notes.yaml` 最低 shape では safe patch rule の「approved alternative」を機械的に扱えない
- 対象ファイル: `docs/milestone-3-design.md`, `ARCHITECTURE.md`, `projects/_template/06_review/human_notes.yaml`
- 問題:
  M3 設計は `replace_segment` を「`fallback_segment_ids` か、human note が明示した approved alternative」に限定しています (`docs/milestone-3-design.md:478-481`)。しかし `human-notes.schema.json` の最低 shape と template は `clip_refs`, `timeline_tc`, `observation`, `severity` しか持たず (`docs/milestone-3-design.md:498-512`, `projects/_template/06_review/human_notes.yaml:3-11`)、approved alternative の `segment_id` や directive type を保存する場所がありません。加えて timeline 参照が machine-readable frame ではなく optional な SMPTE 文字列だけなので、ARCHITECTURE の time representation 方針 (`ARCHITECTURE.md:223-245`) とも噛みません。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `docs/milestone-3-design.md:65-66` は unsafe patch を emit しないことを success criterion にしていますが、現 shape だと human note 由来の safe source 判定を deterministic に実装できません。
- 推奨修正:
  `human-notes.schema.json` に `timeline_in_frame` ないし `timeline_us`, `clip_ids`, `approved_segment_ids`, `directive_type` のような machine-readable fields を追加してください。もし M3 では自由記述ノートに留めるなら、`replace_segment` の human-note 分岐は削除し、M3 では `fallback_segment_ids` のみ safe source と定義した方が安全です。

### [WARNING] `pacing.confirmed_preferences` が success criterion なのに contract が「推奨 shape」のまま
- 対象ファイル: `docs/milestone-3-design.md`, `schemas/edit-blueprint.schema.json`, `schemas/creative-brief.schema.json`, `ARCHITECTURE.md`
- 問題:
  M3 は `collaborative` のとき preference interview を必ず実行し、その結果を `pacing.confirmed_preferences` に残すことを達成条件に置いています (`docs/milestone-3-design.md:61-62`)。一方で具体 shape は `docs/milestone-3-design.md:361-371` で「推奨する」に留まり、required/optional が固定されていません。`schemas/edit-blueprint.schema.json:123-140` は `pacing` を strict object (`additionalProperties: false`) としており、M3 で additive field を入れるなら machine-readable contract を先に閉じないと Claude/Codex の prompt 実装や test oracle がぶれます。`creative_brief.autonomy` 側も現 schema では `mode` をまだ持っていません (`schemas/creative-brief.schema.json:129-152`)。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `ARCHITECTURE.md:388-393` と `docs/roadmap.md:190-196` は preference interview を product contract としています。M3 設計がそこを曖昧にすると cross-runtime compatibility を失います。
- 推奨修正:
  `confirmed_preferences` の schema を設け、少なくとも `mode`, `source`, `duration_target_sec`, `confirmed_at` を required にしてください。`structure_choice` と `pacing_notes` を optional にするかどうかも固定し、`creative_brief.autonomy.mode` 追加と同じ phase で validator / template / role prompt を同時更新すべきです。

### [WARNING] `qc_status: partial` の manual override が設計上は存在するのに、state contract に残らない
- 対象ファイル: `docs/milestone-3-design.md`, `docs/milestone-2-design.md`
- 問題:
  M2 は `qc_status: partial` を debug/manual inspection 用として明示し (`docs/milestone-2-design.md:106-110`)、M3 も `partial` を default では拒否しつつ manual override の debug run を許しています (`docs/milestone-3-design.md:101-103`, `559-560`)。しかし `project_state` shape (`docs/milestone-3-design.md:641-677`) には、この override を記録する field がありません。結果として resume 後の `/status` は `analysis_gate == ready` ではないのに `selects_ready` 以降へ進んだ理由を説明できず、debug run と policy violation を区別できません。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `docs/milestone-3-design.md:687-700` は起動時に `media.project_summary` から analysis gate を再導出するとしており、override 情報を別保存しない限り self-heal 時に意味論が失われます。
- 推奨修正:
  `project_state.yaml` に `analysis_override` block を追加し、`approved_by`, `approved_at`, `reason`, `scope`, `artifact_version` を保持してください。`/status` と `/export` でも degraded/manual path を明示する必要があります。

### [WARNING] `/export` の allowed start state と manifest 必須項目が噛み合っていない
- 対象ファイル: `docs/milestone-3-design.md`
- 問題:
  `/export` は `timeline_drafted` 以降から実行可能とされています (`docs/milestone-3-design.md:548-550`, `565-567`) が、export manifest の最低項目には `review_report_version` が required とされています (`docs/milestone-3-design.md:623-630`)。`timeline_drafted` 直後、まだ `/review` を回していないケースでは `review_report.yaml` が存在しないため、この contract だと valid な draft export を定義できません。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `docs/milestone-3-design.md:610-618` の bundle 内容にも `review_report.yaml` / `review_patch.json` が明示されておらず、`approval_status` と `review_report_version` の整合が曖昧です。
- 推奨修正:
  2 択です。1) `/export` の start state を `critique_ready` 以降に絞る。2) `pre_review` export を正式に認め、`review_report_version` を nullable / optional にし、manifest に `bundle_kind: pre_review|post_review` を追加する。現状のままでは draft export の contract が閉じません。

### [WARNING] Test strategy が既存テスト群との共存と、設計書自身が宣言した failure path を十分にカバーしていない
- 対象ファイル: `docs/milestone-3-design.md`
- 問題:
  M3 設計は新規 test lane を列挙していますが (`docs/milestone-3-design.md:953-998`)、既存の schema/compiler/M2 系 test suite とどう共存させるか、CI 上でどの lane を常時回しどれを smoke/manual に落とすかが書かれていません。さらに error handling では `media-mcp failure`, `interrupted collaborative step`, `concurrent artifact edit` を first-class failure として挙げながら (`docs/milestone-3-design.md:796-811`)、テスト項目にはその failure-injection case がありません。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  M3 の acceptance は state persistence / resume safety / retry safety に依存しているため (`docs/milestone-3-design.md:1102-1104`)、happy-path mock prompt test だけでは regression guard が弱いです。
- 推奨修正:
  新規 M3 tests を既存 suite の上にどう積むかを明記してください。最低でも `media-mcp failure`, `post-run hash mismatch`, `analysis partial override persistence`, `approved / creative_override persistence` の 4 ケースは自動テストに入れるべきです。

### [NOTE] Draft-then-promote と deterministic preflight の分離は、gate 4-7 と整合している
- 対象ファイル: `docs/milestone-3-design.md`, `ARCHITECTURE.md`
- 問題:
  明確な矛盾は見つかっていません。`docs/milestone-3-design.md:124-138`, `156-162`, `455-462` は agent を reasoning layer に留め、compile/render/QC を deterministic runtime に閉じています。これは `ARCHITECTURE.md:205-211` の non-negotiable gates 4-7 と整合しています。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  agent が direct final write / direct timeline mutation / arbitrary command emission を行わない点は一貫しています。
- 推奨修正:
  この分離は維持してください。実装時は role prompt だけでなく slash command runtime 側でも同制約を二重化しておくと安全です。

### [NOTE] `footage-triager` の evidence access pattern は M2 handoff と media-mcp contract に概ね沿っている
- 対象ファイル: `docs/milestone-3-design.md`, `docs/milestone-2-design.md`, `contracts/media-mcp.md`
- 問題:
  大きな不整合は見つかっていません。`docs/milestone-3-design.md:95-105`, `252-269` は M2 の `03_analysis/` + unchanged `media-mcp` 前提を守っており、`docs/milestone-2-design.md:103-110`, `1237-1245` の handoff / contract-safe 方針と噛み合っています。
- 根拠（ARCHITECTURE.md / roadmap / 契約の該当箇所等）:
  `media.project_summary`, `media.list_assets`, `media.search_segments`, `media.peek_segment`, `media.read_transcript_span`, `media.extract_window` という利用順は `contracts/media-mcp.md` の minimum tool set と一致しています。
- 推奨修正:
  可能なら実装時に raw `03_analysis/*.json` 直読みに依存するケースを限定し、creative reasoning の主入口を本当に `media-mcp` に寄せると、runtime 間の再現性がさらに上がります。
