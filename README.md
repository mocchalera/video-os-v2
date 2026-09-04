# RoughCut Agent

素材フォルダと一言の依頼から、解析・検索・粗編集・レンダー・QA 改善まで進める映像編集エージェント。

![RoughCut Agent](docs/images/demo-00-intro.jpg)

## このプロジェクトについて

RoughCut Agent は、映像素材から意図整理、素材解析、マルチモーダル検索、構成設計、粗編集、レンダー、QA 改善ループまでを artifact-driven に進める映像編集エージェントです。

Marlin-2B が映像を見て、Qwen3-VL / CLAP / E5 が素材を検索し、Claude/Codex が evidence を引用しながら rough / fine pass を作り、deterministic compiler が同じ入力から同じ `timeline.json` を再現します。

現在は複数プロジェクトの検証を通じて、`footage.db`、`timeline.json`、`render-report.json`、QA レポートなどの実 artifact を見ながら品質を上げる設計に寄せています。

Premiere Pro との FCP7 XML ラウンドトリップにも対応しており、AI が作った rough cut を NLE で微調整して戻せます。
映像クリエイターや、素材探しから粗編集の手戻りまでを短くしたい人向けのリポジトリです。

## 現行プロダクトとランタイムの責務

- `apps/macos-studio` (`VideoOSStudio`) が現行の正式なオペレーターサーフェスです。GUI と `videoos-studio-cli` は canonical artifacts を読み、必要な処理を `runtime/` と `scripts/` の entrypoint 経由で実行します。
- `editor/server` は引き続きサポートするローカル preview/API infrastructure です。exact preview、media delivery、timeline/review API、WebSocket 通知を提供し、`npm --prefix editor run server -- --project ../projects/<project-id>` で明示的に起動します。macOS Studio の起動や通常操作には不要で、Studio から自動起動・呼び出しもしません。
- `editor/shared` は preview と final render の parity contract を支える共有実装としてサポートします。
- `editor/client` はリタイア済みの旧 Web UI です。新機能・通常保守の対象ではなく、現行 UI の実装先にしないでください。履歴参照のため source は残しています。

CI はこの境界に合わせ、PR では [`ci.yml`](.github/workflows/ci.yml) の単一 Ubuntu fast product gate（schema、契約、repo、build）を実行します。Dev / main / public-candidate への protected push と手動 dispatch では [`full-integration.yml`](.github/workflows/full-integration.yml) が全 Node suite、preview server、real render を実行し、手動 dispatch では macOS Studio も含めます。Studio/Swift 関連パスの PR または protected push だけ [`macos-studio.yml`](.github/workflows/macos-studio.yml) が起動します。`editor/client` の build は意図的に required CI に含めていません。実行モードとコスト境界の詳細は [`docs/ci-workflow-modes.md`](docs/ci-workflow-modes.md)、製品境界は [`editor/README.md`](editor/README.md) と [`ARCHITECTURE.md`](ARCHITECTURE.md) を参照してください。

現行正を確認するときは、まず [`docs/CURRENT_ARCHITECTURE.md`](docs/CURRENT_ARCHITECTURE.md) を読み、続けて [`docs/DECISIONS.md`](docs/DECISIONS.md)、[`docs/PIPELINE_STATES.md`](docs/PIPELINE_STATES.md)、[`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md)、[`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md)、[`docs/DEPRECATED.md`](docs/DEPRECATED.md) を参照してください。過去の design / review 文書は履歴資料であり、これらの現行正、schema、実行コード、CI を上書きしません。

## 特徴

