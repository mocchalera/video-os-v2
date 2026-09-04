---
name: crop-photos
description: "MUST USE when the user asks to crop, reframe, trim, or improve composition of still photos, especially selected event photos, album photos, portraits, speakers, panels, workshops, or group photos. Use after photo selection or correction when the task is composition improvement rather than selecting images."
metadata:
  filePattern:
    - '**/04_plan/crop_edit*_manifest.json'
    - '**/04_plan/crop_edit*_report.md'
    - '**/03_analysis/crop_review*/**'
    - '**/05_delivery/**/*cropped*/**'
  bashPattern: []
---
# crop-photos — 写真トリミング / 構図改善

## いつ使うか

- ユーザーが写真の「トリミング」「構図改善」「余白を詰める」「被写体を立たせる」「写真としてよくする」と依頼したとき
- `album_select` / `album_edited` / `digest_highlights` など、選定済み写真を納品用に整えるとき
- 小さすぎる主役、余白が多い登壇写真、前景の頭や机が強すぎる写真、画面端の半端な人物を救済したいとき

写真選定そのものは `select-photos` を使う。色補正だけ、動画化だけ、スライドショー化だけの依頼ではこのスキルを主役にしない。

## 原則

- 元ファイルは変更しない。必ず別フォルダへ派生物を作る。
- ユーザーが明示しない限り、元写真のアスペクト比を維持する。イベントアルバムでは原則として縦横比を変えない。
- 切る目的は「主役を立てる」「視線が迷う要素を減らす」「弱い余白を整理する」ことであり、説明に必要な文脈を削りすぎない。
- 全写真を機械的に切らない。切ることで悪くなる写真は据え置く。
- トリミング後も十分な解像度を残す。極端な拡大で写真が荒れる場合は救済しない。
- before/after と最終コンタクトシートを作り、主役欠け・切りすぎ・アスペクト崩れを確認する。

## 構図の判断基準

### 主役の置き方

- 人物の顔、目線、手の動き、会話相手が写真の重心になるように置く。
- 1人の登壇者や話者は、中央固定にしすぎず、顔の向きや視線の先に余白を残す。
- 横を向いて話している人物は、顔の向く方向に少し空間を残す。背中側や不要な壁側の余白を優先して詰める。
- 手振りやマイク、PC、ホワイトボードなど、話している理由が分かる要素は残す。
- 顔だけを大きくしすぎない。イベント写真では「人 + 場」が分かる余白を少し残す。

### 人物写真で残すべき余白

- 頭上は詰めすぎない。髪や頭の上に少し呼吸する余白を残す。
- 顎、肩、手先、肘、膝、足先を中途半端に切らない。切るなら意図が分かる位置で切る。
- 座っている人物は、机、PC、手元が表情や状況を補うなら残す。
- 複数人の会話は、発話者だけでなく聞き手の反応も価値がある。反応が良い人物を削らない。
- 集合写真は全員の顔と左右端を優先する。原則として軽い端整理だけにする。

### 余白の詰め方

- 白壁、天井、床、空のスクリーンなど、情報量の低い余白を優先して削る。
- 主役の反対側に大きな無意味な余白がある場合は詰める。
- スライドやスクリーンは、内容が読める・場面説明になる場合は残す。白飛びして情報がない場合は構図要素として扱い、必要なら詰める。
- 会場全体、ワークショップの熱量、参加人数を見せる引き絵は、余白に見えても文脈であることがある。切りすぎない。

### 避けるトリミング

- 元アスペクトを勝手に変える。
- 人物を画面いっぱいに詰めて、イベントの場や関係性が消える。
- 顔の向きと逆側に余白を残し、視線の先を切る。
- 画面端に半端な顔、手、肩、足が残る。
- 前景ボケや参加者の後頭部をすべて削って、臨場感まで消す。
- 集合写真で端の人物を切る。

## アスペクト比の扱い

