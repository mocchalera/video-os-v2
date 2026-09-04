---
name: finish-creator-short
description: Finish an existing Japanese creator, challenge, comeback, vlog, or community-building vertical social rough cut as an evidence-grounded short-form story. Use for strong opening declarations, identity and struggle arcs, crisis-to-goal recovery, multi-source B-roll and evidence stills, emotional typography, semantic punch-ins, pinned SFX, dialogue-first audio, platform-added music delivery, and creator-short retention QA.
---

# Finish Creator Short

クリエイター、挑戦企画、Vlog、ドキュメンタリー、コミュニティ共創型の縦型ショート動画（Instagram Reels / TikTok / YouTube Shorts）を、視聴維持率（Retention）とエンゲージメント（Comment/Follow）を最大化する完成プレビューへ仕上げる。

ビジネス動画（`finish-business-short`）の静的な信頼感とは異なり、**主張の早さ、感情のジェットコースター（Vulnerability）、マルチレイヤー証拠素材（Evidence）、高速な画面変化リズム、要約キーワードテロップ、精密なSE同期**でテンポと共感を生み出す。

## 必ず読む参照

編集判断・演出適用の前に
[`references/creator-challenge-short.md`](references/creator-challenge-short.md)
を読む。7-Beat構成、カット尺配分、画面変化イベントレート、テロップ階層、SE/無音設計、QA基準はそこから選ぶ。

## Workflow

0. **repo project が無ければ、先に作る（手作業のffmpegに逃げない）**:
   - このスキルは `05_timeline/timeline.json` がある project を前提にする。
   - 素材がまだ project の canonical chain に取り込まれていない場合は、許可済みの source directory を入力にして
     `full-pipeline` で project を作る:
     `npm run full-pipeline -- --project <project-id> --source-dir <素材ディレクトリ> --content-hint "<内容>"`
   - project 化せずに ffmpeg を直接叩いて動画を組むことは禁止。
     A/V同期・字幕被り・セーフエリア・NLE書き出しの保証は全て timeline を通った場合のみ効く。
   - 素材内容（発話・映っているもの）を確認する前に、構成やナレーションを書かない。
     未確認の事実を創作した場合はその時点で停止し、`analyze-footage` へ戻る。
1. `01_intent/creative_brief.yaml`、`05_timeline/timeline.json`、最新の preview/manifest、
   `03_analysis/transcripts/` の該当 transcript、`06_review/review_report.yaml`、
   `03_analysis/assets.json` と `03_analysis/segments.json` を確認する。
2. **素材ロール（Material Roles）の監査**:
   - `a_roll` (本人トーク)
   - `b_roll_action` (走行・活動・トレーニング)
   - `b_roll_enactment` (再現ドラマ・象徴カット)
   - `evidence` (レントゲン、包帯、記録スクショ等のカメラロール静止画)
   - `archive` (過去の大会・活動動画)
   ※不足している証拠素材がある場合は架空生成せず、上流（`design-intent`）またはdegraded planへ記録する。
3. **比率ベースの構成アークを選ぶ**:
   - `creative_brief.yaml.narrative_mode: personal_challenge` は
     [`runtime/editorial/arcs/personal-challenge-comeback.yaml`](../../../runtime/editorial/arcs/personal-challenge-comeback.yaml)、
     `day_log` は
     [`runtime/editorial/arcs/vlog-day-log.yaml`](../../../runtime/editorial/arcs/vlog-day-log.yaml)
     を使う。beat 順・尺比率・`story_role`・`valence`・`tempo` の正本は YAML とする。
   - 比率を brief の目標尺へ伸縮し、固定秒数へ置き換えない。値はすべて provisional であり、実 retention データで較正するまで確定値として扱わない。
   - `narrative_mode` 未指定時は既存の構成判断を維持し、素材だけからどちらかのアークを暗黙推定しない。
   - `editorial.hook_priority: credibility_first` は講演・証言系の別経路であり、creator-short の `narrative_mode` と同時指定しない。
   - `narrative_mode` 指定時、`/blueprint` と compiler は YAML 正本に対して beat ID・順序、全体尺比率（丸め誤差1 frame以内）、`story_role`、`emotional_valence`、`evidence_required` を決定的に検査する。`evidence_required: true` の beat は、`candidate_plan` が `selects_candidates.yaml` 上の evidence を持つ候補を参照しなければならない。
   - 上記 fields は `edit_blueprint.yaml` から compiler normalization と deterministic eval まで保持する。timeline schema に対応 field はないため `timeline.json` へは投影しない。`tempo` は planner/editing guidance に留まり、runtime gate ではない。
   - beat ごとの心理誘導、映像・テロップ、証拠素材、kickoff 境界、apex hold、末尾ノイズトリムの判断は
     [`references/creator-challenge-short.md`](references/creator-challenge-short.md) に従う。素材に無い谷・成果・証拠は創作しない。
4. **画面変化リズムとパンチイン（Change Event Rate）**:
   - カットレート、同一構図の保持、パンチインの scale は、brief・narrative arc・project の
     retention/composition policy から選び、blueprint に記録する。固定の cuts/minute、秒数、zoom 値を
     generic rule として持ち込まず、review/eval の実測で判断する。