- 自律パイプライン: `intent -> analysis -> footage DB -> retrieval -> rough/fine planning -> compile -> render -> QA loop`
- 3 モダリティ検索: Qwen3-VL visual 2048-dim、E5/Qwen text 384/2048-dim、CLAP audio 512-dim を同じ検索レイヤで扱う
- マルチモーダル footage DB: SQLite + FTS5 + `embedding_models` + `segment_embeddings` で、モデル ID / 次元 / runner / preprocess を追跡
- Visual pre-selection retrieval: brief の visual intent から Qwen3-VL hybrid search を走らせ、rough pass の prompt に evidence を注入
- Audio pre-selection retrieval: brief の audio intent から CLAP hybrid search を走らせ、音の質感・環境音・ムードの候補を prompt に注入
- Marlin-2B primary VLM: Apple Silicon / ローカル worker で video-native な scene / event / peak analysis を実行
- VLM ピーク検出: Progressive Resolution（`contact sheet -> filmstrip -> precision`）と Marlin event を使って、編集上おいしい瞬間を候補化
- `content-hint` CLI: `--content-hint` で VLM に文脈情報を渡し、認識精度を補強
- Scene continuity ordering: timestamp clustering と Qwen visual coherence による greedy chain で、同一シーンや見た目のつながりを保つ
- QA auto-improvement loop: `render -> Marlin QA -> brief alignment -> issue detection -> fix proposal -> apply -> recompile -> rerender` を最大 3 iteration で実行
- Render duration accounting: expected / actual render duration、gap、xfade overlap、source clamp を `render-report.json` で検証
- 汎用エンディング処理: 最終発話後の素材ハンドルを余韻として残し、音声フェードと任意の黒／白フェードを決定論的に適用
- 編集技法の自動選択: Transition Skill Cards + Adjacency Analyzer + Walter Murch の Rule of Six
- BGM ビートシンク: カットポイントを beat / downbeat にスナップ
- Duration Mode: `strict` / `guide` を creative brief と profile から解決。`guide` は VLM peak 保護を優先
- Premiere Pro ラウンドトリップ: FCP7 XML export / import、UXP Watcher、diff engine を実装
- アスペクト比自動対応: 最頻アスペクト比を推定し、`letterbox` / `pillarbox` を判定
- 時系列順コンパイル: `keepsake` / `event-recap` 系は chronological order を選択可能
- 長尺イベント削減: `longform-event` は2時間級の固定カメラ素材を発話窓と章に分け、不要区間を記録しながら約1時間の時系列タイムラインへ決定論的に圧縮
- macOS Studio: Viewer、Source Monitor、素材ビン、Timeline、Inspector、候補差し替え、マルチモーダル検索、QA、インタビューMA・自動画角、patch apply / undo、render / handoff を1つのネイティブUIで操作
- 字幕ヒューマンレビュー: リスク順キュー、本文・分割・結合・IN/OUT編集、動画loopと波形、IME対応autosave、用語候補、stale競合検出を備え、明示的な人間承認だけで `caption_approval.json` を生成
- Schema 駆動 + Gate 制御: canonical artifacts を validate しながら進行
- Full Autonomy Mode: `autonomy.mode: full` で brief 確定後の確認ゲートを自動通過し、粗編集まで自走
- ローカル推論 / 埋め込み実行: Qwen3-VL、CLAP、E5、Marlin はローカル実行を前提にし、外部 embedding API は不要
- Fail-open: Qwen / CLAP / Marlin のローカルモデルが無い場合も、既存の E5 / FTS / deterministic path を壊さない

## クイックスタート

### 1. インストール

```bash
npm install
```

エディタサーバーを実際に起動するテスト（`npm run test:editor-server-integration` など）を実行する場合は、追加で `npm --prefix editor ci` が必要です。

HyperFrames / Remotion の exact preview は、ローカルに `pyftsubset`
（FontTools）があれば表示文字だけの WOFF2 を生成・再利用します。未導入でも
ネットワークへは接続せず、同梱済み Noto Sans JP のフルTTFへ安全に
fallbackします。キャッシュ先は macOS では
`~/Library/Caches/video-os/font-subsets`、上書きは
`VOS_FONT_SUBSET_CACHE_DIR` / `VOS_PYFTSUBSET_BIN` で指定できます。

### 2. 環境変数とローカルモデルを用意

```bash
cp .env.example .env.local
```

`.env.local` は Git 管理対象外です。公開 issue や PR に API キー、素材ファイル、生成済み動画を含めないでください。

埋め込み検索はローカルモデルで動くため外部 API キーは不要です。Gemini / Groq / OpenAI / pyannote などの外部解析を使う場合だけ、対応するキーを `.env.local` に設定してください。

Qwen3-VL と CLAP は任意ですが、現在の推奨フローでは有効化します。smoke test は Python venv を作り、ローカル cache にある model weight だけを使います。

```bash
bash scripts/smoke-test-qwen3vl.sh
bash scripts/smoke-test-clap.sh
```

ローカル model cache がまだ無い場合、smoke test は失敗します。その場合も E5 / FTS5 中心の検索と deterministic compile は継続できます。

### 3. デモを実行

```bash
npm run demo
```

出力例:

```text
─────────────────────────────────────────────────
  RoughCut Agent — Demo (deterministic compile)
─────────────────────────────────────────────────

[1/3] Reading artifacts from projects/demo/...
  - creative_brief.yaml   (intent)
  - selects_candidates.yaml (candidates)
  - edit_blueprint.yaml   (structure)

[2/3] Running deterministic compiler (Phase 0.5 → 5)...
  Phase 0.5  Duration policy resolved
  Phase 1    Blueprint normalized
  Phase 2    Candidates scored
  Phase 3    Multi-track assembly
  Phase 4    Constraints resolved
  Phase 5    Timeline exported

[3/3] Compilation results:

  Duration mode:    guide
  Target:           28.0s
  Compiled:         28.6s
  Duration fit:     YES
  Overlaps fixed:   0
  Duplicates fixed: 0
  Invalid ranges:   0
  Output:           projects/demo/05_timeline/timeline.json

  Timeline: "Mountain Reset"
  Tracks:   2 video + 3 audio
  Clips:    14 total

  Pre-generated review (from roughcut-critic):
  Judgment:    needs_revision
  Confidence:  0.82
  Strengths:   2
  Weaknesses:  2
  Fatal:       0

─────────────────────────────────────────────────
  Demo complete. Explore projects/demo/ to see all artifacts.
─────────────────────────────────────────────────
```

### 4. 自分の素材を full-pipeline で実行

```bash
npm run full-pipeline -- \
  --project my-project \
  --source-dir /path/to/footage \
  --content-hint "子どもの自転車練習"
```

`/full-pipeline` の npm equivalent です。プロジェクトが無ければ `projects/_template/` から作成し、`analyze -> footage DB -> editorial-pipeline` を単一コマンドで進めます。主な出力は `03_analysis/assets.json`、`03_analysis/search/footage.db`、`04_plan/selects_candidates.yaml`、`04_plan/edit_blueprint.yaml`、`05_timeline/timeline.json`、`09_output/rough-cut.mp4`、`09_output/render-report.json`、QA レポートです。

実行中は stage ごとに progress / ETA が出ます。TTY では 1 行更新、非 TTY では行追記です。

```text
[3/10] triage 実行中... 経過 1m32s / 推定残り ~4m (全体 ~7m)
```

各実行後、stage 別の実測時間を `projects/my-project/03_analysis/pipeline-timings.json` に追記します。次回実行ではこの履歴を読んで ETA を推定し、初回は `segments.json` のセグメント数を使った粗い見積もりにフォールバックします。どちらも無い stage は `計測中` と表示します。

長尺イベントでは `creative_brief.yaml` の `editorial.profile_hint` を `longform-event`、`project.runtime_target_sec` を希望尺（例: `3600`）に設定します。公式 `full-pipeline` は transcript-first の削減計画へ自動分岐し、章カバレッジや尺を満たせなければコンパイル前に停止します。設定と artifact 契約は [`docs/longform-event-mode.md`](docs/longform-event-mode.md) を参照してください。

### 5. パッケージまで進める

```bash
npm run render-route -- projects/my-project
npm run final-render-review-pack -- plan --project projects/my-project
npm run final-render-review-pack -- build --project projects/my-project --source projects/my-project/05_timeline/assembly.mp4
npm run final-render-checklist -- approve --project projects/my-project [checklist options]
npm run package -- projects/my-project --preflight-only --json
npm run caption-finalize -- run --project projects/my-project
```

`--preflight-only --json` はproject artifactを書き換えず、Studioと同じGate 10判定を返します。
長尺のfinal全体を焼く前に、`final-render-review-pack`は冒頭・中盤・終盤、問いかけ、
最長/2行字幕、全章タイトルだけを本番と同じASS・固定フォント・HyperFramesで
一つの短いreview reelへ描画します。visual timeline projection、caption approval、
元映像、fontが同じなら再利用します。元映像の解像度、rational FPS、総尺、音声streamが
timelineと一致しない場合と、承認manifestのSHAが無いfinal renderはfail closedです。
`render-route` は `timeline.json` の要素所有権から FFmpeg / Remotion /
HyperFrames の組み合わせを読み取り専用で表示します。`package` は同じ判定を
`auto` で使い、通常ジャンルの既存 FFmpeg 経路を維持したまま、登録済み要素が
必要な場合だけ Remotion / HyperFrames を有効化します。詳細は
[`docs/render-routing.md`](docs/render-routing.md) を参照してください。

短尺SNSのコールドオープン、早いpayoff、視聴者向け章題、固定画の意味的な視覚更新は、
[`docs/short-form-retention-planning.md`](docs/short-form-retention-planning.md) の明示的な適用条件と監査に従います。

`npm run full-pipeline` は粗編集と QA loop までを主導します。人間が字幕を承認した後は `caption-finalize` が fresh ASS/SRT、final、QA、manifest、preview/receipt を世代単位で作り、全検証成功時だけ `07_package/active_delivery.json` をatomicに切り替えます。運用手順とlegacy互換は [`docs/caption-finalize-runbook.md`](docs/caption-finalize-runbook.md) を参照してください。

### 6. VideoOSStudioで確認・仕上げ

