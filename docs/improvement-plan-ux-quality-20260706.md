# 全体監査: UX・映像品質ボトルネックと改善計画 (2026-07-06)

4方向の並列監査(Skills / ランタイム / アプリUX / 品質エビデンス)の統合結果。
根拠となる file:line は各節に記載。

## 1. 全体像

| レイヤ | 実体 | 成熟度 |
|---|---|---|
| エンジン | `runtime/` + `scripts/` (TS, 2370+ tests) | コンパイラ・ffmpegアセンブラ(sidechain ducking, BGM fade, caption burn-in)・loudness QAは本番品質 |
| 知覚 | `python/` Marlin-2B / Qwen3-VL / CLAP + Gemini connectors | 実装済みだが品質シグナルはfail-openだらけ |
| 操作面 | 17 skills + 7 slash commands / macOS Studio / web editor / premiere-plugin / CLI | Studioのみ活発。webはレガシー。CLIは開発者向けUX |
| 評価 | self-eval / brief-alignment / regen / marlin-qa の4系統 | marlin-qaだけが実映像を見る |

## 2. 核心診断(根本原因)

### R1. 評価が映像を見ていない
- ena-promo: 構造評価82点の裏で marlin-qa(実映像)は 82→12→**2点** (`reports/eval/marlin-qa-ena-promo_2026-06-18T15-06-40-426Z.json`)。
- QAループはレンダー欠如/スキップ時に `placeholderMarlinReport` で **score:100・issues:[] を偽装** (`runtime/eval/qa-loop.ts:314-316,506`)。
- `/review` のcriticはtimelineメタデータのみで、レンダー画素を一切見ない (`runtime/commands/review/index.ts:150-166`)。review_report.yaml自身が「visual playbackに基づかない」と明記(5+プロジェクト)。

### R2. 品質シグナルがfail-openで、最弱モデルが選択を決める
- 品質スコアの源泉Gemini appraiserは `GEMINI_API_KEY` 無しで**全セグメントをスキップ** (`runtime/pipeline/stages/appraiser.ts:215-220`)。
- 唯一の決定論ゲートは composition/subject が**両方**<0.2の時のみ棄却、スコア欠損は無条件通過 (`runtime/agents/triage-enrichment.ts:503-513`)。
- shake/blur/motionの実測は存在しない: `motionSupportScore=0.5` ハードコード (`runtime/pipeline/stages/peak.ts:190`)、`camera-motion.ts` はMarlinテキストの正規表現、**本物のoptical-flow解析 `runtime/connectors/ffmpeg-motion.ts` はimporterゼロの死蔵コード**。
- クリップ選択の意思決定は `gemini-2.5-flash-lite`(スタック中最弱)。「弱いエージェントでも品質」の北極星と逆転している。

### R3. 正規パイプラインの方が弱い(2本並行)
- command系 (`runtime/commands/triage.ts` + `commands/blueprint/`) には品質ゲート+capture-timeクラスタリングがあるが、「新規プロジェクト用」の unified系 (`scripts/editorial-pipeline.ts` → `runtime/agents/unified-editorial-agent.ts`) には**どちらも無い**。

### R4. リズムと連続性が構造的に未モデル
- ビート同期: `bgm-beat-detector.ts` はonset grid/BPMを実測するが、使途はBGMの**entry/exit揃えのみ**。カットを拍に合わせるコードは存在しない。
- シーン連続性: `semantic_cluster_id` はラベルどまりで並び制約に使われない (`triage-enrichment.ts:162-338`)。時系列は「beat内でsrc_in_us順」のみ (`runtime/compiler/assemble.ts:1054-1112`)。
- 実映像での最多欠陥は「非隣接シーン反復 + 13.9s平均の間延び」(ena-promo→2点の主因)。短い再編集で84点に回復。

### R5. 選定のrecall崩壊
- togakushi: recall **19.2%**、hero/must-have 21本取りこぼし、密クラスタを1/18・0/6サンプリング (`reports/eval/regen-togakushi-camp_2026-06-16T05-34-52-188Z.md`)。
- fumoto: precision 95%でもheroを1本落とす。失敗はprecisionではなくrecall側。

### R6. UX: 入口と出口が欠けている
- 入口: E2Eは4+個の手打ちコマンドチェーン (`README.md:122-161`)。進捗は `console.log` のみでETA無し (`scripts/editorial-pipeline.ts:205-329`)。
- 出口: **render専用CLIが無く**、ユーザーがinline `npx tsx -e` を貼る (`render-video/SKILL.md:31-55`)。しかも `engine_render` は誰も生成しない `05_timeline/assembly.mp4` を要求(Gate 6→10断絶)。Remotionレンダーパスも `/package` から到達不能 (`runtime/commands/package.ts:300`)。
- Studioの各編集はNodeサブプロセス再コンパイルで3-8s、footage検索はcold-start 3-5s(常駐worker設計済み・未実装, `docs/design-studio-feedback-loop.md:318-434`)。
- macOSアプリは intent作成もフルパイプライン実行もできず「パイプライン中間のレビュアー」に留まる (`README.md:344`)。
- web editor はStudioと約90%重複のまま凍結漂流(review APIは503スタブ, `editor/server/routes/ai-jobs.ts:255`)。

