## M1 達成条件チェック
1. ✅ schema validate
   `validateProject()`、`node dist/scripts/validate-schemas.js`、`vitest` で sample 系 artifact は通過。`npm run build` も通過。
2. ✅ deterministic compiler
   `compile()` の 2 回実行比較テストがあり、sample copy に対する CLI 実行でも `timeline.json` / `preview-manifest.json` の SHA-256 は再実行で一致した。
3. ✅ critic patch
   `review_patch.json` の schema と `applyPatch()` / E2E で、critic 由来 patch を受理して適用できる。
4. ✅ patch reapply
   `applyPatch()` 自体は動作し、sample patch 3 ops は CLI / E2E の両方で適用できた。
5. 🔲 OTIO export (stub)
   `runtime/compiler/export.ts` の `exportOtio()` は stub のまま。M1 許容範囲。
6. 🔲 human diff (stub)
   round-trip diff / loss-aware summary は未実装。M1 許容範囲。
7. 🔲 stable ID (stub)
   round-trip stable ID は未実装。M1 許容範囲だが、現行 ID 戦略には将来向けの懸念がある。

## 残存指摘
- 🔴 FATAL: 2件
- ⚠️ WARNING: 3件
- 📝 NOTE: 2件

### 🔴 FATAL
1. patch 後に派生 artifact が再生成されず、editorial loop が `timeline.json` と不整合になる。
   [`scripts/compile-timeline.ts`](../scripts/compile-timeline.ts) の patch モードは patched `timeline.json` だけを書き戻し、[`runtime/compiler/export.ts`](../runtime/compiler/export.ts) の `writePreviewManifest()` / `exportOtio()` を呼ばない。実地確認でも sample patch 適用後の `timeline.json` では `CLP_0001.src_in_us=2000000`、`CLP_0003.asset_id=AST_003` に更新された一方、`preview-manifest.json` は pre-patch の `1400000` / `AST_006` のまま残った。M1 の compile → patch → re-render 系ループはこのままでは正しく閉じない。
2. patch 後の Phase 4 再評価が元の target duration を失っており、尺オーバー patch を検出できない。
   [`runtime/compiler/patch.ts`](../runtime/compiler/patch.ts) の `reRunPhase4()` は `resolve()` に blueprint 由来の target ではなく、patch 後 timeline の最大 end frame をそのまま渡している。そのため `move_segment` / `insert_segment` で全体尺を延ばしても `duration_fit` が事実上常に真になる。実地確認でも sample timeline に対して `CLP_0010` を `frame=1000, duration=300` へ移動する patch が `errors=[]` で通り、結果は `maxEnd=1300` になった。元の target は 720 frames であり、post-patch invariant が守られていない。

### ⚠️ WARNING
1. stable ID の仕込みがなく、gate 8 / 条件 7 に直結する clip identity が将来不安定。
   [`runtime/compiler/assemble.ts`](../runtime/compiler/assemble.ts) は `clipCounter` から `CLP_0001...` を採番し、[`runtime/compiler/patch.ts`](../runtime/compiler/patch.ts) の insert も最大番号 + 1 で採番する。これは「同一 compile 結果内では一意」だが、再構成や beat 前方での insert/remove に対して永続 stable ID にならない。[`schemas/timeline-ir.schema.json`](../schemas/timeline-ir.schema.json) にも clip-level の immutable ID / source map / OTIO bridge 用 field はまだない。OTIO round-trip 実装に入る前に ID 戦略を分離すべき。
2. gate 1 は CLI では守られるが、compiler API では強制されていない。
   [`scripts/compile-timeline.ts`](../scripts/compile-timeline.ts) は `validateProject()` で unresolved blocker を見て compile を止める一方、[`runtime/compiler/index.ts`](../runtime/compiler/index.ts) の `compile()` は artifact を直接読んで即コンパイルする。将来 `media.compile_timeline` などが API を直接使うと、ARCHITECTURE.md の gate 1 を bypass できる。
3. gates 9-11 のための契約物がまだ存在せず、source-of-truth / unmapped edit review / capability profile は roadmap 記述止まり。
   [`docs/roadmap.md`](../docs/roadmap.md) では `handoff_manifest.yaml`、`roundtrip_import_report.yaml`、`human_revision_diff.yaml`、`nle_capability_profile.yaml` が想定されているが、現行 `schemas/` と validator registry には未着手。[`schemas/timeline-ir.schema.json`](../schemas/timeline-ir.schema.json) の provenance にも source-of-truth 宣言や handoff contract への参照はない。M1 では stub 許容でも、M2 以降の round-trip 実装前に最低限の contract は先に固定した方がよい。

### 📝 NOTE
1. テスト基盤そのものは良好。
   `vitest run` は 63/63 pass、`npm run build` も pass。sample copy に対する compile の再実行 hash も一致し、schema / compiler / e2e / golden の最低ラインは満たしている。
2. `review_patch` schema は envelope validation はあるが、op ごとの必須項目までは schema で縛っていない。
   [`schemas/review-patch.schema.json`](../schemas/review-patch.schema.json) は `op` と `reason` だけを共通 required にしており、`target_clip_id` や `with_segment_id` の不足は schema ではなく `applyPatch()` 実行時エラーになる。M1 としては許容可能だが、critic の失敗を早く返すなら `oneOf` / `if-then` で締めた方が良い。

## M1 判定: CONDITIONAL PASS
条件 1-4 の中核経路は動いており、5-7 も stub としては受け入れ可能。ただし、patch 後に派生 artifact が stale のまま残る点と、post-patch の duration invariant が抜けている点は、editorial loop の完成判定としては未解消。M2 に進む前にこの 2 点は修正が必要。