```bash
swift run VideoOSStudio
```

VideoOSStudio はこのリポジトリの正式なオペレーターUIです。canonical artifacts を直接読み、素材検索、タイムライン編集、Agent相談、QA、字幕仕上げ、render、Premiere / editor packet handoffを同じプロジェクト上で扱います。診断・自動化には `swift run videoos-studio-cli <command>` を使います。

字幕の機械ドラフトを人間が仕上げる場合は、Studio上部の「字幕仕上げ」を開きます。headless運用では同じReview Coreを使う `scripts/caption-review.ts` を利用できます。字幕のartifact契約と操作手順は [`docs/design-caption-human-review-workflow.md`](docs/design-caption-human-review-workflow.md)、プロジェクト固有の表記ルールは [`docs/caption-glossary.md`](docs/caption-glossary.md) を参照してください。

生成BGM候補を仕上げる場合は、Studio上部の音符アイコンから
`musical-review-queue.json` を開きます。候補を単体または照合済みtimeline
previewの会話と重ねて試聴し、音楽適合・会話適合・生成品質・独自性・
権利証跡を別々に保存できます。候補の完了や採用候補化は公開利用許可を
意味しません。詳細は
[`docs/bgm-pack/core-v1/README.md`](docs/bgm-pack/core-v1/README.md) を参照してください。

## CLI EntryPoints

公開サポートしている主要 CLI は次の通りです。

