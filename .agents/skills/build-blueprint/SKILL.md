---
name: build-blueprint
description: Use when selects_candidates.yaml exists and the user asks to design structure, build an edit blueprint, or create 04_plan/edit_blueprint.yaml.
metadata:
  filePattern:
    - '**/04_plan/edit_blueprint.yaml'
    - '**/04_plan/uncertainty_register.yaml'
  bashPattern: []
---
# build-blueprint
## いつ使うか
- 「構成を設計して」「ブループリントを作って」と言われたとき。
- `04_plan/selects_candidates.yaml` があり、rough cut 前の設計を固めるとき。

## 前提条件
- `schemas/edit-blueprint.schema.json` と `schemas/uncertainty-register.schema.json` を守ること。
- `runtime/commands/blueprint.ts` の narrative loop に従うこと。
  frame → read → draft → evaluate → confirm → promote
- 入力は `creative_brief.yaml`, `unresolved_blockers.yaml`, `selects_candidates.yaml`, 任意で `STYLE.md`。

## やること（ステップ）
1. brief の autonomy を見て、`full` か `collaborative` かを決める。
2. `04_plan/edit_blueprint.yaml` を作る。
   必須の核は `sequence_goals`, `beats`, `pacing`, `music_policy`, `dialogue_policy`, `transition_policy`, `ending_policy`, `rejection_rules`。
3. `beats[].target_duration_frames` と `required_roles` を明確にし、候補素材との対応が読めるようにする。
4. 必要なら `caption_policy`, `timeline_order`, `duration_policy`, `quality_targets`, `trim_policy`, `active_editing_skills` も書く。
5. `04_plan/uncertainty_register.yaml` を作る。
   各 uncertainty は `id`, `type`, `question`, `status`, `evidence`, `alternatives`, `escalation_required` を持つ。
6. `collaborative` の場合は beat proposal と pacing を readback し、`pacing.confirmed_preferences` を入れる。
7. speech-led / interview では promotion 前に first-pass quality audit を行う。
   - 各 dialogue primary は質問テロップなしでも主語または指示対象、比較の両側、原因と結果、結論が範囲内で回収できる
   - 推薦・受講推奨・CTA は単独で置かず、直前または同じ回答に理由、判断問題、具体的な不利益のいずれかを残す
   - `dialogue_policy.cut_tail_hold_sec >= 0.25` と `cut_audio_fade_out_sec >= 0.16` を基本とする
   - `ending_policy` は完全な最終発言後の動く元素材を `tail_hold_sec >= 1.5` 残し、音声と映像をフェードする。静止フレームで終端を延ばさない
   - 字幕は speech caption 1レイヤーとし、質問・章ラベルに発話本文を重複させない
   audit に失敗した場合は、尺を優先して通さず、完全な fallback の昇格または候補範囲の再選択を行う。
8. 明示的な短尺SNS案件（social delivery かつ目標90秒以下）では retention audit も行う。
   - `hook_priority: aggressive` または brief がコールドオープンを要求する場合、最強の実在payoff/reactionを1〜2秒だけ先出しし、setupへ戻って完全版をおおむね全尺65%以前に開始する
   - 同じ素材へ意図的に戻る場合は別source rangeを優先し、必要なら `allow_revisit` にcallback理由を残す
   - `beat.id` / `beat.label` は構造用、画面表示文言は `beat.viewer_label` に視聴者の言葉で書く。`HOOK` / `LEVEL 1` / `PAYOFF` / `ENDING` を brief 指定なしに画面へ出さない
   - talking-head / low-motion素材では6〜12秒ごとの意味的な転換点に、実在リアクション、登録済みreframe/punch-in、登録済み強調overlayのいずれかを計画する。無意味なzoomやflashで埋めない
   - `credibility_first` / 高い信用優先では断片的なspoilerを強制せず、根拠を伴う完全な主張をhookにする
   - このauditは短尺SNS以外へ適用しない
9. brief がBGMを要求する場合だけ、`music_policy` にレビュー済みライブラリ／BGM Packからの選曲を明記する。
   利用可能な候補がなければ `uncertainty_register.yaml` に blocker を作り、通常BGMを案件内生成して仮置きしない。
   短い単純音を明示的に求める場合だけ `usage_class: simple_sound` を例外として扱う。

## 出力 artifact
- `04_plan/edit_blueprint.yaml`
- `04_plan/uncertainty_register.yaml`

## 注意事項
- `uncertainty_register.yaml` の `status: blocker` は planning 上の blocker。compile gate の hard stop は `unresolved_blockers.yaml` 側で管理される。
- beat の role は `hero`, `support`, `transition`, `texture`, `dialogue` の enum に合わせる。
- `timeline_order` を省略した場合は schema default は `editorial`。chronological にしたいときだけ明示する。
- speech-led の first-pass quality audit はユーザーレビューの代替ではなく、明白な意味欠落と終端事故を人間へ出す前に自動修復するための必須ゲートとする。
