# NLE 連携と自前エディタ UI の実現可能性調査

> Date: 2026-03-24
> Scope: Video OS v2 (`video-os-v2-spec`) — Premiere 連携の問題分析、改善余地、自前 UI の選択肢
> Method: premiere-plugin/ 全ファイル精査、runtime/handoff/ FCP7 XML export/import 全実装読解、
>         timeline-ir.schema.json / render pipeline / NLE profile 分析、外部フォーマット仕様調査

---

## A. 現状の Premiere 連携の問題分析

### A-1. UXP プラグイン精査

**ファイル構成:**

```
premiere-plugin/
├── manifest.json   — UXP マニフェスト v5（Premiere Pro >=25.0.0）
├── index.html      — パネル UI（ダークテーマ、Browse/Watch/Stop）
├── index.js        — ロジック（ファイル監視 + 自動インポート）
└── README.md       — 使い方（日本語）
```

**結論: 実装としては動作する設計になっている。ただし制約あり。**

| 項目 | 状態 | 詳細 |
|------|------|------|
| マニフェスト | 正常 | `manifestVersion: 5`, `localFileSystem: fullAccess`, panel 型 |
| ファイル監視 | 実装済 | ポーリング (2000ms default) + ハッシュ比較で変更検知 |
| 自動インポート | 実装済 | `project.importFiles([path], true, rootItem, false)` — suppressUI=true |
| パラメータ設定 | **未実装** | インポートのみ。音量・エフェクト等の API 操作なし |
| 双方向同期 | **片方向のみ** | Agent→XML→Premiere の一方向。Premiere→XML→Agent はユーザー手動 |

**動作しない可能性の原因候補:**

1. **UXP Developer Tool でのサイドロードが必要** — Premiere の Extension Manager に自動表示されない
2. **FCP7 XML インポート API の挙動**: `project.importFiles()` は XML を「新規シーケンス」として読むため、既存シーケンスの更新（再インポート）にならない可能性
3. **ファイルパスの問題**: UXP の `localFileSystem` sandbox で `getFileForOpening()` が返す `entry` は sandbox 外のパスを指せるが、Premiere の `importFiles()` が nativePath を受理するか検証が必要
4. **v2.2 FCP7 roundtrip regression**: importer が XML comment をスキップできず 9 テスト失敗中（V22-01 で修正予定）— exporter 出力が壊れている可能性

### A-2. FCP7 XML パラメータマッピング一覧

#### 引き継げているもの (15 項目)

| timeline.json フィールド | FCP7 XML 要素 | 備考 |
|---|---|---|
| sequence.name | `<sequence><name>` | |
| sequence.fps_num/fps_den | `<rate><timebase>` + `<ntsc>` | NTSC 検出: den=1001 |
| sequence.width/height | `<samplecharacteristics>` | |
| clip.clip_id | `<clipitem id="cv-{id}">` | ASCII-safe 変換 |
| clip.motivation | `<clipitem><name>` | |
| clip.timeline_in_frame | `<start>` | |
| clip.timeline_duration_frames | `<end> - <start>` | |
| clip.src_in_us → frames | `<in>` | μs→フレーム変換 |
| clip.src_out_us → frames | `<out>` | μs→フレーム変換 |
| clip.asset_id | `<file id="file-N">` | ファイル参照 |
| ソースパス (sourceMap) | `<file><pathurl>` | percent-encoded |
| ファイル名 | `<file><name>` | |
| アセット尺 | `<file><duration>` | |
| audio_policy.duck_music_db | `<filter><effect>` Audio Levels | **唯一のオーディオパラメータ** |
| roundtrip metadata | `<marker><comment>` JSON | beat_id, asset_id, clip_id, motivation |

#### 引き継げていないもの (20+ 項目)

