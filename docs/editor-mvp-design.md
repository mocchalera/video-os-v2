# Video OS v2 — Web タイムラインエディタ MVP 設計書

> Date: 2026-03-24
> Phase: 2 (nle-strategy-research.md Phase 2)
> Status: Draft
> Scope: timeline.json を直接操作する Web ベースタイムラインエディタの最小実装

---

## 0. 動機と戦略的位置づけ

### 0-1. 問題

NLE（Premiere Pro）連携は FCP7 XML を経由するため以下の制約がある:

| 問題 | 影響 |
|------|------|
| パラメータ欠落（20+ 項目） | audio fade, transitions, gain が XML に出力されない |
| 双方向同期不可 | Premiere→Agent は手動 XML エクスポートが必要 |
| 変換ロス | μs→frame 変換の丸め誤差、AI メタデータの欠落 |
| UXP API 制約 | タイムライン直接操作の API が不安定 |

### 0-2. 解決方針

timeline.json を直接読み書きする Web エディタを構築する。

- **変換ロス 0**: 中間フォーマットを挟まず timeline.json をそのまま操作
- **パラメータ精度 100%**: スキーマ定義されたすべてのフィールドを編集可能
- **AI ループ統合**: `/review` → エディタで微調整 → `/render` がシームレス
- **配布不要**: `npm run editor` でローカル起動する開発者向けツール

### 0-3. NLE 連携との関係

自前エディタは NLE 連携を**置き換えるものではない**。Phase 1（FCP7 XML 改善）と並行して、
timeline.json の精密な微調整手段として位置づける。プロ NLE に渡す前の「AI 編集の最終チェック」ツール。

```
AI 編集パイプライン
  ↓
timeline.json ←── Web エディタで微調整（本設計）
  ↓
┌─────────────┐  ┌────────────────┐
│ /render     │  │ /export-premiere│
│ (最終レンダー)│  │ (NLE 引き継ぎ)  │
└─────────────┘  └────────────────┘
```

---

## 1. アーキテクチャ

### 1-1. 全体構成

```
┌──────────────────────────────────────────────────────────┐
│  Browser (localhost:5555)                                 │
│                                                           │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────┐ │
│  │  Preview      │  │  Timeline      │  │  Properties  │ │
│  │  Player       │  │  Canvas        │  │  Panel       │ │
│  │  (HTML5       │  │  (2D Canvas    │  │  (React      │ │
│  │   <video>)    │  │   描画)        │  │   フォーム)   │ │
│  └──────┬───────┘  └───────┬────────┘  └──────┬───────┘ │
│         │                   │                   │         │
│         └───────────┬───────┴───────────────────┘         │
│                     │                                     │
│            useTimeline() — React state                    │
│                     │                                     │
│             HTTP API (fetch)                              │
└─────────────┬───────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│  Local Server (Express, localhost:5555)                    │
│                                                           │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐              │
│  │ Timeline │  │ Preview  │  │ Media     │              │
│  │ CRUD     │  │ Renderer │  │ Streamer  │              │
│  │ API      │  │ (ffmpeg) │  │ (Range)   │              │
│  └──────────┘  └──────────┘  └───────────┘              │
│         │              │              │                   │
│    timeline.json    ffmpeg      source media files        │
│    (05_timeline/)               (02_media/)               │
└──────────────────────────────────────────────────────────┘
```

### 1-2. ディレクトリ構成

