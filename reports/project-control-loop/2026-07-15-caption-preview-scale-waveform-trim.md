# Caption Studio 実寸比率previewと波形trim

## ユーザー指摘

- Studioの字幕previewが完成映像に対して巨大に見える。
- 波形上で字幕のIN/OUT点を直接dragしたい。

## 原因

Phase 3Aでは校正時の読みやすさを優先し、Viewer高に関係なく26pt boldで字幕を表示していた。Lively長尺のcanonical `longform-event` presetは56px / 1080pなので、190pt高のViewerでは約9.9pt相当になる。従来previewは約2.6倍で、完成映像の画面占有率を再現していなかった。

## 実装

### 実寸比率preview

- `caption-review.ts queue`へcanonical style presetを表すadditiveな`caption_style`を追加した。
- Studioはfont family、font weight、font size、line height、outline、margin、max width、alignmentをdecodeする。
- Viewer高 / 1080をscaleとしてstyleを描画し、完成映像と同じ画面高比率にした。
- 古いqueueには既存default presetを適用し、後方互換を維持した。
- caption styleの正本は引き続き`editor/shared/caption-style-tokens.ts`であり、Swiftへpreset選択規則を複製していない。

### 波形trim

- 波形のIN/OUT境界へ18ptのdrag hit targetと青いhandleを追加した。
- pointer translationをfpsに基づきframeへ量子化し、既存のframe stepperと同じbindingを更新する。
- IN/OUTの交差、1 frame未満、表示loop外へのdragをclampする。
- hover cursor、tooltip、VoiceOver adjustable actionを追加した。
- drag中の連続更新は既存autosave debounceをcancel/restartし、操作停止から1.2秒後に1 actionとして保存する。

## 検証

- Studio実画面: `/tmp/video-os-studio-caption-waveform-open2.png`
- `swift test`: 533 tests、0 failures
- Node 22 `npm test -- --run`: 2713 passed、39 skipped
- Node 22 `npm run build`: success
- `./script/build_and_run.sh --verify`: app build/sign success
- `codesign --verify --deep --strict dist/VideoOSStudio.app`: success
- `git diff --check`: success

## 非変更範囲

- caption draft、review patch、timeline、source footage、rendered mediaは変更していない。
- final renderのASS生成規則は変更していない。