| パラメータ | 欠落の種類 | 影響度 |
|---|---|---|
| **audio_policy.nat_gain** | 未エクスポート | 高 — ナレーション音量が反映されない |
| **audio_policy.bgm_gain** | 未エクスポート | 高 — BGM バランスが欠落 |
| **audio_policy.fade_in/out_frames** | 未エクスポート | 高 — オーディオフェードなし |
| **audio_policy.nat_sound_fade_*_frames** | 未エクスポート | 中 |
| **audio_policy.bgm_fade_*_frames** | 未エクスポート | 中 |
| **transitions[].transition_type** | 未エクスポート | 高 — 全てハードカット |
| **transitions[].transition_params** | 未エクスポート | 高 — crossfade/zoom/J-cut 等なし |
| speed/time-remap | 未エクスポート | 中 |
| color corrections | スキーマにも無い | 低（意図的に対象外） |
| clip opacity/visibility | ハードコード TRUE | 低 |
| track enable/lock | ハードコード TRUE/FALSE | 低 |
| sequence-level markers | 未エクスポート | 中 |
| clip.segment_id | 未エクスポート | 低（marker JSON で部分的回復） |
| clip.confidence | 未エクスポート | 低 |
| clip.quality_flags | 未エクスポート | 低 |
| clip.metadata | 未エクスポート | 低 |

### A-3. レンダー結果との乖離

**核心的問題: レンダーパイプライン自体が未完成**

| パラメータ | timeline.json で定義 | レンダーで適用 | FCP7 XML で引継 | 乖離 |
|---|---|---|---|---|
| クリップ配置 | Yes | **Stub のみ** (assembly.mp4 前提) | Yes | レンダーが assembly.mp4 を要求するため timeline.json の配置は直接レンダーされない |
| アスペクト比 | Yes | Yes (ffmpeg scale+pad) | No | XML 側に sequence format はあるが letterbox_policy は無い |
| 字幕 burn-in | Yes (別ファイル) | Yes (ffmpeg subtitles) | No | XML にテキストオーバーレイは出せるが caption-approval.json とは別系統 |
| **audio duck** | Yes | **No** (bgmPath=undefined) | **duck_music_db のみ** | 3者間で全て異なる状態 |
| **audio fade** | Yes | **No** | **No** | 定義されているが誰も使わない |
| **transitions** | Yes (6種) | **No** | **No** | スキーマのみ存在 |
| BGM 合成 | Yes (audio_mix) | **No** (パス未接続) | No | パイプラインの FATAL バグ (impl-review-m4) |

**図解: 3 系統の乖離**

```
                   timeline.json が表現できるもの
                   ┌─────────────────────────────────┐
                   │ clips, transitions, audio_policy,│
                   │ markers, captions, audio_mix     │
                   └──────────┬──────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                  ▼
     Render Pipeline     FCP7 XML Export     理想状態
     ┌──────────┐       ┌───────────┐      ┌──────────┐
     │ aspect   │       │ clips     │      │ 全パラメ │
     │ captions │       │ duck_db   │      │ ータが   │
     │ (BGM ✗)  │       │ markers   │      │ 一致     │
     │ (fade ✗) │       │ (fade ✗)  │      │          │
     │ (trans ✗)│       │ (trans ✗) │      │          │
     └──────────┘       └───────────┘      └──────────┘
```

---

## B. NLE 連携の改善余地

### B-1. FCP7 XML で追加可能なパラメータ

FCP7 XML (xmeml v5) の DTD は以下をサポートしている:

| パラメータ | FCP7 XML 要素 | 実装難易度 | 効果 |
|---|---|---|---|
| **Audio Level (clip gain)** | `<filter><effect><effectid>audiolevels</effectid>` | 低 — 既に duck_music_db で部分実装済 | 高 |
| **Audio Level (track gain)** | `<track><outputchannelindex>` + filter | 中 | 高 |
| **Cross-dissolve** | `<transitionitem><effect><effectid>Cross Dissolve</effectid>` | 中 — clipitem 間に挿入 | 高 |
| **Dip to Black** | `<transitionitem><effect><effectid>Dip to Black</effectid>` | 中 | 中 |
| **Wipe transitions** | `<transitionitem><effect>` 各種 | 中 | 低 |
| **Audio cross-fade** | `<transitionitem>` on audio track | 中 | 高 |
| **Speed (constant)** | `<clipitem><rate><timebase>` 変更 or `<speed><reverse>` | 高 — フレーム計算が複雑に | 中 |
| **Markers** | `<marker><name><comment><in><out>` | 低 — 既に clip-level で実装済 | 中 |
| **Opacity** | `<filter><effect><effectid>opacity</effectid>` + keyframes | 高 | 低 |

**推奨追加: Audio Level + Cross-dissolve で投資対効果が最大**

### B-2. FCPXML (Final Cut Pro X format) の検討

