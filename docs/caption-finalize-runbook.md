# caption-finalize 運用手順

`caption-finalize` は、人間が承認した字幕intentと、その字幕に束縛された納品成果物を一つのgenerationとして確定するtransactionです。`caption_approval.json` だけが新しく、ASS/final/QA/package/previewが旧版という混在を許しません。

## 実行

前提は、`05_timeline/timeline.json`、承認済み `07_package/caption_approval.json`、`project_state.yaml` の `approved` または `packaged`、Gate 10に必要なレビュー/引継ぎ判断です。

```bash
npm run caption-finalize -- --help
npm run caption-finalize -- run --project projects/<project-id>
```

Editor serverからは既存`render` phaseを変更せず、独立phaseを明示します。routeはphase別の許可optionだけをworkerへ渡します。

```json
{
  "phase": "caption-finalize",
  "options": {
    "supplied_final_path": "/absolute/path/to/export.mp4",
    "skip_render": false
  }
}
```

NLEやdirect-sourceの書き出しを使う場合は、そのMP4を直接canonical pathへ置き換えず、次のように渡します。

```bash
npm run caption-finalize -- run \
  --project projects/<project-id> \
  --supplied-final /absolute/path/to/export.mp4
```

`caption-finalize`へ渡した入力はgeneration内の `staging/direct-render.mp4` へhash照合付きでコピーされ、`staging/direct-render-receipt.json` が作成されてからfinalizeされます。既存`render` jobの意味は変更せず、atomic caption-bound deliveryが必要な操作は独立した`caption-finalize` jobを明示して実行します。

字幕・章タイトルの映像がすでに承認済みで、MAだけを変更するときは映像全体を再encode
しません。元generation receiptを明示して`audio-finish-remux`を使うと、音声だけを
2-pass処理して再muxし、前後のvideo stream SHA-256が同一であることを検証します。

```bash
npm run audio-finish-remux -- \
  --project projects/<project-id> \
  --source-receipt projects/<project-id>/07_package/caption-finalize/generations/<id>/caption-finalize-receipt.json \
  --finalize
```

Studioでは完パケ承認後に`caption_approval.json`のstatus/hashを確認し、「承認字幕で再レンダー」を明示的に押します。承認操作だけでは重いfinalizeを開始しません。再起動後もqueueが現行draft/patch/validationと一致するapprovalを`current_approval`として復元します。古いapprovalはfinalize対象から外れますが、再承認を妨げません。

新規generationは`caption-finalize-receipt/v2`を使い、staging manifest由来のfont path/hash/familyとfallback有無を記録します。manifest v2の`selected_family`と`selected_asset`は、ASS・Studio previewが実際に使うrole/path/hash/weightを固定します。`clean-lower-third`は検証済み`VideoOS Noto Sans JP Black`/900を選び、ASS synthetic boldを使いません。v1 receiptは引き続き読み取り可能です。preview receipt v2はapproval/timeline/font manifest hashと、Node生成時に計算したvideo hashを保持します。Studioは大容量videoを同期SHA256せず、hash済みreceiptとsmall artifact hash、video size/mtimeを検証します。不正な`active_delivery.json`がある場合はlegacyへfallbackしません。

旧 `09_output/final.mp4` をrepair入力として扱う前に、書き込みなしで計画を確認できます。

```bash
npm run caption-finalize -- repair-direct-render \
  --project projects/<project-id> \
  --dry-run
```

## 生成物契約

```text
07_package/
  active_delivery.json
  caption-finalize/
    intents/<approval-sha256>.json
    generations/<generation-id>/
      captions/speech.ass
      captions/speech.approved.srt
      captions/speech.vtt
      font-manifest.json
      fonts/<manifest-selected-assets>
      video/final.mp4
      qa-report.json
      package_manifest.json
      preview/final.mp4
      preview/receipt.json
      caption-finalize-receipt.json
```

- `intents/<hash>.json` は承認ファイルのcontent-addressed、read-onlyコピーです。既存intentは上書きしません。
- generation IDは`caption_finalize_contract:v2`、approval、timeline、source-input attestation、supplied final、legacy inputのmusic cues、primary/ASS-heavyの検証済みhash、選択font family/role/hashから決まります。同一入力の再実行は検証済みgenerationを再利用します。旧v1 generationは保持されますが、新規の明示finalizeでは別のv2 generationを作ります。
- ASS/SRTはrational FPSと共有ASS builderから生成します。プロジェクト固有の旧ASSヘッダには依存しません。
- QA全check、package manifest、package verification、`package-preflight/v2`、pointer/receiptの全SHA-256が成功した場合だけactive pointerをtemp fileからatomic renameします。
- pointerの動画entryはSHA-256に加えてsize/mtime identityを持ちます。Studioは小artifactを即時SHA検証し、約1GB級の動画はhash-bound receiptとsize/mtimeを同期確認します。全動画SHAのsemantic oracleはpackage/publication preflight等の明示的な非同期Node gateです。

## 入力と出力の分離

`deliveryOutputDir` はgeneration専用の出力rootです。承認intentは明示path、`07_package/music_cues.json`、音楽asset/provenance、その他の既存入力sidecarはproject側の入力rootから読みます。generation内に同名の古いsidecarが残っていても入力には使いません。

## failureと再実行

stage、write、QA、package verification、preflight、pointer activationのいずれかが失敗した場合、既存 `active_delivery.json` は変更されません。失敗した非active generationは次回同一入力の実行時に作り直されます。検証済みgenerationのactivationだけが失敗した場合は、そのgenerationを再利用してpointer切替を再試行します。

同一generationの並列実行はlockで拒否します。失敗理由を直して同じコマンドを再実行してください。

## 移行とfail-closed

- `active_delivery.json` が存在しない旧プロジェクトでは、package、publication preflight、Studio preview/media resolver、render statusが従来のcanonical pathへfallbackします。
- pointerが存在するのにJSON/schema/path/file/hash/receipt/identityが不正な場合はinvalidです。legacy canonical pathへfallbackしません。
- pointerを手動編集して回復させず、原因artifactを修復して`caption-finalize`を再実行するか、保存済みの正しいpointerへ運用上の管理手順で戻してください。

## 検証コマンド

```bash
PATH=/path/to/node-v22.23.1/bin:$PATH npx vitest run tests/caption-finalize.test.ts --configLoader runner
PATH=/path/to/node-v22.23.1/bin:$PATH npx tsc --noEmit
PATH=/path/to/node-v22.23.1/bin:$PATH npm run build
swift test --filter ProjectActiveDeliveryTests
swift build --target VideoOSStudio
git diff --check
```