```
video-os-v2-spec/
├── editor/                          # 独立アプリ（別 package.json）
│   ├── package.json                 # React + Vite + Express 依存
│   ├── tsconfig.json
│   ├── vite.config.ts
│   │
│   ├── server/                      # バックエンド
│   │   ├── index.ts                 # Express サーバーエントリ
│   │   ├── routes/
│   │   │   ├── timeline.ts          # GET/PUT /api/projects/:id/timeline
│   │   │   ├── preview.ts           # POST /api/projects/:id/preview
│   │   │   ├── media.ts             # GET /api/media/* (Range 対応ストリーミング)
│   │   │   ├── waveform.ts          # GET /api/projects/:id/waveform/:assetId
│   │   │   └── thumbnail.ts         # GET /api/projects/:id/thumbnail/:clipId
│   │   ├── services/
│   │   │   ├── ffmpeg.ts            # ffmpeg 呼び出しラッパー
│   │   │   ├── project-resolver.ts  # プロジェクトパス解決、source_map 読み込み
│   │   │   └── waveform-cache.ts    # 波形データキャッシュ (JSON)
│   │   └── middleware/
│   │       └── cors.ts
│   │
│   ├── src/                         # フロントエンド (React)
│   │   ├── main.tsx                 # エントリ
│   │   ├── App.tsx                  # レイアウト統括
│   │   ├── components/
│   │   │   ├── Timeline/
│   │   │   │   ├── TimelineCanvas.tsx      # Canvas 描画 — トラック・クリップ
│   │   │   │   ├── Playhead.tsx            # 再生ヘッド
│   │   │   │   ├── ClipBlock.tsx           # 個別クリップの描画・インタラクション
│   │   │   │   ├── TrackHeader.tsx         # V1/A1/A2 ラベル
│   │   │   │   └── TimeRuler.tsx           # 時間軸ルーラー
│   │   │   ├── Player/
│   │   │   │   ├── VideoPlayer.tsx         # HTML5 <video> プレビュー
│   │   │   │   └── TransportBar.tsx        # 再生/停止/シーク UI
│   │   │   ├── Properties/
│   │   │   │   ├── PropertiesPanel.tsx     # 選択クリップの属性表示
│   │   │   │   ├── AudioPolicyEditor.tsx   # audio_policy 各フィールド
│   │   │   │   ├── ClipInfoDisplay.tsx     # clip_id, asset_id, motivation 等
│   │   │   │   └── TransitionEditor.tsx    # (Phase 2b) トランジション設定
│   │   │   └── shared/
│   │   │       ├── Toolbar.tsx             # 上部ツールバー
│   │   │       └── StatusBar.tsx           # 下部ステータスバー
│   │   ├── hooks/
│   │   │   ├── useTimeline.ts       # timeline.json の state 管理
│   │   │   ├── usePlayback.ts       # playhead ↔ video 同期
│   │   │   ├── useClipSelection.ts  # 選択状態管理
│   │   │   ├── useUndoRedo.ts       # (Phase 2b) Undo/Redo スタック
│   │   │   └── useKeyboard.ts       # キーボードショートカット
│   │   ├── lib/
│   │   │   ├── timeline-types.ts    # timeline.json の TypeScript 型定義
│   │   │   ├── time-utils.ts        # μs ↔ frame ↔ timecode 変換
│   │   │   └── api-client.ts        # バックエンド API ラッパー
│   │   └── styles/
│   │       └── editor.css           # エディタ固有スタイル
│   │
│   └── public/
│       └── index.html
│
├── runtime/                         # 既存（変更なし）
├── schemas/                         # 既存（変更なし）
├── scripts/                         # 既存
│   └── start-editor.ts              # 新規: npm run editor のエントリ
└── package.json                     # ルート: "editor" スクリプト追加
```

### 1-3. 技術スタック選定

| 層 | 技術 | 選定理由 |
|---|---|---|
| **フロントエンド** | React 19 + TypeScript | Video OS エコシステムが TS ベース。React の豊富な Canvas ライブラリ群 |
| **ビルド** | Vite | 高速 HMR。Webpack 不要の軽量構成 |
| **タイムライン描画** | Canvas 2D API (自前) | fabric.js/konva.js は NLE 的 UI には過剰。クリップ矩形の描画とドラッグは Canvas 2D で十分 |
| **波形表示** | wavesurfer.js v7 | 波形描画に特化した成熟ライブラリ。Region プラグインでトリム UI と統合可能 |
| **プレビュー再生** | HTML5 `<video>` | ブラウザネイティブ。Range Request でシーク可能 |
| **バックエンド** | Express (Node.js) | 既存 runtime が Node.js/TS。Fastify でも可だが Express の方がシンプル |
| **プレビュー生成** | ffmpeg (サーバーサイド) | 既存 `segment-renderer.ts` のパターンを流用 |
| **状態管理** | React useState + useReducer | エディタの状態は timeline.json 1 ファイルに集約。外部ライブラリ不要 |
| **スタイリング** | CSS Modules | コンポーネントスコープ。Tailwind は NLE 的 UI に不向き（ピクセル精度のレイアウトが必要） |

**選定しなかった技術:**

| 候補 | 不採用理由 |
|------|-----------|
| Next.js | SSR/SSG 不要のローカルツール。Vite + Express の方が軽量 |
| Electron | 配布の手間が増える。ブラウザ動作で十分 |
| Remotion Studio | エディタ UI ではなくレンダーフレームワーク。カスタム UI の拡張性が低い |
| FFmpeg.wasm | メモリ制約 (2GB)、起動時間、互換性の問題。サーバーサイド ffmpeg の方が信頼性高 |
| Konva.js / Fabric.js | タイムラインの矩形描画には過剰。逆にタイムライン特有の操作（時間軸ズーム、スナップ）は自前実装が必要 |

---

## 2. MVP 機能スコープ（Phase 2a: 最小実装）

### 2-1. 機能一覧

