## 実装レビュー結果
- 🔴 FATAL: 4件
- ⚠️ WARNING: 5件
- 📝 NOTE: 3件
- ✅ GOOD: 特に良い実装パターン

### 🔴 FATAL 1: `compile()` と CLI が既定で非決定的
- `runtime/compiler/index.ts:93` は `opts.createdAt` 未指定時に `new Date().toISOString()` を使い、`scripts/compile-timeline.ts:29-32` も毎回 `new Date().toISOString()` を渡しています。
- これにより同一入力でも `created_at` が変わり、compiler 全体としては「同一入力 -> 同一出力」を満たしません。`compile()` を 20ms 間隔で 2 回呼ぶと `2026-03-21T04:48:57.828Z` と `2026-03-21T04:48:57.855Z` になりました。
- `tests/compiler.test.ts:77-85` は固定 timestamp を明示しているため、この非決定性を検出できていません。

### 🔴 FATAL 2: `src_in_us == src_out_us` を Phase 4 が実際には修復していない
- `ARCHITECTURE.md:214-216` は `src_in_us < src_out_us` を invariant として要求しています。
- しかし `runtime/compiler/resolve.ts:29-39` は `src_in_us >= src_out_us` のとき単に swap するだけなので、等値ケースでは no-op です。
- 再現確認では `src_in_us = 100`, `src_out_us = 100` の clip に対して `resolved_invalid_ranges: 1` が返った一方、clip 自体は `100/100` のままでした。
- `tests/compiler.test.ts:154-164` は正常系出力しか見ておらず、この repair path を検証していません。

### 🔴 FATAL 3: duplicate 解消の fallback 置換が clip provenance を破壊する
- `runtime/compiler/resolve.ts:97-103` は duplicate segment を fallback に差し替える際、`segment_id` と `motivation` しか更新していません。
- `asset_id`, `src_in_us`, `src_out_us`, `confidence`, `quality_flags` は元 clip の値のまま残るため、segment と source range の対応が崩れます。
- 再現確認では `SEG_DUP` を `SEG_FALLBACK` に置換しても `asset_id: "AST_2"`, `src_in_us: 20`, `src_out_us: 30` が残りました。`resolve()` は candidate lookup を持たないので、正しい fallback clip へ復元する情報自体がありません。
- これは `timeline.json` を canonical IR として持つ `ARCHITECTURE.md:191-197` の provenance 要件に反します。

### 🔴 FATAL 4: Phase 5 が `timeline.json` しか出力せず、`.otio` と preview manifest が未実装
- `ARCHITECTURE.md:276-280` は Phase 5 の出力を `timeline.json`, `.otio`, preview render manifest の 3 つと定義しています。
- しかし `runtime/compiler/export.ts:75-85` が書くのは `05_timeline/timeline.json` だけで、`runtime/compiler/index.ts:91-107` もその path しか返しません。
- 実際に `npx tsx scripts/compile-timeline.ts projects/sample` を実行すると、生成物は `projects/sample/05_timeline/timeline.json` のみでした。
- ARCHITECTURE.md 準拠の観点では Phase 5 未完です。

### ⚠️ WARNING 1: Phase 2 scoring が spec の責務分割とずれている
- `ARCHITECTURE.md:239-255` は Phase 2 の入力に adjacency penalties と beat alignment penalties を含めています。
- しかし `runtime/compiler/score.ts:122-124` は adjacency penalty を常に `0` とし、実際の減点は `runtime/compiler/assemble.ts:174-198` で後付けしています。
- beat alignment penalty 専用の入力や breakdown は存在せず、`runtime/compiler/score.ts:99-110` では duration fit の中に tolerance を流し込んでいます。
- 結果として Phase 2 の「ranked candidate table per beat」は、spec が想定する penalty を織り込んだ表になっていません。

### ⚠️ WARNING 2: motif reuse penalty が「採用結果」ではなく「候補母集団の頻度」に反応している
- `runtime/compiler/score.ts:24-30` は全 non-reject candidate の `motif_tags` 件数を先に数え、`runtime/compiler/score.ts:113-120` でその頻度に応じて全 beat で減点しています。
- これだと、まだ一度も採用していない motif でも候補が多いだけで penalty が乗ります。
- `ARCHITECTURE.md:245-253` の motif reuse limit は本来 output timeline 上の reuse 制御として効くべきで、現在の実装は意味がずれています。

### ⚠️ WARNING 3: Phase 4 の制約解決が spec の列挙を網羅していない
- `ARCHITECTURE.md:268-274` は overlaps, repeated shot overuse, invalid source ranges, music timing conflicts, silence / black / freeze QC conflicts の解決を要求しています。
- 実装 `runtime/compiler/resolve.ts:29-129` が扱うのは invalid range, same-track 内 same-asset overlap, duplicate segment, duration fit だけです。
- music timing conflicts と silence / black / freeze QC conflicts は未実装です。
- overlap も `runtime/compiler/resolve.ts:42` のコメントどおり「within the same track」限定で、review 観点の「同一 asset の source time overlap」全般には届いていません。

