---
name: troubleshoot-error
description: Use when a pipeline step fails, an error occurs, schema validation fails, ffmpeg crashes, or API returns an error. Diagnose the root cause and attempt automatic recovery.
metadata:
  filePattern: []
  bashPattern:
    - 'error'
    - 'failed'
    - 'Error'
    - 'FATAL'
---
# troubleshoot-error

## いつ使うか（必ず発火する条件）

- ユーザーが「エラーが出た」「動かない」「失敗した」と言ったとき
- `analyze` / `compile` / `review` / `render` / `export` の途中で command が non-zero exit したとき
- schema validation が落ちたとき
- `ffmpeg` / `ffprobe` / API connector が失敗したとき
- TypeScript compile error や runtime exception で pipeline が止まったとき

## 前提条件

- まず **失敗した command と stderr をそのまま確認する**。要約だけで診断しない
- project artifact が絡む場合、`scripts/validate-schemas.ts` が canonical validator
- `scripts/compile-timeline.ts` は compile 前に Gate 1、compile / patch 後に timeline schema を検証する
- `scripts/analyze.ts` は `--skip-stt` / `--skip-vlm` を持つ。`GEMINI_API_KEY` 未設定は warning + VLM skip であり、常に hard failure ではない
- 詳細な分岐は **`references/error-catalog.md` を参照すること**

## やること（ステップ）

### Step 1: 失敗面を固定する

- 失敗した command、project path、stage、最後に触った artifact、stderr を集める
- ユーザー報告が曖昧なら、最小の再現 command を 1 本だけ実行して failure surface を確定する
- 「どの stage の何が失敗したか」が取れるまでは、広く修正し始めない

### Step 2: 最短の deterministic check を走らせる

- artifact 系の failure なら最初にこれを走らせる

```bash
npx tsx scripts/validate-schemas.ts projects/<project>
```

- code / type error ならこれで切り分ける

```bash
npx tsc --noEmit
```

- media / codec / path error なら `ffprobe` で source を直接確認する
- compile failure なら `01_intent/unresolved_blockers.yaml` と validator output を両方見る

### Step 3: エラー種別ごとに根因を切る

- schema error:
  validator の `artifact`, `rule`, `message`, `details.instancePath` から壊れている field を特定する
- ffmpeg / ffprobe error:
  source file の存在、権限、codec、`02_media/source_map.json` の path 解決を確認する
- API error:
  env var 未設定か、401/403 か、429 か、timeout かを分ける
- compile gate failure:
  hard blocker なのか、ただの schema invalid なのかを分ける
- TypeScript error:
  既存の debt と今回の failure を分け、まず新規 failure を止血する

### Step 4: safe な自動回復を試す

- repo 内で deterministic に直せるものは修正して再実行する
- analyze で remote API が不安定なら、要件を壊さない範囲で `--skip-vlm` / `--skip-stt` に迂回する
- compile gate が blocker 起因なら、勝手に blocker を消さず、解決済みか temporary assumption が許されているかを確認する
- fix 後は **同じ command を再実行** して recovery を確認する

### Step 5: 直らないものは blocker として残す

- bad API key
- sandbox / filesystem permission
- 存在しない source file
- repo 外依存の binary 不足

この種の failure は無理に隠さず、次に必要な action を具体化して返す。

## 出力 artifact

- canonical な単一 artifact はない
- 必要に応じて壊れていた artifact を修正し、失敗していた stage の出力を再生成する

## 注意事項

- `validate-schemas.ts` は violation が 1 件でもあれば exit 1 になる。一方 `compile_gate: blocked` は Gate 1 blocker 専用の狭い判定
- `status: blocker` を勝手に `resolved` に変えない。質問が解決されたか、許可済み assumption がある場合だけ進める
- `GEMINI_API_KEY` 未設定 warning と、401/403 の invalid key error を混同しない
- TypeScript error では repo 全体の歴史的 debt を一気に直そうとしない。失敗の主因から順に止血する
