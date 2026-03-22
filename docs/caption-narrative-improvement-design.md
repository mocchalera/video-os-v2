# 字幕品質 + ナラティブ設計 改善設計書

- 作成日: 2026-03-22
- 対象リポジトリ: `video-os-v2-spec`
- 対象領域: `/blueprint`, `/caption`, packaging QA, Script Engine operational artifacts
- 目的: V2 の字幕品質とナラティブ設計を、旧 `video-edit-agent` の実戦知見を継承しつつ、それ以上の再現性と品質ゲートで引き上げる

## 1. 根拠と前提

本設計は以下を実読した上で作成する。

### 旧 `video-edit-agent` から参照した資産

- `src/video_edit_agent/pipeline/caption_editorial_llm.py`
- `src/video_edit_agent/pipeline/caption_strategy.py`
- `src/video_edit_agent/pipeline/caption.py`
- `.claude/rules/caption-editing.md`
- `docs/inventory-ja/skills/narrative-design.md`
- `docs/inventory-ja/skills/material-reading-review.md`
- `docs/inventory-ja/skills/narrative-continuity-review.md`
- `docs/inventory-ja/skills/quality-judgment.md`
- `docs/inventory-ja/skills/build-edit-plan.md`

### 現 V2 から参照した資産

- `runtime/caption/segmenter.ts`
- `runtime/caption/approval.ts`
- `runtime/commands/caption.ts`
- `runtime/commands/blueprint.ts`
- `runtime/commands/review.ts`
- `runtime/script/frame.ts`
- `runtime/script/read.ts`
- `runtime/script/draft.ts`
- `runtime/script/evaluate.ts`
- `runtime/compiler/types.ts`
- `runtime/packaging/qa.ts`
- `schemas/edit-blueprint.schema.json`
- `schemas/uncertainty-register.schema.json`
- `schemas/message-frame.schema.json`
- `schemas/material-reading.schema.json`
- `schemas/script-draft.schema.json`
- `schemas/script-evaluation.schema.json`
- `schemas/transcript.schema.json`
- `agent-src/roles/blueprint-planner.yaml`
- `agent-src/roles/roughcut-critic.yaml`
- `docs/milestone-4-design.md`
- `docs/milestone-4.5-design.md`
- `docs/impl-review-m45.md`

## 2. 目的と成功条件

### 2.1 目的

V2 の現状は、字幕が deterministic segmentation に寄りすぎており、ナラティブは M4.5 で入れた 4 フェーズが runtime path に未統合である。これを、以下の二本立てで改善する。

1. 字幕を「読める・正しい・映像に合う」draft にする
2. `/blueprint` を単発生成ではなく、素材精読と品質評価を伴う往復工程にする

### 2.2 成功条件

以下を満たした時点で本設計の達成とみなす。

- 字幕
  - `A_I -> AI` のような STT ノイズを自動修正できる
  - stray punctuation を自動除去できる
  - 日本語 20 文字 / 英語 42 文字の 1 行上限、2 行上限を守る
  - 日本語 6.0 CPS / 英語 15.0 CPS を policy-driven に検証できる
  - word-level timing がある場合はそれを第一優先で使い、ない場合も fallback がある
  - LLM 字幕 editorial は injectable で、mock で統合テストできる
- ナラティブ
  - `/blueprint` が `frame -> read -> draft -> evaluate -> confirm -> promote` を内部で実行する
  - `material-reading-review` 相当の深い素材精読を持つ
  - `narrative-continuity-review` は deterministic gate に統合され、`quality-judgment` は advisory block として保持される
  - evaluate 不合格時に draft へ戻る最大 3 回のループを持つ
  - `autonomy=collaborative` では evaluate 合格後に人間確認を挟み、human decline は evaluate reject と別 status で扱う
  - 3 回失敗または素材不足時は `uncertainty_register.yaml` に blocker を残して `blocked` に落ちる
- 契約
  - `edit_blueprint.yaml` と `uncertainty_register.yaml` は引き続き canonical artifact のまま
  - `caption_source.json -> caption_draft.json -> caption_approval.json -> timeline.json` の chain で approval provenance を明示する
  - `caption_approval.json` は human-approved artifact のままとし、machine が直接生成しない
  - `pacing.confirmed_preferences` と `BlueprintAgentResult.confirmed` 相当の collaborative confirmation 契約を維持する
  - M1-M4.5 の state machine と promote モデルを壊さない

## 3. スコープ境界

### 3.1 やること

- 字幕 editorial pipeline の追加
- 字幕 timing 精度改善
- policy-driven な字幕レイアウト制約と QA の追加
- `/blueprint` への Script Engine 4 フェーズ統合
- 素材精読、continuity review、advisory quality judgment、reject loop、collaborative confirm subphase の導入
- 既存 role prompt と command contract の責務見直し

