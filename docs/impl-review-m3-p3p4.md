## M3 Phase 3-4 実装レビュー結果
- 判定: FAIL
- FATAL: 5件
- WARNING: 4件
- NOTE: 4件

## FATAL

### 1. `/review` が operator accept なしで clean approval へ遷移し、`critique_ready` を素通りしている
- 対象ファイル: `runtime/commands/review.ts`, `tests/commands.test.ts`, `docs/milestone-3-design.md`, `ARCHITECTURE.md`
- 問題:
  `fatal_issues` が空なら `runReview()` はその場で `approved` に進め、`approved_by` 未指定でも `roughcut-critic` を approval actor として記録する。設計は「review artifact を確定後に `critique_ready` へ進み、その後 operator accept があった場合のみ clean approval」としており、AI 自身が clean approval を確定してはいけない。
- 根拠:
  `runtime/commands/review.ts:524-554` は `hasFatal === false` で即座に `newState = "approved"` を選び、`runtime/commands/review.ts:549-553` で `approvedBy ?? "roughcut-critic"` を使って `approval_record` を作っている。
  `tests/commands.test.ts:1758-1775` はこの自動承認を happy path として固定している。
  設計は `docs/milestone-3-design.md:538-548` と `docs/milestone-3-design.md:817-820` で operator accept / creative override を approval 条件にしている。`ARCHITECTURE.md:203-211` も `approval_record` を operator record として扱う。
- 影響:
  review loop の最終判断が human-in-the-loop ではなく AI self-approval になる。`approval_record` の意味論が崩れ、`approved` 復元も誤った operator provenance に依存する。
- 推奨修正:
  `/review` 成功時はまず `critique_ready` に止め、clean approval は明示的な operator action でのみ確定する。clean approval でも `approved_by` を必須にし、`roughcut-critic` を default approver にしない。

### 2. `/review` の deterministic preflight が `compile` のみで、`review.mp4` / QC を生成・freshness 確認していない
- 対象ファイル: `runtime/commands/review.ts`, `runtime/compiler/index.ts`, `runtime/compiler/export.ts`, `tests/commands.test.ts`, `projects/sample`
- 問題:
  実装は compile 後に `timeline.json` を読むだけで、設計が要求する `render_preview` と `run_qc` を実行していない。critic が評価すべき `05_timeline/review.mp4` と QC summary の存在保証も freshness check もない。
- 根拠:
  `runtime/commands/review.ts:431-467` は `compile()` 実行後に `timeline.json` 読み込みと optional input 読み込みへ進むだけで、preview render / QC 呼び出しが存在しない。
  `runtime/compiler/index.ts:56-114` は `timeline.json` と `preview-manifest.json` を書くが、`review.mp4` も QC artifact も生成しない。`runtime/compiler/export.ts:101-133` も preview manifest のみである。
  `tests/commands.test.ts:1627-1640` は compile で `timeline.json` ができることしか見ておらず、`review.mp4` / QC を一切検証していない。
  `projects/sample` にも `05_timeline/review.mp4` は存在しない。
  設計は `docs/milestone-3-design.md:24`, `docs/milestone-3-design.md:64-67`, `docs/milestone-3-design.md:460-469`, `docs/milestone-3-design.md:852-863`, `ARCHITECTURE.md:192` で `/review` の deterministic compile -> preview render -> QC -> critique を必須化している。
- 影響:
  roughcut-critic は required input を満たさないまま評価する。technical deliverability / preview-based critique / QC evidence の前提が欠け、設計書どおりの critique baseline にならない。
- 推奨修正:
  `/review` に deterministic preflight runner を追加し、`timeline.json`, `review.mp4`, QC summary の生成または freshness 確認を完了してから agent を起動する。失敗時は `GATE_CHECK_FAILED` で止める。

### 3. `/blueprint` が unresolved blocker / `compile_gate` を最終 state 判定に使っておらず、`blocked` ではなく `blueprint_ready` に進めてしまう
- 対象ファイル: `runtime/commands/blueprint.ts`, `tests/commands.test.ts`, `docs/milestone-3-design.md`
- 問題:
  実装は `uncertainty_register.yaml` の `status: blocker` だけを見て `blocked` を決めており、`unresolved_blockers.yaml` 由来の compile blocker を無視している。さらに agent context に `unresolved_blockers.yaml` を渡していないため、planner 自体もその input contract を直接受け取れない。
