# Caption Studio 日本語IME autosave修正

## 症状

Studioの`字幕仕上げ`で日本語IMEを使用すると、変換を確定する前のmarked textも通常の本文変更として扱われ、1.2秒後のautosave対象になっていた。変換候補を選んでいる途中で保存状態が変わるため、連続した日本語編集を妨げていた。

## 原因

SwiftUI `TextEditor`のbinding変更だけをautosaveの起点にしていたため、AppKit text input systemが管理する「変換中」と「確定済み」を区別できていなかった。

## 修正

- 字幕本文editorをnative `NSTextView`を包む`IMEAwareTextEditor`へ置換した。
- `NSTextView.hasMarkedText()`を`CaptionReviewSession`へ伝え、変換開始時に保留中のautosave taskをcancelする。
- 変換中はautosave、手動保存、確認済み更新を停止する。
- 変換確定後に限り、既存の1.2秒debounceを最初から開始する。
- autosave判定を`CaptionAutosavePolicy`へ分離し、実際のAppKit marked textを使う回帰テストを追加した。

## 検証

- `swift test`: 529 tests、0 failures
- `./script/build_and_run.sh --verify`: build成功、`dist/VideoOSStudio.app`を再署名
- `CaptionAutosavePolicyTests.testAppKitMarkedTextFeedsTheCompositionGate`: `setMarkedText`中は保存不可、`unmarkText`後は保存可能
- `git diff --check`: whitespace errorなし

## 変更範囲

字幕本文editorとautosave gateのみ。timeline、caption patch形式、CLI review core、生成済みプロジェクト成果物は変更していない。