### 3.2 やらないこと

- approval provenance を守る目的以外で canonical artifact を増やすこと
- `caption_approval.json` を machine が直接書くこと
- `/review` を `/blueprint` の代替にすること
- deterministic evaluate gate を prompt-sensitive な fail-closed gate に置き換えること
- 常時 2 パス render を強制すること
- NLE finishing path 全体の再設計
- STT connector 仕様自体の全面変更

## 4. 壊さない契約

### 4.1 Canonical / operational split は維持する

- ナラティブの canonical は引き続き `04_plan/edit_blueprint.yaml`
- 不確実性の canonical は引き続き `04_plan/uncertainty_register.yaml`
- `07_package/caption_source.json` は source generation canonical として維持する
- `07_package/caption_draft.json` を machine-generated draft canonical として追加する
- `07_package/caption_approval.json` は human-approved canonical のまま維持する
- Script Engine 4 フェーズは operational artifact として扱う

### 4.2 Phase 呼び出しと adapter は injectable にする

- `/blueprint` は phase ごとに injectable function を受け取る
- `/caption` は `editorialJudge`, `timingAligner`, `draftReadinessGate`, `artifactWriter` を分離し、個別に差し替え可能にする
- `final_audio_realign` は LLM ではなく timing adapter として独立させる
- unit test / integration test は mock で phase fail, retry, reject, human decline, alignment fallback を再現できるようにする

### 4.3 失敗時の基本方針

- 字幕 editorial は fail-open だが、degraded 状態を明示する
- `caption_draft.json` は machine が生成してよいが、`caption_approval.json` は human approval があるときだけ生成する
- ナラティブ品質ゲートは fail-closed とする
- `evaluate reject` と `human decline` は別 status とし、後者は promote を止めるが reject 回数には混ぜない
- 2 パス字幕は fallback として残し、1 パスも常に使える状態を維持する
- `final_audio_realign` 失敗は adapter status として明示し、silent fallback しない

### 4.4 インターフェース変更方針

本設計で変更する interface は additive を原則とする。

- 新規 schema
  - `schemas/caption-source.schema.json`
    - 現状 schema がない `caption_source.json` を validate 対象にする
  - `schemas/caption-draft.schema.json`
    - `caption_draft.json` を validate 対象にする
- additive 更新
  - `schemas/caption-approval.schema.json`
    - `speech_captions[].editorial`
    - `speech_captions[].timing`
    - approval は human-only のままとし、machine mode は追加しない
  - `schemas/message-frame.schema.json`
    - quality target / guardrail の拡張
  - `schemas/material-reading.schema.json`
    - score breakdown / continuity risk / evidence quotes
  - `schemas/script-draft.schema.json`
    - `revision_brief`, `preserve`, `must_fix`
  - `schemas/script-evaluation.schema.json`
    - continuity judgment
    - advisory quality summary
    - `confirmation_status`
    - `decline_reason`
    - `loop_summary`

command への影響は以下とする。

- `runtime/commands/caption.ts`
  - raw generation -> source generation -> editorial -> timing -> validation -> draft projection -> human approval projection へ再編する
  - command 本体は pure step と adapter に分離する
- `runtime/commands/blueprint.ts`
  - 1-shot agent 実行を orchestrator に置き換え、`confirm` subphase と `confirmed` compatibility contract を保持する
- `runtime/commands/review.ts`
  - blueprint quality target を読むだけに留め、state machine は変えない

### 4.5 Runtime flag 方針

段階 rollout のため、以下の logical flag を持つ前提で設計する。

- `blueprint.iterative_engine.enabled`
- `blueprint.iterative_engine.max_iterations=3`
- `blueprint.iterative_engine.require_confirmation_in_collaborative=true`
- `caption.editorial.enabled`
- `caption.timing.mode`
  - `clip_item`
  - `word_auto`
  - `word_then_final_audio`
- `caption.final_audio_realign.enabled=false`
- `caption.draft_ready.min_timing_confidence=0.75`
- `caption.draft_ready.require_zero_degraded=true`
- `caption.approval.require_human=true`

default rollout は以下とする。

1. `blueprint.iterative_engine.enabled=true`
2. `caption.approval.require_human=true`
3. `caption.editorial.enabled=true`
4. `caption.timing.mode=clip_item`
5. word-aware raw IR 導入後に `caption.timing.mode=word_auto`
6. 実素材 fixture が揃った後に `caption.timing.mode=word_then_final_audio`

2 パス fallback は実素材 fixture が揃うまで opt-in に留める。

## 5. 現状診断

### 5.1 字幕品質の根因

