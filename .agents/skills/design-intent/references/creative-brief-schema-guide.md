# Creative Brief Schema ガイド

creative_brief.yaml の各フィールドの意味と、ユーザーの回答からどう埋めるかの対応表。

## 必須フィールド

| フィールド | 型 | ユーザーへの質問 | 記入例 |
|-----------|-----|----------------|--------|
| `project.title` | string | 「このプロジェクトに名前を付けるなら？」 | `子ども 自転車成長記録` |
| `project.strategy` | string | 「何のための映像？」 | `家族の記念映像として残す` |
| `project.runtime_target_sec` | number | 「何秒くらいのイメージ？」 | `90` |
| `message.primary` | string | 「一言で言うとこの映像で何を伝えたい？」 | `息子が自転車に乗れるようになるまでの成長` |
| `audience.primary` | string | 「誰に見せる？」 | `家族・親戚` |
| `emotion_curve` | string[] | 「感情のカーブは？」 | `["期待", "努力", "達成感"]` |
| `must_have` | string[] | 「絶対入れたいシーンは？」 | `["初めて補助輪なしで走れた瞬間"]` |
| `must_avoid` | string[] | 「避けたいことは？」 | `["転んで泣いているシーン"]` |
| `autonomy.mode` | "full" \| "collaborative" | 「任せてよい？確認したい？」 | `full` |
| `autonomy.may_decide` | string[] | 「任せてよい判断は？」 | `["クリップ選定", "BGMタイミング"]` |
| `autonomy.must_ask` | string[] | 「確認してほしい判断は？」 | `["特定シーンの使用"]` |

## オプションフィールド

| フィールド | 用途 |
|-----------|------|
| `project.format` | `keepsake`, `testimonial`, `commercial`, `social` |
| `project.duration_mode` | `strict` (CM/SNS) or `guide` (記念映像) — profile から自動推定 |
| `message.secondary` | サブメッセージ |
| `audience.excluded` | 見せたくない人 |
| `editorial.aspect_ratio` | `16:9`, `9:16`, `1:1`, `4:5` |
| `content_hint` | VLM に渡す文脈情報 |
| `hypotheses` | 確信がない仮説 |
| `forbidden_interpretations` | 誤解されたくない解釈 |
| `resolved_assumptions` | 確認済みの前提 |

## profile → duration_mode 自動推定

| profile | duration_mode | 理由 |
|---------|--------------|------|
| keepsake | guide | 素材品質優先、尺は目安 |
| testimonial | guide | 発話内容優先 |
| commercial | strict | 秒数厳守 |
| social | strict | プラットフォーム制限 |
| event-recap | guide | 網羅性優先 |
