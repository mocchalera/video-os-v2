# 改善実装計画: クリエイターショート（なるなるgram DAY2 セッションからの学び）

対象セッション: Cockpit task `28578d70`（Antigravity / Gemini 3.7 Flash, 2026-08-19〜08-20, 33ターン）
子タスク: `5ab52549`（Codex gpt-5.6-sol）→ commit `5cafe80d` で一部実装済み
前提レビュー: [`docs/review-narunaru-day0-formula.md`](review-narunaru-day0-formula.md)（2026-08-19、8アクション**未着手**）
日付: 2026-08-20

---

## 0. 結論（先に）

DAY2制作は **リポジトリのパイプラインを1行も通っていない**。
`~/Biz/なるなるgram` 配下で `python3 -c` の ffmpeg ワンライナーを v1→v18 まで手打ちし、
`05_timeline/timeline.json` も `07_package/` も生成されていない。

そして **ユーザーが指摘した不具合は、ほぼ全部この repo が既に防御機構を持っているもの**だった。

| ユーザー指摘 | repo 側の既存防御 | 今回効かなかった理由 |
|---|---|---|
| 上部ブラー帯（縦動画なのに） | `letterbox_policy` / `fit_mode` (`schemas/timeline-ir.schema.json`) | timeline を通していない |
| リップシンクずれ | `runtime/compiler/av-sync.ts`（`5cafe80d` で追加） | 同上 |
| 絵文字が豆腐 | `editor/shared/caption-text-sanitizer.ts`（同上） | 同上 |
| テロップ被り | `caption_overlap` 不変条件 `runtime/caption/final-invariants.ts:167` | 同上 |
| Premiere が XML を読めない | `scripts/export-premiere-xml.ts` + `runtime/nle-profiles/premiere-v1.yaml` + roundtrip receipt | 手書きXMLを自作した |
| パンチインのガタつき | zoom は clip 単位 `runtime/compiler/adjacency.ts:1345` → 構造的に発生しない | 同上 |

つまり本件の一次課題は「演出ノウハウが足りない」ではなく、
**エージェントが repo の実装に入って来られなかった**ことである。
学びを SKILL.md の散文に書き足すだけでは、次も同じことが起きる。

---

## 1. 根本原因

### R1. スキルが「存在しないもの」を指している（最重要）

`finish-creator-short` は、実行するとその場で失敗する導線を持つ。

| SKILL.md の記述 | 実体 |
|---|---|
| `scripts/render-social-review.ts --project <p> --mode creator-short`（`SKILL.md:74`） | `--mode` フラグは**存在しない**。`parseSocialReviewArgs` は `--captions <plan.json>` 必須（`scripts/render-social-review.ts:103-121`）。同じ repo の `finish-business-short/SKILL.md:57` は正しい形で書けている |
| `vos:content.creator-hook/v1` / `vos:content.impact-word/v1`（`5cafe80d` 以前の版） | `CONTENT_TEMPLATE_IDS` に**無い**（`runtime/content/template-registry.ts:3-12`）。使えば `Unknown legacy styling_class` で compile が落ちる（`runtime/content/normalize.ts:138`） |
| `captions_overlay_transparent.mov`（`export-premiere/SKILL.md:72,80`） | 生成コードが**どこにも無い**（packet 生成は `apps/macos-studio/Sources/VideoOSStudioCore/ProjectHandoffExport.swift`） |
| `reference_preview.mp4` / `captions.srt` を editor_packet 直下に同梱（`export-premiere/SKILL.md:81-82`） | 同 Swift 実装は `manifest.json` / `media/` / `editor_annotations.json` / `editor_notes.md` / review artifact のみを置く |

最初の1コマンドが失敗した時点で、弱いエージェントは repo を捨てて ffmpeg 直叩きに落ちる。
実際そうなった。

### R2. 「外部素材フォルダ → repo project」の入口がスキルに無い

