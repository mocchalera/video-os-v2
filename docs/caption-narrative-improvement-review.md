# Caption + Narrative Improvement Design Review

対象:

- `docs/caption-narrative-improvement-design.md`

参照:

- `ARCHITECTURE.md`
- `runtime/commands/blueprint.ts`
- `runtime/commands/caption.ts`
- `runtime/caption/segmenter.ts`
- `runtime/caption/approval.ts`
- `runtime/script/{frame,read,draft,evaluate}.ts`
- `schemas/{transcript,caption-approval,message-frame,material-reading,script-draft,script-evaluation}.json`
- 旧 repo `src/video_edit_agent/pipeline/{caption_editorial_llm,timestamp_refiner}.py`
- 旧 repo `.claude/rules/caption-editing.md`

判定:

- `CONDITIONAL FAIL`
- `FATAL 2`
- `WARNING 4`
- `NOTE 3`

総評:

設計の方向性自体は妥当です。特に字幕の `raw -> cleanup -> editorial -> validator` 分離と、`/blueprint` 内に Script Engine loop を本線統合する判断は、現 V2 の弱点に正面から効きます。  
一方で、現行契約に対してそのまま進めると止まる論点が 2 つあります。`/blueprint` の collaborative confirmation 契約と、`caption_approval.json` の human approval semantics です。ここを先に閉じないと、実装は進められても promote / audit / test contract が崩れます。

## Findings

### FATAL 1. 新 `/blueprint` workflow が既存の collaborative confirmation 契約を落としている

根拠:

