# M3.5 Phase 2-3 Implementation Review

判定: `FAIL`

対象:
- Phase 2 Export: [runtime/handoff/export.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts), [runtime/handoff/otio-bridge.py](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/otio-bridge.py), [tests/m35-phase2.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase2.test.ts)
- Phase 3 Import: [runtime/handoff/import.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts), [tests/m35-phase3.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase3.test.ts)
- Spec: [docs/milestone-3.5-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md), [ARCHITECTURE.md](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md), [schemas/handoff-manifest.schema.json](/Users/mocchalera/Dev/video-os-v2-spec/schemas/handoff-manifest.schema.json), [schemas/roundtrip-import-report.schema.json](/Users/mocchalera/Dev/video-os-v2-spec/schemas/roundtrip-import-report.schema.json)

実行確認:
- `npx vitest run`: 18 files passed, 708 tests passed, 6 skipped
- `npx tsc --noEmit`: passed

## FATAL

1. Gate 9 / import preflight の中核である `base_timeline.hash` 検証が未実装です。`BASE_HASH_MISMATCH` は型にあるだけで、[runtime/handoff/import.ts:165](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L165) 以外で使われておらず、実処理は manifest 読み込み直後に bridge normalize と mapping へ進みます。[runtime/handoff/import.ts:736](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L736) [runtime/handoff/import.ts:885](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L885)  
   設計は import flow step 4 で `base_timeline.hash` 検証を必須化しています。[docs/milestone-3.5-design.md:565](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L565) [docs/milestone-3.5-design.md:570](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L570)  
   テストも実装を担保しておらず、hash mismatch は conceptual test のみです。[tests/m35-phase3.test.ts:1422](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase3.test.ts#L1422)

2. Python bridge が `exchange_clip_id` を落とした clip を正規化結果から丸ごと落としており、stable ID retention と Gate 9 の「dropped stable metadata」検出が成立しません。[runtime/handoff/otio-bridge.py:245](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/otio-bridge.py#L245) [runtime/handoff/otio-bridge.py:259](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/otio-bridge.py#L259) [runtime/handoff/otio-bridge.py:371](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/otio-bridge.py#L371)  
   現実には metadata を失った imported clip は `missing_stable_id` ではなく「存在しなかった」扱いになり、`imported_clip_count` や retention 判定からも消えます。[runtime/handoff/import.ts:837](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L837) [runtime/handoff/import.ts:860](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L860)  
   これは設計の imported readback / dropped stable metadata rule に反します。[docs/milestone-3.5-design.md:684](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L684) [docs/milestone-3.5-design.md:689](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L689) [docs/milestone-3.5-design.md:1154](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1154)

3. lossy / capability-bounded 判定が実編集ではなく profile 定義だけで発火しており、Gate 11 の意味が崩れています。`detectLossyItems()` は imported OTIO を一切見ず、profile 上の `lossy` surface を毎回 `lossy_items` に積みます。[runtime/handoff/import.ts:426](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L426) [runtime/handoff/import.ts:442](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L442) [runtime/handoff/import.ts:580](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L580)  
   ローカル再現でも clean `executeOfflineImport()` が `status: success` のまま `loss_summary` を持ちました。  
   設計は「lossy surface に変更がある場合のみ report」「unsupported surface は review_required」を要求しています。[docs/milestone-3.5-design.md:659](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L659) [docs/milestone-3.5-design.md:672](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L672) [docs/milestone-3.5-design.md:1092](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1092)

4. Gate 9 判定関数が仕様より狭く、lossy / unsupported / vendor-only ambiguity を review required にしません。実装は unmapped, provisional, one-to-many しか見ていません。[runtime/handoff/import.ts:500](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L500) [runtime/handoff/import.ts:510](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L510)  
   設計では `dropped stable metadata`, `unsupported surface edit`, `vendor-specific metadata only` も Gate 9 対象です。[docs/milestone-3.5-design.md:682](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L682) [docs/milestone-3.5-design.md:689](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L689) [ARCHITECTURE.md:239](/Users/mocchalera/Dev/video-os-v2-spec/ARCHITECTURE.md#L239)

## WARNING

1. split / duplicate 正規化は「non-overlap なら split」としており、親範囲を cover しているかを確認していません。[runtime/handoff/import.ts:289](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L289) [runtime/handoff/import.ts:372](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L372)  
   そのため gap を含む partial extraction でも `#S01/#S02` に正規化されます。設計は split を「non-overlap かつ parent range を cover」と定義しています。[docs/milestone-3.5-design.md:593](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L593) [docs/milestone-3.5-design.md:598](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L598)

2. human-readable fallback が `clip.name.includes(exported.clip_id)` の prefix match なので、`CLP_010` が `CLP_01` に誤マップします。[runtime/handoff/import.ts:241](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L241) [runtime/handoff/import.ts:245](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L245)  
   設計は encoded `clip_id` fallback を認めていますが、substring hit ではなく token-aware decode が必要です。[docs/milestone-3.5-design.md:585](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L585)

3. runtime 側で manifest / import report の schema validation を実行していません。コメントは「schema-validated」と書いていますが、実際の validation はテストだけです。[runtime/handoff/export.ts:9](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L9) [runtime/handoff/export.ts:780](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L780) [runtime/handoff/import.ts:13](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L13) [runtime/handoff/import.ts:867](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/import.ts#L867)

4. export readback は記録されるだけで failure に昇格しません。`READBACK_FAILED` は型にある一方、`executeHandoffExport()` は `readbackValid: false` でも成功を返します。[runtime/handoff/export.ts:637](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L637) [runtime/handoff/export.ts:794](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L794) [runtime/handoff/export.ts:826](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L826)  
   境界 gate としては弱く、少なくとも `require_exact_metadata: true` profile では hard fail 候補です。[docs/milestone-3.5-design.md:1152](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L1152)

5. bridge protocol の structured error を TypeScript 側が捨てています。subprocess が non-zero exit のとき `stdout` の JSON error payload を parse せず `response: null` にします。[runtime/handoff/export.ts:429](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L429)  
   設計の error contract は request context / stderr / warning capture を求めています。[docs/milestone-3.5-design.md:320](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-3.5-design.md#L320)

## NOTE

1. Gate 8 の missing / duplicate stable ID validation 自体は概ね設計意図に沿っています。`track_id`, `clip_id`, `segment_id`, `asset_id` の存在と重複を export 前に止めています。[runtime/handoff/export.ts:96](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L96) [runtime/handoff/export.ts:664](/Users/mocchalera/Dev/video-os-v2-spec/runtime/handoff/export.ts#L664)

2. テストは量としては十分ですが、要所が抜けています。Phase 3 は [tests/m35-phase3.test.ts:1193](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase3.test.ts#L1193) 以降の offline import が中心で、`executeHandoffImport()` 実経路は未カバーです。base hash mismatch も conceptual test 止まりです。[tests/m35-phase3.test.ts:1422](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase3.test.ts#L1422)  
   Phase 2 も readback 単体まではありますが、`executeHandoffExport()` 実経路の failure path は未カバーです。[tests/m35-phase2.test.ts:913](/Users/mocchalera/Dev/video-os-v2-spec/tests/m35-phase2.test.ts#L913)

3. bridge 依存テストの一部は local 環境で skip されました。今回の `vitest` 実行結果は green ですが、OTIO 実インポートの critical path が全件検証された状態ではありません。

## 総評

Gate 8 は通る一方で、Gate 9 / Gate 11 / stable ID round-trip の import 側境界が未完成です。特に「wrong base を reject できない」「metadata を失った clip を検出できない」「lossy 判定が常時発火する」の 3 点は、現状の report を運用判断に使うには危険です。