| 問題 | 現状根因 | 設計対応 |
| --- | --- | --- |
| `AI` が `A_I` になる | `segmenter.ts` に STT 後処理と用語正規化がない | glossary-aware pre-clean + LLM editorial を導入 |
| `.` が混入する | punctuation cleanup 工程がない | deterministic cleanup + LLM punctuation edit を追加 |
| 長い字幕が溢れる | `segmenter.ts` が line length / line count を持たない | layout policy と auto line break を追加 |
| 発話と字幕 timing がズレる | item-level remap のみで、word-aware raw IR と final-audio realign adapter がない | clip/item 改善 -> word-aware raw IR -> word-level remap -> final-audio fallback の順で入れる |
| LLM editorial 工程がない | `/caption` は raw segmentation をそのまま approval 化する | source artifact と screen-ready draft を分離する |
| approval provenance が壊れやすい | machine-generated draft と human approval artifact の境界がない | `caption_draft.json` と `caption_approval.json` を分離する |
| `/caption` の test seam が粗い | file IO, editorial, timing, approval, artifact write が command に密結合している | pure step + adapter へ分解する |
| QA が緩い | `packaging/qa.ts` は hard-coded `10.0 CPS / 4.5 WPS` と transcript ref 確認のみ | policy-driven density + layout + timing confidence QA に置き換える |

### 5.2 ナラティブ設計の根因

| 問題 | 現状根因 | 設計対応 |
| --- | --- | --- |
| `/blueprint` が 1 回で終わる | `runtime/commands/blueprint.ts` は agent 1 回実行のみ | 4 フェーズ orchestrator と reject loop を導入 |
| 4 フェーズが未統合 | `runtime/script/*` は helper のみで command path に未接続 | `/blueprint` 内部 workflow に統合 |
| 素材精読が浅い | `read.ts` は role/confidence/semantic_rank 寄りで editorial 意味理解が薄い | transcript + VLM + brief を使う LLM review を追加 |
| collaborative confirmation が抜ける | accepted draft の後に human confirmation phase がない | `confirm` subphase と `pacing.confirmed_preferences` 契約を戻す |
| continuity review がない | `evaluate.ts` は continuity を見ない | `narrative-continuity-review` 相当を deterministic gate に統合 |
| 品質評価が弱い | `evaluate.ts` は一部 warning を fatal 化しない | deterministic gate を維持したまま advisory quality summary を追加する |
| reject -> 修正 loop がない | evaluate 結果を draft に戻さない | revision brief を生成して最大 3 回再draft |

## 6. 目標アーキテクチャ

### 6.1 字幕

1. transcript と timeline から deterministic raw caption を作る
2. layout-aware segmentation と deterministic cleanup で source artifact を整える
3. `caption_source.raw.json` と `caption_source.json` に provenance と remap hint を保持する
4. LLM editorial で orthography / punctuation / linebreak / proper noun normalization を行う
5. deterministic validator と timing aligner で frozen draft text を検証・整列する
6. `caption_draft.json` を machine-generated screen-ready draft として確定する
7. operator approval を経て、同一 text を `caption_approval.json` に投影する
8. compiler が `caption_approval.json` を `timeline.json` へ投影する

### 6.2 ナラティブ

1. `/blueprint` が brief と selects を読む
2. `frame` で message frame と quality target を仮固定する
3. `read` で素材を editorial 観点で深く再スコアする
4. `draft` で非時系列も含む beat 配置草案を作る
5. `evaluate` で deterministic gate と advisory quality summary を出す
6. 不合格なら revision brief を持って `draft` に戻る
7. 合格時、`autonomy=collaborative` なら `confirm` で pacing / structure / duration を人間確認する
8. confirmed または skipped のときだけ `edit_blueprint.yaml` と `uncertainty_register.yaml` を promote する

## 7. 字幕品質改善設計

### 7.1 Artifact 設計

approval provenance を壊さないため、caption artifact を source / draft / approval に分ける。

- `07_package/caption_source.raw.json`
  - deterministic segmentation 直後の raw draft
  - source text, transcript refs, raw timing, `source_word_refs`, `word_timing_mode` を保持
- `07_package/caption_source.json`
  - deterministic cleanup と layout-safe normalization 後の source generation artifact
  - screen-ready ではなく、editorial 前の canonical source として扱う
- `07_package/caption_draft.json`
  - machine-generated な screen-ready subtitle draft
  - editorial metadata, timing metadata, draft readiness status を保持
- `07_package/caption_editorial_report.json`
  - LLM edit result, retry 回数, reject 理由, glossary hit を保持
- `07_package/caption_timing_report.json`
  - `timing_source`, `timing_confidence`, fallback 発火理由を保持

`07_package/caption_approval.json` は `caption_draft.json` の human-approved projection とし、machine は直接書かない。

### 7.2 `SpeechCaption` の additive 拡張

`speech_captions[]` に optional metadata を追加する。

