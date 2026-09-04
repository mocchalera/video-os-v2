---
name: select-photos
description: "MUST USE when the user provides a photo ZIP, photo folder, or still-image event material and asks for photo selection, album selection, highlights, digest photos, curation, or quality filtering. Use this instead of analyze-footage when the source is primarily still photos and the requested work is selecting images rather than editing or video planning."
metadata:
  filePattern:
    - '**/04_plan/photo_selection_manifest.json'
    - '**/04_plan/photo_selection_report.md'
    - '**/03_analysis/eye_review/**'
    - '**/03_analysis/swap_candidates/**'
    - '**/05_delivery/album_select/**'
    - '**/05_delivery/digest_highlights/**'
  bashPattern: []
---
# select-photos — 写真選定

## いつ使うか（必ず発火する条件）

- ユーザーが写真 ZIP、写真フォルダ、イベントスナップ、静止画素材を渡して「写真選定」「セレクト」「フォトアルバム」「ハイライト」「ダイジェスト」を依頼したとき
- 動画編集ではなく、JPG/PNG/HEIC などの静止画から使う写真を選ぶとき
- 「編集しない」「加工しない」「選定だけ」と言われたとき
- `album_select`、`digest_highlights`、`photo_selection_report.md` を作るとき

静止画中心の依頼では `analyze-footage` を流用しない。動画の `segments.json` / STT / peak analysis ではなく、写真向けの品質・重複・場面 coverage を優先する。

## 原則

- 元ファイルは変更しない。展開・コピー・サムネイル生成は作業用プロジェクト配下で行う。
- 写真の編集、トリミング、色補正、リネームによる元ファイル破壊はしない。
- 納品用フォルダに置く画像は、元画像の無加工コピーまたは symlink にする。ユーザーが特に指定しなければコピーを優先する。
- 連写や近似構図は、表情、視線、手の動き、会話感、場面説明力が一番強いものを残す。
- ピント/ブレ/露出の最低限チェックを必ず行う。目視だけでなく、簡易スコアリングで怪しい候補を拾って再確認する。
- 目つぶり/半目の確認を後回しにしない。顔クロップ確認シートを作り、疑わしいカットは前後連番から代替を探す。

## 前提ツール

- `python` + Pillow が使えること。環境によっては repo の `python3` ではなく miniforge など Pillow 入り Python を使う。
- 顔検出は OpenCV があれば使う。無い場合は中央クロップで eye review を作り、目視確認で補う。
- ZIP 展開には `unzip`、納品ZIP作成には Python `zipfile` または `zip` を使う。

## 推奨出力構成

<!-- artifact-producer: agent -->

```text
projects/<project>/
├── 02_media/
│   └── originals/                 # 展開した作業コピー。元ZIP/元フォルダは触らない
├── 03_analysis/
│   ├── contact_sheets/            # 全体確認用
│   ├── photo_metrics.json         # sharpness / exposure などの簡易指標
│   ├── album_select_contact_sheet_*.jpg
│   ├── digest_highlights_contact_sheet_*.jpg
│   ├── low_sharpness_review.jpg   # ブレ/甘ピン疑いの再確認用
│   ├── eye_review/                # 顔クロップ/目つぶり確認用
│   └── swap_candidates/           # 差し替え候補の前後連番シート
├── 04_plan/
│   ├── photo_selection_manifest.json
│   └── photo_selection_report.md
└── 05_delivery/
    ├── album_select/              # 広めのアルバム用セレクト
    ├── digest_highlights/         # さらに絞った代表カット
    ├── album_select_<count>.zip
    └── digest_highlights_<count>.zip
```

## やること（ステップ）

### Step 1: 入力と作業範囲を確定する

- ZIP なら一覧と枚数を確認する。
- フォルダなら対象拡張子と総枚数を確認する。
- 作業プロジェクト名を決め、`projects/<project>/02_media/originals` に作業コピーを作る。
- 展開後ファイルに読み取り権限が無い場合は、作業コピー側だけ権限を直す。元ZIP/元フォルダは触らない。

### Step 2: 全体確認用コンタクトシートを作る

