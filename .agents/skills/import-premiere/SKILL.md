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
- Premiere 側で trim / reorder / delete、または audio gain / fade を変更した XML を `timeline.json` に戻したいとき。

## 前提条件
- `05_timeline/timeline.json` と 編集済み FCP7 XML があること。
- デフォルトは preview であり、明示的な `--apply` がない限り timeline と backup は更新されない。

## やること（ステップ）
1. デフォルトの preview で差分を確認する。

```bash
npx tsx scripts/import-premiere-xml.ts projects/<project> --xml /absolute/path/to/edited.xml
```

`--dry-run` も互換用の preview alias として利用できる。

2. diff が妥当なら `--apply` を明示して本適用する。

`--apply`にはexport時にXMLと同時生成されたreceiptが必須。

```bash
npx tsx scripts/import-premiere-xml.ts projects/<project> --xml /absolute/path/to/edited.xml --receipt /absolute/path/to/<project_id>_premiere.roundtrip.json --apply
```

3. 出力された report を読み、`trim_changed`, `reordered`, `audio_policy_changed`, `deleted`, `added_unmapped` と `unsupported_edit` の内容を確認する。

baked visual を含む base / XML は closed receipt v2 が必須。project/base/generation、outbound XML、bake index、sorted reverse maps、manifest、video-only media、hash、marker、rational residual を diff より前に検証する。v1へのdowngrade、missing/duplicate/malformed marker、artifact path traversal/symlink/hard-link、hash mismatch は `baked_media_unverified` としてbackup/write前にblockする。

baked videoで適用可能なのは unchanged、same-track reorder、deleteだけ。trim、track move、relink/source replacement、speed/rate、filter/effect、identity mutationは`baked_media_edit`で全体applyをblockし、通常clipの変更も部分適用しない。bakeをeditable visual effectとして扱わない。

receiptのexpected title manifestと正確なOutline Text shape、`surface=text_overlay` markerを`overlay_id` / `clip_id`で比較する。text、timing、receipt記録済みstyle、削除、重複、壊れたmarker/shape、unmapped generatorは`text_overlay_edit`としてreport-onlyになり、`--apply`をbackup・timeline書込み前にblockする。overlay-only sequenceのsole titleが削除・破損してsession markerが残らない場合も、manifest-bound reportをgeneric marker abortより先に確定し、適用しない。

`audio_policy_changed` は mapped audio clip の gain と fade-in / fade-out を役割別（BGM / natural sound）に比較し、元と更新後の `audio_policy` を独立した構造化 field として示す。gain は exporter の往復誤差を許容し、fade は exporter と同じ duration clamp 後の frame 値で比較する。audio-level filter の残存を確認できる場合は、個別 fade の削除も `audio_policy` の該当 property 削除として検出・適用する。同じ clip の trim / reorder と audio 変更は併用して適用される。

native effect として扱うのは audio track 上の Audio Levels だけである。raw exact `effectid=audiolevels` の filter は clip ごとに1個、exact `parameterid=level` は1個だけ許可し、finite な 0..4 の static linear gain、または clip duration 内で時刻が一意かつ厳密昇順の gain + fade-in/fade-out keyframe shape に限定する。重複 effect/parameter、余分な parameter、identity/shape 不一致、非有限・範囲外 value、曖昧な keyframe は `unsupported_edit` になり、apply を block する。reference が gain/fade の filter 出力を要求するのに returned mapped audio clip から filter 全体が消えた場合も `audiolevels_filter_missing` として block し、削除意図を推測しない。

`unsupported_edit` は mapped clip の direct `clipitem/speed`、sequence/exporter rate と不一致または不完全な present direct `clipitem/rate`、および未対応の direct clip filter/effect を構造化して報告する。audio track 上の raw exact `effectid` が `audiolevels` の effect だけは既存 audio policy 対応として除外する。`unsupported_edit` は report-only であり、`--apply` では supported diff と混在していても backup・書込み前に全体を block する。

simple transition は track ID と marker 内の `transition_id` / `from_clip_id` / `to_clip_id` を隣接XML endpointと照合し、durationだけでなくcanonical cutを中心とするstart/end windowも比較する。追加、削除、effect、duration、window、alignment、identity、orphan、duplicate、unknown effect は `simple_transition_edit` のreport-onlyとして示す。exact markerとvideo mediatypeとsupported name/effectid pairが揃わないtransitionをcanonical値へ復元せず、unknown effectをcrossfadeへdefaultしない。変更が1件でもあれば通常適用可能なclip/audio diffと混在していてもbackup・timeline書込み前にblockする。変更がなければclip/audio apply後もcanonical transitionをそのまま保持する。source handle authorityはmissingであり、apply/profile promotionの根拠にしない。

## 出力 artifact
- stdout の diff report
- `--apply` で applicable な mapped diff がある場合のみ、更新された `05_timeline/timeline.json`
- 同じ場合のみ、自動バックアップ `05_timeline/timeline.json.bak`

## 注意事項
- デフォルト preview と `--dry-run` では `timeline.json` と backup は更新されない。
- `--apply` と `--dry-run` の同時指定はエラーになる。
- `--apply`はreceiptのproject/sessionと現在のraw `timeline.json` base hashを検証し、不一致ならbackup・書込み前に失敗する。
- previewはreceiptなし、および`roundtrip_id`を持たないlegacy XMLでも利用できる。`--receipt`指定時は検証結果も表示する。
- `--json` は stdout に単一の JSON document のみを出力し、`mode` と `applied` を含む。
- preview JSON は `apply_blocked: false`。blocked apply は `applied: false`, `apply_blocked: true` と `unsupported_edit` / `text_overlay_edit` / `simple_transition_edit` の `block_reason` を返す。
- `added_unmapped` は自動適用されず、manual review 前提。
- 専用の report JSON は書かれない。差分は stdout にしか出ない。
- audio import の applicable diff は gain、fade-in / fade-out、および Audio Levels filter が残る場合の個別 fade 削除のみを対象とする。filter 全体の消失は applicable な削除にはせず、`audiolevels_filter_missing` として block する。
- Motion / Opacity / Crop / Lumetri / keying / speed / timeremap / nested / compound / arbitrary audio effect は native support ではない。mapped direct effect は apply を reject し、unmapped addition は report-only/manual review とする。visual effect fidelity が必要なら、既存の provenance/source-ledger authority の下で derived media に bake して通常 clip として扱う workflow を使う。bake を editable effect として表現せず、この import route で media を生成しない。
- nested/compound replacement は authentic な returned-Premiere fixture と一意な direct-node 契約がないため検出対象外。`timeremap` は effect として generic に block するだけで、timeremap 固有 semantics は主張しない。
- fixture ベースの検証やこの skill 自体は、実 Premiere hardware 上の動作証明を提供しない。
- baked pathも`hardware_verified:false`。import routeはbaked mediaを生成・再生成せず、receipt-bound ready artifactだけを検証する。
- Premiere XMLから`caption_approval.json`を更新しない。caption trackはこのroundtripのtitle surfaceではない。
