# G-0002 closure audit — 2026-07-12

## Verdict

`G-0002`（映像品質と評価の信頼性回復）は、目標としてclose可能である。

`docs/improvement-plan-ux-quality-20260706.md`で特定した「評価の偽装」「実映像QAの欠落」「品質シグナルの無条件通過」「並行パイプライン」「連続性・recall・render経路・回帰リグの断絶」は、F-0022〜F-0036および後続のspeech-led productization作業で実装・検証された。

このcloseは、すべての映像が高得点になったという意味ではない。低品質や不完全なgoldenを低く測り、mock・skip・欠損を成功として扱わず、構造評価と実映像評価を分離できる状態になったことを意味する。

## Closure evidence

### 1. 評価の偽装排除と実映像ゲート

- placeholder Marlin 100点経路は廃止され、blocked / unavailable / mockは合格扱いされない。
- speech-led real-media regressionはlive Marlin、render parity、critical issue、durationをfail-closedで検証する。
- self-hosted runnerのaccepted run `29094676190`はlive inference、`mock=false`、Marlin 100/100で成功した。
- companion CI run `29094670413`はproduct-gateを含む全8ジョブに成功した。

### 2. 決定論評価経路

2026-07-12に次を実行した。

```sh
PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" npm run eval -- --suite golden --no-write
```

結果:

- exit code: `0`
- `--judge`未指定のためLLM judgeは起動しない。
- `--marlin`未指定のためlive Marlinは起動しない。
- 実行前後の`git status --porcelain` SHA-256は同一:
  `fafce7a689b2e5e7d786f93fb4b93ba8912992a003ec7089103cd6e2183731b6`
- scores: fumoto 52、togakushi 100、ena 100、AX-1小松 100、AX-1女性 100。
- Marlin未要求は`marlin_qa_score_unavailable`として明示的にskippedとなり、偽のvisual passにはならない。

### 3. 現行回帰

commit `fd908164`で`npm run verify -- --full`を実行し、全ゲートが成功した。

- Node: 162 files passed、4 skipped。
- tests: 2,665 passed、39 skipped。
- demo schema validation: passed。
- review metrics: passed。
- golden agreement gate: passed。
- render parity: 65 passed。

### 4. 後続の実証

- `lively-alt-vol5`でrights-cleared human golden、resume、Studio exact preview、Premiere XML 12/12 zero-diff round-tripを実証した。
- AX-1の2話者testimonialをhuman golden化し、speech-led review metrics、2-beat cadence、single-source treatmentを回帰対象にした。
- AX-1の保存済みlive Marlin reportsは小松76、女性92で、どちらも`visual_qa=verified`。警告は隠さず残している。

## Residuals outside the goal

- `fumoto-growth`の52点は評価基盤の失敗ではなく、古いgolden品質を再承認または置換すべきという正直な信号である。
- F-0022〜F-0036の一部は`passing`のまま残る。これは古いtest evidenceが現行Project Loopの`evidence-set/v1` / `completion-policy/v1` receipt導入前に記録されたためで、製品実装の未検証を意味しない。履歴移行として別管理する。
- candidate range単位のvisual similarity、event-recap profile実証、Studioの継続的リファクタリングは次のロードマップであり、G-0002 closeの条件には含めない。

## Close recommendation

`G-0002`をevidence-backedでcloseし、次はcurrent `Dev`をpublishしてCIを確認した後、共通パイプライン上の第2プロファイルとしてevent-recapを実証する。