`full-pipeline` は `--source-dir` を持ち、まさにこの用途の正式入口である
（`.agents/skills/full-pipeline/SKILL.md:22`）。
しかし `finish-creator-short` の Workflow step 1 は「`timeline.json` を確認する」から始まり、
**project が存在しない場合の分岐が無い**。
今回の入口は `~/Biz/なるなるgram`（別 repo）だったので、誰もそこへ橋を架けなかった。

### R3. スキルが「データ」ではなく「散文」なので、上書きで劣化する

今回のセッション末尾で Antigravity が `finish-creator-short/SKILL.md` を書き換えた
（未コミット、`git diff` で確認可能）。その結果:

- **7-Beat が別ジャンルのものに置換された。** 従来は「復活ストーリー（Triple Crisis / Creed / Vulnerability CTA、75秒）」。
  新版は「山中湖ジョグ vlog の実尺（Environment & Purpose 8.9–27.0s、Apex Freeze 40.0–43.0s、57秒）」。
  1本の動画のタイムラインが、全ジャンル共通の構成テンプレートを名乗っている。
- **必読 reference と矛盾した。** `references/creator-challenge-short.md:9-13` は旧 7-Beat のまま。
  SKILL.md が「必ず読む」と指定している文書と本文が食い違う。
- **計測可能な QA が消えた。** `感情テロップと発話アンカーのズレ ≤ 1 frame` / `SFXと視覚イベントのズレ ≤ 2 frames` が削除され、
  「オチネタバレゼロ」「表情崩れゼロ」という**測れない**基準に置き換わった。
  これは `docs/review-narunaru-day0-formula.md:10-26` が名指しで警告している退行そのもの。
- **プロジェクト固有物が汎用スキルに焼き込まれた。** 富士山、16km、46歳起業家ランナー、
  「今日もみんな頑張ろうぜ！」、`MarginV: 410px / 310px`（1080×1920 決め打ち）、
  「※わざわざスマホ置いて自撮りしてます笑」。

`docs/review-narunaru-day0-formula.md` の次アクション8件は**1件も実装されていない**
（`creator-challenge-arc.yaml` 無し、`keyword_telop` 型無し、`emotional_valence` 無し、
`narrative_mode` 無し、design-intent の証拠素材ヒアリング無し）。
むしろ今回の編集で `caption_mode: keyword_telop` の記述自体が削除され、アクション#4 の足場が消えた。

### R4. プロジェクト固有知見の置き場が repo 内に無い（実は有るのに使われていない）

ユーザーの最後の要求は「固有知見と汎用スキルを分けて設計して」。
Antigravity の回答は `~/Biz/なるなるgram/docs/brand/NARUNARU_BRAND_GUIDELINES.md` の新規作成 — **repo の外**。
どのコードパスからも読まれない。

一方 repo には **`projects/<id>/STYLE.md` が既に配線済み**である。

- blueprint agent が読む: `runtime/commands/blueprint/index.ts:345`
- review が読む: `runtime/commands/review/index.ts:896,933`
- 変更時に blueprint から再実行される invalidation 対象: `runtime/state/reconcile.ts:147`
- eval の blind copy 対象: `scripts/eval-regenerate.ts:36`
- 位置づけ定義済み: `docs/roadmap.md:234-235`（brief=何を作るか / STYLE.md=どう作るか）

つまり分離レイヤは存在する。誰もエージェントに教えていないだけ。

### R5. コンパイラの creator-short プリセットが、ユーザーが教えた編集規則を持っていない

`5cafe80d` で入った `creator-short-vo-broll/v1` は、実質「中盤の B-roll を 1.5〜3.0秒に丸める」だけ。

```ts
// runtime/compiler/assemble.ts:272-274
options?.creatorShortVoBroll &&
beatIndex > 0 &&
beatIndex < normalized.beats.length - 1 &&
```

最初と最後の beat 以外は無差別に B-roll が入る。
これは **ユーザーが明確に否定した挙動**である:

> 「前半の説明しゃべりのときに走ってるシーンをガンガン入れちゃうの微妙かもね。
> 　それで『行ってきます！』ってあとに走るシーン入れて、その結果と今後の目標の喋りシーンってのが自然」