| Entry point | Purpose | Command |
|-------------|---------|---------|
| `full-pipeline` | init / analyze / footage DB / planning / compile / render / QA を単一実行 | `npm run full-pipeline -- --project <project-id> --source-dir /path/to/footage [--content-hint "..."]` |
| `init-project` | 新規プロジェクトの雛形作成 | `npx tsx scripts/init-project.ts <project-id> [--source-dir /path/to/footage]` |
| `analyze` | 素材解析と `03_analysis/` 生成 | `npx tsx scripts/analyze.ts <source-files...> --project projects/<project-id>` |
| `build-footage-db` | SQLite / FTS5 / Qwen3-VL / CLAP embedding DB 生成 | `npx tsx scripts/build-footage-db.ts --project projects/<project-id> [--qwen3vl] [--clap-audio]` |
| `editorial-pipeline` | retrieval → planning → compile → render → QA の統合実行 | `npx tsx scripts/editorial-pipeline.ts --project projects/<project-id> [--skip-fine] [--skip-render] [--skip-qa]` |
| `render-rough-cut` | `timeline.json` を BGM 付き MP4 にレンダーし duration parity を記録 | `npx tsx scripts/render-rough-cut.ts --project projects/<project-id> [--output path] [--bgm path]` |
| `promo-finish` | transcript aligned 字幕、最後の余韻、音声/映像フェード付き宣材MP4を生成 | `npm run promo-finish -- --project projects/<project-id> [--output path]` |
| `caption-review` | draft復旧、risk queue、安全な一括確認、編集、split / merge、timing、用語候補、検証、人間承認、visual treatmentのinit/status/apply/undo/bind | `npx tsx scripts/caption-review.ts <queue|prepare|recover|init|verify-safe|edit|split|merge|glossary-propose|undo|apply|validate|approve|visual-init|visual-status|visual-apply|visual-undo|visual-approve> --project projects/<project-id> [options]` |
| `caption-finalize` | 承認intentをimmutable化し、caption-bound納品一式を世代生成・検証してatomicにactive化 | `npm run caption-finalize -- run --project projects/<project-id> [--supplied-final /path/final.mp4]` |
| `final-render-review-pack` | 長尺final前に本番同等の代表区間review reelを計画・生成・freshness確認 | `npm run final-render-review-pack -- <plan|build|status> --project projects/<project-id> [options]` |
| `final-render-checklist` | 視覚review reelと音声A/Bをhash-boundし、最終renderを承認 | `npm run final-render-checklist -- <status|approve> --project projects/<project-id> [options]` |
| `audio-finish-remux` | 承認済み映像streamを再encodeせず、2-pass MA音声だけを再mux・任意でatomic finalize | `npm run audio-finish-remux -- --project projects/<project-id> --source-receipt <receipt.json> [--finalize]` |
| `ai-music-master` | AI生成音楽向け専用3-stage MA chain（cleanup EQ / presence-air / stereo width + soft-knee multiband compand）+ SNS向け2-pass loudnorm（受入: -13.3±0.5 LUFS / TP <= -1.0 dBTP、loudnorm処理は別管理の-2.0 dBTP processing true-peak target、fail-closed検証receipt付き）。`source_premaster` routeはloudnormなしのtone conditioningのみで、single final mastering契約を保持 | `npm run ai-music-master -- --input <audio> --output-dir <dir> [--route standalone_sns_master\|source_premaster] [--no-mp3] [--policy <policy.json>] [--json]` |
| `bgm-shortlist` | 生成BGM候補の元音源をSHA照合し、音楽・会話適合・類似性・権利の人間レビューキューを作成・更新 | `npx tsx scripts/bgm-shortlist.ts <verify|prepare-review|review> [options]` |
| `package` | approved rough cut から final package / QA manifest を作成。`--preflight-only --json`は読み取り専用Gate 10確認 | `npm run package -- projects/<project-id> [options]` |
| `pilot:verify` | RFA-016のagent QA、human visual/audio、NLE handoff、platform previewを独立receiptとして読み取り専用評価。public promotionは対象外 | `npm run pilot:verify -- --project projects/<project-id> [--json]` |
| `render-route` | timeline要素から FFmpeg / Remotion / HyperFrames の描画経路を読み取り専用で確認 | `npm run render-route -- projects/<project-id> [--json]` |
| `status` | Gate 状態と次アクション確認 | `npx tsx scripts/status.ts projects/<project-id>` |
| `compile` | `timeline.json` と preview manifest 生成 | `npx tsx scripts/compile-timeline.ts projects/<project-id>` |
| `preview` | preview clip / overview 生成 | `npx tsx scripts/preview-segment.ts projects/<project-id> [--beat <beat-name>]` |
| `export-premiere` | Premiere 向け FCP7 XML 出力 | `npx tsx scripts/export-premiere-xml.ts projects/<project-id>` |
| `import-premiere` | Premiere で編集した XML の差分読込 | `npx tsx scripts/import-premiere-xml.ts projects/<project-id> --xml edited.xml [--dry-run]` |
| `handoff-export` | 承認済み canonical timeline を明示した NLE profile で Resolve OTIO handoff へ出力（`--check` は bridge 実行・project 書込みなし） | `npm run handoff-export -- --project projects/<project-id> --profile runtime/nle-profiles/resolve-v1.yaml [--python <path>] [--check] [--json]` |
| `handoff-import` | 1 handoff の OTIO import report と identity-bound v2 human revision diff を生成（`--check` は読み取り専用） | `npm run handoff-import -- projects/<project-id> --manifest projects/<project-id>/exports/handoffs/<handoff-id>/handoff_manifest.yaml --imported-otio projects/<project-id>/exports/handoffs/<handoff-id>/imported_handoff.otio --profile <nle-profile.yaml> [--check]` |
| `review-patch` | 承認済み canonical timeline に対して review-patch/v2 を prepare/check し、明示受諾時だけ `06_review/review_patch.json` へ install（install は `project_state.yaml` の承認 hash/time も更新、prepare/check は project 書込みなし） | `npm run review-patch -- <prepare|check|install> --project projects/<project-id> --input <patch.json> [--output <external-patch.json>] [--accept --approved-by <human>] [--json]` |
| `smoke-test-qwen3vl.sh` | Qwen3-VL local worker / 2048-dim embedding の確認 | `bash scripts/smoke-test-qwen3vl.sh` |
| `smoke-test-clap.sh` | CLAP local worker / 512-dim audio embedding の確認 | `bash scripts/smoke-test-clap.sh` |

## Advanced / ステージ個別実行

`npm run full-pipeline` が正式デフォルトです。stage を切り分けてデバッグしたい場合だけ、従来の個別コマンドを使います。

### 1. プロジェクトを初期化

```bash
npx tsx scripts/init-project.ts my-project --source-dir /path/to/footage
```

`projects/_template/` を元に `projects/my-project/` を作成し、`project_id` を埋めます。`--source-dir` を付けると `projects/my-project/02_media/source` に素材フォルダへのシンボリックリンクを作成します。

### 2. 素材を解析

```bash
npx tsx scripts/analyze.ts \
  projects/my-project/02_media/source/* \
  --project projects/my-project \
  --content-hint "子どもの自転車練習"
```

必要に応じて glob を `*.mp4` や `*.MOV` に狭めてください。`--source-dir` を使わずに初期化した場合は、`projects/my-project/02_media/source/*` を `/path/to/footage/*` に置き換えてください。`--content-hint` は VLM prompt に文脈情報を追加し、タグ付けや peak 検出の認識精度向上に使えます。

### 3. Footage DB を構築

```bash
npx tsx scripts/build-footage-db.ts \
  --project projects/my-project \
  --embedding-policy auto \
  --qwen3vl \
  --clap-audio
```

