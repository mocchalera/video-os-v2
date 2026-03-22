---
name: import-premiere
description: Use when an edited Premiere Pro FCP7 XML should be compared against timeline.json or imported back into the project.
metadata:
  filePattern:
    - '**/05_timeline/timeline.json'
  bashPattern:
    - 'import-premiere'
    - 'import-premiere-xml'
---
# import-premiere
## いつ使うか
- 「Premiere から取り込んで」「XML の変更を反映して」と言われたとき。
- Premiere 側で trim / reorder / delete を行った XML を `timeline.json` に戻したいとき。

## 前提条件
- `05_timeline/timeline.json` と 編集済み FCP7 XML があること。
- まず `--dry-run` で diff を確認すること。

## やること（ステップ）
1. dry-run で差分を確認する。

```bash
npx tsx scripts/import-premiere-xml.ts projects/<project> --xml /absolute/path/to/edited.xml --dry-run
```

2. diff が妥当なら本適用する。

```bash
npx tsx scripts/import-premiere-xml.ts projects/<project> --xml /absolute/path/to/edited.xml
```

3. 出力された diff report を読み、`trim_changed`, `reordered`, `deleted`, `added_unmapped` の内容を確認する。

## 出力 artifact
- 更新された `05_timeline/timeline.json`
- 自動バックアップ `05_timeline/timeline.json.bak`
- stdout の diff report

## 注意事項
- `--dry-run` では `timeline.json` は更新されない。
- `added_unmapped` は自動適用されず、manual review 前提。
- 専用の report JSON は書かれない。差分は stdout にしか出ない。
