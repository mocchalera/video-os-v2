# API Key Guide

`setup-environment` は `.env.local` が無いとき、キーが空のとき、または取得先を聞かれたときだけこのファイルを読む。

2026-03-22 時点で、取得先 URL は各公式ページで確認済み。

## 一覧

| キー | 必須度 | 用途 | 取得先 | 無料枠 / 料金メモ |
| --- | --- | --- | --- | --- |
| `GEMINI_API_KEY` | 推奨 | VLM 映像理解、contact sheet / filmstrip 文脈化、peak 検出 | [Google AI Studio API Keys](https://aistudio.google.com/app/apikey) | 無料 tier あり。実際の RPM / RPD は model と tier に依存 |
| `GROQ_API_KEY` | 推奨 | STT 音声文字起こし (`whisper-large-v3-turbo`) | [Groq Console API Keys](https://console.groq.com/keys) | 無料 plan あり。上限は organization / model ごとに変わる |
| `OPENAI_API_KEY` | 任意 | 代替 STT + built-in diarization | [OpenAI API keys](https://platform.openai.com/api-keys) | 基本は従量課金。公開の恒常無料枠は前提にしない |
| `HF_TOKEN` | 任意 | pyannote 話者分離 model 取得 | [Hugging Face Access Tokens](https://huggingface.co/settings/tokens) | トークン発行自体は無料 |

## 共通手順

1. 取得先 URL を開く
2. アカウントが無ければ作成する
3. `API Keys` または `Access Tokens` の画面に移動する
4. 新しいキーを生成する
5. `.env.local` の対応する行へ貼り付ける

## `GEMINI_API_KEY`

1. [Google AI Studio API Keys](https://aistudio.google.com/app/apikey) を開く
2. Google アカウントで sign in する
3. API key 作成画面へ進む。project 選択を求められたら案内に従う
4. 新しい key を生成する
5. `.env.local` の `GEMINI_API_KEY=` に貼る

補足:

- この repo では VLM 映像理解と peak 検出に使う
- キーが無い場合、`scripts/analyze.ts` は warning を出して VLM を skip する

## `GROQ_API_KEY`

1. [Groq Console API Keys](https://console.groq.com/keys) を開く
2. Groq Console に sign in する
3. `API Keys` 画面で新しい key を作る
4. 発行直後に key をコピーする
5. `.env.local` の `GROQ_API_KEY=` に貼る

補足:

- この repo の既定 STT は Groq Whisper path と相性がよい
- Groq を使わず OpenAI STT に寄せるなら `OPENAI_API_KEY` と `--stt-provider openai` を使う

## `OPENAI_API_KEY`

1. [OpenAI API keys](https://platform.openai.com/api-keys) を開く
2. OpenAI Platform に sign in する
3. `API keys` 画面で新しい secret key を作る
4. 必要なら billing を確認する
5. `.env.local` の `OPENAI_API_KEY=` に貼る

補足:

- この repo では代替 STT provider として使う
- built-in diarization を使いたいときは `--stt-provider openai` を選ぶ

## `HF_TOKEN`

1. [Hugging Face Access Tokens](https://huggingface.co/settings/tokens) を開く
2. Hugging Face に sign in する
3. `New token` から token を作る
4. 通常は `read` 権限で十分
5. `.env.local` の `HF_TOKEN=` に貼る

補足:

- pyannote を使うときだけ必要
- この repo の bridge 既定 model は `pyannote/speaker-diarization-community-1`
- Hugging Face 側で model access の確認が出たら許可する

## `.env.local` テンプレート

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

## fallback の考え方

- `GEMINI_API_KEY` が無い: `--skip-vlm`
- `GROQ_API_KEY` が無いが `OPENAI_API_KEY` がある: `--stt-provider openai`
- STT 用 key がどちらも無い: `--skip-stt`
- `HF_TOKEN` が無い: `--skip-diarize`

`.env.local` は local secret file であり、**絶対に commit しない**。