### R7. スキル/コマンドの欠落と重複
- 欠落: BGM(`music_cues.json` の作成者不在)、テロップ承認、カラー、オーディオミックス、`/intent` コマンドファイル。
- 重複: `.claude/skills` と `.agents/skills` がバイト一致の手動コピー(ドリフトリスク)。オーケストレーション面が5系統(skill/command/個別/pcl)で入口不明瞭。
- 巨大ファイルが将来のUX作業を阻害: `StudioViewModel.swift` 8,470行、`TimelineViews.swift` 9,043行 (G-0001)。

## 3. 改善計画

原則: **「測ってから直す」**。Phase 0-1が全ての前提。各Phaseは独立に価値が出る。

### Phase 0 — 真実の回復(評価の偽装排除) 【小規模・即効】
1. `qa-loop.ts` の placeholder score:100 を廃止。レンダー無し = `visual_qa: blocked` として Gate を通さない。
2. marlin-qa(実映像)を Gate 8/10 の正とし、構造評価は補助指標に降格。全プロジェクトの `/review` に「レンダー→marlin-qa」を必須化(roadmap V22-02/V22-06 の実行)。
3. packaging QA に解像度/フレームサイズ検証を追加 (`runtime/packaging/qa-measure.ts`)。
4. `VOS_MARLIN_MOCK` / mock経路でのQA合格を成果物に明示タグ付けし、Gateでは不合格扱い。

### Phase 1 — 知覚のローカル化とハードゲート 【映像品質の土台】
1. 死蔵の `ffmpeg-motion.ts` を復活させ、shake/blur/exposure を決定論で実測 → `visual_quality` に格納。
2. ハード品質ゲート新設: shake/blur/露出のワーストは**無条件棄却**(欠損時はデフォルト閾値+low-confidenceタグ、無条件通過を廃止)。
3. Gemini appraiser依存を Marlin/Qwen3-VL ベースに置換(APIコスト方針: 外部APIはVLM最小限、判断はリポジトリ側エージェント)。
4. 選択の意思決定を flash-lite からリポジトリ側エージェント(Claude/Codex, サブスク内)へ移す。unified-editorial-agent のLLM呼び出し境界を差し替え。

### Phase 2 — パイプライン一本化と編集構造の品質
1. unified pipeline に command系の品質ゲート+capture-timeクラスタリングを移植し、**パイプラインを1本に統合**。legacy (`scripts/triage-llm.ts` 等) を削除。
2. シーン連続性: `semantic_cluster_id` / capture-time を compiler の**並び制約**へ昇格。same-asset / 類似ショットの非隣接反復をコンパイル時ハード制約に(現状は事後のmarlin-qa警告のみ)。
3. recall修正: クラスタ毎の最低サンプリング保証 + brief の must_have を選定のハード制約に(coverage未達はGate 4不合格)。
4. ビート同期: compiler で cut boundary を onset grid に quantize するオプション(`bgm-beat-detector.ts` の出力を初めてカットに接続)。
5. ペーシング制約: ショット保持時間の上限(用途別デフォルト、例: PV系は平均4-6s)をcompiler defaultsに。

### Phase 3 — UXの入口と出口
1. **単一エントリポイント**: `/full-pipeline` を正式デフォルトにし、README先頭を書き換え。staged progress + ETA(ステージ別実測時間の記録・表示)。
2. **render CLI**: `scripts/package.ts` を新設し `packageCommand` を包む。`produceAssembly` 経路を有効化して Gate 6→10 の assembly.mp4 断絶を解消。
3. Studio の常駐worker(検索/コンパイル)を実装し、3-8s → sub-second へ(設計済み: `docs/design-studio-feedback-loop.md:318-323`)。
4. web editor を正式リタイア(render backend `editor/shared` は温存)、`.agents/skills` を symlink 化、`/intent` コマンド追加、BGM・テロップ承認のskill追加。
5. Studio に「intentインタビュー起動」「フルパイプライン実行」ボタンを追加し、GUIだけでE2Eが完結する最小経路を作る。
6. G-0001: `StudioViewModel.swift` / `TimelineViews.swift` の分割リファクタリング(機能追加を止めずに段階的に)。

### Phase 4 — 評価の閉ループ常設
1. 3 golden(fumoto / togakushi / ena-promo)+ marlin-qa を標準リグレッションに(`npm run eval` 一発)。
2. brief-alignment の LLM judge をリポジトリ側エージェントで常設(deterministic heuristicsのみの採点を廃止)。
3. 改修ごとに「構造評価と実映像評価の乖離」を監視項目に。

### 優先順位の根拠
- R1(偽装評価)を放置すると、以降の全改善の効果測定が信頼できない → Phase 0 が最優先。
- 実映像での最大欠陥(反復+間延び+低品質混入)は Phase 1-2 で構造的に解消される。
- UX(Phase 3)は独立に進められ、特に入口/出口の欠落は小さい工数で大きな体感改善。

### 実行ルート(参考)
- Phase 0/3 の機械的実装は Codex(AGI Cockpit task)への委譲に適する。
- Phase 1-2 の設計判断(ゲート閾値、制約設計、パイプライン統合)は Claude 側でレビューを挟む。
- 各Phase完了時に togakushi(最難)で marlin-qa を回して効果を実測。
