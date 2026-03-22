---
name: export-premiere
description: Use when timeline.json exists and the user asks to export the rough cut to Premiere Pro as FCP7 XML.
metadata:
  filePattern:
    - '**/09_output/*_premiere.xml'
  bashPattern:
    - 'export-premiere'
    - 'export-premiere-xml'
---
# export-premiere
## いつ使うか
- 「Premiere に出して」「XML を書き出して」と言われたとき。
- `05_timeline/timeline.json` を外部 NLE で詰めたいとき。

## 前提条件
- `scripts/export-premiere-xml.ts` は `timeline.json` と asset ごとの media path が必要。
- 実務上は `--source-map <json>` を渡す前提で考える。

## やること（ステップ）
1. `asset_id -> absolute file path` の source map JSON を用意する。

```json
{
  "AST_31A9CDC2": "/absolute/path/to/file.MOV"
}
```

2. エクスポートする。

```bash
npx tsx scripts/export-premiere-xml.ts projects/<project> --source-map /absolute/path/to/source-map.json
```

3. 生成された XML を Premiere Pro で `File -> Import` する。

## 出力 artifact
- `09_output/<project_id>_premiere.xml`

## 注意事項
- script の auto-resolve は `03_analysis/` 内の top-level JSON にある `asset_id` と `source_path` を探す。canonical な `assets.json.items[]` は直接見ないので、`assets.json` だけでは足りないことが多い。
- source map が 0 件だと export は失敗する。
- 形式は Premiere 向け FCP7 XML。
