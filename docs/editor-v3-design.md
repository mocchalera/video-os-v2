# Video OS v2 — Editor v3 再設計書

> Date: 2026-03-26
> Status: Proposed
> Scope: `editor/` 既存実装をベースに、Video OS v2 エディタを本格的な映像編集 UI へ再設計する
> Inputs:
> - `docs/editor-ai-workflow-final.md`
> - `docs/editor-mvp-design.md`
> - `docs/nle-strategy-research.md`
> - `editor/client/*`
> - `editor/server/*`

---

## Supersedes / Authority Matrix

| Source | Chapter(s) | v3 status | Authority after this document is adopted |
|---|---|---|---|
| `docs/editor-ai-workflow-final.md` | 1-11 | Superseded | editor runtime / save contract / sync / playback / media API / test / rollout は本書を正とする |
| `docs/editor-ai-workflow-final.md` | 0, 12 | Historical | 背景説明と実装メモとしてのみ参照し、実装判断の正本にはしない |
| `docs/editor-mvp-design.md` | 0-10, Appendix A-B | Historical | MVP 時点の設計史料としてのみ扱い、v3 実装の canonical spec には使わない |
| `ARCHITECTURE.md`, `docs/roadmap.md` | canonical writer rule / gate 文言 | Implementation follow-up (P0) | v3 文書内の整合宣言は本 Authority Matrix を正とし、実ファイル更新は Phase 0 で `Only approved engines mutate timeline.json` と `editor server save path` を反映する |
| `docs/editor-ai-workflow-design.md`, `docs/editor-ai-workflow-impl-plan.md` | legacy workflow draft | Implementation follow-up (P0) | historical / superseded banner と v3 参照先の追記を行い、実装判断の正本から外す |

Implementation rule: Editor v3 実装の唯一の正本は本書とし、旧設計書は差分確認用の historical reference に格下げする。

`Supersedes / Authority Matrix` 自体を v3 文書群内の整合宣言とみなし、`ARCHITECTURE.md` / `docs/roadmap.md` / 旧 workflow draft の実ファイル更新は本書採択の blocking precondition にはしない。実ファイル更新は実装 Phase 0 (P0) の follow-up task として扱う。

Phase 0 で更新する実ファイル:

- `ARCHITECTURE.md`
- `docs/roadmap.md`
- `docs/editor-ai-workflow-design.md`
- `docs/editor-ai-workflow-final.md`
- `docs/editor-ai-workflow-impl-plan.md`
- `docs/editor-mvp-design.md`

---

## 0. 目的

### 0-1. 背景

現行エディタは Phase 2a / 2b の成果として、以下までは既に成立している。

- `timeline.json` の GET / PUT と `ETag` / `If-Match` による楽観ロック
- source media の直接再生
- review / patch / alternatives / diff / AI job UI
- AI patch apply と server authoritative save
- 非対応コーデックのサーバー側トランスコードキャッシュ

一方で、体験はまだ MVP レベルに留まる。

- GUI は CLI が更新した `timeline.json` を自動検知しない
- AI job は `progress.json` polling 前提で、外部 CLI 実行と自然につながらない
- タイムラインは「Canvas 背景 + DOM クリップ」のハイブリッドで、NLE 的な密度と拡張性が弱い
- trim / seek / clip 境界切替の精度と再生安定性は改善余地が大きい
- `timeline.json` canonical 方針と GUI 直接編集方針の整合が文書化されていない

本設計の目的は、エディタを「AI と人間が同じ `timeline.json` を共有し、CLI と GUI が途切れず往復できる本格編集ハブ」に引き上げることにある。

### 0-2. 既存コードから確認できた現状

以下は本設計の前提となる現状実装である。

| 領域 | 現状 | 根拠 |
|---|---|---|
| timeline 読み書き | `GET /timeline` が `ETag` を返し、`PUT /timeline` は `If-Match` を要求する | `editor/server/routes/timeline.ts` |
| 競合制御 | per-project in-memory lock と `timeline_revision` が既にある | `editor/server/utils.ts`, `editor/server/routes/timeline.ts`, `editor/server/routes/review.ts`, `editor/server/routes/ai-jobs.ts` |
| source 再生 | `usePlayback()` が clip 内を `video.play()` 主導で再生し、`timeupdate` で playhead を同期する | `editor/client/src/hooks/usePlayback.ts` |
| ギャップ再生 | clip が無い区間は黒画面 + RAF / timeout で transport を進める | `editor/client/src/hooks/usePlayback.ts`, `editor/client/src/components/PreviewPlayer.tsx` |
| メディアプロキシ | 非対応コーデックは `ffprobe` 判定の上で `.proxy-cache/` にトランスコードする | `editor/server/routes/media.ts` |
| AI UI | `PropertyPanel`, `PatchPanel`, `AlternativesPanel`, `DiffPanel`, `CommandBar` は実装済み | `editor/client/src/components/*` |
| AI job 進捗 | WebSocket ではなく `progress.json` polling | `editor/client/src/hooks/useAiJob.ts`, `editor/server/routes/ai-jobs.ts`, `docs/editor-ai-workflow-final.md` |
| timeline 描画 | ruler / grid は Canvas、clip 本体は DOM overlay | `editor/client/src/components/Timeline.tsx`, `TrackLane.tsx`, `ClipBlock.tsx` |
| 自動同期 | `fs.watch` / WebSocket は未実装 | `editor/server/index.ts` に watch / ws 系のエントリが存在しない |

### 0-3. 現状の主要問題