| 観点 | FCP7 XML (xmeml v5) | FCPXML (v1.11+) |
|---|---|---|
| 対応 NLE | Premiere, DaVinci Resolve, Avid (import) | Final Cut Pro, DaVinci Resolve (native) |
| オーディオパラメータ | clip gain, filter chain | **role-based audio**, intrinsic gain, EQ |
| トランジション | transitionitem 要素 | **transition + timing 属性** (より精密) |
| Speed | 複雑 | **timeMap** 要素でフレーム単位 |
| カラー | effectid ベース（名前依存） | **Rec.709/HDR メタデータ** 対応 |
| ロール / レーン | track 番号のみ | **role / subrole** (editorial metadata) |
| 構造化 | フラットなトラック | **compound clip, synchronized clip** |

**結論: FCPXML は技術的に優位だが、Premiere Pro は FCPXML を直接読めない。**
DaVinci Resolve ユーザーには有効。Premiere ターゲットなら FCP7 XML の改善が現実的。

### B-3. AAF / OMF フォーマット

| フォーマット | 用途 | オーディオ精度 | 実装難易度 |
|---|---|---|---|
| **AAF (Advanced Authoring Format)** | Premiere ↔ Avid ↔ Pro Tools | 高 — clip gain, fade, pan, EQ | **極高** — バイナリフォーマット、SDK 必要 |
| **OMF (Open Media Framework)** | レガシー Pro Tools 連携 | 中 | **極高** — 非推奨、サポート終了 |
| **EDL (CMX 3600)** | シンプルなカット情報 | なし | 低 — テキストベース |

**結論: AAF は音声パラメータの精度は最高だが、実装コストが非現実的。**
バイナリフォーマットのためテキストベースの生成ができず、専用 SDK (OpenTimelineIO の AAF adapter 等) が必要。

### B-4. Premiere CEP/UXP API の限界

| API | できること | できないこと |
|---|---|---|
| **UXP (現行プラグイン)** | ファイルインポート、パネル UI | タイムライン直接操作、パラメータ設定 |
| **ExtendScript (レガシー)** | `app.project.activeSequence` のクリップ操作、エフェクト適用、マーカー追加、レンダー | UXP からの呼び出し不可（別ランタイム）|
| **Premiere Pro API (UXP v2 2025+)** | `premierepro.ProjectItem`, `Sequence`, `Track` | 文書が限定的、clip gain 設定は可能だがエフェクトチェーンは制約多 |

**双方向同期の技術的制約:**

1. **Premiere → Agent**: ユーザーが XML エクスポートを手動実行する必要がある。Premiere に「保存時自動エクスポート」フックは無い
2. **Agent → Premiere**: UXP `importFiles()` は新規シーケンスを作成する。既存シーケンスの「更新」は不可能
3. **リアルタイム同期**: Premiere の DOM にイベントリスナーを張る API は限定的。`onItemAdded` 等はあるが、クリップのトリム変更を検知する粒度のイベントは無い
4. **パラメータ逆引き**: Premiere から XML エクスポートした際、カスタムマーカーの `video_os:` メタデータは保持されるが、Premiere 側で追加した effect や gain は FCP7 XML に入る保証がない（Premiere のエクスポーターに依存）

---

## C. 自前エディタ UI の選択肢

### C-1. Web ベースタイムラインエディタの技術候補

| 技術 | 概要 | timeline.json 親和性 | 成熟度 |
|---|---|---|---|
| **React + Canvas** | 自前描画。fabric.js or konva.js でインタラクション | 高 — 直接マッピング可能 | 中 — UI を一から作る必要 |
| **React + wavesurfer.js** | 波形表示 + リージョン操作 | 中 — 音声トラック向き | 高 — 波形表示は成熟 |
| **Remotion Studio** | Remotion のプレビュー環境 | 高 — composition.ts を完成させれば直結 | 中 — 既に stub が存在 |
| **WebCodecs API** | ブラウザネイティブのフレーム操作 | 高 — 低レベルだが高速 | 中 — Chrome 限定 |
| **FFmpeg.wasm** | ブラウザ内 ffmpeg | 中 — プレビュー生成に使える | 中 — メモリ制約あり |

**既存 OSS タイムラインエディタ:**