- 連番順または撮影時刻順でサムネイル付き contact sheet を作る。
- 各サムネイルには index と元ファイル名を表示する。
- 40 枚前後ごとに 1 シートにすると、場面の流れと重複を見やすい。
- 写真そのものは加工せず、contact sheet は確認用派生物として `03_analysis/contact_sheets/` に置く。

```bash
python .agents/skills/select-photos/scripts/make_contact_sheets.py \
  --input projects/<project>/02_media/originals \
  --output-dir projects/<project>/03_analysis/contact_sheets
```

### Step 3: 品質指標を作って低品質候補を拾う

最低限、以下を `photo_metrics.json` に記録する。

- file
- width / height
- mean_luma または露出の簡易指標
- edge_score / sharpness proxy
- bytes

指標は NG 判定の自動決定ではなく、怪しい写真を拾うために使う。白い壁、引き絵、余白の多い登壇写真は低 edge になりやすいので、必ず目視で確認する。

`scripts/photo_quality_scan.py` が使える場合は優先して使う。

```bash
python .agents/skills/select-photos/scripts/photo_quality_scan.py \
  --input projects/<project>/02_media/originals \
  --output projects/<project>/03_analysis/photo_metrics.json \
  --review-dir projects/<project>/03_analysis \
  --eye-review-dir projects/<project>/03_analysis/eye_review
```

### Step 4: 選定基準を固定する

イベントダイジェスト/フォトアルバムでは、優先順位は以下。

1. 場面 coverage: 受付/会場/導入/登壇/ワーク/交流/集合写真などの流れが残る
2. 表情: 笑顔、集中、反応、会話の温度がある
3. 構図: 主役が分かる、手前の遮蔽が少ない、背景が説明になる
4. 技術品質: ピント、ブレ、露出、目つぶり、極端な白飛び/黒つぶれ
5. 重複排除: 同じ人物・同じ構図・同じ瞬間を取りすぎない

「記録として必要な写真」は軽微な甘さがあっても残してよい。ただし `photo_selection_report.md` に方針を書く。

目つぶり判定の注意:

- 背景人物や前景人物の目つぶりは原則 NG にしない。主役の顔・表情・目線を優先する。
- 集合写真だけは全員の目つぶりを厳しめに見る。
- 笑って目が細くなっている自然な表情は、他に強い代替がない限り許容してよい。
- 顔検出されない写真を自動 NG にしない。引き絵、横顔、後ろ姿、会場カットはイベント記録として必要なことがある。

### Step 5: セレクトを分ける

- `album_select`: フォトアルバム用の広めの選定。イベント全体の流れと参加者の多様性を優先する。
- `digest_highlights`: 冒頭、告知、SNS、レポートの先頭に使える強い代表カット。`album_select` からさらに絞る。
- 必要なら `review_candidates` または `quality_review` を作り、ブレ/甘ピン/表情迷いをユーザー確認用に分ける。

枚数指定が無い場合の目安:

- 100 枚未満の素材: `album_select` 30-50%、`digest_highlights` 10-20 枚
- 100-500 枚の素材: `album_select` 25-40%、`digest_highlights` 30-60 枚
- 500 枚超の素材: `album_select` 20-35%、`digest_highlights` 40-80 枚

### Step 6: 選定結果を成果物化する

- `05_delivery/album_select/` と `05_delivery/digest_highlights/` に元画像の無加工コピーを置く。
- ファイル名は並び順が分かるように `001_<original_name>` 形式を推奨する。ただし manifest には元ファイル名を必ず残す。
- 各セレクトの contact sheet を作り、選定漏れや重複過多を目視確認する。
- ZIP があると受け渡ししやすいので、指定がなくても delivery に作ってよい。

manifest から delivery を作る場合は `scripts/materialize_selection.py` を使える。

```bash
python .agents/skills/select-photos/scripts/materialize_selection.py \
  --project projects/<project> \
  --manifest projects/<project>/04_plan/photo_selection_manifest.json

python .agents/skills/select-photos/scripts/make_contact_sheets.py \
  --input projects/<project>/05_delivery/album_select \
  --output-dir projects/<project>/03_analysis \
  --prefix album_select_contact_sheet

python .agents/skills/select-photos/scripts/make_contact_sheets.py \
  --input projects/<project>/05_delivery/digest_highlights \
  --output-dir projects/<project>/03_analysis \
  --prefix digest_highlights_contact_sheet
```