- 根拠:
  `runtime/commands/blueprint.ts:177-225` は `creative_brief.yaml`, `selects_candidates.yaml`, `STYLE.md` しか読まず、設計 input に含まれる `unresolved_blockers.yaml` を読まない。
  `runtime/commands/blueprint.ts:268-286` は `uncertaintyRegister.uncertainties.some((u) => u.status === "blocker")` だけで `targetState` を決めており、`reconcileResult.gates.compile_gate` を一度も参照しない。
  `tests/commands.test.ts:1165-1190` は planning blocker のみを見ており、unresolved blocker が残るケースをカバーしていない。
  設計は `docs/milestone-3-design.md:334-338` で `unresolved_blockers.yaml` を blueprint input に含め、`docs/milestone-3-design.md:402-418` と `docs/milestone-3-design.md:807-812` で unresolved blocker または planning blocker が残る場合は `blocked` を要求している。
- 影響:
  compile gate が閉じている project でも `/blueprint` 後に `blueprint_ready` を主張できる。`/status` と `/review` の再開地点がズレ、state machine の意味論が壊れる。
- 推奨修正:
  `unresolved_blockers.yaml` を明示 input として読み、agent context に渡す。state 判定は `compile_gate === "blocked"` または planning blocker 検出時に `blocked` とし、その failure path を test で固定する。

### 4. P1P2 で指摘済みの multi-artifact promote 非原子性と concurrent edit guard 欠落が、P3/P4 でもそのまま残っている
- 対象ファイル: `runtime/commands/shared.ts`, `runtime/commands/blueprint.ts`, `runtime/commands/review.ts`, `docs/milestone-3-design.md`
- 問題:
  `draftAndPromote()` は validate 後に draft を順番に `renameSync()` するだけで、途中失敗時の rollback がない。さらに command 開始時 hash と promote 直前 hash を照合する concurrent edit guard も未実装で、P3/P4 の 2-artifact promote にそのまま波及している。
- 根拠:
  `runtime/commands/shared.ts:153-206` は validate failure 時 cleanup はあるが、promote failure rollback と preflight/post-run hash 照合を持たない。
  `/blueprint` は `edit_blueprint.yaml` と `uncertainty_register.yaml` を `runtime/commands/blueprint.ts:239-257` でまとめて promote している。
  `/review` は `review_report.yaml` と `review_patch.json` を `runtime/commands/review.ts:489-516` でまとめて promote している。
  設計は `docs/milestone-3-design.md:128-140` で atomic promote を、`docs/milestone-3-design.md:900-901` と `docs/milestone-3-design.md:1084-1088` で post-run hash mismatch 時の promote 中止を要求している。
- 影響:
  片方だけ canonical 化された半端な blueprint/review 状態を作りうる。別 session の operator edit も無検知で上書きする。
- 推奨修正:
  2-phase commit か rollback 付き staging promote を導入し、multi-artifact を unit として commit する。開始時 hash snapshot と promote 直前 snapshot がズレたら中止する test を追加する。

### 5. `insert_segment` の patch safety guard が anchor 一致を検証しておらず、任意位置への unsafe insert を通してしまう
- 対象ファイル: `runtime/commands/review.ts`, `tests/commands.test.ts`, `docs/milestone-3-design.md`
- 問題:
  human note 由来の `insert_segment` は machine-readable anchor 付きで deterministic target を要求されているが、実装は「どこかの note にその `with_segment_id` が出てきたか」しか見ていない。note の `timeline_in_frame` / `timeline_us` と op 側 anchor の一致を検証していない。
- 根拠:
  `runtime/commands/review.ts:326-346` は insert directive を `Set<string>` に落としており、anchor 情報を捨てている。
  `runtime/commands/review.ts:371-379` は `humanInsertDirectives.has(op.with_segment_id)` しか見ないため、同じ segment id なら別位置への insert でも通る。
  `tests/commands.test.ts:2025-2059` は anchor 一致の happy path しかなく、不一致 rejection を持たない。
  設計は `docs/milestone-3-design.md:489-493` と `docs/milestone-3-design.md:529-532` で deterministic insertion target と machine-readable anchor の整合を安全条件にしている。