正しい規則は「行動宣言（kickoff）を境界に、説明トーク中は話者に貼り付き、宣言後に B-roll を展開する」。
これは beat index ではなく **transcript 上のイベント**に紐づく。現状モデル化されていない。

---

## 2. 実装ギャップ一覧（今回のフィードバックから）

| # | ユーザーが求めたもの | repo の現状 | 種別 |
|---|---|---|---|
| G1 | 説明トーク中は顔、宣言後に B-roll | beat index による無差別挿入（`assemble.ts:272`） | 未実装 |
| G2 | ジャンプ頂点で 1.0〜1.2秒フリーズ | `freeze_hold` は adjacency の**フォールバック transition**のみ（`transition-types.ts:51`）。演出として著作できず、renderer にホールド実装が無い | 未実装 |
| G3 | 語尾の舌出し・気の緩みを切って笑顔で締める | クリップ末尾の視覚ノイズ検出は無し | 未実装 |
| G4 | Strava ラップの HUD オーバーレイ | 外部データ→オーバーレイの経路無し（`CONTENT_TEMPLATE_IDS` に data/HUD 系テンプレート無し） | 未実装 |
| G5 | 絵文字 🔥 を出したい | `sanitizeCaptionTextForRendering` は**除去**する。かつ `generateSrt`（`runtime/render/pipeline.ts:618-642`）は sanitize しないので、**焼き込みと sidecar SRT の文言が食い違う** | 実装済／不整合あり |
| G6 | セリフを言い切る前に切らない（間の設計） | `talking-head-pacing` に境界スナップはあるが「言い切り」判定は無し | 部分実装 |
| G7 | スマホを置く／拾う動作を in-out から除外 | trim_hint はあるが、動作ノイズの自動除外は無し | 未実装 |
| G8 | 外出先のスマホでプレビュー確認（cockpit ask） | 手動運用。スキルに手順記載なし | 未実装（運用） |

---

## 3. 改善実装計画

原則: **「散文を足す」改善は禁止。すべて (a) 実行可能なコマンド、(b) スキーマ／データ、(c) 落ちるテスト のいずれかにする。**

### Phase 0 — 退行の除去（ブロッカー・0.5日）✅ 完了 2026-08-20

未コミットの `.agents/skills/*` の変更は、そのまま入れると次のセッションを壊す。

- **P0-1** ✅ `finish-creator-short/SKILL.md` の 7-Beat 差し替えを revert し、旧 7-Beat（=`references/creator-challenge-short.md` と一致する版）へ戻した。
  DAY2 で得た構成知見は [`docs/creator-short-day2-observations-20260820.md`](creator-short-day2-observations-20260820.md) へ退避済み。Phase 2 で `vlog-day-log.yaml` として格上げする。
- **P0-2** ✅ 削除された計測可能 QA（`≤ 1 frame` / `≤ 2 frames`）を復活（revert に含まれる）。
- **P0-3** ✅ `--mode creator-short` を実在する形へ修正:
  `npm run social-review -- --project <project-dir> --captions <plan.json> ...`。
  `npm run social-review -- --help` の USAGE と一致することを実行確認済み。
- **P0-4** ✅ `export-premiere/SKILL.md` の未実装 artifact 記述（`captions_overlay_transparent.mov` /
  `reference_preview.mp4` / packet直下の `captions.srt`）を revert で除去。Phase 5 で実装したら書き戻す。
- **P0-5** ✅ `vos:content.creator-hook/v1` → `vos:content.hook-title/v1`、
  `vos:content.impact-word/v1` → `vos:content.emphasis-word/v1` に置換。
  併せて「未登録IDは compile で落ちる」旨を SKILL.md に明記した。

検証（実行済み）: `.agents/skills/**/*.md` 内の全 `vos:content.*` / `npm run *` / `scripts/*.ts` を
`CONTENT_TEMPLATE_IDS` / `package.json` scripts / 実ファイルに突き合わせ、**不一致 0 件**。
この突き合わせは Phase 1 で `verify:skill-contracts` として恒久化する。

