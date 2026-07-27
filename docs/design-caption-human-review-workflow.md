# 字幕ヒューマンレビュー工程 / Studio統合設計

- Status: Proposed
- Date: 2026-07-14
- Scope: `runtime/caption`, `/caption`, `07_package`, macOS Studio
- Goal: 機械生成字幕を、人間が完パケする品質へ効率よく仕上げられるレビュー工程を追加する

## 1. 結論

字幕は一撃で承認可能にするのではなく、次の4層へ分ける。

1. `caption_source.json`: 文字起こしから作る決定論的な素材字幕
2. `caption_draft.json`: 自動校正・分割・改行・タイミング調整後の機械ドラフト
3. `caption_review_patch.json`: 人間の修正と確認状態を保持する差分
4. `caption_approval.json`: 明示的な人間承認後だけ生成する完パケ用字幕

`caption_draft.json` は機械が再生成できる不変の基準とし、人間の編集で直接上書きしない。CLIとStudioは同じReview Coreを呼び、UI固有の形式を正の成果物にしない。

```text
transcript + glossary + timeline
          |
          v
 caption_source.json
          |
          v
 caption_draft.json -----------+
          |                     |
          | base hash           | video / waveform / source text
          v                     v
 caption_review_patch.json <-> Caption Review UI
          |
          | deterministic apply + validation
          v
 caption_review_preview.json  (derived / regenerable)
          |
          | explicit human approval
          v
 caption_approval.json -> timeline caption track -> render
```

## 2. 今回の実素材で確認した問題

`projects/lively-alt-longform-v1/07_package/caption_draft.json` の現状は以下である。

- 字幕数: 1132
- 二行字幕: 652
- timing source: 1132件すべて `clip_item_remap`
- timing fallback: 1132件すべて `true`
- timing confidence: 0.5
- editorial status: 1132件すべて `clean`
- draft status: `needs_operator_fix`
- 例: `まだまだ話したいことは聞きた\nいことがあるんですけど`

この状態から分かる問題は、単なる辞書不足だけではない。

1. LLM editorialを通っていないpassthrough字幕が`clean`と表現され、確認済みに見える
2. 改行器は文字幅を守れるが、日本語の活用・文節・固有語の境界を保証できない
3. STT誤り、固有名詞、分割、改行、タイミングの問題が同じ一覧に混在している
4. 1000件超を先頭から全件確認するしかなく、リスク順レビューができない
5. 修正を用語集へ戻し、同じ誤認識を後続字幕へ安全に反映する経路がない

## 3. 原則

### 3.1 人間承認と機械生成を混同しない

- 機械未審査は `clean` ではなく `unreviewed` とする
- LLM未実行は `editorial.mode = passthrough` と明記する
- `caption_approval.json` は人間の明示操作でのみ生成する
- 自動処理は承認済み字幕を暗黙に書き換えない

### 3.2 UIより先に共有Review Coreを作る

CLI、テスト、将来のStudio UIが同じ関数を使う。

```ts
interface CaptionReviewCore {
  buildQueue(draft: CaptionDraft, context: ReviewContext): CaptionReviewQueue;
  applyPatch(draft: CaptionDraft, patch: CaptionReviewPatch): ApplyResult;
  validate(reviewed: ReviewedCaptionDocument): CaptionReviewValidation;
  projectApproval(reviewed: ReviewedCaptionDocument, actor: HumanActor): CaptionApproval;
}
```

Swift側で字幕変換ルールを再実装しない。StudioはCoreが生成した文書を読み、patch operationを作るクライアントとする。

### 3.3 全件レビューではなく、リスク順レビューを可能にする

人間が見る順番はタイムライン順だけでなく、次のrisk scoreで並べ替えられるようにする。

- STT / timing confidenceが低い
- word timing fallback
- 固有名詞候補が辞書にない
- glossary variantに近いが一致しない
- 行頭助詞、活用語分断、数字・英字境界などの不自然な改行
- CPS、行長、表示時間違反
- 直前字幕との重なり、短すぎるgap
- LLMが変更したがconfidenceが低い
- 人間がflaggedにした

機械的に安全な字幕はまとめて確認できるが、固有名詞・数値・否定表現を含む字幕は一括承認対象から除外する。

## 4. 成果物契約

### 4.1 `caption_draft.json`

既存契約へadditiveに次を加える。

