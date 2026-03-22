# Setup Troubleshooting

`setup-environment` は `npm install`、`npm run demo`、API key 設定、binary install のどこで落ちたかを切り分けたあと、この表の該当行だけを見る。

## よくあるエラー

| エラー | 原因 | 対処 |
| --- | --- | --- |
| `ffmpeg: command not found` | `ffmpeg` 未インストール、または PATH 未反映 | Step 2 を実行し、`ffmpeg -version` と `ffprobe -version` で確認する |
| `Cannot find module 'yaml'` | `npm install` 未実行、または `node_modules/` 不整合 | `npm install` を実行する |
| `GEMINI_API_KEY is not set` | `.env.local` が無い、または `GEMINI_API_KEY` が空 | Step 4 で `.env.local` を整える。不要なら `--skip-vlm` |
| `TypeError: fetch failed` | API key 無効、rate limit、または provider 側一時障害 | key を再確認し、provider dashboard の制限を確認する。必要なら待って再試行し、degraded path なら `--skip-vlm` / `--skip-stt` を使う |
| `pyannote.audio not found` | Python package 未インストール | Step 5 の `python3 -m pip install pyannote.audio torch torchaudio` を実行する。不要なら `--skip-diarize` |
| `EACCES permission denied` | npm cache / global install の権限問題 | `sudo chown -R $(whoami) ~/.npm` を試す |
| `node: v14.x.x` | Node.js が古い | `nvm install 20 && nvm use 20`、または `nvm use 18` |
| demo 実行時にスキーマエラー | `node_modules/` 破損、依存 version 不整合、または古い install state | `rm -rf node_modules && npm install` を実行し、`npm run demo` を再試行する |

## 切り分けの順番

1. Step 1 の環境チェックを取り直す
2. `ffmpeg` / `ffprobe` が無ければ Step 2
3. `node_modules/` が無い、または module error なら Step 3
4. API key 系 error なら Step 4
5. pyannote 系 error なら Step 5
6. その後に `npm run demo`、最後に `npm test`

## 補足

- `npm run demo` は API キー不要。ここで落ちるなら、まず repo root / Node.js / install state を疑う
- `scripts/analyze.ts` は `GEMINI_API_KEY` 不足時に VLM を warning + skip できるが、STT provider 側の key 不足は connector error になりやすい
- `.env.local` の中身は返答内に出さない。secret を貼らせるときも、commit しないことを必ず伝える
- ここに無い failure は `troubleshoot-error` へ回し、stderr を固定してから診断する