| # | 機能 | 重要度 | 実装難易度 | 備考 |
|---|------|--------|-----------|------|
| F1 | タイムライン表示 | **必須** | 低 | V1/V2 + A1/A2 トラック、クリップ矩形の描画 |
| F2 | プレイヘッド | **必須** | 低 | タイムライン上の赤縦線、クリックでシーク |
| F3 | 時間軸ルーラー | **必須** | 低 | フレーム/タイムコード表示、ズーム対応 |
| F4 | クリップ選択 | **必須** | 低 | クリックで選択、Properties パネルに反映 |
| F5 | クリップトリム | **必須** | 中 | クリップ端のドラッグで src_in_us / src_out_us を調整 |
| F6 | 音量調整 | **必須** | 低 | audio_policy の各 gain フィールドのスライダー |
| F7 | フェード設定 | **必須** | 低 | fade_in_frames / fade_out_frames の数値入力 |
| F8 | プレビュー再生 | **必須** | 中 | ffmpeg で指定区間をレンダー → `<video>` 再生 |
| F9 | timeline.json 保存 | **必須** | 低 | PUT API で書き戻し。スキーマバリデーション付き |
| F10 | プロジェクト選択 | **必須** | 低 | projects/ 配下のプロジェクト一覧から選択 |

### 2-2. 各機能の詳細

#### F1: タイムライン表示

```
Timeline Canvas 構造:

TrackHeader │  Time Ruler (frames / timecode)
            │  0f    24f   48f   72f   96f   120f  144f
────────────┼───┬─────┬─────┬─────┬─────┬─────┬─────────
   V1       │   [====CLP_0001====]  [===CLP_0006===]
   V2       │     [==CLP_0002==]      [=CLP_0007=]
────────────┼───────────────────────────────────────────
   A1 (nat) │   [====nat_0001===]  [===nat_0006===]
   A2 (bgm) │   [================bgm================]
────────────┼───────────────────────────────────────────
   C1 (cap) │   [--caption--]        [--caption--]
────────────┼───────────────────────────────────────────
```

- **描画**: Canvas 2D で矩形描画。クリップは `timeline_in_frame` を x 座標、`timeline_duration_frames` を幅にマッピング
- **ズーム**: マウスホイールで水平ズーム（frames/pixel 比を変更）
- **スクロール**: 水平スクロールバー + Shift+ホイール
- **色分け**: role に応じた配色（hero=blue, support=cyan, bgm=green, nat_sound=orange）
- **クリップラベル**: 短縮した motivation を矩形内に表示

#### F5: クリップトリム

```
トリム操作:

カーソルがクリップ端 (5px 範囲) に入ると ↔ カーソルに変化

    ドラッグ開始
    ↓
[====clip====]  →  [======clip========]
                    └─ src_out_us 増加

制約:
- src_in_us >= 0
- src_out_us <= ソース素材の総尺
- timeline_duration_frames は自動再計算
  timeline_duration_frames = Math.round((src_out_us - src_in_us) / 1_000_000 * fps)
```

#### F6: 音量調整

Properties パネル内のスライダー + 数値入力:

| フィールド | UI | 範囲 | 単位 |
|-----------|-----|------|------|
| `audio_policy.nat_gain` | スライダー | -60 ~ +12 | dB |
| `audio_policy.bgm_gain` | スライダー | -60 ~ +12 | dB |
| `audio_policy.duck_music_db` | スライダー | -60 ~ 0 | dB |
| `audio_policy.nat_sound_gain` | スライダー | -60 ~ +12 | dB |

#### F8: プレビュー再生

2 モードで段階的に実装:

**Mode A: セグメントプレビュー（MVP）**
1. ユーザーがタイムライン上で範囲を選択（またはクリップを選択）
2. `POST /api/projects/:id/preview` で ffmpeg がセグメントをレンダー（720p, ultrafast）
3. レンダー完了後、`<video>` タグでプレビュー MP4 を再生
4. 既存 `segment-renderer.ts` のロジックを流用

**Mode B: メディアストリーミング（将来拡張）**
- ソースファイルを Range Request でストリーミング
- playhead 位置に応じて該当クリップのソースファイルにシーク
- トランジションやミックスは反映されない簡易プレビュー

---

## 3. Phase 2b: 拡張機能

Phase 2a 完了後、以下を段階的に追加する。

| # | 機能 | 優先度 | 実装難易度 | 備考 |
|---|------|--------|-----------|------|
| F11 | 波形表示 | P1 | 中 | wavesurfer.js でオーディオトラックに波形を重畳 |
| F12 | Undo/Redo | P1 | 中 | timeline 状態のスナップショットスタック |
| F13 | テロップ編集 | P2 | 中 | caption トラッククリップのテキスト・タイミング編集 |
| F14 | BGM セクション可視化 | P2 | 低 | bgm_analysis.json のセクション境界をマーカー表示 |
| F15 | キーフレームエディタ | P2 | 高 | fade カーブの視覚的編集（ベジェ曲線） |
| F16 | クリップ並べ替え | P2 | 高 | ドラッグで順序変更。timeline_in_frame の自動再計算 |
| F17 | トランジション設定 | P3 | 高 | transitions[] への UI（種類選択、duration 設定） |
| F18 | review_patch 出力 | P1 | 低 | 変更差分を review_patch.json 形式で保存 |
| F19 | マーカー表示/編集 | P2 | 低 | markers[] のタイムライン上可視化 |
| F20 | サムネイル表示 | P1 | 中 | クリップ矩形内に代表フレームのサムネイルを表示 |

