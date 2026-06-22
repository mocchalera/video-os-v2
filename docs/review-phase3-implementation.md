# Phase 3 Visual & Audio Search Panel Implementation Review

Date: 2026-06-22

Overall: Concern

重大な実装 Fail は見つかりませんでした。CLI/Core runner/UI wiring は概ね期待どおり動作します。一方で、Swift の `SearchResponse` が runtime の JSON shape を完全には表現していない点と、CLI/Swift/UI をまたぐ visual/audio integration のテストが薄い点は Phase 3 の安定性リスクとして残ります。

## Review Results

| # | 観点 | 判定 | 根拠 |
|---|---|---|---|
| 1 | `footage-search-cli.ts` が `searchFootage()` を正しく呼ぶか。`disposeFootageSearch()` cleanup があるか | Pass | `searchFootage(projectDir, input)` を呼び、正常系は `finally` で cleanup しています。トップレベル `catch` でも parse/validation 失敗時を含めて `disposeFootageSearch()` を呼ぶため、worker lifecycle は閉じられます。 |
| 2 | `--image-query-path` / `--audio-query-path` の絶対パス validation と project 基準 relative resolve | Pass | CLI は相対 path を `projectDir` 基準の絶対 path に変換します。runtime 側は absolute check、拡張子、存在、`realpath`、regular file、project root または承認 root 配下チェックを行うため、`../` escape や symlink escape は拒否されます。 |
| 3 | `FootageSearchRunner` の subprocess pattern が `CandidateBrowserDataSource` と一貫しているか | Pass | `Task.detached`、`SubprocessRunner.run`、`npx tsx ... --project ... --json`、exit code handling、JSON decode failure handling が Candidate browser と同じ構造です。 |
| 4 | `SearchResponse` / `SearchResult` Codable が実際の `FootageSearchResponse` JSON shape と一致するか | Concern | 実 JSON の `query` は `SearchFootageInput` object ですが、Swift 側は `String?` として保持し、custom decode で `query.query` だけを抜き出します。UI 用には十分ですが、型としては lossy で、round-trip test も runtime と違う string query shape を通しています。`SearchResult` は必要 subset を decode し、余剰 field は無視できるため実用上は問題ありません。 |
| 5 | `scores: [String: Double]?` decode が null/missing/nested object に耐えるか | Pass | missing/null は `nil`、`weights` や `embedding_matches` のような non-numeric nested values は無視し、numeric channel だけ保持します。 |
| 6 | `FootageSearchView` の mode 切替が `searchFootage` mode に渡るか | Pass | Picker の enum raw value が `text` / `visual` / `audio` / `hybrid` / `multimodal` で、`FootageSearchRunner.search(... mode: mode.rawValue ...)` にそのまま渡っています。 |
| 7 | 画像/音声アンカー選択 UI が絶対 path を生成するか | Pass | `NSOpenPanel` の選択結果を `url.path` で格納するため、選択 UI 経由では absolute path になります。手入力の相対 path は CLI/runtime 側で project 基準 resolve と containment validation に回ります。 |
| 8 | per-channel score bars の色が設計と一致するか | Pass | `e5_text=.blue`, `qwen_visual=.purple`, `qwen_text=.teal`, `clap_audio=.orange`, `lexical=.gray` で設計どおりです。 |
| 9 | "Use in beat" の `replace_segment` op 生成が正しいか | Pass | 選択 beat から target clip を解決し、`replaceSegment(target_clip_id: target.id, with_segment_id: result.segment_id, with_candidate_ref: "footage_search:<mode>", reason: ...)` を追加します。compiler schema の必須 key と一致し、query path は含みません。 |
| 10 | Command Palette の "Search Footage" entry が適切か | Pass | project 選択時のみ enabled、検索語・Qwen・CLAP の keyword が入り、`model.openFootageSearch()` に接続されています。 |
| 11 | `CandidateSwapView` の "Search for more..." が `openFootageSearch` を呼ぶか | Pass | `CandidateSwapView` は `onSearchForMore` を呼び、`ContentView` 側の closure が swap sheet を閉じて `model.openFootageSearch(for: clip)` を呼びます。 |
| 12 | テストカバレッジが十分か | Concern | Core search の Qwen/audio tests は存在し、今回追加の CLI text path と Swift Codable tests は通っています。ただし CLI 経由の visual/audio path resolve、CLI cleanup、`FootageSearchRunner` の subprocess argument construction、UI の mode/path/use operation、Command Palette/CandidateSwap route は直接テストされていません。 |
| 13 | セキュリティ: query path が patch JSON に混入しないか | Pass | `FootageSearchView.use()` が patch op に入れるのは target clip ID、result segment ID、`footage_search:<mode>`、summary/segment reason のみです。`image_query_path` / `audio_query_path` は patch operation に入る経路がありません。 |

## Verification

- Pass: `npx vitest run tests/footage-search-cli.test.ts`
- Pass: `swift test --filter FootageSearchRunnerTests`
- Pass: `swift build`
- Pass: `npx tsc --noEmit`

## Main Concerns

1. Swift `SearchResponse.query` is lossy
   - Runtime shape: `query` is a full `SearchFootageInput` object containing mode, limit, and possible query paths.
   - Swift shape: `String?`, decoding only `query.query`.
   - Recommendation: either rename it to `queryText` internally, or model a minimal nested query object so tests reflect the real JSON contract.

2. Integration test gaps remain
   - Add CLI tests for `--image-query-path` and `--audio-query-path`, including relative project-local paths and escape attempts.
   - Add Swift tests around argument construction if `SubprocessRunner` can be injected.
   - Add a focused test for `FootageSearchView.use()` / `StudioFeedbackSession` patch output to lock down that query paths never enter `review_patch.json`.