- `editorial`
  - `source_text`
  - `operations`
    - `orthography`
    - `punctuation`
    - `linebreak`
    - `filler_removal`
    - `proper_noun_normalization`
  - `glossary_hits`
  - `confidence`
  - `status`
    - `clean`
    - `edited`
    - `degraded`
- `timing`
  - `source`
    - `clip_item_remap`
    - `word_remap`
    - `final_audio_realign`
  - `confidence`
  - `triggered_fallback`
  - `source_word_refs`

この metadata は `caption_draft.json` と `caption_approval.json` の両方で保持し、approved 後の provenance を失わないようにする。`caption_source.json` には editorial 前 provenance に必要な subset だけを保持する。

### 7.3 LLM 字幕 editorial

#### 7.3.1 役割

LLM editorial は timing を変えず、text を screen-ready に整える責務を持つ。

- orthography correction
- punctuation cleanup
- filler cleanup
- linebreak optimization
- proper noun normalization
- mild compression
  - `polished` / `editorial` mode のみ
  - `verbatim` では禁止

#### 7.3.2 入力

- `caption_source.json`
- `creative_brief.yaml`
  - `captions.fidelity` があれば従う
  - `must_include`, `objective`, `desired_emotion` を用語保護に使う
- transcript source text
- optional glossary

glossary は以下から構築する。

- brief の `must_include`
- project / product / brand 名
- transcript 上のカタカナ連続語・大文字語
- operator が承認時に直した固有名詞

#### 7.3.3 出力

LLM は caption 単位の edit proposal を返す。

- `decision`
  - `confirm`
  - `override`
- `edits[]`
  - target caption id
  - edited text
  - operations
- `style_notes`
- `confidence`

#### 7.3.4 Guardrail

旧 `caption_editorial_llm.py` の must-keep token 検証を踏襲しつつ、V2 では以下を追加する。

- glossary に載る固有名詞は完全一致で保存する
- 数字、日付、URL、否定語は保存する
- 2 行超過は禁止
- 1 行長超過は禁止
- fidelity=`verbatim` では意訳禁止
- split / merge による timing change 禁止

#### 7.3.5 Deterministic pre-clean

LLM の前に以下を deterministic に処理し、その結果を `caption_source.json` に固定する。

- `_` や空白で分断された英大文字列の再結合
  - `A_I -> AI`
  - `C_E_O -> CEO`
- 単独で浮いた `.` `。` `、` の削除
- duplicate punctuation の正規化
- filler-only caption の除去

これにより、LLM は「補正すべき obvious noise」の後始末に時間を使わず、文脈判断に集中できる。

#### 7.3.6 失敗時挙動

- LLM timeout / schema invalid / validation fail の場合
  - raw text を維持したまま `editorial.status=degraded`
  - `caption_editorial_report.json` に理由を残す
  - `/caption` は継続するが、draft review UI と QA に degraded を見せる

### 7.4 最終映像ベース再文字起こしの設計選択

#### 7.4.1 選択肢比較

| 選択肢 | 長所 | 短所 | 判定 |
| --- | --- | --- | --- |
| A. 1 パス維持 + remap 精度向上 | 最も安い。render 追加なし。既存方針に近い | clip-level item remap だけでは crossfade, trim, resync, mixed audio に弱い | 単独では不十分 |
| B. 字幕のみ 2 パス | final audio に最も合う。映像完成系に対して timing を取れる | STT コスト増。待ち時間増。text authority を誤ると固有名詞が再崩壊する | fallback として有効 |
| C. word-level timestamps で精密 remap | 1 パス維持のまま大きく精度向上。既存 transcript schema に素直 | word timing が欠ける素材では使えない。clip boundary 近傍の処理が必要 | 主戦略に最適 |

#### 7.4.2 推奨

推奨は `C を第一優先`, `A を基礎改善`, `B を低信頼時 fallback` とする hybrid である。

理由:

- V2 の transcript schema は既に `words[]` と `word_timing_mode` を持つ
- STT connector も word timing を生成できる
- したがって、最も費用対効果が高いのは word-level remap を runtime で使い切ること
- ただし現 runtime はまだ utterance-level 寄りなので、word-aware raw IR を先に固定する必要がある
- ただし、word timing が欠ける素材や final mix 上で drift が残るケースは必ず出るため、字幕専用 2 パスを消してはいけない

#### 7.4.3 推奨フロー

1. baseline として clip/item remap を改善する
   - clip 境界 clamping
   - crossfade / pad / trim を含む timeline offset の厳密化
2. `caption_source.raw.json` に `source_word_refs` を通し、word-aware raw IR を固定する
3. `word_timing_mode in {word, char}` のときは word-level remap を使う
4. caption ごとに `timing_confidence` を出す
5. 以下のどれかを満たしたときのみ `final_audio_realign` を発火する
   - word timing がない
   - caption の多くが clip boundary で切れている
   - `caption_alignment_valid` または新設 timing QA に落ちる
   - operator が high-precision mode を要求する