1. CLI と GUI が同じ `timeline.json` を見ているのに、更新反映が pull 型で遅い。
2. 再生は source-based に寄っているが、clip 境界切替と trim 後の再同期がまだ NLE 品質ではない。
3. UI は機能追加を積み上げた構成で、編集中心の情報密度と操作一貫性が不足している。
4. `ARCHITECTURE.md` の「Only compiler mutates `timeline.json`」と現行 GUI save 実装が衝突している。
5. save contract / lock / watcher truth model が曖昧で、GUI / server / CLI がどこを正として競合解決すべきかが文書で固定されていない。

### 0-4. 成功条件

以下を満たしたら v3 設計の実装成功とみなす。

1. CLI で `compile` / `review` / `render` を実行すると、エディタが手動 reload なしで状態反映する。
2. GUI で保存した `timeline.json` を CLI 側が次回実行時にそのまま canonical input として読める。
3. source-based 再生で、`requestVideoFrameCallback` 利用時は clip 内 drift / seek / trim 反映が 1 frame 以内、fallback の RAF polling でも 2-3 frame 以内に収まる。
4. timeline 保存と AI patch apply と GUI 起動 job は、共通の cross-process advisory lock helper と `timeline_revision` の両方で保護される。
5. 非対応コーデック素材や `MEDIA_ERR_SRC_NOT_SUPPORTED` 発生時でも、transcode fallback 後に source-based 再生へ復帰できる。
6. save contract は server Ajv pipeline を唯一の正本とし、client preflight は shared validator による UX 補助へ正規化される。
7. UI は `Viewer / Timeline / PropertyPanel / TransportBar / CommandBar / AlternativesPanel / DiffPanel / PatchPanel` の責務が分離される。
8. 最低ビルド基準として `npm run build` を維持し、実装後に editor 側ビルドも通る。

---

## 1. 要件定義

### 1-1. 機能要件

#### R1. プロフェッショナルな映像編集 UI

- FCP / DaVinci 級の「編集集中 UI」を目標にする
- 常時表示要素は以下で固定する
  - 左上: Viewer
  - 右: PropertyPanel
  - 下段: Timeline + bottom dock
  - 上部ヘッダ: project / save / AI commands / transport summary
- timeline は最低限以下を備える
  - マルチトラック
  - ルーラー
  - playhead
  - zoom
  - horizontal scroll
  - clip selection
  - trim
  - marker 表示
  - AI overlay

#### R2. ソースベース直接再生

- 日常編集時の再生は pre-render 前提にしない
- Viewer は `timeline.json` の clip 配列を source media に直接マッピングして再生する
- clip 内では video element をマスタークロックとし、playhead sampling は `requestVideoFrameCallback` 優先 / RAF fallback で行う
- ギャップ区間は黒画面で transport のみ進行させる
- full render / preview export は検証用・納品用の別経路に残す

#### R3. AI エージェントと GUI の双方向共有

- GUI と CLI は同じ `05_timeline/timeline.json` を唯一の編集対象とする
- GUI 側の save / patch apply はディスクへ atomic write する
- CLI 側の `compile` / `review` / `render` 結果も同一 project 配下へ書かれる
- 双方は別フォーマットや中間 DB を持たない

#### R4. CLI 結果の即時 GUI 反映

- CLI により `timeline.json` / `review_report.yaml` / `review_patch.json` / render 成果物が更新されたら GUI に push される
- GUI は受信後に必要な endpoint のみ re-fetch する
- 外部更新中に GUI が dirty なら、自動上書きせず merge banner を表示する

#### R5. GUI 結果の即時 CLI 可視性

- GUI は `PUT /timeline` でディスクへ保存する
- 保存完了後の `timeline.json` は CLI の次回 `/compile` `/review` `/render` がそのまま読む
- GUI 専用の shadow state や DB 正本は作らない

#### R6. timeline.json 自動監視

- サーバー側は `fs.watch` で project artifact を監視する
- 変更検知後は WebSocket で project 購読中クライアントへ通知する
- 通知は revision/hash ベースで重複抑止する

### 1-2. 非機能要件

#### 品質・性能

- seek / trim 反映精度: `requestVideoFrameCallback` 利用時は ±1 frame
- seek / trim 反映精度 fallback: RAF polling 時は ±2-3 frame
- trim 後の duration 再計算: frame 単位で deterministic
- disk change から UI 更新までの目標: p50 300ms 以内、p95 1000ms 以内
- 参考負荷: 300 clips / 8 tracks / 60 markers で zoom・scroll・scrub が破綻しない

#### 信頼性

- timeline 保存は temp + rename の atomic write を維持する
- save / patch / compile / review / render は同じ cross-process advisory lock helper を使う
  - lock は contention 緩和用であり、最終的な整合性判定は `timeline_revision` を正とする
- watch 通知はイベントロスを許容しない
  - `fs.watch` は trigger であり source of truth ではない
  - event path の再ハッシュ確認に加え、periodic full hash sweep を必須にする
  - watch attach / re-attach 後は post-reconnect full hash sweep を必須にする
- WebSocket 切断時は自動再接続し、再接続後に revision 差分を再確認する

#### セキュリティ

- project path / media path は既存の path traversal guard を維持する
- WebSocket 購読対象は `safeProjectDir()` で解決可能な project のみ
- media proxy cache は project 配下に閉じ、任意パス書き込みを許容しない

#### 制約

- フロントエンドは React + Vite + Tailwind の既存基盤を継続する
- バックエンドは Express の既存基盤を継続する
- `editor/` を改修し、新規エディタアプリは作らない
- 新規機能は双方向同期を主軸とし、それ以外は既存機能の再設計・安定化として扱う

