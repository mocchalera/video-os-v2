# Review Rubric

`review-roughcut` は「なんとなく良い / 悪い」を書くのではなく、artifact に接続した根拠で
`review_report.yaml` を組み立てる。current repo の `05_timeline/review.mp4` は placeholder なので、
直接観測と timeline / QC からの推論を分けて書くこと。

## 0. Evidence Discipline

- direct evidence:
  `creative_brief.yaml`, `edit_blueprint.yaml`, `timeline.json`, `review-qc-summary.json`,
  `human_notes.yaml`, `STYLE.md`, transitions, markers, `quality_flags`, optional `07_package/qa-report.json`
- inferred evidence:
  clip の連なりから推定した感情カーブ、tempo、beat snap 効果、余韻
- `review.mp4` が placeholder の場合は、映像を見たかのような断定を書かない
- 重要な指摘には最低 1 つの artifact 根拠を付ける
- 可能なら `affected_beat_ids` と `affected_clip_ids` を付ける

## 1. 評価順序

1. brief mismatch
2. blueprint mismatch
3. technical deliverability
4. craft / style

craft の優先順位は Murch Rule of Six:

- `emotion > story > rhythm > eye_trace > plane_2d > space_3d`

## 2. 構成チェック（物語）

- 冒頭の hook は機能しているか
  - first beat / first few clips が `message.primary` と視聴約束を立てているか
  - `edit_blueprint.yaml` の opening beat purpose が timeline 冒頭で実現されているか
- 中盤のテンションは維持されているか
  - 同じ情報の反復で停滞していないか
  - beat ごとの役割が重複しすぎていないか
- 終盤の payoff は機能しているか
  - opening で立てた promise に closing が応答しているか
  - release / silence / afterglow が早すぎたり消失していないか
- ビート間の論理的つながりはあるか
  - 因果、対比、感情の受け渡しのどれかで接続されているか
  - 順序変更で改善するなら `needs_revision` 候補

構成系の目安:

- `FATAL`:
  `must_have` 欠落、`must_avoid` 違反、opening/closing の機能崩壊、message drift
- `needs_revision`:
  hook が弱い、中盤だれる、payoff が薄い、局所的な beat 並び替えで改善可能

## 3. 感情チェック

- `emotion_curve` に沿っているか
  - brief の感情変化と timeline の beat progression が一致しているか
- `build_to_peak` が機能しているか
  - middle から climax までの情報密度 / 尺 / cadence が上がっているか
  - blueprint や adjacency artifact があれば、peak までの積み上げを確認する
- `silence_beat` や余韻が効いているか
  - closing に呼吸があるか
  - climax の直後に余韻を壊す不要カットが入っていないか

感情系の目安:

- `FATAL`:
  brief と逆向きの感情を作っている、peak が成立していない、closing が感情を壊す
- `needs_revision`:
  peak が早すぎる / 遅すぎる、余韻が短い、感情の段差が不自然

## 4. リズムチェック

- 各クリップの尺は適切か
  - `timeline_duration_frames` を見て、beat role と比べて長すぎ / 短すぎを判断する
  - 同じ長さのクリップが続きすぎて平板になっていないか
- カット間のテンポは均一すぎないか
  - hook, setup, experience, closing で cadence が変化しているか
  - trim / move で改善できる局所問題かを切り分ける
- BGM とカットの同期は機能しているか
  - `transitions[].transition_params.beat_snapped` や `beat_ref_sec` があれば参照する
  - `adjacency_analysis.json` や transition skill evidence があれば補強に使う
  - artifact がない場合は「未検証」または「timeline 推論」として扱う

リズム系の目安:

- `FATAL`:
  story を読めないほどテンポが破綻している、duration fit が明確に崩壊している
- `needs_revision`:
  1-2 箇所の trim / move / remove で改善可能な pacing 問題

## 5. 技術チェック

- timeline schema が valid か
  - `review-qc-summary.json.schema_valid == true` を見る
- source range と timeline の整合が取れているか
  - `src_out_us > src_in_us`
  - 必要に応じて `(src_out_us - src_in_us)` と `timeline_duration_frames / (sequence.fps_num / sequence.fps_den)` を比較し、明らかな無理がないかを見る
- gap / overlap のリスクがないか
  - 同一 track 内で `timeline_in_frame` と `timeline_duration_frames` を追い、説明できない衝突や穴がないか確認する
  - 特に主系列の V1 / A1 は blocker 寄りに扱う
- `quality_flags` や `audio_policy` に未処理の危険がないか
  - 風ノイズ、露出、繰り返し quality issue の overexposure が続いていないか
- loudness は target 範囲内か
  - `07_package/qa-report.json` がある場合のみ `loudness_target_valid` を見る
  - `/review` preflight だけでは loudness は自動測定していないため、artifact がなければ未検証として扱う

技術系の目安:

- `FATAL`:
  主系列の blocker 級 overlap、明白な source range 破綻、package QA hard fail
- `needs_revision`:
  warning 級 quality issue、補助 track の timing suspicion、audio policy の局所改善

preflight / hard stop の扱い:

- `review-qc-summary.json.schema_valid == false` や compile failure は、本来 `/review` が command failure で止まる領域
- その場合は critic の prose FATAL を増やすより、preflight hard stop として扱う

## 6. 判定基準

- `PASS`
  - 技術チェックの blocker がない
  - 構成 / 感情 / リズムに重大な問題がない
  - `summary_judgment.status: approved`
- `needs_revision`
  - 技術は通るが、構成 / 感情 / リズム / 局所技術に改善余地がある
  - safe patch に落ちるなら `review_patch.json` を出す
  - `summary_judgment.status: needs_revision`
- `FATAL`
  - message / coherence / technical deliverability を壊す blocker が残る
  - unsafe patch で取り繕わず、必要なら compile / blueprint revisit を指示する
  - `summary_judgment.status: blocked`

## 7. 書き方ルール

- `strengths` は最低 1 つ書く。良い保持点がない review は次パスの指針になりにくい
- `weaknesses` は局所改善可能なものを中心に書く
- `fatal_issues` は blocker だけに絞る
- `warnings` は放置可能ではなく「承知した上で進める軽中度リスク」として使う
- `recommended_next_pass.actions` は patch と report が矛盾しないように書く