`projects/my-project/03_analysis/search/footage.db` に SQLite / FTS5 / embedding rows を作ります。Qwen3-VL や CLAP が使えない場合は warning を残し、利用可能な検索 channel だけで続行します。

### 4. Editorial pipeline を実行

```bash
npx tsx scripts/editorial-pipeline.ts --project projects/my-project --qa
```

このコマンドは visual / audio retrieval、rough pass、fine pass、compile、render、QA improvement loop を順に実行します。主な出力は `04_plan/selects_candidates.yaml`、`04_plan/edit_blueprint.yaml`、`04_plan/visual_search_trace.json`、`05_timeline/timeline.json`、`09_output/rough-cut.mp4`、`09_output/render-report.json` です。

## 完全な E2E フロー

![エージェントがブリーフを作成中](docs/images/demo-03-output.jpg)

```text
素材投入
  -> scripts/analyze.ts
  -> 03_analysis/assets.json / segments.json / transcripts / marlin_events.json / contact sheets / filmstrips / peak_analysis
  -> scripts/build-footage-db.ts
  -> 03_analysis/search/footage.db
     - SQLite structured metadata
     - FTS5 text index
     - embedding_models / segment_embeddings
     - E5 text + Qwen3-VL visual/text + CLAP audio
  -> 01_intent/creative_brief.yaml / unresolved_blockers.yaml
  -> Visual / Audio Retrieval
  -> 04_plan/visual_search_trace.json
  -> Rough Pass
  -> 04_plan/selects_candidates.yaml
  -> Fine Pass
  -> 04_plan/edit_blueprint.yaml / uncertainty_register.yaml
  -> scripts/compile-timeline.ts
  -> 05_timeline/timeline.json / adjacency_analysis.json
  -> scripts/render-rough-cut.ts
  -> 09_output/rough-cut.mp4 / render-report.json
  -> QA Loop
     -> Marlin QA / brief alignment
     -> issue detection / fix proposals
     -> apply / recompile / rerender (max 3 iterations)
  -> Caption Review
     -> caption_source.json / caption_draft.json
     -> caption_review_patch.json / caption_review_preview.json
     -> explicit human approval -> caption_approval.json
  -> Caption Finalize
     -> immutable approval intent / generation-scoped ASS/SRT/final/QA/manifest/preview
     -> verified active_delivery.json atomic switch
  -> 06_review/* / 07_package/* / 09_output/*
```

![ブループリント作成結果プレビュー](docs/images/demo-04-blueprint.png)

補足:

- `runtime/commands/` には `/intent`, `/triage`, `/blueprint`, `/review`, `/caption`, `/package` の command contract が実装されています。
- `scripts/analyze.ts` では STT/VLM と VLM peak detection を実行し、`peak_analysis` を `segments.json` に書き戻します。
- `scripts/build-footage-db.ts` は project-local の検索 DB を作り、Qwen3-VL / CLAP が無い場合も fail-open で進みます。
- `scripts/editorial-pipeline.ts` は retrieval、rough/fine pass、compile、render、QA improvement loop を統合します。
- `scripts/compile-timeline.ts` は deterministic compile の公開 CLI です。scene continuity ordering と visual coherence cache がある場合はコンパイル時に利用します。
- `scripts/caption-review.ts` とVideoOSStudioの字幕仕上げUIは同じReview Coreを使います。機械ドラフトは直接上書きせず、人間の変更をpatchとして保持し、承認条件を満たした場合だけ `caption_approval.json` を生成します。
- `queue --format json --reviewer <name>` は `approval_readiness`、font contract、safe bulk対象/除外理由、整合する既存approvalを返します。draft欠落時は `recovery_action` に従い `prepare`（`recover` alias）を実行します。既存patch/approvalがある場合も隔離再生成とbase hash照合後にだけdraftを復元します。
- `clean-lower-third` は検証済みheavy asset（`VideoOS Noto Sans JP Black`/900）をASSとStudioで共用します。font staging manifest v2とfinalize receiptは選択family/role/path/hash/weightを束縛し、Studioでheavy resourceを登録できない場合はsystem fallbackせず承認をblockします。
- Premiere で詰めたい場合は、`timeline.json -> FCP7 XML -> Premiere -> FCP7 XML -> timeline.json` の往復が可能です。

## Premiere Pro 連携

エクスポート:

```bash
npx tsx scripts/export-premiere-xml.ts projects/my-project
```

インポート:

```bash
npx tsx scripts/import-premiere-xml.ts projects/my-project --xml edited.xml --dry-run
```

UXP プラグイン:

1. Adobe Creative Cloud から UXP Developer Tool を入れる
2. `premiere-plugin/manifest.json` を読み込む
3. Premiere Pro で `Window -> Extensions -> Video OS Watcher` を開く
4. `FCP7 XML Path` に XML のパスを入れて Watch を開始する

