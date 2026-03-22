# Caption + Narrative Improvement Design Review R2

対象:

- `docs/caption-narrative-improvement-design.md`

参照:

- `docs/caption-narrative-improvement-review.md`
- `ARCHITECTURE.md`
- `runtime/commands/blueprint.ts`
- `runtime/commands/caption.ts`
- `runtime/caption/approval.ts`
- `runtime/script/evaluate.ts`
- `schemas/edit-blueprint.schema.json`
- `schemas/caption-approval.schema.json`
- `docs/milestone-4-design.md`
- `docs/milestone-4.5-design.md`

判定:

- `CONDITIONAL PASS`
- `FATAL 0`
- `WARNING 1`
- `NOTE 3`

総評:

R1 の FATAL 2 件は解消されています。`/blueprint` には `confirm` subphase と `pacing.confirmed_preferences` 互換契約が戻り、`caption_approval.json` も human-approved artifact のまま維持する方針が明文化されました。  
また、R1 の WARNING 4 件と NOTE 3 件も概ね取り込まれており、設計の主要な契約破壊は見当たりません。

一方で、`caption_draft.json` から `caption_approval.json` へ進む人間承認の受け渡し interface はまだ設計上の固定が弱いです。実装準備完了という意味ではここだけ詰めてから着手した方が安全です。

## Findings

### WARNING 1. `caption_draft.json` から human approval へ渡す具体 interface がまだ未固定

根拠:

- 設計は `/caption` を `raw generation -> source generation -> editorial -> timing -> validation -> draft projection -> human approval projection` に再編するとしているが、human approval projection の呼び出し形が明示されていない。([design:161](/path/to/project/docs/caption-narrative-improvement-design.md#L161), [design:162](/path/to/project/docs/caption-narrative-improvement-design.md#L162), [design:163](/path/to/project/docs/caption-narrative-improvement-design.md#L163))
- Human approval gate では「human approval が入ったときだけ `caption_approval.json` を生成する」「operator が text を変えた場合は timing diagnostics を再計算してから approval へ進む」と定義しているが、その入力経路が未記述である。([design:526](/path/to/project/docs/caption-narrative-improvement-design.md#L526), [design:527](/path/to/project/docs/caption-narrative-improvement-design.md#L527), [design:528](/path/to/project/docs/caption-narrative-improvement-design.md#L528))
- 現行 `captionCommand()` は `draftOnly` 以外では command 内で即 `caption_approval.json` を作る実装であり、設計変更後はここに代わる明示的 handoff contract が必要になる。([caption.ts:49](/path/to/project/runtime/commands/caption.ts#L49), [caption.ts:53](/path/to/project/runtime/commands/caption.ts#L53), [caption.ts:156](/path/to/project/runtime/commands/caption.ts#L156), [caption.ts:164](/path/to/project/runtime/commands/caption.ts#L164))

影響:

- human-only semantics 自体は守れているが、実装時に `/caption` 再実行、別 subcommand、UI 承認フローのどれを正とするかで責務分割が変わる。
- `operator edit -> timing diagnostics 再計算 -> approval projection` のテスト観点も、この interface が決まらないと固定しにくい。

修正推奨:

- 以下のどれかを設計書に明記する。
- `draftOnly` で `caption_draft.json` を出し、別 approval step がそれを読む。
- `/caption approve` 相当の subcommand を新設する。
- operator 編集済み `caption_draft.json` を入力に approval projection だけ行う adapter を定義する。

## R1 Follow-up

- `FATAL 1: collaborative confirmation`
  解消。`confirm` subphase、`confirmation_status`、`human_declined` 分離、`pacing.confirmed_preferences` 互換契約が設計に戻った。([design:71](/path/to/project/docs/caption-narrative-improvement-design.md#L71), [design:75](/path/to/project/docs/caption-narrative-improvement-design.md#L75), [design:245](/path/to/project/docs/caption-narrative-improvement-design.md#L245), [design:709](/path/to/project/docs/caption-narrative-improvement-design.md#L709), [design:715](/path/to/project/docs/caption-narrative-improvement-design.md#L715))
- `FATAL 2: caption_approval semantics`
  解消。`caption_approval.json` は human-only のままとされ、machine が直接生成しないことが複数箇所で固定された。([design:79](/path/to/project/docs/caption-narrative-improvement-design.md#L79), [design:80](/path/to/project/docs/caption-narrative-improvement-design.md#L80), [design:126](/path/to/project/docs/caption-narrative-improvement-design.md#L126), [design:268](/path/to/project/docs/caption-narrative-improvement-design.md#L268), [design:526](/path/to/project/docs/caption-narrative-improvement-design.md#L526))
- `WARNING 1: quality-judgment fail-closed`
  解消。continuity は deterministic gate、`quality-judgment` は advisory block に後退し、`source_fidelity` / `audience_alignment` は reject 条件から外れた。([design:73](/path/to/project/docs/caption-narrative-improvement-design.md#L73), [design:243](/path/to/project/docs/caption-narrative-improvement-design.md#L243), [design:666](/path/to/project/docs/caption-narrative-improvement-design.md#L666), [design:673](/path/to/project/docs/caption-narrative-improvement-design.md#L673), [design:687](/path/to/project/docs/caption-narrative-improvement-design.md#L687))
- `WARNING 2: final_audio_realign adapter 未固定`
  解消。input/output/failure status/dependency/mock shape まで contract 化された。([design:421](/path/to/project/docs/caption-narrative-improvement-design.md#L421), [design:431](/path/to/project/docs/caption-narrative-improvement-design.md#L431), [design:436](/path/to/project/docs/caption-narrative-improvement-design.md#L436), [design:445](/path/to/project/docs/caption-narrative-improvement-design.md#L445))
- `WARNING 3: word-level remap に必要な raw IR 不足`
  解消。`caption_source.raw.json` と `source_word_refs`、Phase 6 の `word-aware raw IR plumbing` が明記された。([design:254](/path/to/project/docs/caption-narrative-improvement-design.md#L254), [design:256](/path/to/project/docs/caption-narrative-improvement-design.md#L256), [design:402](/path/to/project/docs/caption-narrative-improvement-design.md#L402), [design:866](/path/to/project/docs/caption-narrative-improvement-design.md#L866))
- `WARNING 4: /caption` の test seam 粗さ
  概ね解消。`editorialJudge`, `timingAligner`, `draftReadinessGate`, `artifactWriter` の分離方針が入った。([design:119](/path/to/project/docs/caption-narrative-improvement-design.md#L119), [design:805](/path/to/project/docs/caption-narrative-improvement-design.md#L805), [design:806](/path/to/project/docs/caption-narrative-improvement-design.md#L806))
- `NOTE 1: 字幕 4 層化の実現可能性`
  維持。むしろ `caption_source.raw.json` と report artifact まで加わり、provenance 設計が前進した。([design:228](/path/to/project/docs/caption-narrative-improvement-design.md#L228), [design:233](/path/to/project/docs/caption-narrative-improvement-design.md#L233), [design:263](/path/to/project/docs/caption-narrative-improvement-design.md#L263))
- `NOTE 2: /blueprint への 4 phase 統合`
  維持。workflow、phase 責務、confirm/promotion 条件が揃った。([design:239](/path/to/project/docs/caption-narrative-improvement-design.md#L239), [design:534](/path/to/project/docs/caption-narrative-improvement-design.md#L534), [design:761](/path/to/project/docs/caption-narrative-improvement-design.md#L761))
- `NOTE 3: 実装順序の組み替え`
  解消。Phase 1 に contract fix、Phase 2 に seam 抽出、caption LLM は validator 後段、timing はさらに後段へ整理された。([design:786](/path/to/project/docs/caption-narrative-improvement-design.md#L786), [design:800](/path/to/project/docs/caption-narrative-improvement-design.md#L800), [design:829](/path/to/project/docs/caption-narrative-improvement-design.md#L829), [design:847](/path/to/project/docs/caption-narrative-improvement-design.md#L847), [design:861](/path/to/project/docs/caption-narrative-improvement-design.md#L861))

## 実装準備完了度

- 契約整合:
  `PASS`。`/blueprint` の collaborative confirmation と `caption_approval.json` の human-only semantics は repo 既存契約と整合した。([blueprint.ts:175](/path/to/project/runtime/commands/blueprint.ts#L175), [blueprint.ts:279](/path/to/project/runtime/commands/blueprint.ts#L279), [ARCHITECTURE.md:442](/path/to/project/ARCHITECTURE.md#L442), [approval.ts:25](/path/to/project/runtime/caption/approval.ts#L25))
- 実装分解:
  `PASS`。phase 分離、flag、段階 rollout、テスト戦略まで含めて工程化できている。
- 着手前の残タスク:
  `MINOR`。`caption_draft.json -> caption_approval.json` の承認 handoff を command/API レベルで 1 行でもよいので固定すること。

## Conclusion

R2 時点で `FATAL 0` は確認できます。判定は `CONDITIONAL PASS` です。  
残件は approval handoff interface の固定 1 点で、これは contract break ではなく実装着手時の曖昧さです。ここを追記すれば、実装準備完了として扱ってよいです。