| プロジェクト | 技術 | ライセンス | 評価 |
|---|---|---|---|
| **Editly** | Node.js + ffmpeg (headless) | MIT | 近いコンセプトだが UI なし |
| **OpenShot** | Python + Qt + C++ | GPL | デスクトップアプリ。組み込み困難 |
| **Kdenlive** | Qt + MLT Framework | GPL | 同上 |
| **LosslessCut** | Electron + ffmpeg | MIT | カット特化。タイムライン UI あり。参考になる |
| **Olive** | C++ + Qt + OpenGL | GPL | 本格 NLE。重すぎる |
| **Remotion** | React + Node.js | BSL | 動画生成特化。エディタ UI ではない |

### C-2. 必要最小限の機能スコープ (MVP)

```
┌─────────────────────────────────────────────────┐
│  Video OS Simple Editor (MVP)                    │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │ Preview Player (HTML5 <video> or Canvas)     │ │
│  │ [▶] [⏸] [◀◀] [▶▶]  00:00:15 / 00:01:30    │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │ Timeline                                     │ │
│  │ V1 [====clip1====][==clip2==][===clip3===]  │ │
│  │ A1 [====nat======][==nat===][===nat=====]   │ │
│  │ A2 [============bgm========================]│ │
│  │ C1 [--caption--]    [--caption--]           │ │
│  │ ◄━━━━━━━━━━━▶ playhead                      │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
│  Properties Panel:                               │
│  ├── Clip: clip1.mp4                             │
│  ├── In: 00:00:02.500  Out: 00:00:08.200       │
│  ├── Audio Level: -3.0 dB  [slider]            │
│  ├── Fade In: 12 frames   Fade Out: 12 frames  │
│  └── [Apply] [Save timeline.json]               │
│                                                  │
└─────────────────────────────────────────────────┘
```

**MVP 機能一覧:**

| 機能 | 重要度 | 実装難易度 | 備考 |
|---|---|---|---|
| タイムライン表示 (クリップ配置の可視化) | 必須 | 低 | Canvas or DOM ベース |
| プレビュー再生 | 必須 | 中 | assembly.mp4 をシーク or セグメントプロキシ |
| カット位置の微調整 (トリム) | 必須 | 中 | ドラッグで src_in/out_us を変更 |
| 音量スライダー (clip gain) | 必須 | 低 | audio_policy.duck_music_db 等を直接編集 |
| フェードイン/アウト設定 | 推奨 | 低 | audio_policy.fade_in/out_frames |
| プレイヘッド + フレーム単位シーク | 必須 | 中 | timeline_in_frame との同期 |
| timeline.json 直接保存 | 必須 | 低 | JSON.stringify + fs.write |
| 波形表示 | 推奨 | 中 | wavesurfer.js or Web Audio API |
| テロップ位置/タイミング調整 | 推奨 | 中 | caption track の overlay UI |
| クリップ並べ替え (ドラッグ) | 推奨 | 高 | timeline_in_frame の再計算 |
| トランジション設定 | 後回し | 高 | transitions[] への UI + プレビュー |
| Undo/Redo | 推奨 | 中 | timeline.json のスナップショット |

### C-3. フレームワーク選択

| 選択肢 | Pros | Cons | 推奨度 |
|---|---|---|---|
| **Web (Next.js + React)** | 既存エコシステムと一致、クロスプラットフォーム、デプロイ容易 | ファイルアクセスに制約（File API or サーバー経由）、大容量メディアのプレビューが重い | ★★★★ |
| **Electron** | Node.js フルアクセス、ffmpeg 直接呼び出し、ファイル I/O 自由 | バンドルサイズ大、配布の手間 | ★★★ |
| **Tauri** | 軽量、Rust バックエンド、低メモリ | Rust 学習コスト、Web ⇔ Rust ブリッジの手間 | ★★ |
| **Remotion Studio 拡張** | 既に stub がある (composition.ts)、プレビューと最終レンダーが統一 | Remotion のカスタム UI は制約あり、エディタ向きではない | ★★★ |

**推奨: Web (React) + ローカルサーバー (Node.js)**
- timeline.json を直接読み書きするローカル Express/Hono サーバー
- メディアファイルはサーバー経由で配信 (Range request 対応)
- React でタイムライン UI を構築
- `npm run editor` で起動する開発者向けツール

