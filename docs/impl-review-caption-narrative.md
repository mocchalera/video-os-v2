# 字幕+ナラティブ改善 実装レビュー

- 作成日: 2026-03-22
- 判定: `FAIL`
- 集計: `FATAL 3 / WARNING 3 / NOTE 1`
- 実行結果:
  - `npx vitest run`: `35` files passed, `1136` tests passed, `7` skipped
  - `npx tsc --noEmit`: passed

## Findings

### FATAL 1. `/caption` が依然として machine 側で `caption_approval.json` を生成しており、human-only approval 契約を破っている

根拠:

- `/caption` は `draftOnly` でない限り、その場で `finishApprovalAndProjection()` に進み、`caption_draft.json` から即 `caption_approval.json` を生成する。[[caption.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/caption.ts#L205)] [[caption.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/caption.ts#L250)] [[caption.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/caption.ts#L265)]
- しかも `critique_ready` も allowed state に入っている一方、approval 生成自体には state gate が無い。`approved` かどうかを見ているのは timeline 反映だけで、approval artifact の作成は止まらない。[[caption.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/caption.ts#L92)] [[caption.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/caption.ts#L324)]
- 設計は `caption_draft.json` を `ready_for_human_approval` と判定できる場合でも、人間承認が入るまで `caption_approval.json` を生成してはいけないとしている。[[caption-narrative-improvement-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/caption-narrative-improvement-design.md#L512)] [[caption-narrative-improvement-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/caption-narrative-improvement-design.md#L526)]
- M4 既存契約でも editorial approval は operator が確定する 2 段階 workflow で固定されている。[[milestone-4-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/milestone-4-design.md#L661)]

影響:

- approval provenance が壊れる。
- `caption_draft.json -> human approval -> caption_approval.json` の分離が成立していない。
- `critique_ready` から誤って full path を踏んだ場合にも approved artifact を作れてしまう。

修正推奨:

- `/caption` 本体は常に `caption_source.json` と `caption_draft.json` までで止める。
- approval は別 step か、編集済み `caption_draft.json` を受ける専用 adapter に分離する。
- `critique_ready` では `draftOnly` 相当以外を拒否する。

### FATAL 2. word-level timing 改善が本線に配線されておらず、helper 自体も caption 単位の精密 remap になっていない

根拠:

- 設計は `/caption` を `source -> editorial -> timing -> validation -> draft projection -> approval projection` に再編し、`timing_confidence` と `source_word_refs` を `caption_draft.json` / `caption_approval.json` に保持する前提である。[[caption-narrative-improvement-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/caption-narrative-improvement-design.md#L288)] [[caption-narrative-improvement-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/caption-narrative-improvement-design.md#L399)] [[caption-narrative-improvement-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/caption-narrative-improvement-design.md#L512)]
- しかし `captionCommand()` には timing phase が存在せず、`word-remap.ts` も import されていない。実装は `generateCaptionSource()` の後に editorial と approval へ直行する。[[caption.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/caption.ts#L156)] [[caption.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/caption.ts#L186)] [[caption.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/caption.ts#L209)]
- `CaptionDraftEntry` には `timing` metadata がなく、`caption-approval` schema にも `editorial` / `timing` を保持する欄が無い。approved 後に provenance を保持する契約にも未達である。[[editorial.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/caption/editorial.ts#L53)] [[caption-approval.schema.json](/Users/mocchalera/Dev/video-os-v2-spec/schemas/caption-approval.schema.json#L49)]
- `remapWithWordTimestamps()` も caption text と word sequence を照合せず、参照 transcript item 上の全 word の最小 start / 最大 end を採るだけなので、1 item が複数 caption に割れたケースでは全 caption が同じ広い span になる。[[word-remap.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/caption/word-remap.ts#L68)] [[word-remap.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/caption/word-remap.ts#L92)]

影響:

- review 観点 3 の「word timestamps からの精密 remap」は未達。
- `timing_confidence >= 0.75` gate や fallback 制御が実装不能。
- approval 後の timing provenance が残らない。

修正推奨:

- `/caption` に `timingAligner` を追加し、`word_remap -> clip_item_remap -> final_audio_realign` の順で明示的に配線する。
- draft / approval artifact と schema に `timing.source`, `timing.confidence`, `source_word_refs`, `triggered_fallback` を追加する。
- word remap は `transcriptItemIds` 全体の min/max ではなく、caption text と対応する word span を抽出するロジックに直す。

### FATAL 3. `/blueprint` の evaluate→re-draft loop は runtime に統合されておらず、現在の本線は依然として single-pass

根拠:

- `runBlueprint()` が iterative path に入る条件は `options?.iterativeEngine !== false` に加えて `!!phases` であり、`phases` を渡さない限り legacy single-pass agent にフォールバックする。[[blueprint.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/blueprint.ts#L367)] [[blueprint.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/blueprint.ts#L484)]
- 既存の command/e2e test はすべて `runBlueprint(tmpDir, agent)` の 2 引数呼び出しで、iterative phases を一度も渡していない。[[commands.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/commands.test.ts#L1252)] [[e2e-m3.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/e2e-m3.test.ts#L420)]
- `runtime/script/{frame,read,draft,evaluate}.ts` は unit test されているが、`/blueprint` command path には接続されていない。[[m45-script-engine.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/m45-script-engine.test.ts#L1)]

影響:

- review 観点 5 の「evaluate→re-draft の往復が /blueprint に統合されているか」は `No`。
- `max 3` retry, revision brief, deterministic evaluate gate, human-decline split が production command path では機能していない。
- narrative 改善の主目的が未達。

修正推奨:

- `runBlueprint()` で使う default `NarrativePhases` を実装し、command 本線から必ず phase orchestration を通す。
- legacy path は feature flag fallback に留め、通常 path を iterative engine に切り替える。
- `/blueprint` integration test を phases 付きで追加する。

### WARNING 1. CPS / 行長制限は設計どおりに end-to-end で効いていない

根拠:

- `line-breaker.ts` 自体は `20/42 chars` と `6/15 CPS` を持つが、`captionCommand()` は `generateCaptionSource()` に `autoLineBreak: true` を渡していない。[[line-breaker.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/caption/line-breaker.ts#L27)] [[caption.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/caption.ts#L160)]
- `segmenter.ts` の density calibration は依然として `ja fail=10.0`, `en fail=4.5 WPS` で、設計の `6.0 / 15.0 CPS` と一致していない。[[segmenter.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/caption/segmenter.ts#L69)] [[caption-narrative-improvement-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/caption-narrative-improvement-design.md#L452)]
- `buildPassthroughDraft()` は layout / density / alignment / timing を一切見ずに `ready_for_human_approval` を返す。`runEditorial()` 側も `degraded_count` しか見ていない。[[caption.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/caption.ts#L347)] [[editorial.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/caption/editorial.ts#L303)]
- packaging QA も旧 hard-coded `10.0 CPS / 4.5 WPS` のままで、設計書が求める policy-driven threshold に更新されていない。[[qa.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/packaging/qa.ts#L40)] [[caption-narrative-improvement-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/caption-narrative-improvement-design.md#L492)]

影響:

- `ready_for_human_approval` が readability gate を通っていない。
- review 観点 2 の「CPS/行長制限が設計書通りか」は `No`。

修正推奨:

- caption draft readiness gate を実装し、layout / density / alignment / timing をまとめて判定する。
- segmenter と packaging QA の密度閾値を line-break policy と同じ source of truth に寄せる。

### WARNING 2. deterministic cleanup の regex は false positive / false negative を持つ

根拠:

- space-separated acronym rejoin は `A B` のような通常の英字列も無条件で結合する。実際に `Plan A B test` は `Plan AB test`、`Grade A I think` は `Grade AI think` になる。原因は単純な `[A-Z]` 連結 regex で、文脈や glossary を見ていないため。[[cleanup.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/caption/cleanup.ts#L26)]
- stray punctuation 削除は punctuation の両側に whitespace を要求するため、`hello .world` や `こんにちは 。さようなら` のような片側だけ空白のノイズを落とせない。[[cleanup.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/caption/cleanup.ts#L45)]

影響:

- review 観点 1 の acronym rejoin は `_` 系には効くが、space-split rule は安全ではない。
- STT ノイズ cleanup の取りこぼしと誤補正の両方が残る。

修正推奨:

- space-split rejoin は glossary hit, surrounding script, minimum token class などで限定する。
- stray punctuation は「片側 whitespace + 非語頭/語尾 punctuation」のケースも処理する。

### WARNING 3. 新規テストは helper 単体に寄っており、今回の契約破壊を検知できていない

根拠:

- 新規 `caption-narrative-improvement.test.ts` の narrative 部分は `validateConfirmedPreferences()` しか見ておらず、`runBlueprint()` の iterative path を通していない。[[caption-narrative-improvement.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/caption-narrative-improvement.test.ts#L357)]
- 同テストの caption artifact 分離も plain object assertion に留まり、`/caption` command の actual handoff を検証していない。[[caption-narrative-improvement.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/caption-narrative-improvement.test.ts#L633)]
- 既存 E2E はむしろ legacy behavior を固定しており、`captionCommand()` が即 `caption_approval.json` を作ることを成功条件にしている。[[e2e-m4.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/e2e-m4.test.ts#L219)] [[e2e-m4.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/e2e-m4.test.ts#L440)]

影響:

- 今回の FATAL 3 件がすべて green のまま通る。
- review 観点 8/9 の「後方互換 / テスト網羅性」は、旧挙動に対しては `Pass` だが新設計に対しては `Fail`。

修正推奨:

- `/caption` integration test を追加する。
  - draft 生成だけで止まること
  - approval は別 handoff でしか作れないこと
  - timing metadata / readiness gate を見ること
- `/blueprint` integration test を追加する。
  - evaluate reject -> revisionBrief -> re-draft
  - collaborative confirm decline
  - `script_evaluation.yaml` persistence

### NOTE 1. iterative path を有効化しても、decline / max-iteration failure 時の `script_evaluation.yaml` 永続化が抜けている

根拠:

- `script_evaluation.yaml` の書き込みは success path のあとにしか実行されない。[[blueprint.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/blueprint.ts#L464)]
- human decline / max iteration failure はその前に return するため、設計書が要求する `confirmation_status`, `decline_reason`, `loop_summary` が残らない。[[blueprint.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/commands/blueprint.ts#L392)] [[caption-narrative-improvement-design.md](/Users/mocchalera/Dev/video-os-v2-spec/docs/caption-narrative-improvement-design.md#L709)]

影響:

- operational artifact としての監査性が弱い。

## Backward Compatibility

- 既存 suite は全通過しており、現行 repo 契約に対する即時回帰は観測していない。
- ただしその green は「旧契約を維持している」ことの証跡でもある。特に `caption_approval` 即時生成と single-pass `/blueprint` は、今回の設計改善を検証する oracle になっていない。

## Conclusion

実装は helper 追加までは進んでいるが、設計の中心だった 2 本線はまだ成立していない。

- 字幕側: `draft -> human approval` 分離と timing/readiness gate が未接続
- ナラティブ側: iterative `/blueprint` loop が本線未統合

したがって判定は `FAIL` とする。既存 test/compile は green だが、今回の改善が runtime path で有効になったことは示していない。