#### 7.4.4 2 パス fallback のルール

2 パス fallback は「text を再決定する工程」ではなく、「frozen draft text に timing を付け直す工程」とする。

- authority は `caption_draft.json` に固定された editorialized text が持つ
- 2 パス目は final audio への realignment を担当する
- re-transcribe は alignment hint として使ってよいが、その text を canonical にしない

これにより、proper noun や editorial copy が 2 パス目で再崩壊する事故を防ぐ。

#### 7.4.5 `final_audio_realign` adapter 契約

`final_audio_realign` は `/caption` の内部実装詳細ではなく、明示的な timing adapter として定義する。

- 入力
  - frozen `caption_draft.json`
  - final audio asset 参照
  - per-caption 初期 timing hint
  - `source_word_refs`
  - language / fps / requested precision mode
- 出力
  - per-caption aligned timing
  - `timing_confidence`
  - `alignment_source=final_audio_realign`
  - diagnostics
- failure status
  - `dependency_unavailable`
  - `unsupported_language`
  - `insufficient_audio`
  - `low_confidence`
  - `internal_error`
- 依存性
  - text-constrained alignment または forced alignment backend を前提にする
  - CPU を baseline とし、GPU は optional acceleration として扱う
- mock shape
  - caption id ごとの固定 offset / confidence / failure status を返せること

### 7.5 文字数制限と自動改行

#### 7.5.1 Policy

| 言語 | 1 行上限 | 最大行数 | CPS 上限 |
| --- | --- | --- | --- |
| 日本語 | 20 文字 | 2 行 | 6.0 |
| 英語 | 42 文字 | 2 行 | 15.0 |

ここでの CPS は caption policy に従う display-speed 指標であり、packaging QA でも同じ閾値を使う。

#### 7.5.2 Auto line break

改行は以下の優先順で決める。

1. punctuation 直後
2. 語句境界
3. midpoint 近傍で最もバランスが良い位置
4. 行頭助詞 / orphan function word を作らない位置
5. それでも収まらない場合は caption split を再計算

日本語では次を禁止する。

- 行頭助詞
- dangling opener で始まる 2 行目
- 句読点だけの行

英語では次を禁止する。

- `a`, `an`, `the`, `to`, `of`, `and` などの孤立行頭
- closing punctuation だけが次行に落ちること

#### 7.5.3 Verbatim 例外

`verbatim` で text が長すぎる場合の優先順は以下とする。

1. dwell を延ばす
2. split できるなら split する
3. それでも無理なら `layout_violation` として operator に見せる

verbatim では意味圧縮しない。

### 7.6 QA / 受け入れ条件

既存 `caption_density_valid` と `caption_alignment_valid` を以下へ拡張する。

- `caption_density_valid`
  - hard-coded ではなく policy-driven threshold を読む
- `caption_layout_valid`
  - max lines, max chars per line, orphan rule, empty line を検証
- `caption_timing_confidence_valid`
  - `timing_confidence` の下限と fallback 発火率を検証
- `caption_alignment_valid`
  - transcript-backed caption の item refs / word refs / timing_source を検証

最低受け入れ条件:

- policy 上限超過ゼロ
- overlap ゼロ
- draft-ready 対象では degraded caption 0 件
- fallback 発火時に `timing.source=final_audio_realign` が正しく記録される

#### 7.6.1 Draft readiness gate

`/caption` は常に `caption_source.json` と `caption_draft.json` まで生成する。以下を満たすときだけ `caption_draft.json` を `ready_for_human_approval` とみなす。

- degraded caption が 0 件
- `timing_confidence >= 0.75` を全 caption が満たす
- layout / density / alignment QA が全通過

いずれかを満たさない場合:

- `caption_draft.json` は `needs_operator_fix` として残す
- `caption_approval.json` は生成しない
- operator が確認・必要なら修正した後に承認する

#### 7.6.2 Human approval gate

- `caption_approval.json` は human approval が入ったときだけ生成する
- auto mode でも `draft -> approval` の 2 ステップを維持する
- operator が text を変えた場合は timing diagnostics を再計算してから approval へ進む

## 8. ナラティブ設計改善

### 8.1 `/blueprint` の新 workflow

`/blueprint` は単発 agent call ではなく、以下の orchestrated workflow になる。

1. `frame`
   - user intent -> message frame
2. `read`
   - transcript + VLM + candidate metadata -> material reading
3. `draft`
   - frame + scored materials -> narrative draft
4. `evaluate`
   - deterministic metrics + continuity review + advisory quality summary
5. `reject?`
   - 不合格なら revision brief を生成し `draft` に戻る
6. `confirm`
   - `autonomy=collaborative` のときだけ pacing / structure / duration を人間確認する