- 影響:
  human が許可した source segment を AI が別フレームへ差し込んでも safe patch と見なされる。patch safety guard の根幹が弱い。
- 推奨修正:
  insert directive は `segment_id + timeline_in_frame/timeline_us (+ target clip/beat if needed)` で保持し、op 側 anchor と完全一致したときだけ通す。anchor mismatch の failure test を追加する。

## WARNING

### 1. `confirmed_preferences` contract と legacy `autonomy.mode` 推定が runtime で強制されていない
- 対象ファイル: `runtime/commands/blueprint.ts`, `schemas/edit-blueprint.schema.json`, `tests/commands.test.ts`, `docs/milestone-3-design.md`
- 問題:
  `confirmed_preferences` は schema 上 optional のままで、`mode/source` の組み合わせも runtime で検証されていない。さらに legacy brief で `autonomy.mode` が absent の場合、設計は `must_ask` が空なら `full`、それ以外は `collaborative` と read-time infer するとしているが、実装は常に `collaborative` に倒している。
- 根拠:
  `runtime/commands/blueprint.ts:188-196` は `autonomy.mode ?? "collaborative"` で固定 default にしている。
  `schemas/edit-blueprint.schema.json:147-149` と `schemas/edit-blueprint.schema.json:153-185` では `pacing.confirmed_preferences` 自体が required ではなく、`mode=collaborative` と `source=ai_autonomous` のような組み合わせも schema 上は通る。
  `tests/commands.test.ts:1402-1446` も absent mode を collaborative 扱いするケースしか固定していない。
  設計は `docs/milestone-3-design.md:365-378` と `docs/milestone-3-design.md:226-227` で fixed contract と read-time inference rule を定めている。
- 影響:
  `/blueprint` が schema-valid でも設計違反の `confirmed_preferences` を canonical 化できる。legacy brief の autonomy branching も誤る。
- 推奨修正:
  promote 前に `confirmed_preferences` の存在・`mode/source` 整合・`duration_target_sec`・timestamp を command 側で検証する。legacy brief の inference は `must_ask` ベースに修正する。

### 2. `human_notes.yaml` が schema-validate されず、parse failure は黙って `null` 扱いになる
- 対象ファイル: `runtime/commands/review.ts`, `schemas/human-notes.schema.json`
- 問題:
  `human_notes.yaml` は設計上 schema 化された operator evidence だが、実装は YAML parse 成功だけで agent と patch safety に渡す。parse failure は silently `null` に落とし、shape 不正でも `buildHumanApprovedSegments()` / `buildHumanInsertDirectives()` が iterable 前提で走る。
- 根拠:
  `runtime/commands/review.ts:593-601` は parse error を握り潰して `null` を返すだけで、`schemas/human-notes.schema.json` に対する validation を行わない。
  `runtime/commands/review.ts:304-346` は `humanNotes.notes` を前提に `for ... of` しており、schema-invalid shape を defensive に扱っていない。
  設計は `docs/milestone-3-design.md:498-532` で `human_notes.yaml` を schema-based evidence receptacle として扱い、safe patch 判定に machine-readable field を使うことを要求している。
- 影響:
  operator feedback が invalid file ひとつで silently 無視されるか、patch safety 中に例外化する。review loop の human priority が壊れる。
- 推奨修正:
  `human-notes.schema.json` を command 側で validate し、invalid なら `VALIDATION_FAILED` か少なくとも explicit warning/error を返す。parse error を `null` に落とすだけの fail-open は避ける。

### 3. `blocked` state の multi-session resume は依然として reconcile 側で壊れており、P3/P4 の blocked flow を不安定にしている
- 対象ファイル: `runtime/state/reconcile.ts`, `runtime/commands/blueprint.ts`, `docs/milestone-3-design.md`, `ARCHITECTURE.md`
- 問題:
  `/blueprint` 自体は planning blocker で `blocked` へ遷移できるが、startup reconcile が `blocked` を stable state として復元できないため、次回 command 起動時に `blueprint_ready` へ self-heal されうる。