5. **テロップ（字幕）のタイポグラフィと配置**:
   - `caption_mode: keyword_telop` は project の versioned typography policy が選ぶ場合だけ使う。
     caption text、timing、approval は caption review/finalize と FFmpeg/libass speech route が所有し、
     content element で二重化しない。
   - 配置は project-contained の versioned platform safe-zone profile と typography policy に従う。
   - 階層:
     - `Baseline`: project の typography policy が定める baseline style
     - `Positive Hook`: 登録済み `vos:content.hook-title/v1`
     - `Crisis / Damage`: 登録済み `vos:content.emphasis-word/v1`
   - `styling_class` は `runtime/content/template-registry.ts` の `CONTENT_TEMPLATE_IDS` にある ID のみ使う。未登録IDは compile 時に `Unknown legacy styling_class` で落ちる。
   - 人間の修正指示は先にrouterへ渡す:
     `npm run caption-edit-route -- --project projects/<project> --instruction "<human instruction>" --reviewer "<reviewer>" --write-receipt`
   - 本文/timingは`caption_review_patch`、style/size/rect/hierarchy/emphasis/animationは
     `caption_visual_treatment`、shot order/trim/crop/audioは`timeline_review_patch`へだけ送る。
     mixed/ambiguous/表現不能なら`06_review/caption-edit-route.json`を残して停止し、複数artifactや
     project-local ASS/FFmpeg/render scriptを書かない。
   - draft/approval欠損時はrouterの`project.initialize_commands`に戻り、
     `caption-review.ts prepare` → `init` → 人間確認 → `approve`を使う。新しい承認モデルを作らない。
   - visual-only候補は次の1 commandでauthoring + previewする。初回patch hashは`absent`、
     再実行は直前の`patch_hash`、approval hashはrouterの`project.caption_approval_binding_hash`を使う:
     `npx tsx scripts/caption-review.ts visual-author-preview --project projects/<project> --reviewer "<reviewer>" --typography-policy projects/<project>/04_plan/typography_policy.json --visual-operation-json '<schema-valid operation JSON>' --expected-patch-hash <hash-or-absent> --expected-approval-hash <caption-approval-binding-hash>`
   - stop conditionはstale input/approval/patch/receipt、unknown field/path escape、`blocked`、`human_hold`、
     subject evidence無しの顔相対rect、同一文言をspeech captionとgraphical elementで二重描画するplan。
   - artifactsは`caption_visual_treatment_patch.json`、`caption_visual_treatment_preapproval_input.json`、
     `caption_visual_treatment_preapproval_receipt.json`、canonical `preview-baseline-fast-full.mp4`とreceipt。
     before/after text/timing hashとapproval hashが不変で
     `production_approval_unchanged=true`でなければ採用しない。
   - speech caption text/timing/renderはcaption review/finalize + FFmpeg/libass、graphical hook/title/emphasisは
     registered content element + Remotionがowner。canonical capabilityへ戻れない表現はdegraded-route noteで停止する。
   - 例外的なreview-only outputはrepo-owned writerだけを使う:
     `npm run project-output:degraded -- --project projects/<project> --source <review-file> --output projects/<project>/09_output/<versioned-review-file> --degraded-route-receipt projects/<project>/06_review/degraded-route-receipt.json`
     receiptは実canonical command/capability、production approval hash、承認者、15分以内のtimestampへbindし、検証失敗は書込み前停止する。
6. **音響（Audio, SFX, Silence）とPlatform BGM Handoff**:
   - `finish-interview` は dialogue-led の picture/reframe 判断に使い、音声仕上げは `$short-sound-design`
     の shared AudioRenderPlan/Executor に集約する。dialogue、caption、picture timing は動かさない。
   - テロップ出現・写真インサートに連動したSEは、pinned semantic window と evidence に同期配置する。
   - **無音（Silence / Audio Drop）**: 重要メッセージの直前に、brief と audio policy が許す音の引きを置く。
   - **BGMポリシー**: platform-side audio を選ぶ場合は timeline/package に BGM を焼かず、
     `audio_policy: original_only` と platform preview/handoff gate を別に記録する。存在しない
     project artifact を作らず、platform 側の preview evidence と package receipt を分離する。
7. **完了QA（Creator Short QA）**:
   - Hook、identity、visual refresh、caption safe-zone、caption/word anchor、SFX alignment、
     loudness/true peak を、brief と versioned retention/typography/audio/delivery profiles の
     target、および測定済み QA receipt で確認する。固定の秒数、frame tolerance、LUFS、dBFS を
     generic skill の universal law にしない。

## プロジェクト固有ルールの置き場

人名・地名・決め台詞・ブランドカラー・その案件だけのテロップ癖は、このSKILL.mdに書かない。
`projects/<project-id>/STYLE.md` に書く（blueprint と review が読む。変更すると blueprint から再実行される）。
このスキルに書いてよいのは、案件を問わず成立する構成・テンポ・可読性・QAの規約だけ。

## レビュー導線

ユーザーがPCの前にいない場合、プレビューをスマホへ送って判断を仰ぐ:

```bash
cockpit ask --summary "<何を確認してほしいか。尺・変更点・次の選択肢を書く>" --media <preview.mp4>
```

`cockpit ask` 後はターンを終える。ポーリングせず、回答で再開されるのを待つ。

## Canonical edit path

- 局所削除・トリム・パンチイン: `re-edit`
- 会話MA・人物リフレーム: `finish-interview`
- クリエイター向けオーバーレイ・SE合成プレビュー:
  `npm run social-review -- --project <project-dir> --captions <plan.json> [--repo-sfx-root <directory>] [--timeline <timeline.json>] [--music-cues <music_cues.json>] [--sfx-cues <sfx_cues.json>] [--output <mp4>] [--work-dir <directory>]`
- 編集後の判断: `review-roughcut`
- 編集ソフト向けハンドオフ: `export-premiere`
- 承認済みパッケージ書き出し: `render-video`