### 1-3. やること / やらないこと

#### 今回やること

- timeline / review artifact の watcher + WebSocket push
- source-based 再生の安定化
- timeline renderer の NLE 向け再構成
- 既存 AI panels の docking / 情報整理
- 409 conflict 時の merge UI

#### 今回やらないこと

- CRDT / OT / multi-user 協調編集
- クラウド常時同期
- ブラウザ内フル compositing renderer
- GUI 独自 DB や timeline mirror store
- engine render を置き換えるリアルタイム最終画質プレビュー

### 1-4. 前提・依存関係

- primary target browser は Chromium 系最新版とする
  - 理由: HTML5 video / codec / seek の挙動差を最小化するため
- server 実行環境には `ffmpeg` / `ffprobe` が存在すること
- editor server は local filesystem に対して read / write / watch 権限を持つこと
- 追加依存は最小限に留める
  - server 側は WebSocket 実装用の依存追加を許容する
  - client 側は browser native `WebSocket` を使う
- project directory 構造は既存 Video OS v2 project 規約を前提とする
  - `02_media/`
  - `04_plan/`
  - `05_timeline/`
  - `06_review/`

---

## 2. アーキテクチャ

### 2-1. 全体構成

```text
CLI Agent / Runtime
  ├─ compile/review/render
  └─ writes project artifacts on disk
          │
          ▼
  project files
  ├─ 05_timeline/timeline.json
  ├─ 06_review/review_report.yaml
  ├─ 06_review/review_patch.json
  ├─ progress.json
  └─ render outputs
          │
          ▼
Express Editor Server
  ├─ REST API
  ├─ TimelineWatchHub (fs.watch)
  ├─ WebSocket broadcast hub
  ├─ MediaProxyService
  └─ AI job launcher
          │
          ▼
React + Vite + Tailwind Editor Client
  ├─ Viewer
  ├─ Timeline
  ├─ Inspector / bottom dock
  └─ Sync hooks
```

### 2-2. Canonical source of truth の決定

`timeline.json` は引き続き canonical timeline artifact とする。

ただし v3 では repository の gate を以下へ更新する。

- 旧: `Only compiler mutates timeline.json`
- 新: `Only approved engines mutate timeline.json`

approved engines の内訳:

- compiler / patch applicator / editor server save path

理由:

- 現行実装でも GUI はすでに `PUT /timeline` と `POST /ai/patches/apply` で `timeline.json` を更新している
- 実態と文書がズレたままだと、v3 実装で責務境界が壊れる
- canonical を守るべき本質は「単一 artifact を共有すること」であって、「compiler だけが writer であること」ではない

v3 文書内の整合宣言は本節と Authority Matrix で完了扱いとする。`ARCHITECTURE.md` / `docs/roadmap.md` / 旧 workflow draft の実ファイル更新は Phase 0 (P0) で実施し、本書採択の blocking precondition にはしない。

### 2-3. サーバー構成

既存 Express に以下の責務を追加する。

| モジュール | 役割 | 備考 |
|---|---|---|
| `Timeline API` | `GET /timeline`, `PUT /timeline` | 既存継続 |
| `Review API` | review report / patch / alternatives / patch apply | 既存継続 |
| `AI Jobs API` | compile / review / render 起動、progress polling | 既存継続 |
| `ProjectMutationLock` | save / patch / compile / review / render を横断する cross-process advisory lock | 新規 |
| `TimelineWatchHub` | `fs.watch` trigger + periodic hash sweep + reconnect recovery で artifact 変更監視 | 新規 |
| `ProjectSocketHub` | project 単位 WebSocket room 管理 | 新規 |
| `MediaProxyService` | codec 判定、トランスコード、cache serve | 既存改善 |

### 2-4. クライアント構成

既存 React app に以下の責務を追加する。

| hook / component | 役割 |
|---|---|
| `useTimeline()` | local edit state、save、undo/redo、revision 管理 |
| `usePlayback()` | source-based playback、gap transport、boundary switch |
| `useProjectSync()` | WebSocket 接続、artifact change 受信、re-fetch、dirty conflict ハンドリング |
| `useReview()` | review artifacts / blueprint 再取得 |
| `Timeline` | Canvas 主体の編集面 |
| `Viewer` | source 再生、buffering、error、gap 表示 |

### 2-5. 通信モデル

#### REST

- `GET /api/projects/:id/timeline`
- `PUT /api/projects/:id/timeline`
- `GET /api/projects/:id/ai/context`
- `GET /api/projects/:id/ai/review-report`
- `GET /api/projects/:id/source-map`
- `GET /api/projects/:id/media/by-asset/:assetId`
- `GET /api/projects/:id/media/:filename`
  - basename ベース endpoint は backward-compat のみ。v3 client は新規利用しない

#### WebSocket

- endpoint: `ws://localhost:<port>/api/ws?projectId=<id>`
- 用途: artifact changed event を push
- 非用途:
  - 編集操作の逐次同期
  - multi-user OT
  - フレーム同期

#### なぜ polling を全廃しないか

- GUI から起動した AI job の live progress は現状 `progress.json` polling が動いている
- v3 初期段階では progress 系は既存 polling を維持する
- 今回 WebSocket 化するのは「external mutation の即時反映」が主目的である

---

## 3. コンポーネント設計

### 3-1. Viewer

#### 責務

- source media の直接再生
- clip / gap 判定
- seek
- buffer / stall / error 表示
- transport への playhead 通知

#### 入力

- `timeline`
- `playheadFrame`
- `fps`
- `source_map`
- `isPlaying`

