## M2 Phase 2 実装レビュー結果
- 🔴 FATAL: 2件
- ⚠️ WARNING: 4件
- 📝 NOTE: 1件

## 詳細
### [FATAL] ingest.reduce 後に asset と source file の対応が壊れ、multi-asset で別ファイルのセグメント/派生物が紐づく
- 対象ファイル: `runtime/pipeline/ingest.ts` / `tests/pipeline-ingest.test.ts`
- 問題: `ingest.reduce` で asset を `asset_id` 昇順に並べ替えた後、`segment.map` と `derivatives.map` は元の `sourceFiles[i]` をそのまま `assets[i]` に対応付けている。入力順と `asset_id` 順がズレると、別ファイルの boundary/derivatives が他 asset_id に書き込まれる。
- 根拠: 設計は stable ID と reducer pattern を前提にしている (`docs/milestone-2-design.md:211-216`, `docs/milestone-2-design.md:1047-1081`)。一方で実装は `runtime/pipeline/ingest.ts:129-165` と `runtime/pipeline/ingest.ts:216-229` で sort 後 asset 配列に対し index ベースで元の `sourceFiles` を再利用している。再現確認では `test-clip-5s.mp4 = AST_889B5CCB`、`test-scene-changes.mp4 = AST_51E209EB` だったため、2本同時 run で `AST_51E209EB` に 1 segment、`AST_889B5CCB` に 3 segments が入り、単体実行時の真値と入れ替わった。
- 推奨修正: ingest.map の時点で `{ sourceFile, asset }` を結び付けた shard を reducer まで保持するか、`asset_id` / `source_fingerprint` keyed map で source を引き直す。2-file order inversion の integration test を追加する。

### [FATAL] ffmpeg detector failure が例外にならず、missing/failed input でも「ready の単一セグメント」を合成して gap_report に上がらない
- 対象ファイル: `runtime/connectors/ffmpeg-segmenter.ts` / `runtime/pipeline/ingest.ts`
- 問題: `execFilePromise()` が `err && stderr` を success 扱いするため、ffmpeg が失敗しても detector は空配列を返す。`segmentAsset()` はそのまま asset 全体 1 セグメントを生成し、`confidence.boundary.status: "ready"` を付ける。設計の `no silent fallback to empty semantics` に反する。
- 根拠: 設計は stage failure を `gap_report.yaml` に surfaced することを要求している (`docs/milestone-2-design.md:137-140`, `docs/milestone-2-design.md:1073-1081`)。しかし実装は `runtime/connectors/ffmpeg-segmenter.ts:71-80` で non-zero exit を握り潰し、`runtime/connectors/ffmpeg-segmenter.ts:95-123`, `runtime/connectors/ffmpeg-segmenter.ts:131-232`, `runtime/connectors/ffmpeg-segmenter.ts:503-585` で空 detector result を正常系として処理する。再現確認でも `detectSceneBoundaries("/no/such/file.mp4", 0.30)` と `detectBlackRegions("/no/such/file.mp4", thresholds)` は `[]` を返し、`segmentAsset("/no/such/file.mp4", fakeAsset, thresholds)` は 0→5000000 の単一 segment を返した。`runtime/pipeline/ingest.ts:266-304` の gap report も stage-local failure reason を保持していない。
- 推奨修正: non-zero exit は原則 reject し、parse 済み detector output を得られたケースだけ明示 whitelist する。stage-local gap shard に stderr 要約を残し、segment.map は detector failure 時に `ready` segment を生成しない。

### [WARNING] ffprobe の ID/path rule edge case が未実装で、collision extension と source_locator 境界チェックが設計未達
- 対象ファイル: `runtime/connectors/ffprobe.ts`
- 問題: `generateAssetId()` は常に先頭 8 桁で切り詰め、設計の collision extension を実装していない。加えて `source_locator` 判定は `absPath.startsWith(projRoot)` なので sibling prefix (`/proj-evil`) を project 内と誤認し、`../...` が canonical artifact に入る。
- 根拠: 設計は collision 時の hash suffix extension と project 内 source のみ canonical locator 化する path rule を定義している (`docs/milestone-2-design.md:211-213`, `docs/milestone-2-design.md:255-258`)。実装は `runtime/connectors/ffprobe.ts:169-170` で固定 8 桁切り出しのみ、`runtime/connectors/ffprobe.ts:289-295` で prefix 比較のみになっている。再現確認でも `projectRoot=/tmp/.../proj`、`source=/tmp/.../proj-evil/test.mp4` で `source_locator: "../proj-evil/test.mp4"` が入った。
- 推奨修正: `asset_id` 採番を専用 helper に寄せ、同 prefix collision 時は suffix extension で解決する。locator は `path.relative()` 後に `..` / absolute を拒否する。