### F11: 波形表示

```
wavesurfer.js 統合:

A1 トラック:
   [▁▂▃▅▇▅▃▂▁▁▂▃▄▅▆▇▆▅▃▂▁]  ← 波形
   [========clip=========]     ← クリップ矩形

- サーバー側で ffmpeg でオーディオ抽出 → PCM データ生成
- wavesurfer.js の peaks データとして JSON キャッシュ
- GET /api/projects/:id/waveform/:assetId で peaks JSON を返却
```

### F12: Undo/Redo

```typescript
// useUndoRedo.ts の設計
interface UndoStack {
  past: TimelineState[];     // 最大 50 スナップショット
  present: TimelineState;
  future: TimelineState[];
}

// 操作のたびに present をディープコピーして past に push
// Ctrl+Z: past.pop() → present, present → future.push()
// Ctrl+Shift+Z: future.pop() → present, present → past.push()
```

### F15: キーフレームエディタ

```
fade カーブの視覚的編集:

音量
 0dB ┤          ╭──────────────╮
     │         ╱                ╲
     │        ╱                  ╲
-∞dB ┤───────╱                    ╲───
     └────┬──────────────────────┬────
      fade_in                fade_out
      (12 frames)            (12 frames)

- audio_policy.fade_in_frames / fade_out_frames を視覚的に調整
- クリップの端に三角形のフェードインジケーターを描画
- ドラッグでフレーム数を変更
```

---

## 4. API 設計

### 4-1. エンドポイント一覧

| Method | Path | 機能 | Phase |
|--------|------|------|-------|
| GET | `/api/projects` | プロジェクト一覧 | 2a |
| GET | `/api/projects/:id/timeline` | timeline.json を返却 | 2a |
| PUT | `/api/projects/:id/timeline` | timeline.json を更新（バリデーション付き） | 2a |
| POST | `/api/projects/:id/preview` | 指定区間のプレビュー MP4 を生成 | 2a |
| GET | `/api/projects/:id/preview/:filename` | 生成済みプレビューを配信 | 2a |
| GET | `/api/media/:projectId/*` | メディアファイルの Range 対応ストリーミング | 2a |
| GET | `/api/projects/:id/waveform/:assetId` | 波形 peaks データ (JSON) | 2b |
| GET | `/api/projects/:id/thumbnail/:clipId` | クリップ代表フレーム画像 | 2b |
| GET | `/api/projects/:id/source-map` | source_map.json を返却 | 2a |

### 4-2. 詳細仕様

#### GET /api/projects

```
Response 200:
{
  "projects": [
    {
      "id": "rokutaro-v7",
      "name": "rokutaro-v7",
      "hasTimeline": true,
      "path": "/path/to/projects/rokutaro-v7"
    }
  ]
}
```

プロジェクト検出ロジック: `projects/*/05_timeline/timeline.json` が存在するディレクトリを列挙。

#### GET /api/projects/:id/timeline

```
Response 200: timeline.json の内容をそのまま返却
Content-Type: application/json

Response 404:
{ "error": "Timeline not found", "project": ":id" }
```

#### PUT /api/projects/:id/timeline

```
Request Body: timeline.json 全体 (Content-Type: application/json)

処理:
1. timeline-ir.schema.json でバリデーション
2. バリデーション成功 → 上書き保存
3. バックアップ: 保存前に timeline.json.bak を作成

Response 200:
{ "ok": true, "validated": true, "backupPath": "timeline.json.bak" }

Response 400:
{ "error": "Schema validation failed", "details": [...] }
```

#### POST /api/projects/:id/preview

```
Request Body:
{
  "mode": "range" | "clip" | "full",
  "startFrame": 0,        // mode=range の場合
  "endFrame": 120,         // mode=range の場合
  "clipId": "CLP_0001",   // mode=clip の場合
  "resolution": "720p"     // optional, default "720p"
}

処理:
1. source_map.json からソースファイルパスを解決
2. ffmpeg で指定区間を 720p/ultrafast でレンダー
3. 05_timeline/preview-editor-{timestamp}.mp4 に出力

Response 200:
{
  "previewUrl": "/api/projects/:id/preview/preview-editor-1711234567.mp4",
  "clipCount": 3,
  "durationSec": 5.2
}

Response 500:
{ "error": "ffmpeg failed", "stderr": "..." }
```

#### GET /api/media/:projectId/*

