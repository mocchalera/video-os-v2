# Content Hint ガイド

`--content-hint` は VLM に「この素材をどういう文脈で読むべきか」を与えるための自由文です。`runtime/connectors/gemini-vlm.ts` では prompt にそのまま埋め込まれ、segment enrichment と peak detection の両方に効きます。

## 良い `content-hint` の書き方

良い例:

- `子供の自転車練習の成長記録（2024-2026）。公園で補助ありの初期練習から安定走行までの過程`
- `卒園式の記念映像。園児30名の合唱、証書授与、保護者との記念撮影`
- `新製品デモ撮影。担当者が卓上で製品を手に取り、操作方法を説明している`

悪い例:

- `家族の動画`
- `卒園式`
- `イベント映像`

原則:

- 具体的に書く。誰が、何をしているか、どんな場面かを含める
- 文脈を書く。記録映像なのか、式典なのか、練習過程なのかを入れる
- 時系列や期間が重要なら入れる
- VLM に見せたい「映像上の事実」を書き、編集方針だけを書かない
- 長すぎる散文にはしないが、単語 1-2 個で済ませない

## `content-hint` が VLM に与える影響

### 1. `display_name` の品質

`runtime/pipeline/display-name.ts` は VLM の `summary` と `tags` から `display_name` を作ります。VLM の summary が generic だと、`a_person_is`、`a_child_is`、`clip` のような弱い名前に落ちます。

改善例:

- hint なしに近い状態:
  `a person is riding`
- hint あり:
  `first_wobbly_ride`
  `assisted_riding`
  `bicycle_practice`

### 2. `tags` の精度

実装上の field 名は `visual_tags` ではなく `segments.json.items[].tags` です。`content-hint` があると、汎用タグより目的に沿ったタグが出やすくなります。

改善例:

- 弱い認識:
  `toy`
  `outdoor_scene`
  `person`
- 文脈あり:
  `bicycle_practice`
  `assisted_riding`
  `child_development`

### 3. `peak_analysis` の文脈理解

peak detector では coarse pass に `Content: ...` として hint が渡されます。これにより、「何を payoff とみなすか」が変わります。

例:

- hint なし:
  動きが大きい場面だけを `action_peak` として拾いがち
- hint あり:
  `初めて安定して走れた瞬間`
  `証書授与の受け取り`
  `製品の機能がはっきり見える手元`

## `content-hint` の情報源

優先順位:

1. ユーザーの説明
2. `01_intent/creative_brief.yaml` の `content_hint`
3. `01_intent/creative_brief.yaml` の `message.primary`
4. `must_have`、`project.title` など brief の補助情報
5. フォルダ名やファイル名のパターン
6. 撮影日時や季節性からの弱い推定

## Agent の抽出手順

### 1. まず brief を見る

- `content_hint` が埋まっていればそれを優先する
- 無ければ `message.primary` をベースに、`must_have` の具体 scene を 1 つ足す

### 2. brief が薄いときは素材側の手掛かりを使う

- フォルダ名:
  `graduation_2026`, `bicycle_practice`, `product_demo`
- ファイル名:
  `IMG_7345.MOV` 自体は弱いが、親フォルダ名と組み合わせると補助になる
- 撮影日:
  季節や年跨ぎの成長記録なら hint に入れる価値がある

### 3. 1-3 文に再構成する

テンプレート:

`<誰/何> の <場面/イベント>。<重要な行為や文脈>。<必要なら期間・人数・場所の性質>`

例:

`卒園式の記念映像。園児30名の合唱と証書授与、最後の集合写真。ホール内での式典進行。`

## 避けるべき書き方

- 抽象語だけ:
  `思い出動画`
- 編集意図だけ:
  `感動的に見せたい`
- 未確認の断定:
  `初優勝の瞬間` だと裏取りが無ければ危険
- 情報の詰め込みすぎ:
  長すぎて主語と場面がぼやける文章

## 再実行の判断

次の兆候が出たら、`content-hint` を改善して analyze をやり直す価値が高いです。

- `assets.json` の `display_name` が `a_person_is` / `a_child_is` / `clip` 系に偏る
- `segments.json` の `tags` が汎用語ばかりで、素材の主題語が出ない
- `peak_analysis` が weak な `visual_peak` に寄り、見せたい出来事を外す
