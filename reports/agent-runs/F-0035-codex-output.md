## Findings — suite設計、乖離監視の算出方法、judgeルーティング変更点

`npm run eval -- --suite golden` を追加しました。デフォルト対象は `fumoto-growth,togakushi-camp,ena-promo`、`--projects a,b,c` と `--divergence-threshold n` で上書きできます。suite 本体は [runtime/eval/suite.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/eval/suite.ts:10)、CLI 分岐は [scripts/eval.ts](/Users/mocchalera/Dev/video-os-v2-spec/scripts/eval.ts:40) です。

乖離監視は、構造一致スコアと LLM judge が走った brief-alignment を primary の `structure/alignment` 平均にし、verified な F-0023 `visual_qa` の Marlin score と絶対差分を取ります。差分が閾値超えなら `WARNING`。`deterministic-only` の brief-alignment は `参考値` として primary 平均から除外します。

brief-alignment judge は Gemini 直結から `editorial-llm` 経由に変更し、`codex_exec -> claude_cli -> gemini -> deterministic` の順にルーティングします。judge 不実行時は `judge_source: "deterministic-only"` と `decision_runtime` を report に残します。主な変更は [runtime/eval/brief-alignment-judge.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/eval/brief-alignment-judge.ts:184) と [runtime/eval/brief-alignment.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/eval/brief-alignment.ts:366) です。

## Evidence — 変更ファイル一覧、テストコマンドと結果件数

変更ファイル:
- [runtime/eval/suite.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/eval/suite.ts:322) 新規 suite 集計、skip、前回比、Markdown/JSON 出力
- [scripts/eval.ts](/Users/mocchalera/Dev/video-os-v2-spec/scripts/eval.ts:217) `--suite golden` CLI 追加
- [runtime/eval/brief-alignment-judge.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/eval/brief-alignment-judge.ts:205) editorial-llm 経由化
- [runtime/eval/brief-alignment.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/eval/brief-alignment.ts:432) `judge_source` / `decision_runtime` 記録
- [runtime/eval/brief-alignment-types.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/eval/brief-alignment-types.ts:28) additive report 型
- [runtime/review/visual-qa.ts](/Users/mocchalera/Dev/video-os-v2-spec/runtime/review/visual-qa.ts:67) suite 用 Marlin report 出力先 option
- [tests/brief-alignment.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/brief-alignment.test.ts:259) judge routing / deterministic-only テスト
- [tests/eval-suite.test.ts](/Users/mocchalera/Dev/video-os-v2-spec/tests/eval-suite.test.ts:102) suite 集計 / skip / WARNING テスト

検証:
- `pcl validate --strict --json`: ok, errors 0, warnings 0
- `npx tsc --noEmit`: pass
- `npx vitest run tests/brief-alignment.test.ts tests/eval-suite.test.ts`: 2 files passed, 15 tests passed
- `npm test`: 146 files passed, 4 skipped; 2540 tests passed, 39 skipped
- `npx tsx scripts/eval.ts --suite golden --projects does-not-exist --no-write`: exit 0、skip summary 出力確認

コミットはしていません。禁止領域の `.project-loop/`, `.env*`, `projects/*/02_media`, `projects/*/09_output` は変更していません。

<oai-mem-citation>
<citation_entries>
MEMORY.md:1307-1353|note=[repo project-loop rules and validation posture]
MEMORY.md:4431-4444|note=[prior LLM JSON connector context]
MEMORY.md:4587-4627|note=[eval work patterns and golden project context]
</citation_entries>
<rollout_ids>
019f1bb5-512f-75e2-998b-6471acd1bc2b
019ecb0a-99b2-72e2-8f09-5d2b692ad637
019ecaa6-8380-7c42-8d96-8a30d4d83179
019eca07-61eb-7e92-867c-d3cf6c0ba2cf
</rollout_ids>
</oai-mem-citation>