### ⚠️ WARNING 4: export/comment と実装がずれ、compile 前後の validation も弱い
- `runtime/compiler/export.ts:1-3` は「schema validation before writing」と書いていますが、実装 `runtime/compiler/export.ts:75-85` は validation を行わずそのまま書き込みます。
- `scripts/compile-timeline.ts:16-26` の pre-check も Gate 1 blocker だけを見ており、他の schema violation や runner violation があっても compile を止めません。
- そのため invalid input を `compile()` に直接渡した場合や、CLI で blocker 以外の violation を含む project を処理した場合の失敗モードが不安定です。

### ⚠️ WARNING 5: テスト 16 本は happy path に偏っており、高リスク failure path を外している
- `tests/compiler.test.ts:55-233` は sample fixture に対する統合 happy path が中心で、現在の FATAL 4件を捕捉できていません。
- 未テストの主要ケースは、`createdAt` 未指定時の非決定性、`src_in_us == src_out_us` repair、duplicate fallback 置換、same-asset overlap 解消、adjacency/tie-break 境界、empty candidates、all reject、CLI が `.otio` / preview manifest を出すか、です。
- scoring 自体も数値テストがなく、`runtime/compiler-defaults.yaml` の各値がどのように効くかを regression から守れていません。

### 📝 NOTE 1: Gate 4 / Gate 6 / provider 禁止事項は守れている
- repo 内検索では canonical `timeline.json` への write は `runtime/compiler/export.ts:75-85` のみでした。
- compiler/CLI から LLM provider, ffmpeg filter string, direct media mutation は見当たりませんでした。
- `ARCHITECTURE.md:181-187` の non-negotiable gate に関して、少なくとも「誰が timeline.json を書くか」「agent が media を直接書かないか」の線は守れています。

### 📝 NOTE 2: モジュール分割は明快だが、型は一部ゆるい
- `runtime/compiler/normalize.ts`, `score.ts`, `assemble.ts`, `resolve.ts`, `export.ts` の phase 分離は読みやすく、レビューしやすい構成です。
- 一方で `runtime/compiler/export.ts:88-102` の `toClipOutput()` は引数型を匿名 object + `role: string` に落としており、`runtime/compiler/score.ts:48-49` と `runtime/compiler/assemble.ts:233` でも cast に依存しています。
- `tsconfig.json` は `strict: true` で `npx tsc --noEmit` も通りますが、schema contract を表す型としてはまだ tighten できます。

### 📝 NOTE 3: Phase 1 の `role_quotas` は算出されるが、その後の制御には使われていない
- `runtime/compiler/normalize.ts:29-41` で `role_quotas` は作られていますが、以降の phase では参照されていません。
- 現時点では害はありませんが、ARCHITECTURE.md:231-233 が normalization output として明示している以上、将来 quota-driven assembly を想定しているなら drift の起点になります。

### ✅ GOOD
- phase ごとの責務分割はきれいです。`runtime/compiler/index.ts:67-105` で Phase 1-5 の流れが追いやすく、仕様レビューに向いた構成になっています。
- sort の tie-break は `segment_id` 辞書順で一貫しています。`runtime/compiler/score.ts:64-69`, `runtime/compiler/assemble.ts:77-81`, `runtime/compiler/assemble.ts:191-196`, `runtime/compiler/resolve.ts:53-58` を確認しました。
- sample fixture の happy path は通っており、`pnpm test -- tests/compiler.test.ts` は 16 test pass、`npx tsc --noEmit` も pass でした。
- sample compile の出力自体は `timeline-ir.schema.json` に通り、全 clip に `motivation`, `role`, `beat_id` と provenance が入っています。正常系 contract の骨格はできています。

### 改善優先度
1. `created_at` を input artifact から決定するか、CLI でも固定生成規則へ寄せて compiler/CLI の非決定性をなくす。
2. duplicate 解消は `segment_id` だけを差し替えず、candidate lookup から clip 全体を置換する。fallback 後の再重複チェックも追加する。
3. invalid range 修復を `src_out_us = src_in_us + 1` などで確実に strict inequality に直し、unit test を追加する。
4. Phase 5 に `.otio` と preview manifest を追加し、CLI/戻り値にも含める。
5. scoring を spec に合わせて整理し、adjacency と beat alignment の責務を明示する。motif reuse は selected timeline ベースへ寄せる。
6. `resolve()` と compiler test suite に failure-path の fixture test を追加する。