```ts
interface CaptionDraftEntry {
  // existing fields...
  editorial?: {
    mode: "llm" | "deterministic" | "passthrough";
    status: "unreviewed" | "suggested" | "degraded";
    sourceText: string;
    confidence: number;
    operations: EditorialOperation[];
    glossaryHits: string[];
  };
  reviewHints?: CaptionReviewHint[];
}

interface CaptionReviewHint {
  code:
    | "low_timing_confidence"
    | "timing_fallback"
    | "suspected_stt_error"
    | "unknown_proper_noun"
    | "glossary_near_match"
    | "unnatural_line_break"
    | "caption_split_recommended"
    | "density_violation"
    | "short_gap"
    | "overlap";
  severity: "info" | "warn" | "block";
  message: string;
  evidence?: string[];
}
```

`clean`はvalidatorを通ったという意味に限定せず、使用を廃止する。機械処理済みでも人間未確認なら`unreviewed`である。

### 4.2 `caption_review_patch.json`

timeline用の`review_patch.json`へ字幕編集を混在させない。字幕には分割・結合・改行・本文修正・確認状態など固有の操作が必要なため、専用のschemaを持つ。

```ts
interface CaptionReviewPatch {
  version: "caption-review-patch/v1";
  project_id: string;
  base_caption_draft_hash: string;
  base_timeline_hash: string;
  operations: CaptionReviewOperation[];
  session: {
    reviewer: string;
    started_at: string;
    updated_at: string;
  };
}

type CaptionReviewOperation =
  | {
      op: "replace_text";
      caption_id: string;
      base_text_hash: string;
      text: string;
      category: "stt" | "proper_noun" | "kanji" | "punctuation" | "other";
    }
  | {
      op: "set_line_break";
      caption_id: string;
      base_text_hash: string;
      lines: [string] | [string, string];
    }
  | {
      op: "split_caption";
      caption_id: string;
      base_text_hash: string;
      parts: Array<{ caption_id: string; text: string; start_frame: number; end_frame: number }>;
    }
  | {
      op: "merge_captions";
      caption_ids: [string, string];
      base_text_hashes: [string, string];
      result: { caption_id: string; text: string; start_frame: number; end_frame: number };
    }
  | {
      op: "adjust_timing";
      caption_id: string;
      start_frame: number;
      end_frame: number;
    }
  | {
      op: "set_review_state";
      caption_id: string;
      base_text_hash: string;
      state: "verified" | "flagged" | "unreviewed";
      note?: string;
    }
  | {
      op: "propose_glossary_term";
      canonical: string;
      variants: string[];
      source_caption_ids: string[];
    };
```

各operationはbase hashを持ち、draft再生成後の古い修正を黙って適用しない。split後のIDは元IDを保持した決定論的suffix（例: `SC_1164_A`, `SC_1164_B`）を使う。

### 4.3 `caption_review_preview.json`

draftへpatchを適用したderived artifact。Studio表示、SRT/ASSプレビュー、validationに使用する。再生成可能なのでcanonical approvalにはしない。

含める状態:

- `unreviewed_count`
- `verified_count`
- `edited_count`
- `flagged_count`
- `blocking_issue_count`
- captionごとのsource text / current text / diff / review state / validation

### 4.4 `caption_approval.json`

既存のhuman-only契約を維持し、次のprovenanceをadditiveに持つ。

```ts
approval: {
  status: "approved" | "stale";
  approved_by: string;
  approved_at: string;
  base_caption_draft_hash: string;
  caption_review_patch_hash: string;
  validation_hash: string;
}
```

## 5. 日本語分割・改行の改善

### 5.1 文章分割と画面内改行を別問題として扱う

現在のように一つの関数で長さに合わせて改行するだけでは、文節を壊す。先に字幕単位を決め、次にその字幕内を最大2行へ配置する。

1. sentence / clause segmentation
2. caption duration assignment
3. phrase-aware line breaking
4. layout validation

### 5.2 分割候補の優先順位

1. 句点、疑問符、感嘆符
2. 読点の後
3. 接続表現の前後
4. `Intl.Segmenter("ja", { granularity: "word" })`の語境界
5. 助詞を前行へ含めた文節境界
6. 音声pause / word timing境界
7. 最後にのみ文字数ベースfallback

以下はhard rejectする。