### Phase 1 — スキル契約を機械検証にする（1.5日）★最優先

R1 を構造的に殺す。散文の嘘を CI で落とせるようにする。

- **P1-1** `scripts/generate-agent-skill-contracts.ts` の対象を拡張。
  現在 `agent-skill-contracts.json` は `full-pipeline` と `short-sound-design` の **2件だけ**。
  実行系スキル全て（`finish-creator-short` / `finish-business-short` / `finish-interview` /
  `export-premiere` / `compile-timeline` / `render-video` / `re-edit` / `review-roughcut`）を対象にする。
- **P1-2** 契約に以下を含め、`npm run verify:skill-contracts` で検証する:
  - SKILL.md 内の全 CLI 呼び出しについて、**エントリポイントの存在**と**フラグの実在**（パーサから抽出）
  - SKILL.md が宣言する出力 artifact パスが、いずれかの生成コードに現れること
  - SKILL.md 内の `vos:content.*` / `vos:overlay.*` が `CONTENT_TEMPLATE_IDS` に存在すること
- **P1-3** CI に `verify:skill-contracts` を追加（`package.json:30` は既に存在、実行されていない）。

検証: P0 を戻す前の壊れた SKILL.md で `verify:skill-contracts` が **落ちる**回帰テストを追加。

### Phase 2 — 構成アークをデータにする（2日）

`docs/review-narunaru-day0-formula.md` の次アクション #3/#5 の実装。今回の DAY2 で2ジャンル目が確定した。

- **P2-1** `runtime/editorial/arcs/` に比率ベースの beat 定義（秒固定にしない）:
  - `personal-challenge-comeback.yaml` — 既存 7-Beat（hook / identity / struggle / breakthrough / crisis_cluster / creed_goal / vulnerability_cta）
  - `vlog-day-log.yaml` — **DAY2 で確定した新アーク**（double_hook / identity_gap / setup_purpose / kickoff / action_broll / apex_beat / finish_cta）
- **P2-2** `creative_brief.yaml` に `narrative_mode` を追加（`personal_challenge` / `day_log` / `credibility_first`）。
  既存 `credibility_first` と相反するため分岐は明示。schema + `runtime/agents/llm-blueprint-agent.ts` に配線。
- **P2-3** blueprint schema に `emotional_valence` / `evidence_required` を追加（アクション #5）。
- **P2-4** SKILL.md の 7-Beat 散文は **アーク YAML への参照1行**に置き換える。
  以後、演出知見の追加は YAML への PR になり、SKILL.md の上書き合戦が起きなくなる。

検証: 既存 golden（`tests/golden/sample-timeline.json`）が不変であること + 各アークの beat 比率合計 = 1.0 のテスト。

### Phase 3 — コンパイラ／レンダラの能力ギャップ（3日）

- **P3-1 (G1) kickoff アンカー型 B-roll ゲーティング。**
  `creator-short-vo-broll.ts` を beat index ではなく **transcript イベント基準**に変更。
  行動宣言句（「行ってきます」「やってみた」「スタート」等、辞書は YAML 外出し）を検出し、
  **宣言前 = A-roll 優先（B-roll 挿入禁止）／宣言後 = B-roll 展開**。検出できない場合は現行挙動へ degrade。
  テスト: 宣言前の beat に support/texture が入らないこと。
- **P3-2 (G2) apex freeze を著作可能な編集スキルにする。**
  `runtime/editorial/skills/apex-freeze-hold.yaml` を追加し、clip に
  `freeze_at_source_us` + `hold_frames`(30〜36) を持たせる。
  renderer 側は ffmpeg `trim`+`tpad`/`loop` でホールドを生成（`runtime/render/assembler.ts`）。
  **今回ユーザーが2回「静止できてないぞ」と指摘した箇所**であり、手打ちでは再現性が無い。
  テスト: 生成フィルタグラフに固定フレーム保持が含まれ、timeline 総尺が hold 分だけ伸びること。
