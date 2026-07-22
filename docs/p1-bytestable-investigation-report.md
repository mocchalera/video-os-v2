# P1 Manifest + Coverage byte-stable investigation report

## 1. Verdict

Verdict: **(A) P1 起因ではない**

Confidence: **high**

`npm run demo` の byte-stable 失敗は、既存 demo script が実行時刻を `created_at` に注入するために起きている。P1 の変更を含む現在の worktree でも、P1 を含まない `HEAD` archive でも、再生成後の `timeline.json` は baseline と `created_at` だけが異なる。

## 2. 各 Step の実行結果ログ

### Step 1: P1 変更ポイントの diff 確認

実行コマンド:

```bash
git diff -- runtime/commands/analyze.ts runtime/commands/status.ts runtime/state/reconcile.ts runtime/validation/schema-validator.ts scripts/init-project.ts
git diff --cached -- runtime/commands/analyze.ts runtime/commands/status.ts runtime/state/reconcile.ts runtime/validation/schema-validator.ts scripts/init-project.ts
sed -n '1,520p' docs/p1-manifest-coverage-implementation-notes.md
```

確認結果:

- `runtime/commands/analyze.ts`: `ENABLE_P1_MANIFEST_COVERAGE` / `ENABLE_P1_MANIFEST` が truthy のときだけ manifest / coverage を write。OFF 時は `p1Artifacts=[]` で従来 analyze artifacts に空配列を concat するだけ。
- `runtime/commands/status.ts`: coverage summary は `isP1ManifestCoverageEnabled()` が true のときだけ read / expose。OFF 時は `coverage: undefined`。
- `runtime/state/reconcile.ts`: coverage gate override は feature flag ON のときだけ read。OFF 時は従来の `analysisGate` 算出に戻る。
- `runtime/validation/schema-validator.ts`: optional artifact registry 追加。`npm run demo` は validator を呼ばないため、demo compile path には入らない。
- `scripts/init-project.ts`: P1 の manifest write は feature flag ON かつ source dir ありの場合のみ。なお `09_output` 追加は staged 既存差分として別に存在。

P1 実装ノートの記録:

```text
Baseline: 011dbadafa7529ed057e88aafc217408c22947a86ad23302a47bc4dac3739eb7
Reported after npm run demo: 565723e23c61929a5ed5e77e730113c6a8a0768bb7ddc4777b242c338d90a81a
Feature flag default: OFF
```

### Step 2: timeline.json の差分中身

事前 hash:

```bash
node -e "..." # sha256
```

```text
011dbadafa7529ed057e88aafc217408c22947a86ad23302a47bc4dac3739eb7  projects/demo/05_timeline/timeline.json
```

`npm run demo` 実行後 hash:

```text
c4dd0393d9aeedf1f163149f650caa049726ba821f33945e7adfdf12f1ef5547  projects/demo/05_timeline/timeline.json
eb3089fc3761a37964bbad70c66e9904d4cac001b38dded607c58b2de73496e1  projects/demo/05_timeline/preview-manifest.json
```

`git diff` 抜粋:

```diff
diff --git a/projects/demo/05_timeline/timeline.json b/projects/demo/05_timeline/timeline.json
@@ -1,7 +1,7 @@
 {
   "version": "1",
   "project_id": "sample-mountain-reset",
-  "created_at": "2026-03-22T16:19:21.882Z",
+  "created_at": "2026-04-26T13:55:11.568Z",
   "sequence": {
```

構造比較:

```text
timeline_diff_count=1
/created_at: "2026-03-22T16:19:21.882Z" -> "2026-04-26T13:55:11.568Z"
equal_ignoring_created_at=true
preview_diff_count=1
/created_at: "2026-03-22T16:19:21.882Z" -> "2026-04-26T13:55:11.568Z"
preview_equal_ignoring_created_at=true
```

分類: **timestamp / 日時のみ**。UUID、random ID、path、順序、数値誤差、構造的内容の差分は検出なし。

補足: 今回の再生成 hash は報告値 `565723...` ではなく `c4dd03...` だった。これは `created_at` が実行ごとに変わるためで、hash 不一致の性質と整合する。

### Step 3: P1 退避時の再現確認

ユーザー制約に `git 操作しない` と `P1 以外の dirty worktree を絶対に触らない` があるため、`git stash` / `git worktree add` は実行しなかった。代替として、状態を変えない `HEAD` archive を `/tmp` に展開し、既存 `node_modules` symlink で P1 なし相当の `npm run demo` を実行した。

実行コマンド:

```bash
TMPHEAD=$(mktemp -d /tmp/vos-head-demo.XXXXXX)
git archive HEAD | tar -x -C "$TMPHEAD"
ln -s /Users/operator/Dev/video-os-v2-spec/node_modules "$TMPHEAD/node_modules"
(cd "$TMPHEAD" && npm run demo)
```

P1 なし相当の再生成 hash:

```text
ae79dc8d80830a5bd0e2fef1e6132217e3b9a95170a509b5053d58dfd1249fe5  projects/demo/05_timeline/timeline.json
2a1222ae79620f60d3656a64f4b525810918b13e6572521b178873dd6a6db715  projects/demo/05_timeline/preview-manifest.json
```

baseline との差分:

```diff
@@ -1,7 +1,7 @@
 {
   "version": "1",
   "project_id": "sample-mountain-reset",
-  "created_at": "2026-03-22T16:19:21.882Z",
+  "created_at": "2026-04-26T13:56:34.416Z",
   "sequence": {
```