### C-4. timeline.json / OTIO との整合性

**timeline.json 直接操作のメリット:**

1. **変換ロス 0**: FCP7 XML 変換で失われるパラメータ (fade, transitions, 全 audio_policy) が全て保持される
2. **AI メタデータ保持**: confidence, quality_flags, beat_id, motivation 等の AI 固有フィールドがそのまま
3. **review-patch との統合**: エディタ操作を patch 形式で記録すれば、既存のレビューループと統合可能
4. **スキーマバリデーション**: 保存時に `timeline-ir.schema.json` で即座に検証

**OTIO との関係:**

- OTIO export は現在 stub (`exportOtio()` が空文字返却)
- 自前エディタは timeline.json ネイティブなので OTIO 不要
- OTIO は「他の NLE に渡すとき」の追加エクスポートオプションとして位置づければ良い

---

## D. 戦略的比較

| 観点 | NLE 連携改善 (FCP7 XML 拡張) | 自前エディタ UI | 両方組み合わせ |
|---|---|---|---|
| **開発コスト** | 低〜中 (2-4 週間) | 中〜高 (4-8 週間 MVP) | 高 (6-10 週間) |
| **ユーザー獲得** | プロ映像編集者にリーチ | Video OS ユーザーに閉じる | 両方にリーチ |
| **パラメータ精度** | FCP7 の制約内 (70-80%) | 100% (timeline.json 直接) | 最大 |
| **双方向同期** | 困難 (手動エクスポート必須) | 不要 (直接保存) | NLE 側は片方向のまま |
| **メンテナンス負荷** | 低 (XML 生成ロジック追加のみ) | 高 (UI + インタラクション) | 最高 |
| **プロユースの信頼性** | 高 (Premiere/Resolve が最終レンダー) | 低〜中 (独自レンダーの品質) | 高 |
| **学習コスト (ユーザー)** | 低 (既存 NLE スキル活用) | 中 (新ツールの習得) | 中 |
| **差別化** | 低 (他の XML ツールと同質) | 高 (AI 編集→即プレビュー→微調整) | 最高 |

---

## E. 技術的実現可能性 (1-5 段階)

| 施策 | 実現可能性 | 理由 |
|---|---|---|
| FCP7 XML に audio level (全 gain) を追加 | **5** | `<filter><effect>` の duck_music_db と同じパターン。既存コードの拡張で済む |
| FCP7 XML に cross-dissolve を追加 | **4** | `<transitionitem>` 要素の追加。フレーム計算が必要だが仕様は明確 |
| FCP7 XML に speed change を追加 | **3** | FCP7 の speed 表現は非直感的 (`<speed><reverse>` + 実効フレームレート変更) |
| FCPXML エクスポーター新規実装 | **3** | DaVinci Resolve 向け。XML 生成は可能だが Premiere では使えない |
| AAF エクスポーター | **1** | バイナリフォーマット。OTIO の AAF adapter 経由でも Python 依存で重い |
| UXP プラグインでパラメータ設定 | **2** | Premiere Pro UXP API のタイムライン操作は文書が乏しく不安定 |
| Premiere 双方向リアルタイム同期 | **1** | Adobe API に編集イベントのリアルタイムフックが無い |
| Web タイムライン UI (MVP) | **4** | React + Canvas + wavesurfer.js で実現可能。timeline.json 直接操作で変換不要 |
| Remotion ベースプレビュー統合 | **3** | composition.ts の stub を実装すれば可能だが、Remotion のカスタム UI は制約あり |
| Electron タイムラインエディタ | **4** | ffmpeg 直接呼び出し可能で自由度高いが、配布の手間 |

---

## F. 推奨戦略

### Phase 1: FCP7 XML 改善 (即効性・低コスト) — 2-3 週間

**目標: NLE 連携の「70% → 90%」引き上げ**

1. **V22-01 修正** (FCP7 roundtrip regression) — 既に計画済
2. **Audio Level 全パラメータの XML 出力**
   - `nat_gain`, `bgm_gain` → `<filter><effect><effectid>audiolevels</effectid>` (duck_music_db と同パターン)
   - `fade_in_frames`, `fade_out_frames` → Audio Levels のキーフレーム or `<transitionitem>` audio fade
3. **Cross-dissolve トランジション出力**
   - `transitions[].transition_type === "crossfade"` → `<transitionitem>` 要素
   - `crossfade_sec` → duration in frames