```
Range Request 対応のメディアストリーミング。

Headers:
  Accept-Ranges: bytes
  Content-Range: bytes 0-999999/5000000

source_map.json を参照して asset_id → 実ファイルパスを解決。
セキュリティ: projects/ 配下のファイルのみアクセス許可（パストラバーサル防止）。
```

#### GET /api/projects/:id/waveform/:assetId (Phase 2b)

```
処理:
1. キャッシュ確認: 05_timeline/.waveform-cache/{assetId}.json
2. キャッシュなし → ffmpeg でオーディオ抽出 → peaks 計算 → キャッシュ保存
3. peaks JSON を返却

Response 200:
{
  "assetId": "AST_005",
  "sampleRate": 44100,
  "channels": 1,
  "peaks": [0.01, 0.03, 0.12, 0.45, 0.78, ...],  // 正規化済み
  "duration_sec": 45.2
}
```

#### GET /api/projects/:id/thumbnail/:clipId (Phase 2b)

```
処理:
1. timeline.json から clip_id でクリップ情報を取得
2. src_in_us と src_out_us の中間点でフレーム抽出（timeline-overview.ts と同じロジック）
3. 160x90 JPEG で返却

Response 200:
Content-Type: image/jpeg
(サムネイル画像バイナリ)
```

---

## 5. UI 設計

### 5-1. レイアウト

```
┌──────────────────────────────────────────────────────────────────┐
│  Toolbar                                                         │
│  [Project: rokutaro-v7 ▾]  [Save] [Undo] [Redo]  [Zoom: 100%]  │
├────────────────────────────────────────────┬─────────────────────┤
│                                            │                     │
│   Preview Player                           │  Properties Panel   │
│   ┌──────────────────────────────────┐    │                     │
│   │                                  │    │  Clip: CLP_0001     │
│   │          Video Preview           │    │  Asset: AST_005     │
│   │          (16:9 aspect)           │    │  Role: hero         │
│   │                                  │    │  Motivation:        │
│   └──────────────────────────────────┘    │   sunrise flare...  │
│   [◀◀] [▶ Play] [▶▶] 00:00:04.000       │                     │
│   [Render Preview]                        │  ── Source ──       │
│                                            │  In:  00:01.400    │
│                                            │  Out: 00:06.000    │
├────────────────────────────────────────────┤                     │
│                                            │  ── Audio Policy ── │
│   Timeline                                 │  Nat Gain:  [===]  │
│   ┌─────────────────────────────────────┐ │  BGM Gain:  [===]  │
│   │ 0s    2s    4s    6s    8s    10s   │ │  Duck:      [===]  │
│   │─────────────────────────────────────│ │                     │
│   │ V1 [====clip1====][==clip2===]      │ │  ── Fade ──        │
│   │ V2   [=clip3=]      [=clip4=]      │ │  Fade In:  12 fr   │
│   │─────────────────────────────────────│ │  Fade Out: 12 fr   │
│   │ A1 [====nat1=====][==nat2====]      │ │                     │
│   │ A2 [==========bgm=============]    │ │  ── Metadata ──    │
│   │─────────────────────────────────────│ │  Confidence: 0.93  │
│   │ C1 [--caption1--]  [--caption2--]  │ │  Beat: b01         │
│   │              ▼ playhead             │ │                     │
│   └─────────────────────────────────────┘ │  [Apply Changes]   │
│   ◄═══════════════════════════════════►   │                     │
│                                            │                     │
├────────────────────────────────────────────┴─────────────────────┤
│  Status: Ready | Clips: 12 | Duration: 01:30 | 24fps | 1920x1080│
└──────────────────────────────────────────────────────────────────┘
```

### 5-2. パネルサイズ

| パネル | 幅/高さ | リサイズ |
|--------|---------|----------|
| Preview Player | 上部 40% | ドラッグで上下境界を変更可能 |
| Timeline | 下部 60% | 上と連動 |
| Properties | 右 280px 固定 | 折りたたみ可能 |
| 最小ウィンドウ幅 | 1024px | — |
| 最小ウィンドウ高 | 700px | — |

### 5-3. 操作体系

| 操作 | 入力 | 動作 |
|------|------|------|
| 再生/停止 | Space | プレビュー再生のトグル |
| クリップ選択 | Click | 対象クリップを選択、Properties に反映 |
| トリム | Drag (クリップ端) | src_in_us / src_out_us を変更 |
| プレイヘッド移動 | Click (ルーラー) | プレイヘッドを移動 |
| 水平ズーム | Ctrl + Scroll | タイムラインのズームイン/アウト |
| 水平スクロール | Shift + Scroll | タイムラインを左右にスクロール |
| プロパティ編集 | ダブルクリック (クリップ) | Properties パネルにフォーカス |
| 保存 | Ctrl+S | timeline.json を PUT API で保存 |
| プレビュー生成 | Ctrl+Enter | 選択範囲のプレビューを生成 |
| 全選択解除 | Escape | 選択をクリア |

