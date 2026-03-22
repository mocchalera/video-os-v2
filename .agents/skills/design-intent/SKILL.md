---
name: design-intent
description: "MUST USE when starting a new video project, when the user provides footage and asks to edit/create a video, or when 01_intent/creative_brief.yaml does not yet exist. This skill interviews the user to understand their intent before any editing begins. Never skip this step."
metadata:
  filePattern:
    - '**/01_intent/creative_brief.yaml'
    - '**/01_intent/unresolved_blockers.yaml'
  bashPattern: []
---
# design-intent — 意図ヒアリング

## いつ使うか（必ず発火する条件）

- ユーザーが素材を渡して「編集して」「動画を作って」「粗編集して」と言ったとき
- 新しいプロジェクトを開始するとき（`01_intent/creative_brief.yaml` が存在しない）
- `full-pipeline` の Step 2 として呼ばれたとき
- 「意図を決めて」「creative brief を作って」と明示的に言われたとき

**このスキルを省略してはいけない。** brief なしに triage や blueprint に進むと、エージェントの判断基準がなくなり品質が下がる。

## 前提条件

- `schemas/creative-brief.schema.json` と `schemas/unresolved-blockers.schema.json` を守ること
- 可能なら `03_analysis/assets.json` と `03_analysis/segments.json` を読み、素材理解を反映すること
- `runtime/commands/intent.ts` の dialogue flow に沿うこと:
  1. purpose capture → 2. constraint capture → 3. autonomy capture → 4. blocker extraction → 5. readback confirmation

## やること（ステップ）

### Step 1: 素材を把握する
- `03_analysis/assets.json` があれば読んで、素材の本数・尺・内容を把握する
- `segments.json` の `peak_analysis` や `display_name` があれば、どんなシーンがあるかを理解する
- 素材がまだ分析されていなければ、先に `analyze-footage` スキルを実行する

### Step 2: ユーザーにヒアリングする（省略不可）

**references/interview-questions.md を参照し、以下の Phase に沿って質問する。**

#### Phase 1: 目的と背景（プロデューサー視点）— 必須
- 何のための映像か
- 誰に見せるか
- 見た人にどうなってほしいか
- 期限や制約

#### Phase 2: 素材の理解（ディレクター視点）— 素材がある場合は必須
- 一番見せたいシーン
- 使いたくない素材（NG カット）
- 時系列は重要か
- BGM のイメージ

#### Phase 3: トーンと演出（演出家視点）
- 全体の雰囲気
- 感情のカーブ
- テロップの要否
- 避けたい演出

#### Phase 4: 自律性の確認（コラボレーション設計）— 必須
- エージェントに任せてよい判断
- 必ず確認してほしい判断

#### Phase 5: マーケティング視点（該当する場合のみ）
- 配信プラットフォーム
- アスペクト比

**質問のルール:**
- 1回の質問は最大3つまで。質問攻めにしない
- ユーザーの最初の説明で明らかな項目はスキップしてよい
- 曖昧な回答は深掘りする（「いい感じに」→「具体的には？」）
- ユーザーの言葉をそのまま brief に使う

### Step 3: creative_brief.yaml を作成する

**references/creative-brief-schema-guide.md を参照し、ユーザーの回答をフィールドにマッピングする。**

必須フィールド:
- `project.title`, `project.strategy`, `project.runtime_target_sec`
- `message.primary`
- `audience.primary`
- `emotion_curve`, `must_have`, `must_avoid`
- `autonomy.mode`, `autonomy.may_decide`, `autonomy.must_ask`
- `resolved_assumptions`

### Step 4: unresolved_blockers.yaml を作成する
- ヒアリングで解決できなかった疑問を blocker として記録
- 各 blocker: `id`, `question`, `status`, `why_it_matters`, `allowed_temporary_assumption`
- `status: blocker` は compile gate を止める hard blocker

### Step 5: 読み返し確認（省略不可）
- 作成した brief をユーザーに読み返す
- 「この内容で進めてよいですか？」と確認する
- 修正があれば反映する

## 出力 artifact
- `01_intent/creative_brief.yaml`
- `01_intent/unresolved_blockers.yaml`

## 注意事項
- `unresolved_blockers.yaml` の `status: blocker` は compile gate を止める
- `allowed_temporary_assumption` は `null` か文字列で必ず埋める
- `content_hint` は VLM の認識精度に直結するので、ユーザーの説明から必ず抽出する
- profile (`keepsake`, `commercial` 等) から `duration_mode` が自動推定される
- **brief を埋める前にユーザーに聞く。推測で埋めない。**
