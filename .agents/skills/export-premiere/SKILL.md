---
name: export-premiere
description: Use when timeline.json exists and the user asks to export the rough cut or an editable handoff packet to Premiere Pro.
metadata:
  filePattern:
    - '**/09_output/*_premiere.xml'
    - '**/09_output/editor_packet/manifest.json'
  bashPattern:
    - 'export-premiere'
    - 'export-premiere-xml'
---
# export-premiere
## いつ使うか
- 「Premiere に出して」「XML を書き出して」と言われたとき。
- `05_timeline/timeline.json` を外部 NLE で詰めたいとき。

## 前提条件
- `timeline.json` と asset ごとの media path が必要。
- 実務上は XML単体ではなく、XML・注釈・review・preview/final mediaを束ねた editor packet を既定にする。
- Studioで見えている完成状態を渡す場合、先に playback contract が `exact` であることを確認する。

## やること（ステップ）
1. playback contract と packet readiness を確認する。

```bash
swift run --package-path apps/macos-studio videoos-studio-cli playback-contract-status <project-id>
swift run --package-path apps/macos-studio videoos-studio-cli handoff-packet-status <project-id>
```

2. `asset_id -> absolute file path` の source map JSON を用意する。自動解決できない場合だけ明示mapを使う。

```json
{
  "AST_31A9CDC2": "/absolute/path/to/file.MOV"
}
```

3. editor packet をエクスポートし、manifestを検証する。

```bash
swift run --package-path apps/macos-studio videoos-studio-cli handoff-export-packet <project-id>
swift run --package-path apps/macos-studio videoos-studio-cli handoff-packet-verify <project-id>
```

4. XML単体が必要な場合だけ従来CLIを使う。

```bash
npx tsx scripts/export-premiere-xml.ts projects/<project> --source-map /absolute/path/to/source-map.json
```

video clip に `metadata.zoom` / `crop` / `position` / `render.effects` が宣言されている場合、まず非破壊 preflight を行う。

```bash
node_modules/.bin/tsx scripts/export-premiere-xml.ts projects/<project> --preflight --json
```

`bake_required` は exit 2 であり、元映像を未処理のまま書き出してはならない。rights が `operator_declared_ok|licensed`、privacy が `operator_declared_ok` で、source-ledger / source-map / source-media-manifest / live file が一意に一致する場合だけ、明示 consent で video-only bake を生成する。

```bash
node_modules/.bin/tsx scripts/export-premiere-xml.ts projects/<project> --bake-visual-effects --json
```

固定 cache は `09_output/premiere-bakes`、export authority は `09_output/premiere-exports/CURRENT.json`。bake は H.264 CRF 14 near-lossless、BT.709 limited、single-thread、`bframes=0` で、`effect_editable:false` の非編集可能な derived media。output-root override はない。canonical audio は元 source の独立 clipitem を維持する。

`timeline.tracks.overlay` の全クリップはXML生成前に検査する。現在登録済みのcanonical presetはmotion/font/layout/shadow/stroke/accent/panel/background/safe-area等の必須semanticsを持ち、Outline Textでは正確に表現できないため、構造化style errorでXML/receipt書込み前に停止する。登録済みplain-title exact routeは現在ない。caption trackはtitleに変換しない。

simple transition は `crossfade` を正確な Cross Dissolve、`match_cut_bridge` / `match_cut` を正確な Dip to Color としてのみ出力する。`fade_to_black` を Cross Dissolve に置換しない。transition ID と track 上の隣接 endpoint は一意、duration は明示的な正の整数、alignment は center、window は両隣 clip のtimeline区間内でなければ、XML/receipt書込み前に構造化エラーで停止する。source handle authority は生成せず、profile は `report_only` のままにする。

5. packet内の XML を Premiere Pro で `File -> Import` する。字幕が有効な案件では caption sidecar と承認artifactも編集者へ渡す。

## 出力 artifact
- `09_output/<project_id>_premiere.xml`
- `09_output/<project_id>_premiere.roundtrip.json`（XMLと同時生成されるapply用receipt）
- `09_output/editor_packet/manifest.json`
- `09_output/editor_packet/media/*`

## 注意事項
- script の auto-resolve は `03_analysis/` 内の top-level JSON にある `asset_id` と `source_path` を探す。canonical な `assets.json.items[]` は直接見ないので、`assets.json` だけでは足りないことが多い。
- source map が 0 件だと export は失敗する。
- 形式は Premiere 向け FCP7 XML。
- XMLをPremiereへ渡すときは、同時生成された`.roundtrip.json`も保持する。同じraw `timeline.json`からの再exportでは同じ`roundtrip_id`になる。
- canonical overlayがある場合、legacy `--titles` / `--auto-titles` は重複titleを避けるため、解決結果が空でも書込み前に失敗する。
- canonical titleは全required semanticsがOutline Text parametersで表現できるpresetだけが対象であり、現在は該当presetがない。警告劣化やlegacy titleへの置換は行わない。
- packet verifyが通っても playback contractがstaleなら完成状態の保証にはならない。両方を確認する。
- 字幕有効時は packet manifest に `caption_sidecar` と `caption_approval` が含まれることを確認する。欠けていればpackage後にpacketを再exportする。
- synthetic fixture の成功は Premiere hardware proof ではなく、simple transition profile を昇格させない。
- bake manifest/index/receipt v2/READY が全て一致しても `hardware_verified:false` のままであり、editable effect、human approval、rights clearance、Premiere実機証明を主張しない。