7. `promote`
   - accepted かつ confirmed または skipped のときだけ `edit_blueprint.yaml` / `uncertainty_register.yaml` を確定

最大反復回数は 3 回とする。

### 8.2 Phase A: frame

責務:

- story promise
- hook angle
- closing intent
- beat count / role sequence
- target duration window
- quality targets
- narrative guardrails

改善点:

- 旧 `narrative-design.md` の「素材全体に対して 1 本の coherent な物語線を作る」をここで明文化する
- current `frame.ts` は deterministic resolution が中心なので、LLM で message framing を入れ、profile/policy resolution は引き続き deterministic にする
- signal 不足時は default profile に silent fallback せず、`uncertainty_register` の `blocker` 候補に接続する

### 8.3 Phase B: read

`read.ts` は現在、role match と confidence に寄りすぎている。ここを旧 `material-reading-review` 以上にする。

#### 8.3.1 新しい評価軸

各 candidate を beat ごとに次で評価する。

- `message_fit`
  - この発話が primary message をどれだけ前進させるか
- `standalone_comprehension`
  - 単独で見て意味が立つか
- `emotion_yield`
  - desired emotion に効くか
- `continuity_affordance`
  - 前後 beat とつなげやすいか
- `novelty_contribution`
  - 既出 beat と重複しないか
- `evidence_strength`
  - claim を支える具体性があるか
- `risk_flags`
  - fragment opener
  - unresolved pronoun
  - interviewer contamination
  - asset concentration
  - tone mismatch

#### 8.3.2 実行方式

1. deterministic pre-bucket
   - role, beat eligibility, confidence, dedupe で top-K を作る
2. LLM material reading review
   - transcript excerpt
   - VLM summary / tags
   - editorial signals
   - message frame
   を読ませ、top / backup を editorial 観点で並べ替える
3. deterministic validator
   - candidate_ref 存在確認
   - duplicate primary 抑止
   - asset concentration threshold

#### 8.3.3 Artifact 拡張

`material_reading.yaml` に optional field を追加する。

- top / backup candidate の score breakdown
- evidence quotes
- fragment opener risk
- standalone score
- continuity risk
- message contribution note

これにより、「単なるキーワード一致ではなく、なぜこの発話がこの beat に効くのか」を audit できる。

### 8.4 Phase C: draft

責務:

- beat 配置
- non-chronological reveal order
- primary / backup candidate assignment
- transition hypothesis
- revision-aware rationale

改善点:

- 旧 `build-edit-plan` の「冒頭 clip は価値を稼ぐ」「弱い hook は禁止」を gate に反映する
- hook を時系列先頭に固定しない
- `story_role` と `delivery_order` を分離し、`experience` を hook に先出しできるようにする
- `draft` は evaluate の修正指示を受け取り再生成できるようにする

`script_draft.yaml` には optional で以下を持たせる。

- `revision_brief`
- `preserve`
- `must_fix`
- `draft_summary`

### 8.5 Phase D: evaluate

evaluate は M4.5 の deterministic contract を維持したまま、次の 3 層を出力する。

1. deterministic gate metrics
   - `hook_density`
   - `novelty_rate`
   - `duration_pacing`
   - `emotion_gradient`
   - `causal_connectivity`
2. deterministic continuity diagnostics
   - beat 間接続
   - dangling opener
   - pronoun float
   - keyword repetition
   - closing beat quality
3. advisory quality summary
   - `claim_support`
   - `source_fidelity`
   - `narrative_coherence`
   - `audience_alignment`
   - `duration_pacing`

`quality-judgment` は reject oracle ではなく、accepted draft の説明責務と人間確認 / `/review` への橋渡しに使う。

#### 8.5.1 Gate ルール

以下のいずれかで reject とする。

- missing beat がある
- hook_density が target 未達
- novelty_rate が target 未達
- hard dedupe violation が primary beat に残る
- continuity diagnostics に fatal issue がある
- closing beat が未完結
- `interview` policy なのに interviewer contamination が protected beat に残る

advisory のまま通してよいもの:

- `source_fidelity`
- `audience_alignment`
- `narrative_coherence`
- 軽微な asset concentration
- 代替案が複数あり message を壊さない差分

#### 8.5.2 Reject loop

reject 時は `evaluate` が `revision_brief` を返す。

- 何を保持するか
- 何を直すか
- どの beat が壊れているか
- どの backup candidate を優先すべきか
- blocker なら何が足りないか

`draft` はこれを入力に再実行される。

#### 8.5.3 Collaborative confirmation

deterministic gate を通過したあと、`autonomy=collaborative` のときだけ `confirm` subphase を実行する。