#### 出力

- `onPlayheadChange(frame)`
- `onPlaybackStateChange(buffering | playing | gap | error)`

#### v3 設計

- visible `<video>` 要素を 1 つ持つ
- clip 境界で `media_id` または `playback_strategy` が切り替わる場合は、hidden preload `<video>` を conditionally required とする
- clip 内の master playback clock は `requestVideoFrameCallback` を優先し、未対応環境では RAF polling を fallback にする
- `timeupdate` は coarse UI 更新と stall 補助に格下げし、timeline clock の正本には使わない
- clip が無い frame では black overlay を表示し、video src を外す
- seek 時は clip lookup を先に行い、clip 内なら source seek、gap なら black gap transport に入る

#### v3 で直す点

- current 実装は `asset_id -> filename` 解決が client 側ロジックに寄っている
- v3 では source_map 解決の正本を server に寄せ、client は `asset_id` だけを扱う
- 同名ファイル衝突リスクを避けるため、media cache key は `filename` ではなく `asset_id + source file fingerprint` ベースにする
- `MEDIA_ERR_SRC_NOT_SUPPORTED` が出た場合は同じ `asset_id` に対して transcode fallback を要求し、basename 解決へ戻さない

### 3-2. Timeline

#### 責務

- Canvas 描画
- マルチトラック可視化
- ズーム / スクロール
- clip 選択
- trim
- AI overlay

#### v3 設計

現行は「Canvas で ruler/backdrop、DOM で clip」という構成だが、v3 では timeline を layered canvas 主体へ寄せる。

layers:

1. `grid canvas`
2. `clips canvas`
3. `overlay canvas`
4. `interaction layer`

主な理由:

- clip 数が増えたときの DOM コストを抑える
- NLE 的な密度で hover / selection / trim handle を描ける
- zoom 時の視覚一貫性を保ちやすい

#### interaction 要件

- frame 基準の trim
- clip hit-test
- scrub seek
- wheel zoom
- shift + wheel scroll
- playhead draw

### 3-3. PropertyPanel

#### 構成

- `Properties`
- `AI Context`
- `Review`

#### 責務

- clip 基本情報
- audio policy 編集
- beat / motivation / quality flags / confidence 表示
- clip 単位 weakness / warning / review summary 表示

#### v3 方針

- 既存 `PropertyPanel.tsx` を継続利用する
- ただし右パネルの情報密度を優先し、bottom dock に置くべき情報は分離する
- clip edit と AI explanation を同一 panel で往復可能にする

### 3-4. TransportBar

#### 責務

- 再生 / 停止
- seek summary
- タイムコード
- 現在 frame
- source / offline state

#### v3 方針

- transport は Viewer の下に固定する
- `Export Render` は残すが、source-based preview と混同しない命名にする
  - label: `Export Reference Render`

### 3-5. CommandBar

#### 責務

- `Compile`
- `Review`
- `Render`
- job state
- error surface

#### v3 方針

- 既存 job polling を継続
- external CLI 実行結果は WebSocket で受け、必要に応じて job state を refresh する
- dirty 時の disable は維持する

### 3-6. AlternativesPanel

#### 責務

- current clip の差し替え候補表示
- confidence / why_it_matches / risks の表示
- swap 実行

#### v3 方針

- bottom dock 継続
- apply 後は local dirty state に反映
- source thumbnail と source preview の導線は残すが、候補の full playback は v3 範囲外

### 3-7. DiffPanel

#### 責務

- AI 初回出力 vs 現在 timeline の差分表示
- local edits / patch apply / swap / trim の可視化

#### v3 方針

- `sessionBaseline` ベース比較を継続
- 409 merge UI でもこの diff model を再利用する

### 3-8. PatchPanel

#### 責務

- review patch proposal の一覧
- `Apply`
- `Apply All`
- `Reject`

#### v3 方針

- server authoritative apply は維持
- apply 完了後は remote mutation として timeline state へ反映
- safety filter を通った operations のみ actionable にする

---

## 4. 双方向同期の設計

### 4-1. 監視対象

v3 で watch する対象は以下。

| artifact | 理由 |
|---|---|
| `05_timeline/timeline.json` | GUI / CLI 共有の canonical timeline |
| `06_review/review_report.yaml` | `/review` 結果の即時反映 |
| `06_review/review_patch.json` | patch panel の即時反映 |
| `project_state.yaml` | gate / stale 状態反映 |
| render manifest / packaged output の代表ファイル | `/render` 結果表示 |

ユーザー要求の最小核は `timeline.json` 監視だが、`compile` / `review` / `render` 結果の即時反映を満たすには review / render artifacts も同じハブで監視する必要がある。

### 4-2. サーバー側設計

#### Watch 単位

- file ではなく directory を watch する
- 理由:
  - 既存 save は temp + rename の atomic write
  - file 単位 watch は rename 後に購読が切れやすい

watch 対象 directory:

- `05_timeline/`
- `06_review/`
- project root (`project_state.yaml`)
- render output directory

#### Change detection

`TimelineWatchHub` は artifact ごとの last-known hash registry を持ち、これを change detection の唯一の正本とする。`fs.watch` は sweep を起動する trigger であり、source of truth ではない。

1. watch 対象 directory に `fs.watch(dir)` を attach する
2. `fs.watch` event、watch error/reconnect、または periodic timer を受けたら sweep を enqueue する
3. 50-100ms debounce する
4. tracked artifact 全体の content hash / revision を再計算する
5. last-known hash registry と比較し、差分がある artifact だけ broadcast する
6. watch attach / re-attach 直後は post-reconnect full hash sweep を必須にし、registry を再確立してから healthy 扱いにする