- 漢字語幹と送り仮名の分断: `聞きた / い`
- 固有名詞・辞書語の内部
- 数値と単位、英字語の内部
- 行頭の助詞・助動詞・接尾辞
- 一文字だけの孤立行

hard reject時は無理に2行へ収めず、`caption_split_recommended`として時間軸上で字幕を二つに分ける。

### 5.3 形態素解析への依存方針

初期実装は追加依存なしで、`Intl.Segmenter`、辞書保護、活用語heuristics、word timingを組み合わせる。実素材の誤分割率が受入基準を満たさない場合だけ、Sudachi等の日本語形態素解析をhuman-approved dependencyとして評価する。

## 6. 固有名詞・誤変換の改善

### 6.1 レビュー前ヒアリング

プロジェクト作成時または字幕生成前に、Studioで次を入力・インポートできるようにする。

- 登壇者名、会社名、商品・サービス名
- イベント名、会場、地名
- 業界専門用語
- 表記ルール（英字、大文字小文字、敬称）
- 既知の誤認識と正表記
- 参考資料（brief、台本、PDF、Web資料から抽出した候補）

入力は既存`01_intent/caption_glossary.yaml`へ保存する。参考資料から抽出した候補は自動確定せず、operatorが採用したものだけ辞書へ入れる。

### 6.2 修正から辞書への学習

人間が`富井 -> Tomy`のような修正をした際、UIは次の二択を出す。

- この字幕だけ修正
- プロジェクト用語集へ追加し、未確認字幕へ再提案

後者でもverified字幕は自動変更しない。影響対象とbefore/afterを表示し、一括適用を明示操作にする。

## 7. レビュー体験

### 7.1 画面構成

Studioに`字幕仕上げ`workspaceを追加する。

```text
+----------------------+------------------------------+
| Viewer               | Review Queue                 |
| 実映像 + 実サイズ字幕 | 要確認 / 未確認 / 修正済み   |
| A/B: 原文 / 修正版    | 検索・risk filter            |
+----------------------+------------------------------+
| Waveform + caption timing + 前後caption             |
+------------------------------------------------------+
| Source transcript | Text editor | glossary / hints  |
+------------------------------------------------------+
|  42/1132 verified  18 edited  7 flagged  [承認]      |
+------------------------------------------------------+
```

### 7.2 選択字幕のプレビュー

- 選択字幕の前後2〜3秒をloop再生
- タイムライン上の前後字幕も表示し、重なりと呼吸を確認
- 実際のfont、outline、safe area、改行でoverlay表示
- 原文、機械案、人間修正版を切替
- 音声のみ低速再生（0.75x / 0.5x）
- source transcript itemとword timingを表示
- フル動画の再エンコードは不要。承認前はStudio overlayを正とする
- 必要なときだけ選択範囲の短いburn-in previewを生成する

### 7.3 編集操作

- 本文修正
- カーソル位置で改行
- 字幕を分割
- 次字幕と結合
- IN/OUT調整
- 前後字幕へ移動
- verified / flagged
- 用語集へ提案
- Undo / Redo

長尺レビュー用にキーボード操作を第一級にする。保存はpatchへautosaveし、承認だけを明示操作にする。

### 7.4 Review Queue

既定表示は`要確認`。

- Blocking: overlap、空字幕、3行以上、辞書語内部分断、stale patch
- High: 固有名詞候補、低信頼STT、低信頼timing、不自然な改行
- Medium: CPS、短いdwell、句読点、長さの偏り
- Low: machine suggestionのみ

タイムライン順、risk順、話者別、用語別で切替可能にする。

## 8. 承認ゲート

`caption_approval.json`生成条件:

1. draft hashとpatchのbase hashが一致
2. timeline hashが一致
3. blocking issueが0
4. flagged captionが0
5. すべての字幕がverified、またはoperatorが明示したbulk approval scope内
6. 行数、行長、CPS、dwell、overlap、gapのvalidationがpass
7. 固有名詞候補と数値・否定表現の未確認件数が0
8. 承認者名と時刻がある

approval後にdraftやtimelineが変わった場合は`stale`へ落とす。古いapprovalでrender/packageを通さない。

## 9. Studio既存基盤との接続

