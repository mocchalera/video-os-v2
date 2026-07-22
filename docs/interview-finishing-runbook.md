# Interview Finishing Runbook

インタビュー短尺を、レビュー用previewから公開可能な完成版へ再現性を持って仕上げるための運用契約。
個別案件の手作業コマンドではなく、canonical timeline、共有renderer、package QAを使う。

## 今回顕在化した普遍的な失敗

| 失敗 | 原因 | 再発防止 |
|---|---|---|
| 冒頭が頭に入らない | 外観、タイトル、音声を同時に開始 | 外観を認識させ、タイトルを読ませ、その後にJ-cutで音声を入れる |
| タイトル後に数フレーム静止する | freeze frameを遷移の糊として使用 | interviewの動いているsource frameへ直接入る |
| 最終発言が途中で切れる | 尺優先でutterance boundaryを無視 | 完全文と動くtailを確保し、transcript boundaryで確認 |
| 音声が約3.33秒先行する | `adelay`後の`atrim=start=0`が挿入無音を削除 | source trim → `adelay` → `amix` → final trimの順を固定 |
| 総尺QAは通るのに口がずれる | stream duration差だけを同期とみなした | dialogue stemの実信号とtimeline windowの位置も測る |
| VFRで1〜2フレーム単位に行き過ぎる | 映像trimを連続時間として調整 | 映像フレームを先に確定し、残差を音声offsetで補正 |
| player原因と早合点する | 一時停止後だけ合う等の症状に引かれた | source基準の映像・音声offsetを実測し、別playerは補助証拠に留める |
| previewが増え公開対象を誤る | v番号だけで完成版を管理 | QA合格後の`09_output/final.mp4`だけを公開候補にする |
| BGM権利確認前に公開工程へ入る | creative approvalとrelease approvalを混同 | rights statusと人間承認を公開前の別gateにする |

## 標準工程

1. `timeline.json`、最新review patch、caption、music cue、source manifestを読む。
2. 冒頭を「visual establish → title read → dialogue J-cut → moving interview」の順で確認する。
3. 末尾をtranscriptの完全な発話単位と動く映像tailで確認する。
4. rendererでclean assemblyを作り、その後にcaption/cardを合成する。
5. packageを実行し、次を同時に通す。
   - full decode
   - resolution / aspect ratio
   - loudness / true peak
   - `av_drift_valid`（stream総尺差）
   - `dialogue_timeline_alignment_valid`（発話内容の配置）
   - source freshness、caption、music、package completeness
6. QA合格後にのみ`09_output/final.mp4`へ昇格する。
7. 外部アップロード前に、権利、privacy、公開範囲、アップロード対象hashの人間承認を取る。
   `07_package/publication_approval.yaml`で全承認を同じ`09_output/final.mp4`のSHA-256へ束ね、
   `npm run publication-preflight -- <project> --platform youtube --visibility unlisted`を通す。
8. upload後は「API成功」だけで終えず、remote ID、visibility、processing完了、再生可能性を確認する。
9. Slack等へ共有した場合は、workspace、channel、thread、message timestamp、共有URLを記録する。

## 同期調整の判断順

1. `ffprobe`で`avg_frame_rate`、`r_frame_rate`、`time_base`、stream durationを記録する。
2. source上の同じ発話について、映像の口形anchorと音声anchorのoffsetを別々に測る。
3. residualを `video_source_offset - audio_source_offset` として求める。
4. CFRで映像frameを動かせる場合でも、意図した画が変わらない範囲だけで調整する。
5. VFRまたはframe quantizationで1フレーム移動が過補正になる場合、映像frameを固定して音声をresidual分補正する。
6. full-rangeの冒頭・中盤・末尾を再確認する。1点だけ合う補正を採用しない。

## FFmpeg audio graph契約

安全:

```text
atrim=<source range>,asetpts=PTS-STARTPTS,...,adelay=<timeline offset>[clip]
[silent][clip]amix=...,atrim=<final duration>[aout]
```

禁止:

```text
adelay=<timeline offset>,atrim=start=0...
```

後者は挿入した無音を切り落とし、stream総尺を保ったまま内容を先行させる。rendererは
`assertSafeAudioDelayFilterOrder`でこの順序を拒否し、package QAはdialogue-only stemの
window外信号を1フレーム未満に制限する。

## Cockpitでのレビュー運用

- 動画はside panel previewで見せ、同じ更新に絶対パスも併記する。Markdownのfile linkだけに依存しない。
- Askは本当に判断が必要な時だけ使い、同時に複数の未解決Askを作らない。
- 「テンポ」「タイトル尺」「終端」「同期」の判断を分ける。診断proxyをcreative approvalへ流用しない。
- 外部公開やSlack投稿は明示承認後に実行し、remote側の結果を検証する。

## 公開承認の最小例

```yaml
version: publication-approval/v1
project_id: example
created_at: "2026-07-21T00:00:00Z"
canonical_video:
  path: 09_output/final.mp4
  sha256: "sha256:<64 hex>"
approvals:
  creative:
    status: approved
    approved_by: operator
    approved_at: "2026-07-21T00:00:00Z"
    scope: creative approval for YouTube unlisted
    artifact_sha256: "sha256:<64 hex>"
  rights:
    status: approved
    approved_by: operator
    approved_at: "2026-07-21T00:00:00Z"
    scope: music and source rights for YouTube unlisted
    artifact_sha256: "sha256:<64 hex>"
  privacy:
    status: approved
    approved_by: operator
    approved_at: "2026-07-21T00:00:00Z"
    scope: appearance and privacy approval for YouTube unlisted
    artifact_sha256: "sha256:<64 hex>"
destinations:
  - platform: youtube
    visibility: unlisted
```

各承認の担当者・時刻・scopeを個別に記録する。preflightはcanonical file、package manifest、
QA、3承認、requested destinationのhash一致を検証する。

## 完了条件

- 冒頭の各情報を一度で認識できる。
- transitionにfreeze frameがない。
- 最終発言が意味単位で完結し、映像tailが動いている。
- loudnessとtrue peakがdelivery target内。
- `av_drift_valid`と`dialogue_timeline_alignment_valid`がpass。
- BGMを含む全素材の権利確認が完了。
- 公開対象がQA済み`09_output/final.mp4`の1本に一意化されている。
