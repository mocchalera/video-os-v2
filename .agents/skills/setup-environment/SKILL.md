---
name: setup-environment
description: "MUST USE when the user is setting up this project for the first time, when dependencies are missing, API keys are not configured, or when 'npm run demo' fails. Triggers on: 'セットアップ', '環境構築', 'setup', 'install', 'API key', 'ffmpeg not found', 'GEMINI_API_KEY', 'cannot find module'."
metadata:
  filePattern:
    - '**/.env.local'
    - '**/package.json'
  bashPattern:
    - 'npm install'
    - 'npm run demo'
    - 'ffmpeg'
    - 'ffprobe'
---
# setup-environment — 初期セットアップ

## いつ使うか（必ず発火する条件）

- ユーザーがこの repo を新しい環境で初めて使うとき
- ユーザーが「セットアップして」「環境構築したい」「install したい」と言ったとき
- `npm install` 未実行、`node_modules/` 欠落、`Cannot find module` 系 error が出たとき
- `ffmpeg` / `ffprobe` が見つからないとき
- `GEMINI_API_KEY`、`GROQ_API_KEY`、`OPENAI_API_KEY`、`HF_TOKEN` の設定方法を聞かれたとき
- `npm run demo` や `npx tsx scripts/analyze.ts ...` が環境要因で失敗したとき

## 前提条件

- 作業ディレクトリは repo root であること
- 秘密情報は絶対に表示しない。`.env.local` の値を読み上げたり、返答内に貼り付けたりしない
- `.env.local` は **絶対に commit しない**。作成前に `.gitignore` に `.env.local` が含まれているか確認する
- この repo では `scripts/analyze.ts` が `.env.local` を先に読み、次に `.env` を読む
- 詳細な API キー取得手順は `references/api-key-guide.md`、典型エラーは `references/troubleshoot-setup.md` を必要時だけ読む

## やること（ステップ）

### Step 1: 環境チェックを自動実行する

- まず以下を実行し、環境の現在値を取る

```bash
node -v
npm -v
which ffmpeg
which ffprobe
which python3
test -f .env.local && echo yes || echo no
test -d node_modules && echo yes || echo no
```

- 結果は必ず表形式で返す。最低でも `項目 | 現在値 | 期待値 | 状態` を含める
- 確認対象は以下:
  - Node.js バージョン: `>= 18` 推奨
  - npm バージョン
  - `ffmpeg` の存在
  - `ffprobe` の存在
  - `python3` の存在
  - `.env.local` の存在
  - `node_modules/` の存在
- **次アクションを案内するのは不足項目だけ** にする
- Node.js が古い場合は他の手順に進む前に更新する。目安は `nvm install 20 && nvm use 20`、または `nvm use 18`

### Step 2: `ffmpeg` / `ffprobe` を入れる

- `ffmpeg` または `ffprobe` が無いときだけ実行する
- OS ごとの基本コマンド:

```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt install ffmpeg

# Windows (winget または Chocolatey)
winget install ffmpeg
choco install ffmpeg
```

- インストール後は必ず確認する

```bash
ffmpeg -version
ffprobe -version
```

- ここで詰まったら `references/troubleshoot-setup.md` の `ffmpeg: command not found` を読む

### Step 3: `npm install` を実行する

- `node_modules/` が無い、または `Cannot find module` 系 error が出ているときだけ実行する

```bash
npm install
```

- install が失敗したら、エラーメッセージをそのまま確認したうえで `references/troubleshoot-setup.md` を読む
- `npm install` 済みなのに module error が続く場合は、`node_modules/` の破損や Node.js version mismatch を疑う

### Step 4: API キーと `.env.local` を整える

- `.env.local` が無い、または必要なキーが空なら **`references/api-key-guide.md` を読む**
- 先に `.gitignore` を確認し、`.env.local` が無ければ追加する
- `.env.local` が無い場合は次のテンプレートを作る

