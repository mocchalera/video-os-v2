## 実装レビュー結果
- 🔴 FATAL: 2件
- ⚠️ WARNING: 3件
- 📝 NOTE: 2件
- ✅ GOOD: 特に良い実装パターン

### 🔴 FATAL 1: Gate 2 を素通りする `timeline.json` の見落とし
- `ARCHITECTURE.md:171-183,191,216,278-285` は canonical artifact を `timeline.json` と定義し、timeline schema fail 時は final render を止める契約です。
- しかし `scripts/validate-schemas.ts:99-108` は `05_timeline/` 配下の `*.timeline.json` しか検査せず、`05_timeline/timeline.json` を完全に無視します。
- 再現確認: `05_timeline/timeline.json` に invalid JSON object を置いても `validateProject()` は `valid: true`, `artifacts_checked: 5`, `compile_gate: "open"` を返しました。
- この状態だと canonical timeline に対する schema gate が実装されておらず、Non-negotiable Gate 2 を満たしていません。

### 🔴 FATAL 2: `review_report` / `review_patch` が未検証で Gate 3 を実装していない
- `ARCHITECTURE.md:172-187` は `review_report.yaml` と fatal review issue を gate 対象にしています。`agent-src/roles/roughcut-critic.yaml:9-11` でも出力先は `projects/*/06_review/review_report.yaml` / `review_patch.json` です。
- しかし `scripts/validate-schemas.ts:32-38` の schema map は 5 artifact しか持たず、`schemas/review-report.schema.json` と `schemas/review-patch.schema.json` は一度も読み込まれません。`06_review/` 自体も走査していません。
- 再現確認: `06_review/review_report.yaml` に `fatal_issues` を含む valid document を置いても `validateProject()` は `valid: true`, `compile_gate: "open"` を返しました。
- これにより review artifact 契約の機械検証が存在せず、Non-negotiable Gate 3 も未実装です。

### ⚠️ WARNING 1: schema-invalid 入力で violation ではなく例外終了する
- `scripts/validate-schemas.ts:133-146`, `160-188`, `195-226` は schema validation 後の runner で `candidates`, `beats`, `segments.items`, `assets.items` を型アサーション前提で走査しています。
- `Array.isArray` などの guard がないため、schema-invalid だが parse 自体は成功する入力で `TypeError` が発生します。再現として `selects_candidates.yaml` の `candidates` を object にすると `TypeError: candidates is not iterable` で落ちました。
- `loadYaml()` / `loadJson()` も `scripts/validate-schemas.ts:42-47` で例外をそのまま投げるため、YAML parse error や broken JSON も `ValidationResult` に落ちません。
- validator の主目的は「落ちること」ではなく「違反を報告すること」なので、CI gate としては扱いづらいです。

### ⚠️ WARNING 2: `uncertainty_register.yaml` の blocker semantics を実装が黙って片側に寄せている
- `docs/milestone-1-design.md:130-133` は `uncertainty_register.yaml` の `status: blocker` でも compile/render stop を要求しています。
- 一方で `ARCHITECTURE.md:168-183` は `unresolved_blockers` 側だけを hard gate と読める書き方で、`docs/milestone-1-review-r2.md:18-20` でも未解決 warning として残っています。
- 現実の実装は `scripts/validate-schemas.ts:231-250` で `01_intent/unresolved_blockers.yaml` しか gate 判定していません。`uncertainty_register.yaml` に `status: blocker` を入れても `valid: true`, `compile_gate: "open"` でした。
- 契約が未確定なら TODO として明示すべきで、現状は意味論を silent に固定しています。

### ⚠️ WARNING 3: テストが高リスク経路を外している
- `tests/validate.test.ts` の 9 テストは `src_in_us < src_out_us`、参照整合、`required_roles_covered`、`unresolved_blockers`、versioned timeline (`05_timeline/v001.timeline.json`) には触れています。
- ただし次が未テストです。
- `05_timeline/timeline.json` という canonical filename
- `06_review/review_report.yaml` / `review_patch.json`
- malformed YAML / broken JSON / schema-invalid shape での例外ハンドリング
- repo 外 path を渡したときの `findRepoRoot()` 前提
- その結果、今回の FATAL 2件と WARNING 1件をテストが捕捉できていません。

### 📝 NOTE 1: API は repo 内 path 前提で、外部 temp fixture だと失敗する
- `scripts/validate-schemas.ts:50-57` の `findRepoRoot()` は `projectPath` から親方向に `schemas/` を探す実装です。
- repo 外にコピーした fixture を `validateProject()` に渡すと `Could not find repo root (directory containing schemas/)` で落ちます。
- 現状の tests は `tests/validate.test.ts:15-16` で repo 内に temp dir を作るため問題化していませんが、API の使い勝手としては暗黙前提が強いです。

### 📝 NOTE 2: schema 追加時の変更点が分散している
- `ARTIFACT_SCHEMA_MAP` のハードコード (`scripts/validate-schemas.ts:32-38`) と `05_timeline` の別処理 (`scripts/validate-schemas.ts:99-127`) が分かれているため、新 artifact / schema の追加時に実装変更箇所が増えます。
- たとえば今回抜けた `06_review/*` も、「schema map に足す」では済まず、ディレクトリ走査と gate logic まで別途実装が必要です。
- artifact registry を manifest 化して `kind`, `path`, `format`, `runnerChecks` を一元管理した方が将来拡張しやすいです。

### ✅ GOOD
- `scripts/validate-schemas.ts` は read-only で、media を書いたり `timeline.json` を mutate したりしていません。Gate 4/5/6 の禁止事項は守れています。
- JSON Schema と runner invariant を分ける二段検証の骨格はできています。`src_in_us < src_out_us` を schema 外の runner に置いた判断は `ARCHITECTURE.md:205-216` と整合しています。
- 境界値 `src_in_us == src_out_us` を `tests/validate.test.ts:101-124` で明示的に検証しているのは良いです。
- テストは sample fixture から temp project を作る方式で、外部サービス依存がなく独立実行できます。`npm test` と `npm run build` は通過しました。

### 改善優先度
1. `05_timeline/timeline.json` と `06_review/*` を validator 対象へ追加し、Gate 2 / Gate 3 を `ValidationResult` 上で表現する。
2. parse / shape error を catch して violation 化し、runner は schema-invalid data に対して defensive に振る舞う。
3. `uncertainty_register.status == blocker` の扱いを契約で確定し、その決定に合わせて gate とテストを追加する。
4. artifact registry を manifest 化して、schema 追加時に validator 本体の分岐を増やさない構造へ寄せる。