- confirm 対象は pacing / structure / duration の readback
- `pacing.confirmed_preferences.mode` は autonomy mode と一致させる
- `pacing.confirmed_preferences.source` は `full` なら `ai_autonomous`, `collaborative` なら `human_confirmed` とする
- `script_evaluation.yaml` には `confirmation_status=skipped | confirmed | declined` を残す
- `human_declined` は `evaluate_reject` と別 status とし、`BlueprintAgentResult.confirmed=false` 相当の command contract を維持する

human が decline した場合:

- canonical artifact は promote しない
- `script_evaluation.yaml` に `decline_reason` を残す
- `/blueprint` command は confirmation failure として終了する

#### 8.5.4 3 回失敗時の処理

3 回失敗しても通らない場合:

- `script_evaluation.yaml` に最終 reject 理由を残す
- `uncertainty_register.yaml` に blocker を起票する
- `/blueprint` の state は `blocked`

これにより、「低品質だがとりあえず blueprint_ready」にしない。

### 8.6 Operational artifact の扱い

M4.5 の方針どおり、以下を operational artifact として保存する。

- `04_plan/message_frame.yaml`
- `04_plan/material_reading.yaml`
- `04_plan/script_draft.yaml`
- `04_plan/script_evaluation.yaml`

追加方針:

- 各ファイルは latest evaluated attempt を保持する
- `script_evaluation.yaml` に `loop_summary` を追加し、`evaluate_reject_count` と `human_decline_count` を分けて残す
- `script_evaluation.yaml` に gate 結果と advisory quality summary の両方を残す
- canonical への projection は `edit_blueprint.yaml` に集約する

### 8.7 `/blueprint` と role prompt の責務再定義

#### `blueprint-planner`

現在の 1 回生成型 prompt を、phase-aware orchestration 前提に変える。

- frame 時は message framing と editorial guardrail を返す
- draft 時は beat sheet を返す
- confirm 前には pacing / structure / duration の readback を返す
- final projection 時は accepted operational artifact から `edit_blueprint.yaml` を組み立てる
- blocker を silent に握り潰さず `uncertainty_register` へ出す

`/blueprint` command の実行順は以下に固定する。

1. brief / blockers / selects / STYLE.md を読む
2. `frame`
3. `read`
4. `draft`
5. `evaluate`
6. reject なら `draft -> evaluate` を最大 2 回追加
7. `autonomy=collaborative` なら `confirm`
8. decline なら promote せず終了する
9. accepted かつ confirmed または skipped の draft を `edit_blueprint.yaml` に投影
10. blocker 有無で `blueprint_ready` / `blocked` を決める

#### `roughcut-critic`

`/review` は roughcut 段階の reviewer として残す。ただし blueprint 改善に合わせて、次を必ず読む。

- `edit_blueprint.yaml.story_arc`
- `edit_blueprint.yaml.quality_targets`
- `edit_blueprint.yaml.rejection_rules`

これにより、blueprint の narrative contract と review の評価軸を揃える。

## 9. 依存関係と実装順序

### Phase 1: Contract fix と schema split

内容:

- `caption_source.json / caption_draft.json / caption_approval.json` の役割固定
- `caption_approval.json` human-only semantics の固定
- `/blueprint` confirm contract と `pacing.confirmed_preferences` 契約の固定
- operational artifact schema additive field 定義

達成条件:

- 旧 fixture が新 schema でも fail-open で通る
- human-only / machine-generated の境界が artifact 名だけで判別できる

### Phase 2: Injection seam 抽出

内容:

- `/blueprint` の phase interface を分離する
- `/caption` を `editorialJudge`, `timingAligner`, `draftReadinessGate`, `artifactWriter` に分ける
- mock で fail / retry / decline / fallback を局所再現できる seam を作る

達成条件:

- phase ごとの unit test が command 全体を起動せずに書ける
- failure 原因を phase 単位で特定できる

### Phase 3: ナラティブ deterministic loop 統合

内容:

- `/blueprint` に 4 フェーズ統合
- evaluate -> draft の reject loop
- advisory quality summary と collaborative confirm の追加
- blocker 化と state transition

達成条件:

- `/blueprint` が operational artifact を生成する
- 1 回 reject 後の再draft が再現できる
- collaborative confirm success / decline を分岐できる
- 3 回失敗で `blocked` に落ちる

### Phase 4: 字幕 source / draft / validator 導入

内容:

- `caption_source.raw.json` 生成
- `caption_source.json` 生成
- `caption_draft.json` 生成
- glossary-aware cleanup
- layout validator
- draft readiness gate
- human-only approval projection

達成条件:

- `AI` / stray punctuation / line overflow fixture が通る
- `caption_approval.json` を machine が生成しない
- operator review なしでは approval へ進まない

### Phase 5: 字幕 editorial LLM 追加

内容:

- caption editorial prompt
- must-keep token guard
- editorial report
- degraded 継続

達成条件:

- proper noun normalization fixture が通る
- LLM failure 時も degraded として継続できる