```dotenv
# Required for VLM video understanding (contact sheets, filmstrips, peak detection)
GEMINI_API_KEY=

# Required for Speech-to-Text (Whisper Large v3 Turbo)
GROQ_API_KEY=

# Optional: Alternative STT with built-in diarization
OPENAI_API_KEY=

# Optional: Speaker diarization (pyannote)
HF_TOKEN=
```

- `.env.local` が既にある場合は、既存値を消さずに不足行だけ補う
- 必須度はこう扱う
  - `GEMINI_API_KEY`: 推奨。VLM 映像理解と peak 検出に使う
  - `GROQ_API_KEY`: 推奨。Groq Whisper STT に使う
  - `OPENAI_API_KEY`: 任意。OpenAI STT を使う場合だけ必要
  - `HF_TOKEN`: 任意。pyannote 話者分離を使う場合だけ必要
- キーが足りないときの fallback も必ず伝える
  - `GEMINI_API_KEY` が無い:
    `scripts/analyze.ts` は warning を出して VLM を skip する。明示的に local/degraded path を取りたいなら `--skip-vlm`
  - `GROQ_API_KEY` が無く、`OPENAI_API_KEY` がある:
    `--stt-provider openai`
  - `GROQ_API_KEY` も `OPENAI_API_KEY` も無い:
    `--skip-stt`
  - `HF_TOKEN` が無い:
    `--skip-diarize`
- `.env.local` の値は返答内に出さない。commit もさせない

### Step 5: Python + pyannote を入れる

- これは **話者分離が必要な場合だけ** 行う
- 基本コマンド:

```bash
python3 -m pip install pyannote.audio torch torchaudio
```

- `HF_TOKEN` を `.env.local` に入れる
- この repo の pyannote bridge は既定で `pyannote/speaker-diarization-community-1` を使う。Hugging Face 側で model access の確認が出たら許可する
- Groq STT + 話者分離を使わないなら、この step は飛ばしてよい
- 不要な場合は完全に `--skip-diarize` で回避できる

### Step 6: 動作確認をする

- まず API キー不要の demo を確認する

```bash
npm run demo
```

- demo が通ったら test を流す

```bash
npm test
```

- `npm run demo` が失敗したら install / Node.js / repo root を見直す
- `npm test` が失敗したら、環境差分か repo 側不整合かを切り分ける。セットアップ起因の典型例は `references/troubleshoot-setup.md` を読む
- demo と test が両方通れば「セットアップ完了」と判断してよい

### Step 7: 初回 project の作り方を案内する

- セットアップが終わったら、最小の project を作る

```bash
mkdir -p projects/my-project
```

- 素材は `./footage/` など任意の場所に置き、まず analyze を走らせる

```bash
npx tsx scripts/analyze.ts ./footage/*.mp4 \
  --project projects/my-project \
  --content-hint "内容の説明"
```

- キー不足で degraded path を取るなら、必要に応じて `--skip-vlm`、`--skip-stt`、`--skip-diarize`、`--stt-provider openai` を追加する
- setup 後の skill 連携も案内する
  - 素材理解だけ欲しいなら `analyze-footage`
  - analysis 後に `01_intent/creative_brief.yaml` が無ければ次は `design-intent`
  - 「素材から rough cut までまとめて進めたい」なら `full-pipeline`

## 出力 artifact

- `.env.local` ただし local-only。**絶対に commit しない**
- `node_modules/`
- `projects/demo/05_timeline/timeline.json` ただし `npm run demo` 実行時
- `projects/<project>/03_analysis/*` ただし初回 analyze 実行時

## 注意事項

- `.env.local` の中身を version control に入れない
- `npm run demo` は repo root 実行が前提で、API キーは不要
- `scripts/analyze.ts` の degraded path は品質と引き換え。`--skip-vlm` では `summary` / `tags` / `peak_analysis` の品質が落ちる
- pyannote は optional。`python3` や `HF_TOKEN` が無くても、`--skip-diarize` で repo 全体の利用は続けられる
- setup で解決しない failure は `troubleshoot-error` に引き継ぐ