- デフォルトは元アスペクト維持。例: 4240x2832 は 265:177 として扱う。
- 厳密チェックでは `output_width * source_height == output_height * source_width` を満たすこと。
- 丸め誤差を避けるため、簡約比の整数倍で crop size を決める。例: 4240:2832 -> 265:177 なので、3180x2124、3445x2301、3975x2655 などを使う。
- 縦横比を変える必要がある場合は、ユーザーが用途を明示したときだけ行う。例: SNS縦長、16:9スライド、正方形サムネイル。

## 作業フロー

### Step 1: 対象を固定する

- 入力フォルダ、対象枚数、ベースにする版を確認する。
- 補正済みがある場合は、ユーザーの目的に応じて元写真か補正済みかを選ぶ。アルバム用の仕上げなら補正済みをベースにしてよい。
- 出力先は既存フォルダを上書きせず、`album_edited_cropped_aspect` など目的が分かる名前にする。

### Step 2: 確認用コンタクトシートを作る

- 対象全体の contact sheet を作り、切るべき写真と据え置く写真を分ける。
- 見る観点:
  - 主役が小さすぎる
  - 余白が多く重心が弱い
  - 端の人物や物が半端に残っている
  - 前景の頭、机、機材が強すぎる
  - 切ると会場感や関係性が弱くなる

### Step 3: crop 方針を決める

- 各写真を `crop`, `copy`, `review` に分ける。
- `crop`: 主役が立つ、不要余白が減る、端のノイズが消える。
- `copy`: 引き絵、集合、会場文脈、すでに構図が成立している写真。
- `review`: 切るとよくなりそうだが、顔・手・関係性が欠けるリスクがある写真。

### Step 4: トリミングする

- 元アスペクト維持で crop box を作る。
- 主役の顔と体の向き、視線の先、手の動きを基準に中心を置く。
- 余白を詰めるときは、左右・上下のどちらを詰めると主役が立つかを見る。
- 人物が画面端に寄りすぎる場合は、詰めすぎず弱めの crop にする。
- 切る前より主役が大きくなっても、写真として不自然なら戻す。

### Step 5: QA する

最低限の確認:

- before/after sheet で、主役欠け、手足欠け、画面端の半端な要素を確認する。
- final contact sheet で、アルバム全体のリズムが単調になっていないか確認する。
- 全出力の枚数が入力と一致することを確認する。
- 元アスペクト維持の場合、全出力でアスペクト崩れ 0 件を確認する。
- ZIP を作る場合、ZIP 内の枚数も確認する。

## 推奨出力

<!-- artifact-producer: agent -->

```text
projects/<project>/
├── 03_analysis/
│   └── crop_review_<scope>/
│       ├── crop_review_<scope>_01.jpg
│       ├── aspect_crop_before_after_<scope>_01.jpg
│       └── album_edited_cropped_aspect_<scope>_01.jpg
├── 04_plan/
│   ├── crop_edit_<scope>_manifest.json
│   └── crop_edit_<scope>_report.md
└── 05_delivery/
    └── <scope>/
        ├── album_edited_cropped_aspect/
        └── album_edited_cropped_aspect_<scope>_<count>.zip
```

## manifest に残す項目

```json
{
  "source_folder": "/path/to/source",
  "output_folder": "/path/to/output",
  "total_photos": 79,
  "cropped_count": 61,
  "copied_count": 18,
  "aspect_policy": "All outputs use the exact original aspect ratio 265:177.",
  "items": [
    {
      "file": "001_DSC0001.JPG",
      "action": "cropped_aspect_preserved",
      "crop_box_px": [0, 0, 3975, 2655],
      "original_size": [4240, 2832],
      "output_size": [3975, 2655],
      "aspect_ratio": "265:177",
      "reason": "strict original-aspect crop to enlarge small subject or reduce excess margin"
    }
  ]
}
```

## 報告に含めること

- 入力枚数、出力枚数、crop 枚数、copy 枚数
- 元アスペクト維持の有無と検証結果
- 出力フォルダ、ZIP、確認シート、レポートのパス
- やりすぎ防止のため据え置いた写真があること
