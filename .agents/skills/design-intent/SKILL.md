---
name: design-intent
description: Use when the user asks to define editing intent, create a creative brief, or lock 01_intent artifacts after footage analysis.
metadata:
  filePattern:
    - '**/01_intent/creative_brief.yaml'
    - '**/01_intent/unresolved_blockers.yaml'
  bashPattern: []
---
# design-intent
## いつ使うか
- 「編集の意図を決めて」「creative brief を作って」と言われたとき。
- `03_analysis` はできているが、`01_intent/creative_brief.yaml` と `unresolved_blockers.yaml` がまだないとき。

## 前提条件
- `schemas/creative-brief.schema.json` と `schemas/unresolved-blockers.schema.json` を守ること。
- 可能なら `03_analysis/assets.json` と `03_analysis/segments.json` を読み、素材理解を brief に反映すること。
- `runtime/commands/intent.ts` の flow に沿って、purpose capture → constraint capture → autonomy capture → blocker extraction → readback confirmation を行うこと。

## やること（ステップ）
1. ユーザーの目的、対象 audience、避けたい表現、任せてよい判断と要確認事項を整理する。
2. `01_intent/creative_brief.yaml` を作る。
   必須の核は `project`, `message`, `audience`, `emotion_curve`, `must_have`, `must_avoid`, `autonomy`, `resolved_assumptions`。
3. `autonomy.mode` は `full` か `collaborative` を明示する。
4. `01_intent/unresolved_blockers.yaml` を作る。
   各 blocker は `id`, `question`, `status`, `why_it_matters`, `allowed_temporary_assumption` を持つ。
5. 残課題がある場合は `status` を `blocker` / `hypothesis` / `resolved` / `waived` のどれかで固定する。
6. 仕上げ前に、brief の読み返しと blocker の有無をユーザーに確認する。

## 出力 artifact
- `01_intent/creative_brief.yaml`
- `01_intent/unresolved_blockers.yaml`

## 注意事項
- `unresolved_blockers.yaml` の `status: blocker` は compile gate を止める hard blocker になる。
- `allowed_temporary_assumption` は `null` か文字列で必ず埋める。省略しない。
- `creative_brief.yaml` は optional で `editorial`, `content_hint`, `hypotheses`, `forbidden_interpretations` を持てるが、schema にない項目は入れない。