- **P3-3 (G3) クリップ末尾ノイズトリム。**
  `talking-head-pacing` の境界スナップに「発話終了後の末尾フレーム」処理を追加。
  最小実装は**発話終了 + N フレームで強制アウト**（決定的）。
  画像による表情判定（Marlin/Qwen3-VL）は Phase 3.5 の任意拡張とし、fail-open にしない。
- **P3-4 (G7)** `re-edit` に「in/out を発話境界＋動作静止点へスナップ」する決定的オペレーションを追加。

### Phase 4 — 字幕の真実性（1日）

- **P4-1 (G5)** `generateSrt` / `generateVtt`（`runtime/render/pipeline.ts:618-642`）に sanitize を通すか、
  **通さないことを receipt に明示**する。現状は焼き込みと sidecar が黙って食い違う。
- **P4-2** sanitize が文字を削った場合、caption receipt に `sanitized: true` と削除文字列を記録する。
  今は無言で消えるため、`🔥` を書いた人間は何が起きたか分からない。
- **P4-3** 絵文字ポリシーの決定を1箇所に置く（`runtime/caption/font-contract.ts`）:
  A案=モノクロ絵文字フォント同梱で描画、B案=現行の除去。
  **A/B どちらでもよいがドキュメントと実装を一致させる**。現状は SKILL.md が「絵文字OK」の見た目で書かれている。

### Phase 5 — NLE ハンドオフ（2日）

- **P5-1** `captions_overlay_transparent.mov`（ProRes 4444 / `yuva444p10le`）を
  `ProjectHandoffExport.swift` の packet 生成に**実装する**か、SKILL.md から**消す**。
  実装する場合、ASS の装飾を Premiere が読めない問題への回答として妥当なので推奨。
  併せて `alpha-layer-contract.ts`（既存）を再利用する。
- **P5-2** `reference_preview.mp4` の packet 同梱を manifest に正式化。
- **P5-3** export-premiere スキルに「**手書きXMLを作らない**」を明記し、
  `scripts/export-premiere-xml.ts` + roundtrip receipt 以外の出力を禁止する。
  今回 Premiere が開けなかったのは自作XMLが原因であり、repo の exporter は使われていない。

### Phase 6 — 汎用／プロジェクト固有の分離（1日）★ユーザーの明示要求

- **P6-1** `projects/_template/STYLE.md` にブランド規約テンプレートを定義（見出し固定）:
  キャラクター／トーン&マナー／禁止表現／シグネチャー締め／キーカラー／固有テロップ癖。
- **P6-2** `~/Biz/なるなるgram/docs/brand/NARUNARU_BRAND_GUIDELINES.md` の内容を
  `projects/<narunaru-project>/STYLE.md` へ移送する。移送先はコードから読まれる（`blueprint/index.ts:345`）。
- **P6-3** 各 finishing スキルに「固有知見は SKILL.md ではなく `STYLE.md` に書く」を1行で明記し、
  P1 の契約検査で「SKILL.md に固有名詞（人名・地名・特定数値）が入っていないか」を lint する。
  今回焼き込まれた「富士山」「16km」「46歳」「今日もみんな頑張ろうぜ」がこれで弾ける。

### Phase 7 — 入口とレビュー運用（0.5日）

- **P7-1 (R2)** `finish-creator-short` / `finish-business-short` の Workflow step 0 を追加:
  「repo project が無ければ先に
  `npm run full-pipeline -- --project <id> --source-dir <dir> --content-hint <hint>` で作る」。
  外部フォルダ（`~/Biz/...` 等）を素材元とするケースを明示的に例示する。
- **P7-2 (G8)** レビュー導線を手順化: プレビュー生成後に
  `cockpit ask --summary ... --media <preview.mp4>` でスマホ確認へ回す。
  今回このやり方が実際に機能していた（v14/v15/v18 の確認）ので、運用として固定する。

---

## 3.5. 進捗（2026-08-20 時点）

