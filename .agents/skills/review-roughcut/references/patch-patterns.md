# Patch Patterns

`review_patch.json` は re-edit の夢想を書く場所ではない。`runtime/compiler/patch.ts` で適用できる、
局所的で deterministic な op だけを出す。

## 0. 基本原則

- 1 op = 1 つの具体的修正
- 必ず `timeline_version` を入れる
- 各 op に `reason` を入れる
- 可能なら `confidence` と `evidence` を入れる
- safe に落ちない改善案は patch ではなく `review_report.yaml` に残す
- patch は常に作るが、safe op がなければ `operations: []` にする

## 1. 弱い hook を強い候補に差し替える

使う op:

- `replace_segment`

使ってよい条件:

- `target_clip_id` が明確
- 置換先 `with_segment_id` が `fallback_segment_ids` にある
- または `human_notes.yaml` の `approved_segment_ids` にある

例:

```json
{
  "op": "replace_segment",
  "target_clip_id": "CLP_0003",
  "with_segment_id": "SEG_0014",
  "reason": "Opening promise is weak; use the stronger action beat for the hook",
  "confidence": 0.82,
  "evidence": ["review_report weakness: current hook lacks immediate story promise"]
}
```

やってはいけないこと:

- fallback / human approval のない segment を勝手に指定する
- 何を改善する差し替えかが `reason` に書かれていない

## 2. 長すぎる / 短すぎるクリップを詰める

使う op:

- `trim_segment`

使ってよい条件:

- 問題が source in/out の調整で解決する
- target clip が一意

例:

```json
{
  "op": "trim_segment",
  "target_clip_id": "CLP_0001",
  "new_src_in_us": 2000000,
  "new_src_out_us": 5500000,
  "reason": "Reduce dead air in the hook and tighten the opening cadence",
  "confidence": 0.85,
  "evidence": ["review_report weakness: hook holds too long before payoff"]
}
```

補足:

- source window は clip の意図を壊さない範囲で動かす
- 尺問題が timeline 上の位置変更も伴うなら `move_segment` を検討する

## 3. 順序やテンポを改善する

使う op:

- `move_segment`

使ってよい条件:

- 既存 clip の順番や timeline 上の位置を変えるだけで改善する
- new frame が明確
- 必要なら `new_duration_frames` も指定する

例:

```json
{
  "op": "move_segment",
  "target_clip_id": "CLP_0007",
  "new_timeline_in_frame": 312,
  "reason": "Move reaction shot later so the build reaches the peak before release",
  "confidence": 0.74,
  "evidence": ["review_report weakness: emotional peak arrives too early"]
}
```

やってはいけないこと:

- 複数 beat の再設計が必要なのに、無理やり 1 op で済ませたことにする
- target clip を特定せずに「順序を入れ替える」とだけ書く

## 4. 冗長な箇所を削る

使う op:

- `remove_segment`

使ってよい条件:

- clip を消すだけで改善する
- 削除後の beat purpose がまだ成立する

例:

```json
{
  "op": "remove_segment",
  "target_clip_id": "CLP_0011",
  "reason": "This repeat shot restates information and flattens the middle section",
  "confidence": 0.8,
  "evidence": ["review_report weakness: midsection repeats the same visual idea"]
}
```

## 5. 音まわりの局所修正を出す

使う op:

- `change_audio_policy`
- `add_marker`
- `add_note`

使い分け:

- clip 単位で ducking / nat sound / fade を調整するなら `change_audio_policy`
- 人間に確認してほしい地点を残すなら `add_marker`
- 明示的な作業メモだけを残すなら `add_note`

例:

```json
{
  "op": "add_marker",
  "new_timeline_in_frame": 312,
  "reason": "Audio QA needed: wind may compete with dialogue at beat b03 entry",
  "confidence": 0.9,
  "evidence": ["review_report warning: slight_wind quality flag"]
}
```

## 6. 追加クリップを差し込む

使う op:

- `insert_segment`

使ってよい条件:

- `human_notes.yaml` に `directive_type: insert_segment` がある
- machine-readable anchor がある
- `with_segment_id` が approved されている
- `new_timeline_in_frame` または anchor clip が deterministic

insert は最も危険な op のひとつ。human note anchor がないなら出さない。

## 7. Patch を空にすべきケース

`operations: []` にする代表例:

- 問題は事実だが、safe op では直せない
- 差し替え候補が複数あり、fallback / human approval がない
- 問題が blueprint レベルで、beat の再設計が必要
- `FATAL` で compile / blueprint revisit を促すべき

空 patch の例:

```json
{
  "timeline_version": "7",
  "operations": []
}
```

空 patch は失敗ではない。unsafe な patch を捏造しないための正常系である。