periodic rescan:

- missed event 補正のため、event が無くても full hash sweep を固定間隔で実行する
- periodic rescan は low-latency path ではなく repair path である

reconnect recovery の補正対象:

- `05_timeline/timeline.json`
- `06_review/review_report.yaml`
- `06_review/review_patch.json`
- `project_state.yaml`
- render output の代表ファイル群

`review.changed` / `render.changed` / `project-state.changed` は `timeline.changed` と同じ repair path に乗せる。切断中に event を取りこぼしても、post-reconnect full hash sweep と periodic rescan により hash / revision 差分を検出し、missed event を補正する。

#### Event payload

```json
{
  "type": "timeline.changed",
  "project_id": "demo",
  "revision": "sha256:abcd1234ef567890",
  "source": "external",
  "changed_at": "2026-03-26T10:00:00.000Z"
}
```

artifact ごとに `type` を変える。

- `timeline.changed`
- `review.changed`
- `project-state.changed`
- `render.changed`

`source` は以下を取りうる。

- `external`
- `api-save`
- `patch-apply`
- `ai-job`

### 4-3. クライアント側設計

新規 hook `useProjectSync(projectId, localRevision, dirty)` を導入する。

#### 接続時

- project 選択時に WS 接続
- reconnect は exponential backoff
- reconnect 後は server 側で post-reconnect full hash sweep を走らせた上で、client 側でも recovery read を 1 回実行する
- recovery read 対象:
  - `GET /timeline`
  - `GET /ai/context`
  - `GET /ai/review-report`
- あわせて `project_state.yaml` と render output 代表ファイルの hash を再確認し、切断中に欠落した `review.changed` / `render.changed` / `project-state.changed` を補正する

#### 受信時

`timeline.changed` を受けた場合:

- `event.revision === localRevision`
  - ignore する
  - save / patch apply 直後の self-echo を防ぐ
- `dirty === false`
  - `GET /timeline`
  - present timeline を置換
  - `timelineRevision` を更新
- `dirty === true`
  - 自動置換しない
  - `pendingRemoteRevision` を保持
  - merge banner を表示

`review.changed` / `render.changed` / `project-state.changed` を受けた場合:

- `useReview().reload()`
- 必要に応じて render status / output badge を refresh

reconnect repair により event 無しで review / project state / render hash drift を検知した場合も、上記と同じ reload path を実行する。

### 4-4. 競合制御

#### 正本

- `timeline_revision = ETag = file-content hash`
- save correctness の正本は server-side save contract (`Ajv` + canonical invariant check) とする
- advisory lock は競合窓を狭めるための補助手段であり、409 / revision 判定を置き換えない

#### advisory lock

- save / patch / compile / review / render は project 単位の cross-process advisory lock を同じ helper で取る
- helper は process-local lock ではなく filesystem ベース lock を扱い、GUI と server job と CLI wrapper の別 process 間で共有される
- lock payload には少なくとも `operation`, `holder`, `acquired_at` を持たせる
- lock 取得失敗時は `423 Locked` を返し、UI は retry か待機を選べるようにする

#### GUI save

- client は shared validator で preflight するが、通過しても server save 成功は保証しない
- server は canonical save normalization を実行し、`Ajv` pipeline を通した結果だけを永続化する
- request header: `If-Match`
- mismatch 時は 409

#### patch apply

- GUI save と同じ advisory lock helper を使う
- request body: `base_timeline_revision`
- mismatch 時は 409

#### merge UI

409 または dirty 中 remote change 受信時は `MergeDialog` を表示する。

表示内容:

- local revision
- remote revision
- session baseline との差分
- local changes summary
- remote changes summary

選択肢:

1. `Reload Remote`
2. `Keep Local (stay dirty)`
3. `Compare First`

v3 では auto-merge しない。merge は human-in-the-loop で明示操作に限定する。

### 4-5. CLI → GUI フロー

```text
Agent / CLI
  -> write timeline.json
  -> fs.watch triggers hash sweep
  -> server recomputes revision/hash registry
  -> WS broadcast timeline.changed
  -> client refetches /timeline
  -> UI refresh
```

### 4-6. GUI → CLI フロー

```text
GUI
  -> acquire advisory lock
  -> PUT /timeline
  -> server atomic write timeline.json
  -> server emits api-save event or watcher detects file replacement
  -> next CLI command reads latest file from disk
```

CLI 側に push 通知は不要である。canonical artifact を disk に揃えることが同期の成立条件である。

### 4-7. API write と watcher の関係

通知経路と mutation guard は以下で統一する。

1. save / patch / compile / review / render は同じ advisory lock helper を使う
2. editor server 内 write は成功後に hub へ即時通知してよい
3. external write は `fs.watch` event を trigger に sweep し、hash registry 差分から通知する
4. watcher reconnect 後は即座に post-reconnect full hash sweep を走らせる
5. periodic rescan は missed event repair 用に常時有効にする

これにより、

- GUI save 後の反映 latency は最小化する
- external CLI 変更は `fs.watch` miss があっても periodic sweep で補正できる
- `fs.watch` event 自体を source of truth にせず、revision/hash registry を正として dedupe できる

---

## 5. メディア再生の設計

### 5-1. source 解決

Viewer は `clip.asset_id` を唯一の入力キーとして source_map を引く。client は basename や path を組み立てない。

`GET /api/projects/:id/source-map` の返り値は、少なくとも以下の正規化形を満たす。

