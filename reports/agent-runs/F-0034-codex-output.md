## Findings — 進捗/ETA機構の設計、README再構成の概要

`runtime/progress.ts` に staged progress / ETA / `03_analysis/pipeline-timings.json` の読み書きを追加しました。履歴があれば過去実測、なければセグメント数fallback、どちらも無ければ `計測中` で表示します。TTYは1行更新、非TTYは行追記です。

`editorial-pipeline`、`runtime/commands/full-pipeline`、`build-footage-db`、新規 `scripts/full-pipeline.ts` に接続しました。失敗時メッセージには stage 名、次に試すコマンド、`troubleshoot-error` skill誘導を含めています。

READMEはQuick Startを `npm run full-pipeline -- --project ... --source-dir ...` 先導に再構成し、従来の4コマンドチェーンは Advanced / ステージ個別実行へ降格しました。F-0033出口として `npm run package -- projects/<id>` も追記済みです。

## Evidence — 変更ファイル一覧、テストコマンドと結果件数

変更ファイル:
`README.md`, `package.json`, `.agents/skills/full-pipeline/SKILL.md`, `runtime/progress.ts`, `runtime/commands/analyze.ts`, `runtime/commands/full-pipeline.ts`, `runtime/pipeline/ingest.ts`, `scripts/full-pipeline.ts`, `scripts/build-footage-db.ts`, `scripts/editorial-pipeline.ts`, `tests/progress.test.ts`

検証:
`npx tsc --noEmit` passed  
`npm test` passed: Test Files `145 passed | 4 skipped (149)`, Tests `2535 passed | 39 skipped (2574)`

未コミットです。`git status --short` は上記変更と新規 `scripts/full-pipeline.ts` のみです。

<oai-mem-citation>
<citation_entries>
MEMORY.md:2051-2063|note=[full pipeline prior chain and artifact context]
MEMORY.md:1856-1888|note=[editorial pipeline QA loop fail-open context]
</citation_entries>
<rollout_ids>
019ee24b-73ea-73a3-a9ea-1400f27ab587
019ee54b-5aaf-7451-b15e-93fe6c018423
</rollout_ids>
</oai-mem-citation>