### 5-4. カラーパレット（ダークテーマ）

```
背景:         #1a1a2e (深い紺)
パネル背景:    #16213e
トラック背景:   #0f3460
ルーラー:       #1a1a2e
テキスト:       #e0e0e0
プレイヘッド:   #ff4444

クリップ色 (role ベース):
  hero:        #4a90d9 (青)
  support:     #5bc0de (シアン)
  texture:     #8e7cc3 (紫)
  transition:  #f0ad4e (オレンジ)
  dialogue:    #5cb85c (緑)
  nat_sound:   #e67e22 (オレンジ)
  bgm:         #2ecc71 (緑)
  ambient:     #95a5a6 (グレー)
  title:       #e74c3c (赤)

選択クリップ:   白枠 2px + 明度 +20%
ホバー:         明度 +10%
```

---

## 6. timeline.json との整合性

### 6-1. スキーマ準拠の保証

エディタが保存する timeline.json は `timeline-ir.schema.json` に完全準拠する。

```
保存フロー:

ユーザー操作 → React state 更新
                    ↓
              バリデーション (フロントエンド)
              - src_in_us < src_out_us
              - timeline_duration_frames >= 1
              - required フィールドの存在確認
                    ↓
              PUT /api/projects/:id/timeline
                    ↓
              バリデーション (バックエンド)
              - Ajv で timeline-ir.schema.json による検証
              - 既存の schemas/ ディレクトリの validator を流用
                    ↓
              timeline.json.bak 作成 → timeline.json 上書き
```

### 6-2. フィールドマッピング

エディタ UI で編集可能なフィールドと timeline.json の対応:

| UI 操作 | 変更されるフィールド | 自動再計算 |
|---------|---------------------|-----------|
| クリップ左端ドラッグ | `clip.src_in_us`, `clip.timeline_in_frame` | `timeline_duration_frames` |
| クリップ右端ドラッグ | `clip.src_out_us` | `timeline_duration_frames` |
| 音量スライダー | `clip.audio_policy.nat_gain` 等 | — |
| フェード入力 | `clip.audio_policy.fade_in_frames` 等 | — |
| (2b) トランジション設定 | `transitions[]` の追加/変更 | — |

### 6-3. 不変条件 (Invariants)

エディタは以下の不変条件を保存時に検証する:

1. **src_in_us < src_out_us** — ソース範囲の正当性
2. **timeline_duration_frames >= 1** — ゼロ長クリップの禁止
3. **timeline_duration_frames ≈ (src_out_us - src_in_us) / 1_000_000 × fps** — 整合性（±1 frame の丸め許容）
4. **V1 クリップの timeline_in_frame が重複しない** — 同一トラック内のオーバーラップ検出
5. **required フィールドの存在** — clip_id, segment_id, asset_id, role, motivation
6. **role が enum 値** — スキーマ定義の値のみ許可
7. **audio_policy のフィールド型** — dB 値は number、frames は非負 integer

### 6-4. 下流パイプラインとの互換性

エディタで保存した timeline.json は以下のコマンドにそのまま渡せる:

| コマンド | 互換性 | 備考 |
|---------|--------|------|
| `/review` (roughcut-critic) | **完全互換** | timeline.json を読んでレビュー |
| `/render` (render pipeline) | **完全互換** | timeline.json + source_map でレンダー |
| `/export-premiere-xml` | **完全互換** | timeline.json → FCP7 XML 変換 |
| `/compile` (re-compile) | **注意** | エディタの変更は compile で上書きされる。provenance は保持 |

### 6-5. provenance の扱い

エディタで timeline.json を編集した場合、`provenance` フィールドに編集履歴を追記:

```json
{
  "provenance": {
    "brief_path": "01_intent/creative_brief.yaml",
    "blueprint_path": "04_plan/edit_blueprint.yaml",
    "selects_path": "04_plan/selects_candidates.yaml",
    "compiler_version": "2.0.0",
    "editor_version": "0.1.0",
    "last_editor_save": "2026-03-24T12:00:00Z"
  }
}
```

`editor_version` と `last_editor_save` を追加することで、手動編集の有無を後工程が判別できる。
これらのフィールドは `additionalProperties: false` の制約外に出るため、スキーマに追加する必要がある（後述）。

---

## 7. 実装計画

### 7-1. 作業見積り