```json
{
  "assets": {
    "asset_001": {
      "media_id": "media_7f4c8d2a",
      "playback_strategy": {
        "kind": "direct",
        "url": "/api/projects/demo/media/by-asset/asset_001"
      }
    }
  }
}
```

意味:

- `asset_id -> media_id` は server が管理する再生 identity
- `media_id -> playback_strategy` は direct / cached-transcode / transcode-on-error を表す
- browser に渡す URL は `/api/projects/:id/media/by-asset/:assetId` に統一する
- `GET /api/projects/:id/media/:filename` は backward-compat endpoint としてのみ残す

### 5-2. ブラウザ非対応コーデック

既存 route の方針は正しいため継続する。

- `ffprobe` で audio / video codec 判定
- 非対応なら `.proxy-cache/` へトランスコード
- 2 回目以降は cache serve

v3 で改善する点:

- cache key を `basename.mp4` ではなく `hash(realPath + mtimeMs + codec profile)` にする
- duplicate filename collision を防ぐ
- partial file 配信防止の temp + rename を維持する
- `MEDIA_ERR_SRC_NOT_SUPPORTED` を受けた場合は、同一 `asset_id` の `playback_strategy` を transcode fallback に切り替えて再要求する

### 5-3. 再生ステートマシン

states:

- `idle`
- `loading_source`
- `playing_clip`
- `paused_clip`
- `gap_playing`
- `gap_paused`
- `error`

### 5-4. 再生アルゴリズム

1. playhead frame から現在 clip を検索する
2. clip が存在する
   - `asset_id` から `media_id` と `playback_strategy` を引く
   - 同一 `media_id` かつ許容 drift 内なら `src` 切替しない
   - それ以外は `src` 切替 -> `loadedmetadata` 待ち -> exact seek -> `play()`
3. clip 再生中の clock source は `requestVideoFrameCallback` を優先する
   - callback で得た decode 済み frame から timeline frame を逆算する
4. `requestVideoFrameCallback` が無い場合は RAF polling で `currentTime` を読む
5. `timeupdate` は coarse UI 表示と buffering 補助にのみ使い、playhead の正本には使わない
6. clip が存在しない
   - black gap 表示
   - transport は RAF で進行する
7. `MEDIA_ERR_SRC_NOT_SUPPORTED` が出たら同じ `asset_id` に対して transcode fallback URL へ切り替えて 1 回だけ再試行する
8. `clip.src_out_us` 到達 or clip end frame 到達で次の clip / gap へ遷移する

### 5-5. clip 境界切替

必須挙動:

- 境界で stop しない
- 次 clip があれば `src switch + seek + play`
- 次が gap なら black gap transport

安定化策:

- next clip が別 `media_id` または別 `playback_strategy` の場合、boundary 近傍では hidden preload video を必須とする
- same `media_id` の連続 clip は visible video 1 本で seek し直す
- preload 済み clip が準備完了なら、boundary 到達時に preload 側へ promote して継続再生する
- preload 失敗時は visible video の direct switch に degrade するが、fallback 受け入れ条件以内に収める
- API と state machine は preload 無し経路と preload 有り経路の両方を同じ `asset_id` / `media_id` contract 上で扱う

### 5-6. v3 で扱わない再生 fidelity

以下は final render を authoritative とし、Viewer の完全一致対象から外す。

- multi-track audio mix の sample-accurate 合成
- transition effect のリアルタイム完全再現
- color / title / caption の最終ルック一致

Viewer の役割は「cut / trim / source continuity / rough timing の即時確認」である。

---

## 6. API / インターフェース設計

### 6-1. timeline API

#### `GET /api/projects/:id/timeline`

- body: raw `timeline.json`
- header: `ETag`

#### `PUT /api/projects/:id/timeline`

- request header: `If-Match`
- response body: `timeline_revision`

### 6-2. media resolution API

#### `GET /api/projects/:id/source-map`

- response body は `asset_id -> media_id -> playback_strategy` を正規化して返す
- client は `local_source_path` / `link_path` / `source_locator` を直接解釈しない

#### `GET /api/projects/:id/media/by-asset/:assetId`

- `asset_id` から server 内部で source を解決して stream する
- `playback_strategy.kind` に応じて direct serve / cache serve / transcode fallback を選ぶ

#### `GET /api/projects/:id/media/:filename`

- backward-compat のみ
- v3 client の新規利用は禁止する

### 6-3. 新規 WebSocket

#### 接続

```text
GET ws://localhost:3100/api/ws?projectId=<id>
```

#### server -> client event schema

```ts
type ProjectSyncSource = "external" | "api-save" | "patch-apply" | "ai-job";

type ProjectSyncEvent =
  | {
      type: "timeline.changed";
      project_id: string;
      revision: string;
      source: ProjectSyncSource;
      changed_at: string;
    }
  | {
      type: "review.changed";
      project_id: string;
      review_report_revision?: string;
      review_patch_revision?: string;
      source: ProjectSyncSource;
      changed_at: string;
    }
  | {
      type: "render.changed";
      project_id: string;
      source: ProjectSyncSource;
      changed_at: string;
    }
  | {
      type: "project-state.changed";
      project_id: string;
      source: ProjectSyncSource;
      changed_at: string;
    };
```

### 6-4. timeline schema 変更方針

- `timeline.json` schema の必須拡張は行わない
- `timeline_revision` は API header / response で扱う
- GUI 固有の session state は client memory に留める

### 6-5. save contract normalization

