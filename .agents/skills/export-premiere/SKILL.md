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

5. packet内の XML を Premiere Pro で `File -> Import` する。字幕が有効な案件では caption sidecar と承認artifactも編集者へ渡す。

## 出力 artifact
- `09_output/<project_id>_premiere.xml`
- `09_output/editor_packet/manifest.json`
- `09_output/editor_packet/media/*`

## 注意事項
- script の auto-resolve は `03_analysis/` 内の top-level JSON にある `asset_id` と `source_path` を探す。canonical な `assets.json.items[]` は直接見ないので、`assets.json` だけでは足りないことが多い。
- source map が 0 件だと export は失敗する。
- 形式は Premiere 向け FCP7 XML。
- packet verifyが通っても playback contractがstaleなら完成状態の保証にはならない。両方を確認する。
- 字幕有効時は packet manifest に `caption_sidecar` と `caption_approval` が含まれることを確認する。欠けていればpackage後にpacketを再exportする。
