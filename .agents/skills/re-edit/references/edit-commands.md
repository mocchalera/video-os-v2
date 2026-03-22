# Edit Commands

自然言語をそのまま patch にしない。まず `timeline.json` を見て、対象 clip と編集面を確定する。

## 基本ルール

- `timeline_version` には `timeline.json.version` を入れる
- `reorder` という op 名は使わない。順序変更は通常 `move_segment`
- `replace_clip` / `trim` / `remove` のような略称は使わず、schema の正式名を使う
- patch に落ちない指示は upstream artifact の修正に切り替える

## マッピング

### 「短くして」

基本:

- `trim_segment`

使いどころ:

- dead air を削る
- hook を詰める
- 1 クリップだけ少し短くしたい

例:

```json
{
  "op": "trim_segment",
  "target_clip_id": "CLP_0004",
  "new_src_out_us": 4200000,
  "reason": "Tighten the setup and remove dead air"
}
```

### 「この部分カットして」

基本:

- `remove_segment`

使いどころ:

- 冗長 shot を消す
- 同じ情報の繰り返しをなくす

例:

```json
{
  "op": "remove_segment",
  "target_clip_id": "CLP_0011",
  "reason": "Remove the repeated middle shot"
}
```

### 「このクリップと入れ替えて」

意味を分ける:

- 別候補に差し替える:
  `replace_segment`
- 既存クリップ同士の順番を変える:
  `move_segment`

`replace_segment` の条件:

- `with_segment_id` が `selects_candidates.yaml` に存在する
- 可能なら fallback / approved source に沿う

例:

```json
{
  "op": "replace_segment",
  "target_clip_id": "CLP_0002",
  "with_segment_id": "SEG_0014",
  "reason": "Use the stronger action beat for the opening"
}
```

### 「順番を変えて」

基本:

- `move_segment`

使いどころ:

- 既存 clip の timeline position を後ろへずらす
- 反応 shot を少し遅らせる

例:

```json
{
  "op": "move_segment",
  "target_clip_id": "CLP_0007",
  "new_timeline_in_frame": 312,
  "reason": "Delay the reaction shot so the peak lands later"
}
```

注意:

- beat の順番そのものを組み替えるなら `edit_blueprint.yaml` を直して full compile

### 「このシーンを追加して」

基本:

- `insert_segment`

使ってよい条件:

- 挿入する `with_segment_id` が明確
- 挿入位置が deterministic
- 必要なら human note anchor がある

例:

```json
{
  "op": "insert_segment",
  "with_segment_id": "SEG_0042",
  "new_timeline_in_frame": 540,
  "new_duration_frames": 24,
  "role": "support",
  "reason": "Add a short reaction insert before the payoff"
}
```

条件を満たさない場合:

- 先に `select-clips` で候補を増やす
- 必要なら `build-blueprint` で beat を更新する

### 「BGM を変えて」

重要:

- `change_audio_policy` は BGM asset 置換ではない

patch でできること:

- ducking を強める / 弱める
- natural sound を残す
- fade を調整する

本当に BGM 曲を差し替える場合:

- creative brief / package 入力を更新する
- 必要なら `render-video` をやり直す

局所 audio policy 調整の例:

```json
{
  "op": "change_audio_policy",
  "target_clip_id": "CLP_0005",
  "audio_policy": {
    "duck_music_db": -12,
    "preserve_nat_sound": true,
    "fade_in_frames": 12,
    "fade_out_frames": 12
  },
  "reason": "Lower music and preserve ambience under dialogue"
}
```

### 「テンポを上げて」

基本:

- 複数の `trim_segment`
- 必要に応じて `move_segment`

注意:

- 全クリップの duration を一律に縮める、のような雑な patch は作らない
- どの clip が間延びしているかを `timeline.json` から特定してから詰める
- 要求が全体構成レベルなら blueprint の target duration を見直す