| ステップ | 内容 | 工数 (日) | 前提 |
|---------|------|-----------|------|
| S1 | プロジェクト初期化 (Vite + Express 構成) | 1 | — |
| S2 | バックエンド API: timeline CRUD + media streaming | 2 | S1 |
| S3 | タイムライン Canvas 描画 (クリップ矩形 + ルーラー + トラック) | 3 | S1 |
| S4 | プレイヘッド + クリック操作 | 1 | S3 |
| S5 | クリップ選択 + Properties パネル | 2 | S3 |
| S6 | クリップトリム (ドラッグ操作) | 3 | S5 |
| S7 | 音量スライダー + フェード入力 | 1 | S5 |
| S8 | プレビュー API + Player 統合 | 3 | S2 |
| S9 | 保存 + バリデーション + バックアップ | 1 | S2 |
| S10 | キーボードショートカット + UX 改善 | 2 | S4-S9 |
| — | **Phase 2a 合計** | **~19 日** | — |

### 7-2. Phase 2b 追加工数

| ステップ | 内容 | 工数 (日) |
|---------|------|-----------|
| S11 | wavesurfer.js 波形表示 | 3 |
| S12 | Undo/Redo | 2 |
| S13 | テロップ編集 UI | 3 |
| S14 | BGM セクション可視化 | 1 |
| S15 | キーフレームエディタ | 5 |
| S16 | クリップ並べ替え | 3 |
| S17 | review_patch 出力 | 1 |
| — | **Phase 2b 合計** | **~18 日** |

### 7-3. スキーマ変更要件

timeline-ir.schema.json に以下を追加する必要がある:

```json
// provenance に追加
"editor_version": { "type": "string" },
"last_editor_save": { "type": "string", "format": "date-time" }
```

これは Phase 2a 開始前に実施する。既存の timeline.json には影響しない（optional フィールド）。

---

## 8. 起動方法

### 8-1. npm scripts

```json
// editor/package.json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:server": "tsx watch server/index.ts",
    "dev:client": "vite",
    "build": "vite build && tsc -p tsconfig.server.json"
  }
}
```

```json
// ルート package.json に追加
{
  "scripts": {
    "editor": "cd editor && npm run dev -- --project-root .."
  }
}
```

### 8-2. 起動フロー

```bash
# 初回セットアップ
cd editor && npm install

# 起動
npm run editor
# → Express server: http://localhost:5555
# → Vite dev server: http://localhost:5173 (proxy → 5555)
# → ブラウザが自動で開く

# プロジェクト指定で起動
npm run editor -- --project rokutaro-v7
```

### 8-3. サーバー設定

```typescript
// editor/server/index.ts の概要
const app = express();
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '../..');

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api/projects', projectRoutes(PROJECT_ROOT));
app.use('/api/media', mediaRoutes(PROJECT_ROOT));

// Serve Vite build in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
}

app.listen(5555, () => {
  console.log('Video OS Editor: http://localhost:5555');
});
```

---

## 9. セキュリティ考慮

| リスク | 対策 |
|--------|------|
| パストラバーサル | media ルートで `path.resolve()` 後に `PROJECT_ROOT` プレフィックス検証 |
| ファイル上書き | timeline.json 保存前に `.bak` バックアップ |
| 大容量リクエスト | `express.json({ limit: '10mb' })` |
| CORS | localhost のみ許可 |
| ffmpeg インジェクション | ユーザー入力を ffmpeg 引数に渡さない。数値パラメータのみ使用し、`execFile` (not `exec`) を使用 |

**注意**: このエディタは**ローカル専用ツール**であり、インターネットに公開しない前提。
認証・認可は実装しない。

---

## 10. 将来の拡張パス

| 拡張 | 概要 | 前提 |
|------|------|------|
| Remotion リアルタイムプレビュー | ffmpeg ではなく Remotion でブラウザ内プレビュー | Remotion composition.ts の完成 |
| WebCodecs プレビュー | ブラウザネイティブのフレームデコード | Chrome 限定で可 |
| マルチユーザー | WebSocket で timeline の同時編集 | CRDT or OT ライブラリ |
| クラウドデプロイ | Vercel/Railway にデプロイ、メディアは S3 | メディアストレージの再設計 |
| AI 再編集ループ | エディタ内から `/review` + patch 適用 | review_patch 出力 (F18) |
| OTIO エクスポート | timeline.json → OTIO → DaVinci Resolve | otio-bridge.py の完成 |

---

## 付録 A: 型定義 (timeline-types.ts)