- `StudioFeedbackSession`のautosave、conflict、undo/redoの考え方を再利用する
- timeline用`ReviewPatchDocument`は変更せず、字幕用`CaptionReviewPatchDocument`を並列に置く
- `TimelineAgentReviewPatchApplyPlan`と同じく、Caption Review Coreがbefore/after diffを決定論で作る
- `AgentInspectorViews`はAI提案diffの確認面として再利用できる
- `ProjectRenderRunner`はapproval済みcaption trackだけを最終レンダーへ渡す
- Viewer overlayはpreview用derived stateであり、`timeline.json`やapprovalを暗黙に更新しない

## 10. CLI / headless契約

Studio未実装時も同じ工程を試せるよう、thin CLIを用意する。

```sh
npx tsx scripts/caption-review.ts queue --project <dir>
npx tsx scripts/caption-review.ts prepare --project <dir>
npx tsx scripts/caption-review.ts verify-safe --project <dir> --reviewer <name> \
  --base-caption-draft-hash <hash> --caption-text-hash SC_001=<hash> [...]
npx tsx scripts/caption-review.ts init --project <dir> --reviewer <name>
npx tsx scripts/caption-review.ts apply --project <dir> --patch <json>
npx tsx scripts/caption-review.ts validate --project <dir>
npx tsx scripts/caption-review.ts approve --project <dir> --reviewer <name>
```

`queue` v2はReview Coreが算出した`approval_readiness`（blocker code/messageを全件）、`safe_bulk_review`、`font_contract`、整合する`current_approval`を返す。長行・密度のlayout warnは一括確認対象にできるが、block/flagged、固有名詞、数値、否定、低timing確度は除外する。一括確認はdraft hashと全caption text hashを必須とし、staleなら0件更新、成功時は1操作としてundoする。

`clean-lower-third`のfont contractは`VideoOS Noto Sans JP Black`/900を選択する。ASSはmanifestの`ass_heavy` assetをFontnameとして使いsynthetic boldを無効化し、Studioは同じfamilyをCoreText登録して900を`.black`として表示する。登録失敗時はsystem fontへfallbackせず、`font_contract_mismatch`として承認とoverlayを停止する。

`caption_draft.json`欠落時のqueueは`recovery_action`を返す。`prepare`/`recover`はcanonical caption生成器を隔離領域で実行し、既存patch/approvalのbase hashと一致したdraftだけをatomicに復元する。既存レビューartifactを暗黙に上書きしない。

CLIはReview Coreのadapterとし、独自ルールを持たない。`queue`はHTML、CSV、JSONへexport可能にするが、正はJSON成果物である。

実装済みのheadless手順は次のとおり。

1. `queue --severity block|warn|info|all --limit N`でリスク順に抽出する
2. `init`で現在のdraft/timeline hashへ固定した空patchを作る（既存patchは上書きしない）
3. 人間またはStudioがpatch operationを追記する
4. `apply`でschema検証、stale検出、決定論的diff生成を行い、canonical patchとderived previewを保存する
5. `validate`で成果物を書き換えずに承認可否を確認する
6. `approve`で全字幕verifiedかつblocking/flaggedなしの場合だけhuman-only approvalを生成する

`approve`はtimelineを暗黙に更新しない。承認済み字幕のtimeline projectionは既存のcompile/render境界で行い、レビュー中のpreviewと完パケ状態を混同しない。

## 11. 実装順

### Phase 1: Review Coreと成果物契約

- `caption-review-patch.schema.json`
- `caption-review-preview.schema.json`
- base hash / stale detection
- patch apply / diff / validation
- risk queue
- unit + schema + real-fixture regression

### Phase 2: CLIレビュー工程

- queue export
- patch apply
- selective preview render
- explicit approval
- 現在のLively ALT字幕をfixture化せず、匿名化した代表的誤りをtest fixtureへ抽出

### Phase 3: Studio `字幕仕上げ` workspace

- caption list / risk filter
- Viewer overlay / loop playback / waveform
- text、line break、split、merge、timing editor
- autosave / undo / stale conflict
- glossary promotion

#### Phase 3A 実装済みの最小縦切り

- Studioトップバーから開く専用`字幕仕上げ`シート
- risk順キュー、修正必須・要確認・未確認・確認済み・全件filter、本文/ID検索
- 20ptの本文編集と26ptの2行想定表示preview
- 本文・改行修正、`unreviewed / verified / flagged`更新
- 選択字幕のtimeline frameへViewer/Timelineを移動する導線
- 人間名、blocking/flagged/unreviewed gateを使う完パケ承認
- Swift側で字幕規則を再実装せず、`caption-review.ts queue/edit/approve`を通じてReview Coreを共有