4. **Sequence-level markers 出力**
   - `timeline.markers[]` → `<sequence><marker>` 要素

**根拠:**
- 既存の duck_music_db 実装パターンを拡張するだけで、コード変更量は小さい
- NLE ユーザーへの即効性が高い
- roundtrip テストの基盤が既にある

### Phase 2: 簡易 Web エディタ MVP — 4-6 週間

**目標: timeline.json の直接可視化・微調整ツール**

```
video-os-v2-spec/
├── editor/                     # 新規ディレクトリ
│   ├── server.ts               # Express/Hono — timeline.json + media 配信
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Timeline.tsx    # Canvas ベースタイムライン
│   │   │   ├── Player.tsx      # HTML5 video プレビュー
│   │   │   ├── Properties.tsx  # クリップ属性パネル
│   │   │   └── Waveform.tsx    # wavesurfer.js 波形
│   │   └── hooks/
│   │       ├── useTimeline.ts  # timeline.json state management
│   │       └── usePlayback.ts  # playhead sync
│   └── package.json
```

**MVP スコープ:**
1. timeline.json 読み込み → タイムライン可視化
2. assembly.mp4 (or セグメントプロキシ) のプレビュー再生
3. クリップのトリム (src_in/out_us のドラッグ調整)
4. 音量スライダー (audio_policy 各フィールド)
5. フェードイン/アウト設定
6. 変更を timeline.json に直接保存
7. 変更を review-patch.json 形式でも出力可能

**根拠:**
- timeline.json を直接操作するため、パラメータ精度 100%
- FCP7 XML 変換の制約を完全にバイパス
- AI 編集 → プレビュー → 微調整 → AI 再編集 のループが最短
- `npm run editor` で起動するローカルツールなので配布不要

### Phase 3 (将来): Remotion レンダー統合

- composition.ts の stub を実装
- Web エディタのプレビューを Remotion コンポジションに統一
- timeline.json → React コンポーネント → リアルタイムプレビュー → 最終レンダー

---

## G. 次のアクションプラン

| # | アクション | 担当 | 優先度 | 前提 |
|---|---|---|---|---|
| 1 | V22-01 FCP7 roundtrip regression 修正 | 実装 | P0 | なし |
| 2 | FCP7 exporter に audio gain 全パラメータ追加 | 実装 | P1 | #1 |
| 3 | FCP7 exporter に cross-dissolve 追加 | 実装 | P1 | #1 |
| 4 | FCP7 exporter に sequence markers 追加 | 実装 | P2 | #1 |
| 5 | render pipeline の BGM パス接続修正 (impl-review-m4 FATAL 2) | 実装 | P0 | なし |
| 6 | Web エディタ MVP の技術検証 (PoC) | 調査 | P1 | なし |
| 7 | エディタ PoC: timeline.json → Canvas タイムライン描画 | 実装 | P1 | #6 |
| 8 | エディタ PoC: プレビュー再生 + playhead 同期 | 実装 | P1 | #7 |
| 9 | エディタ MVP: トリム + 音量 + 保存 | 実装 | P2 | #8 |
| 10 | FCPXML エクスポーター (DaVinci Resolve 向け) | 実装 | P3 | #2-4 |

---

## 付録: FCP7 XML audio level 実装パターン (参考)

現在の duck_music_db エクスポート (`fcp7-xml-export.ts`):

```xml
<filter>
  <effect>
    <name>Audio Levels</name>
    <effectid>audiolevels</effectid>
    <effectcategory>audio</effectcategory>
    <effecttype>audio</effecttype>
    <parameter>
      <parameterid>level</parameterid>
      <name>Level</name>
      <value>-4.0</value>  <!-- duck_music_db -->
    </parameter>
  </effect>
</filter>
```

nat_gain, bgm_gain も同じパターンで追加可能。fade はキーフレーム付きで:

```xml
<parameter>
  <parameterid>level</parameterid>
  <name>Level</name>
  <keyframe>
    <when>0</when>
    <value>-100</value>  <!-- fade in start: -inf dB -->
  </keyframe>
  <keyframe>
    <when>12</when>       <!-- fade_in_frames -->
    <value>0</value>      <!-- target level -->
  </keyframe>
</parameter>
```