### Step 6.5: 目つぶり/表情の差し替え確認を標準で行う

`album_select` と `digest_highlights` を作ったあと、主要人物の顔が見える写真は `eye_review` で確認する。

- 目つぶり、半目、主役の表情が弱いカットを `review_candidates` に記録する。
- 疑わしい写真ごとに、元素材の前後 5-8 枚を `swap_candidates` として並べる。
- 差し替える場合は、単体のピント/表情だけでなく、イベントの流れと人物の重複も確認する。
- 差し替えたら `photo_selection_manifest.json` に `eye_recheck_replacements` を残す。
- 差し替え前後の確認シートを作る。

```bash
python .agents/skills/select-photos/scripts/make_swap_candidates.py \
  --input projects/<project>/02_media/originals \
  --output-dir projects/<project>/03_analysis/swap_candidates \
  --candidates <comma-separated-filenames>
```

### Step 7: 品質チェックして報告する

最低限やること:

- 元素材枚数、`album_select` 枚数、`digest_highlights` 枚数を確認する。
- manifest の全ファイルが `02_media/originals` に存在することを確認する。
- 低 sharpness 候補の contact sheet を作り、致命的なブレが混ざっていないか確認する。
- eye review / swap candidates を確認し、目つぶり候補を差し替え済みか、意図的に残したかを明示する。
- 「最低限のピント/ブレ選定済み」か「二次選定推奨」かを明示する。

## 出力 artifact

<!-- artifact-producer: agent -->

- `03_analysis/contact_sheets/*.jpg`
- `03_analysis/photo_metrics.json`
- `03_analysis/album_select_contact_sheet_*.jpg`
- `03_analysis/digest_highlights_contact_sheet_*.jpg`
- `03_analysis/low_sharpness_review.jpg`
- `03_analysis/eye_review/*.jpg`
- `03_analysis/swap_candidates/*.jpg`
- `04_plan/photo_selection_manifest.json`
- `04_plan/photo_selection_report.md`
- `05_delivery/album_select/`
- `05_delivery/digest_highlights/`
- `05_delivery/*.zip`

## `photo_selection_manifest.json` の最低項目

```json
{
  "source": "/path/to/source.zip",
  "source_count": 524,
  "selection_policy": [
    "無加工の元JPGを使用",
    "重複連写は表情・構図が強いものを優先",
    "ピント/ブレ/露出の最低限チェックを実施"
  ],
  "album_select_count": 169,
  "digest_highlights_count": 45,
  "album_select": ["DSC0001.JPG"],
  "digest_highlights": ["DSC0001.JPG"],
  "review_candidates": [
    {
      "file": "DSC0002.JPG",
      "reason": "main subject half closed eyes",
      "recommended_action": "check neighboring frames"
    }
  ],
  "eye_recheck_replacements": [
    {
      "old": "DSC0002.JPG",
      "new": "DSC0003.JPG",
      "reason": "main subject eyes open in neighboring frame"
    }
  ]
}
```

## 注意事項

- 写真の内容に個人情報、機密資料、顔出し配慮がありそうな場合は、選定後に privacy review を提案する。
- 機械的な sharpness score だけで落とさない。集合写真、会場引き絵、登壇スライド前の写真は低スコアでも必要なことがある。
- ブレ判定では「全体手ブレ」と「被写界深度による自然な背景/前景ボケ」を分ける。主役にピントがあっていれば背景ボケは NG にしない。
- ユーザーが「編集しない」と言った場合、色補正・トリミング・リサイズ済み納品物を勝手に作らない。
- 元ZIPから展開した作業コピーの権限修正はよいが、元ZIPや元フォルダの属性は変えない。

## 同梱スクリプト

- `scripts/make_contact_sheets.py`: フォルダ内画像からコンタクトシートを作る。
- `scripts/photo_quality_scan.py`: sharpness / brightness / contrast と顔/主要部クロップ確認シートを作る。
- `scripts/make_swap_candidates.py`: 目つぶり/半目候補の前後連番シートを作る。
- `scripts/materialize_selection.py`: manifest から `album_select` / `digest_highlights` / ZIP を作る。

スクリプトは補助であり、最終判断は目視と前後比較で行う。