- 根拠:
  `runtime/state/reconcile.ts:212-221` の `STATE_ORDER` に `blocked` がなく、`runtime/state/reconcile.ts:239-243` は timeline が無ければ無条件で `blueprint_ready` を返す。
  `runtime/commands/blueprint.ts:268-286` は immediate transition として `blocked` を書いている。
  設計は `docs/milestone-3-design.md:404-407`, `docs/milestone-3-design.md:809-812`, `ARCHITECTURE.md:189-191` で `blueprint_ready <-> blocked` を正式 state としている。
- 影響:
  uncertainty blocker が残る project の再開地点が安定しない。`/status` や `/review` の案内が session を跨いでぶれる。
- 推奨修正:
  gate 計算後に `compile_gate == blocked` または `planning_gate == blocked` を `blocked` 復元に反映し、resume test を追加する。

### 4. テストは happy path に寄っており、今回の設計差分を検出できていない
- 対象ファイル: `tests/commands.test.ts`, `docs/milestone-3-design.md`
- 問題:
  Blueprint/Review test は正方向ケースを多く押さえている一方で、今回の設計差分を露出させる負方向テストが不足している。
- 根拠:
  `tests/commands.test.ts:1104-1163` は `confirmed_preferences` の happy path のみで、mode/source mismatch や field 欠落を見ていない。
  `tests/commands.test.ts:1627-1640` は compile のみを見ており、`docs/milestone-3-design.md:1084` が要求する compile/render/qc preflight を検証していない。
  `tests/commands.test.ts:1758-1775` は operator accept 不要の自動 approval を success case にしている。
  `tests/commands.test.ts:2025-2059` は `insert_segment` anchor mismatch rejection を持たない。
  `docs/milestone-3-design.md:76-80`, `docs/milestone-3-design.md:1084-1088`, `docs/milestone-3-design.md:1193` は autonomy branching / patch safety / preflight / state branching の test gate を要求している。
- 影響:
  現在の `vitest` PASS は設計準拠の証明になっていない。review loop の重要 invariant が regression しやすい。
- 推奨修正:
  少なくとも以下を追加する: unresolved blocker で `/blueprint -> blocked`、clean approval に operator accept 必須、compile/render/qc preflight、invalid/malformed `human_notes.yaml`、`insert_segment` anchor mismatch、promote failure rollback、post-run hash mismatch 中止。

## NOTE

### 1. `/blueprint` の immediate planning blocker 検出自体は実装されている
- 確認:
  `runtime/commands/blueprint.ts:268-286` は `uncertainty_register.yaml` の `status: blocker` を見て `blocked` へ遷移している。`tests/commands.test.ts:1165-1190` もこの command-level 挙動を固定している。

### 2. `replace_segment` の source 制限は fallback / human-approved segments に限定されている
- 確認:
  `runtime/commands/review.ts:236-251` と `runtime/commands/review.ts:349-369` は `replace_segment` を `fallback_segment_ids` または `human_notes approved_segment_ids` に限定している。`tests/commands.test.ts:1904-2001` も allow/deny の両側を押さえている。

### 3. `approval_record.artifact_versions` へ `human_notes_hash` / `style_hash` を記録する wiring は入っている
- 確認:
  `runtime/commands/review.ts:638-646` は clean/override approval 時に `human_notes_hash` と `style_hash` を snapshot しており、`runtime/state/reconcile.ts:271-275` が stale 判定に使っている。この軸の invalidation/self-heal は設計意図に近い。

### 4. 2026-03-21 実行時点では test / typecheck は通っている
- 確認:
  `npx vitest run` は 14 files / 520 tests passed、`npx tsc --noEmit` も passed。
  ただし上記 FATAL/WARNING は、実行結果ではなく設計意味論とのズレに起因する。

## 総合判定

FAIL

主因は、Phase 4 の approval/preflight が設計書の human-in-the-loop critique loop に達していないこと、Phase 3 の blocked semantics が unresolved blocker を取り込めていないこと、そして P1P2 で既知だった promote/concurrency の safety gap が P3/P4 にもそのまま残っていることにある。テストと型チェックは 2026-03-21 時点で通過したが、現状の PASS は主として happy-path 実装を確認しているだけで、設計が要求する gate / approval / safety invariant の担保には不足している。