- save 契約の唯一の正本は server-side `Ajv` pipeline とする
- client preflight は shared validator を使うが、これは UX 補助であり canonical 判定ではない
- save 前に client / server の双方で同じ shared normalization を通し、derived field を揃える
  - `timeline_duration_frames` の再計算
  - track 内 clip sort の正規化
- overlap 判定は canonical track semantics で固定する
  - track ごとに clips を `timeline_in_frame` 昇順、同値なら `clip_id` 昇順で整列する
  - 同一 start frame の clips は stack group とみなす
  - stack group の次境界は、その group 内の最短 end frame とする
  - 前 group の境界が次 group の start frame を超えたら overlap と判定する
  - 生の配列順や UI 上の見た目の重なりは意味を持たない
- 永続化される revision は server が normalize + validate した後の file content からのみ算出する

---

## 7. 実装方針

### 7-1. 改修対象

- `editor/client/src/*`
- `editor/server/*`

新規 standalone app は作らない。

### 7-2. 優先順位

#### Priority 0. 壊れている機能の修正

- cross-document canonical sync
  - Authority Matrix の整合宣言を実ファイルへ反映する
  - `ARCHITECTURE.md`, `docs/roadmap.md`, `docs/editor-ai-workflow-design.md`, `docs/editor-ai-workflow-final.md`, `docs/editor-ai-workflow-impl-plan.md`, `docs/editor-mvp-design.md` を更新対象に固定する
- save contract normalization
  - server Ajv pipeline を唯一の正本に固定する
  - client preflight は shared validator に統一する
  - overlap 判定を canonical track semantics で固定する
- cross-process mutation guard
  - save / patch / compile / review / render を同じ advisory lock helper に統一する
- trim 後の seek / duration 再同期
- clip 境界の再生切替安定化
- media cache key の衝突回避
- dirty / remote change 競合時の UI 破綻防止

#### Priority 1. 双方向同期

- `TimelineWatchHub`
- `ProjectSocketHub`
- `useProjectSync()`
- merge banner / reload flow

#### Priority 2. UI 再構成

- Timeline の layered canvas 化
- Viewer / Transport / Inspector / bottom dock の責務固定
- professional density への調整

### 7-3. 段階実装

#### Phase 0. Cross-doc canonical sync

- v3 文書内の整合宣言は Authority Matrix で成立済みとする
- `ARCHITECTURE.md` と `docs/roadmap.md` の canonical writer rule / gate 文言を更新する
- `docs/editor-ai-workflow-design.md`, `docs/editor-ai-workflow-final.md`, `docs/editor-ai-workflow-impl-plan.md`, `docs/editor-mvp-design.md` に historical / superseded banner と v3 参照先を追記する

#### Phase A. Sync foundation

- server に advisory lock helper + watcher + ws 追加
- WatchHub の periodic sweep / reconnect full sweep を成立させる
- client に ws hook 追加
- timeline / review artifact auto reload を成立させる

#### Phase B. Playback stabilization

- source resolution を `asset_id -> media_id -> playback_strategy` へ整理
- proxy cache key を改善
- rVFC 優先 clock / RAF fallback / hidden preload / transcode fallback を明文化通りに揃える

#### Phase C. Timeline refactor

- clip 描画を Canvas 主体へ移行
- hit-test / trim / overlay を整理

#### Phase D. Merge UX / polish

- 409 merge dialog
- remote pending banner
- status bar / dock / command coherence

### 7-4. 既存 polling との共存

- GUI 起動 job の progress は現行 polling を維持する
- WebSocket は artifact change push に限定する
- これにより双方向同期を最小差分で導入できる

---

## 8. テスト戦略と受け入れ条件

### 8-1. 最低基準

- `npm run build` が通ること

### 8-2. 実装後の必須確認

1. GUI を開いた状態で CLI から `compile` 実行
   - `timeline.json` 更新後、GUI が自動 reload する
2. GUI を開いた状態で CLI から `review` 実行
   - Review / Patch panel が自動更新される
3. GUI で trim して save
   - 次回 CLI `review` が更新済み `timeline.json` を読む
4. client preflight をバイパスして `PUT /timeline` しても、server Ajv pipeline が不正 payload を reject する
5. overlap する timeline を save しようとした場合
   - client preflight と server save が同じ canonical track semantics で block する
6. 非対応コーデック素材を含む project を再生
   - 初回は transcode、2 回目は cache serve
7. `MEDIA_ERR_SRC_NOT_SUPPORTED` を強制発火させた再生
   - 同じ `asset_id` の transcode fallback に切り替わり、basename endpoint へ戻らない
8. clip 境界と gap を跨いで再生 (`requestVideoFrameCallback` 利用可)
   - 黒画面 gap と next clip 遷移が破綻せず、drift は 1 frame 以内
9. clip 境界と gap を跨いで再生 (`requestVideoFrameCallback` 不可の fallback)
   - 黒画面 gap と next clip 遷移が破綻せず、drift は 2-3 frame 以内
10. 別プロセスで `timeline.json` を変更し、GUI 側が dirty
   - auto overwrite されず merge banner が出る
11. stale revision で save / patch apply
   - 409 が返り、merge UI へ誘導される
12. save / patch / compile / review / render を別 process から同時に起動
   - 同じ advisory lock helper が競合を抑止し、後続要求は 423 または待機へ落ちる
13. `GET /source-map` と media 再生
   - client は `asset_id` 直指定だけで再生でき、`/media/:filename` は backward-compat に留まる
14. WS 切断中に `review_report.yaml` または `review_patch.json` が更新される
   - reconnect 後の `GET /ai/context` + `GET /ai/review-report` と hash sweep により missed `review.changed` が補正される