ラウンドトリップ diff engine は `trim_changed`, `reordered`, `deleted`, `added_unmapped` を検出します。`added_unmapped` は自動適用せず、手動レビュー前提です。

## 書き出し先

現在の rough-cut renderer は次のパスに MP4 と duration accounting を出力します。

```text
projects/<project-id>/09_output/rough-cut.mp4
projects/<project-id>/09_output/render-report.json
```

`07_package/` は QA、manifest、音声 stem、caption sidecar などの内部パッケージ用ディレクトリです。新しいcaption-bound納品は `07_package/active_delivery.json` が指すgenerationを正本とし、pointerが存在しない旧プロジェクトだけ従来の `07_package/*` と `09_output/final.mp4` を参照します。

## アーキテクチャ

![自由を渡すには止まる設計が必要](docs/images/demo-05-result.jpg)

```text
Creative Brief
  -> Visual/Audio Retrieval (Qwen3-VL + CLAP pre-selection)
  -> Rough Pass (LLM with multimodal evidence)
  -> Fine Pass (LLM refinement)
  -> Deterministic Compiler (scene continuity + visual coherence)
  -> Render (ffmpeg xfade + BGM)
  -> QA Loop (Marlin QA -> fix proposals -> apply -> recompile -> rerender)
  -> Human Caption Review (draft -> patch -> approval)
  -> Final Output
```

- 2-model architecture: Marlin が「目」として scene / event / peak を読み、Claude/Codex が「脳」として evidence を使って編集判断を行います。Qwen3-VL / CLAP / E5 は planner ではなく検索 channel です。
- 3-modality search: visual、text、audio を同じ footage DB と検索 API で扱います。ただし Qwen / E5 / CLAP のベクトル空間は混ぜず、`embedding_models.id` 単位で比較し、score fusion で統合します。
- Deterministic Compiler: `normalize -> score -> assemble -> trim -> resolve -> export` を純関数的に進め、timestamp clustering と Qwen visual coherence cache がある場合は scene continuity ordering に使います。
- QA Loop: Marlin QA と brief alignment から issue を検出し、bounded fixes を提案・適用・再コンパイル・再レンダーします。最大 3 iteration、score 低下、duration/fill/render parity regression で停止します。
- Canonical Artifacts: 各ステージは YAML / JSON の canonical artifact を出力し、隠れた状態を持ちません。
- Native Operator Surface: VideoOSStudio はcanonical artifactsと共有runtimeを使うクライアントであり、別のpipelineや独自timelineを持ちません。未保存のUI編集はpreviewで、明示保存時だけcompiler/runtime経由で反映します。
- Transition Skill Cards: P0 の 5 スキル (`match_cut_bridge`, `build_to_peak`, `crossfade_bridge`, `smash_cut_energy`, `silence_beat`) を隣接クリップ単位で自動選択します。

## Agent Skills

`.agents/skills/` に定義された Agent Skill が、エージェントの判断と行動をガイドします。Claude Code / Codex CLI どちらでも同じスキルが発火します（symlink 共有）。

| スキル | 発火条件 | 役割 |
|--------|----------|------|
| `setup-environment` | 初回セットアップ、依存不足、API キー未設定 | 環境構築をステップバイステップでガイド |
| `design-intent` | 素材を渡して「編集して」、新プロジェクト開始 | ユーザーの意図をヒアリングし creative brief を作成 |
| `analyze-footage` | 素材フォルダや動画ファイルを渡されたとき | VLM/STT で素材を解析し assets.json / segments.json を生成 |
| `select-clips` | 「クリップを選んで」、triage 実行 | 素材から候補クリップを抽出・スコアリング |
| `build-blueprint` | 「構成を作って」、blueprint 実行 | ビート構造と編集構成を設計 |
| `compile-timeline` | 「タイムラインを作って」、compile 実行 | 確定的コンパイラで timeline.json を生成 |
| `review-roughcut` | 「レビューして」、粗編集の品質確認 | 自己批評ループで品質を評価・パッチ提案 |
| `export-premiere` | 「Premiere に出して」、XML エクスポート | timeline.json → FCP7 XML 変換 |
| `import-premiere` | 「Premiere から戻して」、XML インポート | FCP7 XML → timeline.json 差分検出・適用 |
| `render-video` | 「レンダリングして」、動画出力 | ffmpeg で最終動画を生成 |
| `full-pipeline` | 「全自動で」「素材から動画を作って」 | 全ステージを Gate 付きでオーケストレーション |
| `troubleshoot-error` | エラー発生時、「直して」 | エラーカタログから原因特定・復旧手順を案内 |
| `re-edit` | 「ここを変えて」「尺を短くして」 | 既存 timeline への部分的な再編集指示を処理 |
| `finish-interview` | 「MAして」「人物を大きく」「画角を整えて」 | overlay前の人物リフレーム、2-pass会話MA、ラウドネス・同期QAを実行 |