```typescript
// editor/src/lib/timeline-types.ts
// timeline-ir.schema.json から派生した TypeScript 型定義

export interface TimelineIR {
  version: string;
  project_id: string;
  created_at?: string;
  sequence: Sequence;
  tracks: Tracks;
  markers?: Marker[];
  transitions?: Transition[];
  audio_mix?: AudioMix;
  provenance: Provenance;
}

export interface Sequence {
  name: string;
  fps_num: number;
  fps_den: number;
  width: number;
  height: number;
  start_frame: number;
  sample_rate?: number;
  timecode_format?: 'NDF' | 'DF' | 'AUTO';
  output_aspect_ratio?: string;
  letterbox_policy?: 'none' | 'pillarbox' | 'letterbox';
}

export interface Tracks {
  video: Track[];
  audio: Track[];
  overlay?: Track[];
  caption?: Track[];
}

export interface Track {
  track_id: string;
  kind: 'video' | 'audio' | 'overlay' | 'caption';
  clips: Clip[];
}

export interface Clip {
  clip_id: string;
  segment_id: string;
  asset_id: string;
  src_in_us: number;
  src_out_us: number;
  src_in_tc?: string;
  src_out_tc?: string;
  timeline_in_frame: number;
  timeline_duration_frames: number;
  role: ClipRole;
  motivation: string;
  beat_id?: string;
  fallback_segment_ids?: string[];
  confidence?: number;
  quality_flags?: string[];
  audio_policy?: AudioPolicy;
  candidate_ref?: string;
  fallback_candidate_refs?: string[];
  metadata?: Record<string, unknown>;
}

export type ClipRole =
  | 'hero' | 'support' | 'transition' | 'texture'
  | 'dialogue' | 'music' | 'nat_sound' | 'ambient'
  | 'bgm' | 'title';

export interface AudioPolicy {
  duck_music_db?: number;
  nat_gain?: number;
  nat_sound_gain?: number;
  bgm_gain?: number;
  preserve_nat_sound?: boolean;
  fade_in_frames?: number;
  fade_out_frames?: number;
  nat_sound_fade_in_frames?: number;
  nat_sound_fade_out_frames?: number;
  bgm_fade_in_frames?: number;
  bgm_fade_out_frames?: number;
}

export interface AudioMix {
  nat_sound_gain?: number;
  bgm_gain?: number;
  duck_music_db?: number;
  fade_in_frames?: number;
  fade_out_frames?: number;
  nat_sound_fade_in_frames?: number;
  nat_sound_fade_out_frames?: number;
  bgm_fade_in_frames?: number;
  bgm_fade_out_frames?: number;
  bgm_asset_id?: string;
  bgm_clip_id?: string;
  strategy?: 'manual_mix' | 'nat_under_bgm' | 'dialogue_ducked_bgm';
  notes?: string;
}

export interface Transition {
  transition_id: string;
  from_clip_id: string;
  to_clip_id: string;
  track_id: string;
  transition_type: 'cut' | 'crossfade' | 'j_cut' | 'l_cut' | 'match_cut' | 'fade_to_black';
  transition_frames?: number;
  transition_params?: TransitionParams;
  applied_skill_id?: string;
  degraded_from_skill_id?: string | null;
  confidence?: number;
}

export interface TransitionParams {
  crossfade_sec?: number;
  audio_overlap_sec?: number;
  cut_frame_before_snap?: number;
  cut_frame_after_snap?: number;
  snap_delta_frames?: number;
  hold_side?: 'left' | 'right';
  hold_frames?: number;
  zoom?: Record<string, unknown>;
  beat_snapped?: boolean;
  beat_ref_sec?: number;
}

export interface Marker {
  frame: number;
  kind: 'note' | 'warning' | 'beat' | 'caption' | 'transition' | 'review';
  label: string;
  metadata?: Record<string, unknown>;
}

export interface Provenance {
  brief_path: string;
  blueprint_path: string;
  selects_path: string;
  compiler_version?: string;
  review_report_path?: string;
  compiler_defaults_hash?: string;
  editorial_registry_hash?: string;
  duration_policy?: DurationPolicy;
}

export interface DurationPolicy {
  mode?: 'strict' | 'guide';
  source?: 'explicit_brief' | 'profile_default' | 'global_default';
  target_source?: 'explicit_brief' | 'material_total';
  target_duration_sec?: number;
  min_duration_sec?: number;
  max_duration_sec?: number | null;
}
```

## 付録 B: 時間変換ユーティリティ

```typescript
// editor/src/lib/time-utils.ts

/** μs → seconds */
export function usToSec(us: number): number {
  return us / 1_000_000;
}

/** seconds → μs */
export function secToUs(sec: number): number {
  return Math.round(sec * 1_000_000);
}

/** frame → seconds */
export function frameToSec(frame: number, fpsNum: number, fpsDen: number): number {
  return (frame * fpsDen) / fpsNum;
}

/** seconds → frame (floor) */
export function secToFrame(sec: number, fpsNum: number, fpsDen: number): number {
  return Math.floor((sec * fpsNum) / fpsDen);
}

/** μs duration → frame duration */
export function usDurationToFrames(durationUs: number, fpsNum: number, fpsDen: number): number {
  const sec = durationUs / 1_000_000;
  return Math.round((sec * fpsNum) / fpsDen);
}

/** frame → timecode string (HH:MM:SS:FF) */
export function frameToTimecode(
  frame: number,
  fpsNum: number,
  fpsDen: number,
): string {
  const fps = Math.round(fpsNum / fpsDen);
  const ff = frame % fps;
  const totalSec = Math.floor(frame / fps);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}
```
