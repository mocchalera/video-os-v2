---
name: render-video
description: Use when the user wants a final packaged video from an approved project and the project satisfies Gate 10 packaging prerequisites.
metadata:
  filePattern:
    - '**/07_package/video/final.mp4'
    - '**/07_package/audio/final_mix.wav'
    - '**/07_package/package_manifest.json'
  bashPattern: []
---
# render-video
## いつ使うか
- 「レンダーして」「動画を書き出して」と言われたとき。
- rough cut ではなく package 済み deliverable を作る段階のとき。

## 前提条件
- 最終 package/render は `scripts/package.ts` を使う。
- `npm run package -- projects/<project> [options]` と
  `npx tsx scripts/package.ts projects/<project> [options]` は同じ入口。
- Gate 10 を満たしていること。
  `current_state: approved`
  `approval_record.status: clean` または `creative_override`
  `handoff_resolution.status: decided`
  `handoff_resolution.source_of_truth_decision: engine_render` または `nle_finishing`
  `gates.review_gate: open`
- F-0023 の `review_report.visual_qa` が `verified` で min score 以上、または明示 waiver が必要。
- `engine_render` の場合、CLI は `timeline.json` の renderer ownership を解決し、
  通常案件は既存 FFmpeg assembly を維持する。Remotion-owned overlay がある場合だけ
  Remotion、HyperFrames-owned element がある場合だけ透過 HyperFrames composite を使う。
  `05_timeline/render-report.json` に freshness metadata を書く。
- caption が有効なら `07_package/caption_approval.json`、BGM が有効なら `07_package/music_cues.json` が必要。
- 通常のBGM bedは検証済みBGM Pack／レビュー済みライブラリ音源から選ぶ。Packが空でも案件内スクリプトで代替BGMを生成しない。
- 手続き生成音を使えるのは、provenanceで `usage_class=simple_sound` と明示された短い単純音だけ。通常BGMの代替にはしない。

## やること（ステップ）
1. Gate 10 と package 前提を読み取り専用preflightで確認する。Studioも同じJSON oracleを使う。

```bash
npm run package -- projects/<project> --preflight-only --json
```

   終了コード0かつJSONの`ok: true`でない場合はpackageへ進まない。このコマンドはproject artifactを書き換えない。
2. `engine_render` path なら先に読み取り専用 preflight を行う。

```bash
npm run render-route -- projects/<project>
```

3. 表示された route が `timeline.json` の登録済み要素と一致することを確認して
   package CLI を呼ぶ。SNS / interview / event / longform というジャンル名だけを
   engine 選択に使わない。

```bash
npm run package -- projects/<project> --source-of-truth engine_render
```

4. `nle_finishing` path なら supplied final を検証用に渡す。

```bash
npm run package -- projects/<project> --source-of-truth nle_finishing --supplied-final projects/<project>/07_package/video/final.mp4
```

5. `assembly.mp4` を手動管理する場合だけ `--no-assembly` または `--assembly-path <path>` を使う。
   通常は自動生成に任せる。
6. Studio確認やNLE handoffを行う場合、最終timeline更新後に playback contract を確認する。

```bash
swift run --package-path apps/macos-studio videoos-studio-cli playback-contract-status <project-id>
```

   `status: exact` でない場合は、古いpreviewを採用せずrender/packageを再実行する。manifestのhashだけを手編集して整合したことにしない。
7. speech-led / interview の場合は `07_package/qa-report.json` で総尺差だけでなく
   `dialogue_timeline_alignment_valid` も確認する。`raw_dialogue.wav` の実信号が
   timelineのdialogue window外へ1フレーム以上出ていれば公開候補へ昇格しない。
8. VFR素材で口の同期を調整した場合は、選んだ映像フレームを固定し、映像・音声の
   source offsetを別々に実測する。残差は音声側で補正し、別プレイヤー／診断proxyの
   見え方だけを根拠に演出尺を変更しない。
9. YouTube等への外部公開はrender/packageとは別gateとする。対象hashにcreative・rights・
   privacy承認と公開先を束ねた`07_package/publication_approval.yaml`を作り、外部write直前に
   次を通す。

```bash
npm run publication-preflight -- projects/<project> --platform youtube --visibility unlisted
```

## 出力 artifact
- `07_package/video/final.mp4`
- `07_package/video/raw_video.mp4`
- `07_package/audio/raw_dialogue.wav`
- `07_package/audio/final_mix.wav`
- `07_package/captions/*.srt` / `*.vtt` 必要な場合のみ
- `07_package/qa-report.json`
- `07_package/package_manifest.json`
- `09_output/final.mp4`
- `05_timeline/assembly.mp4` と `05_timeline/render-report.json` (`engine_render` 自動生成時)
- `07_package/logs/render-route.json`
- `07_package/logs/audio-mix-report.json`

## 注意事項
- `--skip-render` は検証/テスト用途。通常の deliverable 作成では付けない。
- `--no-assembly` は自動生成を止めるため、`05_timeline/assembly.mp4` が無い場合は packaging が失敗する。
- `--assembly-path` は Remotion-owned element を含む timeline では使わない。描画済みか
  証明できない prebuilt assembly は fail closed になる。
- project artifact に任意 JSX / HTML を生成しない。Remotion / HyperFrames は
  allow-list 済み `content-element/v1` template からだけ起動する。
- `music_cues.json` がなくても `final_mix.wav` は生成される。no-BGM path もraw dialogueを2-pass MAし、失敗時は未処理音声へ黙ってフォールバックしない。
- ライブラリ候補が未レビュー／未インストールなら、no-BGMまたは人間レビューで停止する。品質未確認の手続き生成BGMへフォールバックしない。
- `caption_burn` と `audio_mix` の実行ログは `07_package/logs/*.log` に出る。
- 字幕有効時は final映像だけでなく `07_package/captions/*.srt` / `*.vtt` と `caption_approval.json` の存在も確認する。
- BGMありではBGMを基準 -23 LUFSへ正規化してからeditorial gainを適用し、A1 clipの占有区間ではなく実際のdialogue waveformでsidechain duckingする。
- `audio-mix-report.json` の `audio_mix_policy_valid` と、実測の `loudness_target_valid` が両方passして初めてMA完了とみなす。
- FFmpeg graphではsource `atrim`を`adelay`より前に置く。同一input branchの
  `adelay=...,atrim=start=0`は禁止。全体尺のtrimは`amix`後だけに置く。
- 外部公開／共有に使うのはQAを通過して`09_output/final.mp4`へ昇格した1本だけ。
  `preview-v*`や診断proxyをアップロード対象にしない。
- `publication-preflight`は承認後のfile差し替え、QA未通過、manifest hash不一致、未承認の
  visibilityをfail closedにする。upload成功、remote processing完了、Slack投稿成功は
  preflightとは別にremote側で検証して記録する。
