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

## 出力 artifact
- `04_plan/edit_blueprint.yaml`
- `04_plan/uncertainty_register.yaml`

## 注意事項
- `uncertainty_register.yaml` の `status: blocker` は planning 上の blocker。compile gate の hard stop は `unresolved_blockers.yaml` 側で管理される。
- beat の role は `hero`, `support`, `transition`, `texture`, `dialogue` の enum に合わせる。
- `timeline_order` を省略した場合は schema default は `editorial`。chronological にしたいときだけ明示する。