15. WS 切断中に `project_state.yaml` または render output 代表ファイルが更新される
   - reconnect 後の project state / render hash check により missed `project-state.changed` / `render.changed` が補正される

### 8-3. テスト観点

#### 自動テスト

- revision compare
- save contract normalization parity
- advisory lock cross-process contention
- watcher hash dedupe
- watcher periodic sweep / reconnect full sweep
- reconnect missed event repair for `review.changed` / `render.changed` / `project-state.changed`
- WebSocket reconnect
- source-map asset_id contract
- cache key generation
- playback state machine の pure helper
- rVFC path / RAF fallback の許容 drift

#### 手動テスト

- scrubbing
- frame trim
- zoom / scroll
- black gap UX
- external CLI reflection

---

## 9. リスク・代替案・ロールバック

### 9-1. リスク

#### `fs.watch` の不安定性

- rename ベース save と相性が悪い
- 対策:
  - file ではなく directory を watch
  - `fs.watch` は trigger に限定し、hash registry を正本にする
  - event 後に hash 再計算する
  - periodic full hash sweep を常時有効にする
  - watch 再接続直後に full hash sweep を走らせる

#### source-based playback の限界

- ブラウザ再生は NLE と完全同等ではない
- 対策:
  - Viewer の責務を rough editorial preview に固定
  - rVFC 優先 / RAF fallback の二段品質として受け入れ条件を分ける
  - `MEDIA_ERR_SRC_NOT_SUPPORTED` は transcode fallback で回復させる
  - final fidelity は render を authoritative にする

#### canonical policy の文書不整合

- 旧 gate が残ると実装判断が割れる
- 対策:
  - Authority Matrix で v3 内の整合を先に宣言し、`ARCHITECTURE.md` / `docs/roadmap.md` / 旧 workflow draft の実ファイル更新は Phase 0 (P0) で追従させる

### 9-2. 検討したが採用しない案

#### SSE

- 一方向 push には十分だが、project 単位 room 管理と将来拡張で WebSocket の方が素直

#### polling 継続

- 既存 AI job progress には十分だが、CLI 外部更新の UX 改善には不十分

#### prerender preview を主経路に戻す

- trim / seek たびにレンダー待ちが発生し、編集ループが遅すぎる

---

## 10. 運用・移行・保守

### 10-1. 移行方針

- 既存 project format は維持する
- `timeline.json` schema 変更は行わない
- `.proxy-cache/` は project ローカルの派生物として扱う
- basename ベース media endpoint は backward-compat として一時維持するが、新規 client path は `asset_id` 直指定へ移行する

### 10-2. feature rollout

- 初期 rollout は local editor 専用
- WebSocket 不達時は警告を出し、manual reload + existing polling に degrade できるようにする
- feature flag `EDITOR_WS_SYNC=0` で旧挙動へ戻せるようにする

### 10-3. 監視

server log で最低限以下を記録する。

- watcher attach / detach
- watcher full sweep start / complete / drift repaired
- broadcast event type / revision
- advisory lock acquire / release / contention
- transcode start / cache hit / transcode fail
- `MEDIA_ERR_SRC_NOT_SUPPORTED` fallback 発火
- 409 conflict
- ws reconnect

### 10-4. ロールバック

以下のいずれかが出た場合は watcher + WebSocket を一時 rollback する。

- save 後に self-echo で editor state が壊れる
- project 切替時の WS reconnect loop が止まらない
- `fs.watch` drop により external CLI 変更取りこぼしが再現する

rollback 手段:

1. `EDITOR_WS_SYNC=0`
2. manual reload ボタン + 既存 polling のみで運用継続
3. watcher 実装を修正後に flag を再度有効化

---

## 11. 実装タスク分解

### Track 1. Sync

- `editor/server/index.ts` を HTTP server + WebSocket 対応へ変更
- `editor/server/services/project-mutation-lock.ts` を追加
- `editor/server/services/timeline-watch-hub.ts` を追加
- `editor/client/src/hooks/useProjectSync.ts` を追加
- `useTimeline()` と `useReview()` を sync event 連動に変える

### Track 2. Playback

- `usePlayback()` の `asset_id -> media_id -> playback_strategy` 解決を整理
- media proxy cache key を改善
- Viewer state machine を rVFC / RAF fallback / preload / transcode fallback 込みで明文化通りへ揃える

### Track 3. Timeline UI

- `Timeline.tsx` を layered canvas 前提に再構築
- `TrackLane.tsx` / `ClipBlock.tsx` を migration 用 wrapper に落とすか整理する
- overlay / selection / trim handle の描画責務を Timeline に寄せる

### Track 4. Conflict UX

- remote pending banner
- merge dialog
- diff reuse

---

## 12. 最終判断

Editor v3 の中核判断は以下で固定する。

1. `timeline.json` は canonical のまま維持する。
2. GUI と CLI は同じファイルを共有し、別正本を作らない。
3. save contract の正本は server Ajv pipeline とし、client は shared validator で preflight する。
4. 外部変更反映は `fs.watch` を trigger、hash sweep を source of truth、WebSocket を通知経路として採用する。
5. source-based playback は `requestVideoFrameCallback` 優先、RAF fallback、conditional preload、transcode fallback を前提にする。
6. media 解決は `asset_id` 直指定と server 管理の `media_id` / `playback_strategy` に統一する。
7. 新機能は双方向同期を主軸とし、残りは既存 editor の安定化・本格 UI 化として進める。

この方針により、Video OS v2 エディタは「MVP の補助ツール」から「AI と人間が同じ timeline を編集する本番 UI」へ移行できる。