| Phase | 状態 | 担当 |
|---|---|---|
| Phase 0 | ✅ 完了 | 本セッション |
| Phase 6 (P6-1) | ✅ 完了 — `projects/_template/STYLE.md` に Persona / Forbidden Expressions / Signature Moments / Key Colors / Telop Idioms を追加 | 本セッション |
| Phase 6 (P6-2) | ⏸ 保留 — 移送先 project がまだ無い。Phase 7 の入口で project 化してから実施 | — |
| Phase 6 (P6-3) | ⏸ Phase 1 の lint 基盤に依存 | Phase 1 の後 |
| Phase 7 | ✅ 完了 — `finish-creator-short` / `finish-business-short` に Step 0（project化の強制・素材未確認での創作禁止）、固有ルールの置き場、`cockpit ask` レビュー導線を追記 | 本セッション |
| Phase 1 | 🔄 実行中 — Cockpit task `1167c265`（codex / gpt-5.6-sol / high、main worktree） | 委譲 |
| Phase 3 | 🔄 実行中 — Cockpit task `12b38edc`（codex / gpt-5.6-sol / high、worktree `feature/creator-short-phase3`） | 委譲 |
| Phase 2 | ⏸ Phase 1 完了後に着手（契約検査の上でアーク YAML 化する） | — |
| Phase 4 / 5 | ⏸ 未着手 | — |

Phase 1 と Phase 3 はファイル集合が交わらないため並列実行。
Phase 3 は worktree で隔離し、commit 衝突を回避している。

## 4. 優先順位

| 順 | Phase | 理由 |
|---|---|---|
| 1 | Phase 0 | 未コミットの退行を入れない。他の全作業の前提 |
| 2 | Phase 1 | R1 を構造的に殺す。これ無しでは Phase 2 以降も嘘を書ける |
| 3 | Phase 7 | 0.5日で「repo に入って来られない」問題が消える。費用対効果最大 |
| 4 | Phase 6 | ユーザーの明示要求。Phase 1 の lint が土台 |
| 5 | Phase 2 | 知見の置き場をデータにする。以後の劣化を防ぐ |
| 6 | Phase 3 | 実際の映像品質差。工数最大 |
| 7 | Phase 4 / 5 | 不整合の解消。局所的 |

合計見積: 約11.5日（Phase 3 が3日で最大）。

---

## 5. 委譲方針

- Phase 0 / 1 / 6 / 7（スキル・契約・lint）: 低曖昧度で検証容易 → `gpt-5.6-terra` (high)
- Phase 2（アーク YAML + schema）: 設計判断あり → `gpt-5.6-terra` (high)、レビューは `opus-4.8`
- Phase 3（compiler/renderer、ffmpeg フィルタグラフ）: 難所 → `gpt-5.6-sol` (high) を Cockpit task で
- Phase 4 / 5: 境界が明快 → `gpt-5.6-terra` (medium)

いずれも Cockpit task 化して可視化する（前回 `5ab52549` の運用が機能していた）。

---

## 6. 明示的な非対象

- `~/Biz/なるなるgram` 側の DAY2 成果物・DAY3以降の企画 — 本計画は repo 実装のみを扱う
- Project Loop Harness（`CLAUDE.md` により停止中）
- 閾値の確定 — 全ての数値は provisional。実 retention データで較正するまで確定値として扱わない
  （`docs/review-narunaru-day0-formula.md:311-313` の方針を継承）

---

## 7. リスク

- **Phase 0 の revert はユーザー体感と逆に見える。** 「せっかく学びを書いたのに消すのか」となる。
  消すのではなく Phase 2 で `vlog-day-log.yaml` として**格上げ**する、という順序を先に伝えること。
- **Phase 1 の lint は既存スキルを大量に落とす可能性がある。** 初回は warn で棚卸しし、
  ゼロ件にしてから error に切り替える。
- **Phase 3-3 の表情判定は fail-open の温床。** 決定的な発話境界トリムを先に入れ、
  知覚モデルは「あれば良くなる」拡張に留める（`docs/improvement-plan-ux-quality-20260706.md` の R1 と同じ轍）。