### [WARNING] base quality flags / segment_type が設計書の canonical vocabulary に届いていない
- 対象ファイル: `runtime/connectors/ffmpeg-segmenter.ts`
- 問題: 実装されている base flags は `black_segment` / `frozen_frame` / `near_silent` / `very_short_segment` のみで、設計が live base layer に含める `clipped_audio` / `underexposed` / `minor_highlight_clip` が欠落している。`segment_type` も policy classifier ではなく固定 `general`。
- 根拠: 設計は `signalstats` / `astats` を使った deterministic QC と canonical vocabulary を要求している (`docs/milestone-2-design.md:296-301`, `docs/milestone-2-design.md:331`, `docs/milestone-2-design.md:339-347`)。一方で `runtime/connectors/ffmpeg-segmenter.ts:400-440` は 4 flag しか実装しておらず、`runtime/connectors/ffmpeg-segmenter.ts:554-566` は `segment_type: "general"` を固定で返す。
- 推奨修正: `signalstats` / `astats` を追加し、設計の base flag vocabulary を揃える。`segment_type` は policy-based classifier helper に切り出し、deterministic に算出する。

### [WARNING] poster fallback が設計と異なり、全 hard-reject asset でも midpoint fallback しない
- 対象ファイル: `runtime/connectors/ffmpeg-derivatives.ts`
- 問題: 設計は「全 segment が hard-rejected なら asset midpoint frame に fallback」と定義しているが、実装は sort 後の先頭 segment を常に返すため hard-reject only case でも midpoint に落ちない。
- 根拠: 設計の poster rule は `docs/milestone-2-design.md:384-392`。しかし `runtime/connectors/ffmpeg-derivatives.ts:197-223` は hard reject flag を ranking に使うだけで、all-rejected 判定を持っていない。
- 推奨修正: non-rejected segment を先に filter し、空なら midpoint を返す helper にする。poster selection の unit test を追加する。

### [WARNING] テスト網羅性が happy path に偏っており、上記 regressions を検出できていない
- 対象ファイル: `tests/pipeline-ingest.test.ts` / `tests/ffprobe-connector.test.ts` / `tests/ffmpeg-segmenter.test.ts`
- 問題: pipeline test は single-asset run のみで、determinism test も 1 ファイル比較のみ。ffprobe test は collision / source_locator 境界を見ておらず、segmenter test は ffmpeg failure path を見ていない。`ffmpeg-derivatives.ts` 専用 test も存在しない。
- 根拠: `tests/pipeline-ingest.test.ts:66-72` と `tests/pipeline-ingest.test.ts:215-248` はどちらも 1 source file しか使っていない。`tests/ffprobe-connector.test.ts:49-59` と `tests/ffprobe-connector.test.ts:148-174` は basic deterministic case のみ、`tests/ffmpeg-segmenter.test.ts:167-231` も happy path だけを見ている。`tests/` 配下に `ffmpeg-derivatives` / `generatePoster` / `generateContactSheets` への直接 test は存在しない。
- 推奨修正: 2-file order inversion pipeline test、detector non-zero-exit と gap_report の test、source_locator boundary test、poster hard-reject fallback test、derivative manifest/filmstrip determinism test を追加する。

### [NOTE] canonical artifact write discipline / schema happy path / command invocation の基礎は満たしている
- 対象ファイル: `runtime/pipeline/ingest.ts` / `runtime/connectors/*.ts`
- 確認: `assets.json` / `segments.json` / `gap_report.yaml` は reducer 側で temp file + rename を使っている (`runtime/pipeline/ingest.ts:77-93`, `runtime/pipeline/ingest.ts:192`, `runtime/pipeline/ingest.ts:200`, `runtime/pipeline/ingest.ts:250`, `runtime/pipeline/ingest.ts:259`, `runtime/pipeline/ingest.ts:371`)。外部コマンドも shell 展開ではなく `child_process.execFile` を使っている。現行 happy path では `npx vitest run` は PASS（171 tests）、`npx tsc --noEmit` も PASS で、pipeline output の assets/segments schema validation も通る。

## テスト結果
- vitest: PASS（171 tests）
- tsc: PASS

## 判定
FAIL