#### Phase 3B 実装済みの仕上げ編集

- 選択字幕の前後1.25秒を含む実タイムライン映像loopと区間波形
- risk順 / timeline順の切り替えと、前後字幕への移動
- frame単位のIN/OUT調整、中央frame + 句読点優先のsplit、直後字幕とのmerge
- 入力停止後1.2秒のatomic autosave、直前action単位のundo
- `text_hash`をStudioからCLIへ渡すstale edit拒否
- queue contractへ`fps`、`timeline_duration_frames`、`can_undo`を追加
- 既存`split_caption / merge_captions / adjust_timing` operationを共有Core経由で使用し、Studio側へ字幕規則を複製しない

#### Phase 3C 実装済みの人間協調仕上げ

- 修正後の正表記と誤認識例を`propose_glossary_term`として、人間確認待ちのプロジェクト用語候補へ昇格
- queueは機械ドラフト由来の`source_text`を保持し、保存済み修正文を誤認識例として自己学習しない
- 候補追加は`caption_glossary.yaml`や確認済み字幕を自動変更せず、patch内の可逆操作として保存
- action単位のoperation数を`action_operation_counts`へ積み、編集・分割・結合・用語候補を複数段undo可能にした
- queue contractへ`undo_depth`と`glossary_proposals`を追加し、旧patch/queueは既定値で後方互換を維持
- stale text hash検出時に「読み込み時 / 現在版 / 作業案」の本文・IN/OUTを並べる競合解決sheetを表示
- 競合解決では、現在版を採用するか、現在版を新しい基準にして作業案を未保存のまま保持する。黙った上書きは行わない
- 作業案を保持した場合はautosaveを止め、状態バーで明示保存待ちを示す
- 字幕本文はnative `NSTextView`で編集し、`hasMarkedText()`が真の日本語IME変換中はautosaveを停止する
- 変換確定後にだけ1.2秒のautosave debounceを再開し、変換中は手動保存・確認済み更新も無効化して未確定文字列をpatchへ書き込まない
- Studio previewはqueue contractの`caption_style`を使い、1080p基準のfont size、line height、margin、max widthをViewerの表示高へ縮尺して完成映像と同じ占有率で表示する
- 音声波形のIN/OUTハンドルを左右dragしてframe単位で表示区間を調整でき、1 frame未満やIN/OUTの交差は許可しない

Studioは引き続き高密度editorとして、native sheet、標準`Cmd+Z`、明示的な選択状態を維持する。視覚上のsignatureは、frame値、risk、undo depthを同じmetric rhythmで見せる`Precision Instrument`とする。

次の3Dでは、候補を`01_intent/caption_glossary.yaml`へ人間承認付きで採用し、影響する未確認字幕のbefore/after一括提案、redo、用語別queueを追加する。

### Phase 4: 自動提案の高度化

- reference documentから用語候補抽出
- LLM editorialのbefore/after suggestion
- word alignment再実行
- 修正履歴をproject-local correction memoryへ反映

## 12. 受入基準

### Contract

- draftを直接変更せず、patch applyで同じ結果を再現できる
- stale patchは適用不可
- approvalはhuman identityなしに生成不可
- StudioとCLIで同じpatchから同じreview previewを作る

### Japanese quality

- `聞きた / い`のような語幹・送り仮名分断をvalidatorがblockする
- protected term内部では改行・字幕分割しない
- 3行以上、行長超過、1文字孤立行をblockする
- split/merge後もcaption timingが単調増加し、重ならない

### Human workflow

- operatorがrisk順に要確認字幕だけをレビューできる
- 選択字幕の前後を実映像・実スタイルでloop確認できる
- 修正を字幕単体または用語集提案として保存できる
- 中断・再開してもpatchと確認状態が残る
- 全編再エンコードなしで字幕仕上げを反復できる
- 日本語IMEの変換候補を選んでいる間は保存されず、変換確定後にだけautosaveされる

## 13. 非目標

- LLM判断だけで`caption_approval.json`を生成する
- Studio側に別の日本語分割ロジックを実装する
- caption patchをtimeline `review_patch.json`へ混在させる
- 未確認の参考資料用語を自動で正表記として採用する
- 字幕編集のたびに1時間映像を再エンコードする