結果: **P1 を含まない HEAD でも baseline hash と一致しない**。差分は `created_at` のみ。

### Step 4: クリーン環境確認

`git worktree add` と `npm install` は実行していない。Step 3 の `HEAD` archive 検証で P1 なし相当でも同じ timestamp drift が再現したため、重い clean install は不要と判断した。

追加で、`/tmp` の demo コピーに baseline timestamp を固定して compiler を実行した。

```text
011dbadafa7529ed057e88aafc217408c22947a86ad23302a47bc4dac3739eb7  05_timeline/timeline.json
a7be0da29f870f39f8a735b060e398c7abccc064cc55be64c691e962f6349257  05_timeline/preview-manifest.json
```

`timeline.json` は baseline hash に完全一致した。つまり compile output の可変要素は `created_at` で説明できる。

### Step 5: 既存 demo の再現性

`scripts/demo.ts` は毎回 `compile({ createdAt: new Date().toISOString() })` を渡している。`runtime/compiler/export.ts` はその値を `timeline.created_at` と `preview-manifest.created_at` に書く。

該当箇所:

```text
scripts/demo.ts: compile({ ..., createdAt: new Date().toISOString() })
runtime/compiler/index.ts: const createdAt = opts.createdAt
runtime/compiler/export.ts: created_at: opts.createdAt
runtime/compiler/export.ts: preview manifest uses timeline.created_at
```

このため、`npm run demo` は baseline timestamp と同じ時刻を注入しない限り byte-stable にはならない。

## 3. P1 の 5ファイル diff レビュー所見

P1 の 5ファイルは compiler / timeline 生成 path に直接影響していない。

- `scripts/demo.ts` は `../runtime/compiler/index.js` だけを import し、P1 の `runtime/commands/*`、`runtime/state/reconcile.ts`、`runtime/validation/schema-validator.ts`、`scripts/init-project.ts` を経由しない。
- P1 の artifact module import は `analyze/status/reconcile/schema-validator/init-project` に閉じており、compiler module から参照されていない。
- P1 feature flag OFF 時、write/read/gate override は実行されない。
- `schema-validator.ts` の optional artifact registry は validator 実行時のみ影響し、`npm run demo` の compile path には入らない。
- `scripts/init-project.ts` は demo compile path では実行されない。

## 4. timeline.json 差分の性質分類

| 分類 | 結果 |
| --- | --- |
| timestamp / 日時 | **該当**。`/created_at` のみ差分 |
| UUID / random ID | 非該当 |
| path | 非該当 |
| 順序 | 非該当 |
| 数値 / 小数誤差 | 非該当 |
| 構造的内容 | 非該当 |

`created_at` を除外すると `timeline.json` と `preview-manifest.json` は完全一致。

## 5. P1 退避時の hash 検証結果

`stash` は実行していない。代替の `HEAD` archive による P1 なし相当検証では:

```text
baseline:        011dbadafa7529ed057e88aafc217408c22947a86ad23302a47bc4dac3739eb7
P1なし再生成:   ae79dc8d80830a5bd0e2fef1e6132217e3b9a95170a509b5053d58dfd1249fe5
差分:           /created_at のみ
```

また baseline timestamp 固定 compile では:

```text
fixed-createdAt: 011dbadafa7529ed057e88aafc217408c22947a86ad23302a47bc4dac3739eb7
```

## 6. 結論の根拠

1. P1 ありの現在 worktree で `npm run demo` を実行しても、差分は `created_at` だけだった。
2. P1 なし相当の `HEAD` archive でも `npm run demo` は baseline hash と一致せず、差分は `created_at` だけだった。
3. baseline の `created_at` を固定して compiler を実行すると、`timeline.json` の hash は baseline に完全一致した。
4. P1 の変更ファイルは demo compiler path から参照されず、feature flag OFF 時の write/read/gate override も実行されない。

したがって、報告者の「P1 起因ではなく既存 demo 再生成差分」「P1 は compiler/demo path に触っていない」という弁明は妥当。

## 7. P2 着手前にやるべきこと

P2 着手は **go** でよい。ただし byte-stable acceptance の扱いは P2 前に明確化するべき。

- `npm run demo` を byte-stable gate にするなら、demo script に固定 `createdAt` を渡す仕様にする。
- runtime の実行時刻を残す必要があるなら、byte-stable 比較では `created_at` を除外する canonical hash を採用する。
- acceptance 文言を「semantic stable」か「byte stable」かに分ける。現状の `npm run demo` は byte-stable ではない。

## 8. 原状回復確認

`npm run demo` で一時的に生成された `projects/demo/05_timeline/timeline.json` と `projects/demo/05_timeline/preview-manifest.json` は退避コピーから復元済み。`projects/demo/project_state.yaml` は作成されていない。

確認コマンド:

```bash
git diff -- projects/demo/05_timeline/timeline.json projects/demo/05_timeline/preview-manifest.json projects/demo/project_state.yaml
git status --short docs/p1-bytestable-investigation-report.md projects/demo/05_timeline/timeline.json projects/demo/05_timeline/preview-manifest.json projects/demo/project_state.yaml
```

結果:

```text
# git diff output: empty
# scoped git status before report creation: empty
```

本タスク由来の最終想定差分:

```text
?? docs/p1-bytestable-investigation-report.md
```

stash / stash pop は実行していないため、stash 原状回復対象はない。