インタビュー仕上げでは review patch の `change_visual_transform` で
clip metadataのzoom/crop/positionを更新し、`change_audio_finish` で
`dialogue-clean` または `loudness-only` を指定できます。共有assemblerが
preview/final共通の映像filterと、測定値を使った2-pass MAを適用します。
Studioの選択クリップInspectorではMA presetとzoom/panを調整でき、Viewerへ
即時プレビューされます。顔landmark・yaw・手首位置から再現可能な提案値だけを
取得する場合は次を使います。

```bash
swift build --product videoos-studio-cli
.build/debug/videoos-studio-cli interview-reframe \
  --source=/path/to/interview.mov --in-us=0 --out-us=30000000
```

## テスト

```bash
npm run validate
npm test
npm run build
swift test
```

CI でも Node / TypeScript とmacOS Studioの境界を分けて検証します。2026-07-15時点では Vitest 2733件、SwiftPM 533件が通過しています。件数は開発中に変動するため、正確な値は `npm test` と `swift test` の出力を確認してください。
`npm run validate` は公開デモ `projects/demo` を検証します。checkout 内のローカル作業プロジェクトも含めて確認したい場合は `npm run validate:all-local` を使ってください。

## OSS と貢献

- ライセンス: [MIT](LICENSE)
- 貢献ガイド: [CONTRIBUTING.md](CONTRIBUTING.md)
- セキュリティ報告: [SECURITY.md](SECURITY.md)
- 公開前チェックリスト: [docs/oss-readiness.md](docs/oss-readiness.md)

公開リポジトリには `projects/_template/`、`projects/demo/`、`projects/sample/` と、回帰評価用に明示的に選んだgolden fixtureだけを含めます。それ以外の `projects/*`、`tmp/`、`.env.local`、生成動画、contact sheet、ローカル解析結果はcheckout固有の作業データとして扱います。fixtureを追加するときは、秘密情報、個人絶対パス、元動画、不要な大容量artifactを含まないことを公開前に確認してください。

## 技術スタック

- TypeScript / Node.js / `tsx`
- Vitest
- AJV + JSON Schema + YAML
- SQLite / FTS5 / `better-sqlite3`
- `ffmpeg` / `ffprobe`
- FontTools `pyftsubset`（browser exact preview の文字単位 WOFF2 最適化、任意）
- Qwen3-VL-Embedding-2B（visual / text embedding、2048-dim）
- CLAP `laion/clap-htsat-fused`（audio embedding、512-dim）
- Marlin-2B（local video VLM）
- `Xenova/multilingual-e5-small`（text embedding、384-dim）
- Python JSONL workers（Qwen3-VL / CLAP / Marlin local inference）
- Gemini VLM / Groq STT / OpenAI STT / pyannote diarization
- OpenTimelineIO Python bridge
- FCP7 XML exporter / importer
- Premiere Pro UXP plugin
- SwiftUI / AppKit / AVFoundation (`VideoOSStudio`)

## 制限事項

- Qwen3-VL / CLAP / Marlin の real model 実行には Python venv とローカル model cache が必要です。未設定時は warning を出して、利用可能な channel だけで続行します。
- Qwen3-VL mixed input、Qwen reranker、before/after 両側を使う visual bridge search は設計済みですが、公開 API としては段階的に拡張中です。
- CLAP は音の質感・環境音・ムード検索に使います。発話内容そのものの検索は transcript / FTS5 / E5 / Qwen text channel が担当します。
- QA improvement loop は bounded auto-fix です。創作判断を完全に置き換えるものではなく、score 低下や duration parity 失敗では停止します。
- `/intent` などのslash commandは `runtime/commands/` のcommand contractです。VideoOSStudioはそれらを含む共有runtime / scriptsを呼ぶオペレーターUIであり、別実装のpipelineではありません。
- `caption_approval.json` は人間の明示操作でのみ生成します。LLMやfull autonomyは字幕の最終承認を代行せず、draftまたはtimelineが変わった古いapprovalは無効です。
- 高精度 analysis には `ffmpeg` 系ツールと API key、場合によっては Python / `opentimelineio` / `pyannote` が必要です。
- Premiere UXP plugin は手動インストールと Premiere 上での手動確認が前提です。

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照してください。