### Phase 6: timing precision

内容:

- clip/item remap 改善
- word-aware raw IR plumbing
- word-level remap
- timing confidence
- final-audio realign fallback

達成条件:

- word timing fixture で drift が既存より改善する
- word timing なし fixture で fallback が正しく発火する

### Phase 7: QA / review / rollout

内容:

- caption QA 拡張
- `/review` との評価軸整合
- metrics / logging / feature flag

達成条件:

- packaging QA が新 policy を読む
- review prompt が blueprint quality target を参照する

### 並行可能性

- Phase 3 と Phase 4 は、Phase 2 の後なら並行可能
- Phase 5 は Phase 4 に依存
- Phase 6 は Phase 4-5 の後段
- Phase 7 は Phase 3-6 の後段

つまり、字幕とナラティブは shared contract を決めた後はほぼ並列で進められる。

## 10. テスト戦略と受け入れ条件

### 10.1 字幕

- unit
  - proper noun normalization
  - punctuation cleanup
  - line break placement
  - CPS calculation
  - timing confidence
  - draft readiness gate
- integration
  - `/caption` draft generation without approval projection
  - human approval projection from `caption_draft.json`
  - `/caption` with word timings
  - `/caption` without word timings
  - editorial LLM mock retry / failure
  - final-audio fallback trigger
- golden
  - 実素材由来 fixture で `A_I`, stray `.`, overflow, timing drift を再現

### 10.2 ナラティブ

- unit
  - frame validation
  - material reading score validation
  - continuity fatal detection
  - deterministic gate / advisory split
  - confirmation status contract
- integration
  - `/blueprint` single-pass success
  - `/blueprint` collaborative confirm -> success
  - `/blueprint` collaborative confirm -> decline -> no promote
  - `/blueprint` reject -> redraft -> success
  - `/blueprint` reject x3 -> blocked
- golden
  - fragment opener
  - pronoun float
  - closing unresolved
  - duplicate primary
  - interviewer contamination

### 10.3 受け入れ条件

- 既存 state machine を壊さない
- 旧 fixture と新 fixture の両方が通る
- mock LLM だけで deterministic CI が回る
- `caption_approval.json` が human-approved artifact として監査可能である
- `evaluate_reject` と `human_declined` が別経路で観測できる
- 実素材テストで列挙された 10 問題に対応する確認項目がすべてある

## 11. 非機能要件

### 11.1 信頼性

- 字幕 editorial failure で command 全体を落とさない
- ナラティブ quality failure は fail-closed にする
- human decline では promote しない
- すべての LLM 結果は deterministic validator を通す

### 11.2 運用性

- fallback 発火率
- degraded caption 率
- final_audio aligner failure 率
- blueprint の平均 iteration 回数
- blueprint の human decline 率
- blocker 理由分布

を記録し、実素材テストの改善サイクルに使う。

運用アラートの初期値:

- `caption.final_audio_realign_rate > 20%`
- `caption.final_audio_realign_failure_rate > 0%`
- `caption.degraded_rate > 0%`
- `blueprint.iteration_p95 > 2`
- `blueprint.human_decline_rate` が連続 3 fixture で上昇
- `blueprint.blocked_rate` が連続 3 fixture で上昇

### 11.3 保守性

- LLM prompt を phase ごとに分離する
- deterministic policy と LLM judgment を混ぜすぎない
- canonical artifact に思考過程を押し込まない

## 12. リスク・代替案・ロールバック

### 主なリスク

- LLM が過剰に言い換える
  - must-keep token と fidelity guard で抑える
- 2 パス fallback が text authority を奪う
  - timing only の fallback に限定する
- operational artifact schema の肥大化
  - canonical には投影しない情報だけを追加する

### ロールバック方針

- narrative loop は feature flag で旧 single-pass `/blueprint` に戻せるようにする
- caption editorial は feature flag で deterministic raw caption only に戻せるようにする
- timing mode は `word_remap -> clip_item_remap` に即時 downgrade できるようにする

## 13. 最終提案

本件の中核判断は次の 3 点である。

1. 字幕 timing は `word-level remap` を主戦略にし、`final-audio 2 パス` は fallback にする
2. 字幕品質は `raw segmentation -> deterministic cleanup -> LLM editorial -> validator` の 4 層構成にし、machine draft と human approval を分離する
3. ナラティブは `/blueprint` の内部に `frame/read/draft/evaluate/confirm` を統合し、quality 未達時は reject、human decline 時は promote せず止める

これにより、V2 は旧 repo の知見を単に移植するのではなく、以下を満たす。

- 字幕は旧 repo より provenance と fallback が明確
- ナラティブは旧 repo より loop と blocker 制御が強い
- 新規 canonical は `caption_draft.json` 1 つに限定し、approval semantics を壊さず runtime と CI に載せられる