- 新 workflow 定義は `frame -> read -> draft -> evaluate -> reject? -> promote` で閉じており、human confirmation / preference interview の明示ステップが無い。([design:466](/path/to/project/docs/caption-narrative-improvement-design.md#L466), [design:671](/path/to/project/docs/caption-narrative-improvement-design.md#L671))
- 現行 `/blueprint` は `pacing.confirmed_preferences` を autonomy mode と照合し、human decline も command error として扱う。([blueprint.ts:175](/path/to/project/runtime/commands/blueprint.ts#L175), [blueprint.ts:279](/path/to/project/runtime/commands/blueprint.ts#L279))
- `ARCHITECTURE.md` でも `autonomy=collaborative` では pacing / structure / duration の human confirmation が必須。([ARCHITECTURE.md:442](/path/to/project/ARCHITECTURE.md#L442))

影響:

- collaborative project で accepted draft ができても、どの時点で human confirmation を入れるか未定義のままでは current schema / command contract を満たせない。
- `reject loop` と `human declined readback` が別概念なのに、設計上は分離されていない。実装時に state / retry semantics が曖昧になる。

修正推奨:

- `promote` 前に明示的な `confirm` subphase を追加する。
- `evaluate reject` と `human decline` を別 status に分ける。
- `pacing.confirmed_preferences` と `BlueprintAgentResult.confirmed` を残すか、等価の新 contract を先に定義する。

### FATAL 2. `/caption` auto approval が `caption_approval.json` の approved-only semantics を壊す

根拠:

- 設計は品質閾値を満たした場合に `/caption` の auto approval を許可している。([design:452](/path/to/project/docs/caption-narrative-improvement-design.md#L452))
- しかし M4 の caption workflow は `source generation -> operator editorial approval` の 2 段階で固定され、`caption_approval.json.approval.approved_by` は human editorial approval の証跡として定義されている。([milestone-4-design:661](/path/to/project/docs/milestone-4-design.md#L661), [milestone-4-design:671](/path/to/project/docs/milestone-4-design.md#L671))
- 現 approval shape も `approved | stale` と `approved_by` / `approved_at` しか持たず、machine-approved と human-approved を区別できない。([approval.ts:18](/path/to/project/runtime/caption/approval.ts#L18), [caption-approval.schema.json:130](/path/to/project/schemas/caption-approval.schema.json#L130))

影響:

- auto-created `caption_approval.json` を human-approved artifact と同じ canonical path に置くと、approval provenance が崩れる。
- 既存 M4 の audit semantics と後続 packaging gate の意味が曖昧になる。

修正推奨:

- `caption_approval.json` は human-only のまま維持し、auto path は別 artifact に分ける。
- もし auto approval を残すなら、少なくとも `approval.mode: auto | human` 相当の contract を先に追加し、既存 consumer への互換方針を明文化する。

### WARNING 1. `quality-judgment` を fail-closed gate に入れる設計が M4.5 の deterministic evaluate 契約と衝突する

根拠:

- 設計は Phase D に `continuity review + quality judgment` を入れ、`source_fidelity fail` と `audience_alignment fail` を reject 条件にしている。([design:582](/path/to/project/docs/caption-narrative-improvement-design.md#L582), [design:607](/path/to/project/docs/caption-narrative-improvement-design.md#L607))
- M4.5 では `script_evaluation.yaml` は LLM を使わず、`tone_integrity` / `source_fidelity` は roughcut review 側 advisory に留めると明記されている。([milestone-4.5-design:388](/path/to/project/docs/milestone-4.5-design.md#L388), [milestone-4.5-design:423](/path/to/project/docs/milestone-4.5-design.md#L423))
- 現 runtime の `evaluateScript()` も純 deterministic helper として実装・テストされている。([evaluate.ts:60](/path/to/project/runtime/script/evaluate.ts#L60), [m45-script-engine.test.ts:205](/path/to/project/tests/m45-script-engine.test.ts#L205))

影響:

- blueprint gate が prompt-sensitive になり、M4.5 が意図した deterministic CI の前提が弱くなる。
- reject 理由の再現性が落ち、artifact diff だけで loop failure を説明しにくくなる。

修正推奨:

- `continuity review` は gate に残してよい。
- `quality_judgment` は advisory block として別保持し、fail-closed にするのは deterministic に固定できる subset だけに絞る。

### WARNING 2. `final_audio_realign` fallback の実装手段が未固定

根拠:

- 設計は 2-pass fallback を「approved text の timing 付け直し」と定義し、re-transcribe は hint に留めるとしている。([design:378](/path/to/project/docs/caption-narrative-improvement-design.md#L378), [design:384](/path/to/project/docs/caption-narrative-improvement-design.md#L384))
- これは plain STT では足りず、text-constrained alignment か forced alignment の adapter が要る。
- 旧 repo でも timing refinement は専用 module と dependency/failure status を持っていた。([timestamp_refiner.py:333](/path/to/legacy-project/src/video_edit_agent/pipeline/timestamp_refiner.py#L333), [timestamp_refiner.py:382](/path/to/legacy-project/src/video_edit_agent/pipeline/timestamp_refiner.py#L382))

影響:

- `Phase 4: final-audio realign fallback` の done condition が backend 非依存で定義されておらず、実装コストと failure behavior を見積もれない。
- `LLM injectable` とは別の adapter contract が必要なのに、設計上まだ露出していない。

修正推奨:

- `final_audio_realign` を caption timing adapter として独立させる。
- 入力、出力、失敗 status、依存性、CPU/GPU 前提、mock shape を先に定義する。

### WARNING 3. `word-level remap` を主戦略にする判断は妥当だが、現 runtime はまだ utterance-level 実装である

根拠:

- 設計は transcript schema の `words[]` / `word_timing_mode` を主根拠にしている。([design:360](/path/to/project/docs/caption-narrative-improvement-design.md#L360), [design:370](/path/to/project/docs/caption-narrative-improvement-design.md#L370))
- transcript schema 自体はその field を持つ。([transcript.schema.json:22](/path/to/project/schemas/transcript.schema.json#L22), [transcript.schema.json:54](/path/to/project/schemas/transcript.schema.json#L54))
- ただし現 `generateCaptionSource()` は transcript item を clip に remap してから caption segmentation しており、word timing を使う path を持たない。([segmenter.ts:103](/path/to/project/runtime/caption/segmenter.ts#L103), [segmenter.ts:369](/path/to/project/runtime/caption/segmenter.ts#L369))

影響:

- `word_auto` を default rollout に置くには、caption raw artifact と remap IR の追加が先に必要。
- 設計の Phase 4 見積もりはやや楽観的で、実際には Phase 3.5 相当の plumbing が要る。

修正推奨:

- `caption_source.raw.json` に `source_word_refs` を持たせる設計を先に固定する。
- `clip/item remap 改善` と `word-level remap` の間に、word-aware raw IR 導入の小フェーズを挟む。

### WARNING 4. `LLM injectable` 方針は正しいが、`/caption` 側の test seam がまだ粗い

根拠:

- 設計は `/blueprint` と `/caption` の LLM を phase-aware injectable にする、としている。([design:110](/path/to/project/docs/caption-narrative-improvement-design.md#L110))
- `/blueprint` は既に injectable agent interface を持つ。([blueprint.ts:116](/path/to/project/runtime/commands/blueprint.ts#L116))
- 一方 `captionCommand()` は file IO、source generation、approval 作成、timeline mutation を一体で持っており、editorial / timing / approval を個別に差し替える seam が無い。([caption.ts:58](/path/to/project/runtime/commands/caption.ts#L58), [caption.ts:126](/path/to/project/runtime/commands/caption.ts#L126), [caption.ts:156](/path/to/project/runtime/commands/caption.ts#L156))

影響:

- 設計が要求する `fail / retry / reject` の phase別再現は、現 command shape のままだと重い integration test に寄りやすい。
- mock LLM だけで deterministic CI を回す要件は満たせても、失敗原因の局所化が難しい。

修正推奨:

- `/caption` を pure step と adapter に分離する。
- 最低でも `editorialJudge`, `timingAligner`, `approvalDecision`, `artifactWriter` を分ける。

## Notes

### NOTE 1. 字幕 4 層化そのものは十分実現可能

確認内容:

- 設計の `raw -> deterministic pre-clean -> LLM editorial -> validator` は、旧 repo の guarded editorial flow と整合している。([design:225](/path/to/project/docs/caption-narrative-improvement-design.md#L225), [design:268](/path/to/project/docs/caption-narrative-improvement-design.md#L268), [caption_editorial_llm.py:203](/path/to/legacy-project/src/video_edit_agent/pipeline/caption_editorial_llm.py#L203), [caption_editorial_llm.py:271](/path/to/legacy-project/src/video_edit_agent/pipeline/caption_editorial_llm.py#L271))
- 現 runtime は `caption_source.json -> caption_approval.json` を直結しているので、今回の raw/source 分離は provenance 改善として妥当。([caption.ts:143](/path/to/project/runtime/commands/caption.ts#L143), [caption.ts:156](/path/to/project/runtime/commands/caption.ts#L156))

所見:

- 実装可能性に問題はない。
- ただし approval semantics を先に直さないと、4 層目 validator の先で canonical approved artifact に誤って promote される。

### NOTE 2. `frame/read/draft/evaluate` を `/blueprint` に統合する方向は妥当

確認内容:

- Script Engine 4 phase helper と unit tests は既に存在する。([frame.ts:1](/path/to/project/runtime/script/frame.ts#L1), [read.ts:1](/path/to/project/runtime/script/read.ts#L1), [draft.ts:1](/path/to/project/runtime/script/draft.ts#L1), [evaluate.ts:1](/path/to/project/runtime/script/evaluate.ts#L1), [m45-script-engine.test.ts:55](/path/to/project/tests/m45-script-engine.test.ts#L55))
- M4.5 も operational artifact を `/blueprint` 配下に閉じ込める方針を採っている。([milestone-4.5-design:152](/path/to/project/docs/milestone-4.5-design.md#L152))

所見:

- `runtime/commands/blueprint.ts` の single agent path を orchestrator に置き換えるのは現実的。
- ただし FATAL 1 の confirmation contract を同時に解く必要がある。

### NOTE 3. 実装順序は少し組み替えた方が安全

現設計の Phase 1-5 は大枠では妥当だが、以下の順の方が契約破壊を避けやすい。

1. `FATAL` 2件を先に閉じる
2. `/blueprint` と `/caption` の injection seam を先に作る
3. narrative は deterministic evaluate ベースで loop 統合する
4. caption は `raw + cleanup + validator` まで先に入れる
5. その後に LLM editorial を追加する
6. timing は `clip/item -> word-level -> final-audio fallback` の順で入れる

## 観点別結論

1. 字幕 4 層化:
   実現可能。だが `caption_approval.json` の auto approval をこのまま入れると contract break になる。
2. timing 戦略:
   `word-level remap` 主戦略、`2-pass` fallback の判断は概ね妥当。実装 adapter の固定が必要。
3. ナラティブ往復ループの `/blueprint` 統合:
   十分可能。既存 helper もある。ただし collaborative confirmation step を戻す必要がある。
4. `evaluate` への continuity + quality judgment 統合:
   continuity review は適切。quality judgment を fail-closed gate にするのは時期尚早。
5. LLM injectable 設計:
   方針は正しい。`/blueprint` は既に近いが、`/caption` は command 分割が前提になる。
6. M1-M4.5 契約維持:
   現状案のままでは M3 `/blueprint` の confirmation 契約と M4 caption approval semantics を壊す。
7. 実装順序:
   全体は現実的。ただし contract fix と injection seam を Phase 2/3 より前に繰り上げるべき。

## Conclusion

この設計は「どこを良くするか」はかなり正しいです。  
ただし着手前に直すべき論点が 2 つあります。

- `/blueprint` loop に collaborative confirmation を明示的に戻すこと
- `caption_approval.json` を machine-approved artifact に流用しないこと

この 2 点を先に修正すれば、残りは `WARNING` レベルです。そこまで落とせれば、判定は `CONDITIONAL PASS` に引き上げてよいです。
