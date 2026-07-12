# ProgramMonitor / MP4 完全一致設計

## 文書情報
- 対象: Video OS エディタ `ProgramMonitor`
- 版: draft v1
- 作成日: 2026-04-04
- 対象コードベース: `video-os-v2-spec`

## 1. 目的
ProgramMonitor の表示と、レンダーパイプラインで最終的に書き出される MP4 を、同一タイムラインリビジョンに対して全要素で一致させる。

対象要素は以下の 5 系統とする。

1. 映像クリップ
2. トランジション
3. テロップ / キャプション / テキストオーバーレイ
4. オーディオ
5. カラー / エフェクト

## 2. 成功条件
この設計の成功条件は以下とする。

1. `timelineRevision` が一致する saved state に対して、ProgramMonitor の exact preview と最終 MP4 が同じ映像構成・同じ字幕構成・同じオーディオ処理結果になること。
2. exact preview が `source playback` や CSS オーバーレイを使わず、最終レンダーと同じレンダー仕様から生成された preview artifact を再生すること。
3. preview artifact と final artifact の差分が encode profile のみであり、合成仕様そのものは単一の `RenderSpec` から生成されること。
4. unsaved なローカル変更がある場合は ProgramMonitor が stale を明示し、exact ではなく approximate fallback であることを UI で明示できること。
5. フレーム比較・字幕比較・LUFS 比較を含む検証手段が定義され、CI で再現可能であること。

## 3. スコープ境界

### 3.1 やること
- preview と final の入力仕様を `TimelineIR + caption approval + blueprint + source map` から導出される単一 `RenderSpec` に統一する。
- ProgramMonitor の exact preview を、サーバー事前生成 preview MP4 再生へ切り替える。
- preview artifact と final render artifact の両方を同じ ffmpeg graph builder / subtitle style builder / audio mixing pipeline で生成する。
- CSS 字幕は approximate fallback 専用へ格下げし、exact preview の真実源泉から外す。
- `zoom` / `crop` / `position` / `transition` / `loudnorm` / `BGM` / `caption style` / `effects` を shared render path に寄せる。

### 3.2 やらないこと
- ブラウザだけで final render を完全再現すること。
- フレーム単位のリアルタイム server-side streaming preview。
- すべての NLE 向け高度エフェクトを Phase 1 から実装すること。
- unsaved ローカル変更に対して exact preview を即時保証すること。

### 3.3 明示的な前提
- exact parity の保証対象は「最新 saved timeline revision」に限る。
- preview artifact は final と同一の composition spec を使う。
- low-res proxy は exact parity を崩すため、ProgramMonitor の exact モードでは使わない。

### 3.4 依存関係
- server 実行環境に `ffmpeg` と `libass` が存在すること。
- preview / final の双方で同一フォントファイルを参照できること。
- `source_map.json` または `preview-manifest.json` から、render 対象 asset の実ソースパスを解決できること。
- exact preview の生成対象は保存済みタイムラインであり、editor 内メモリだけの未保存状態は含まないこと。

## 4. 現状の根本問題
現状は 1 つのタイムラインを 3 通りに再生 / 生成している。

1. エディタ ProgramMonitor
   `usePlayback` がソースメディアを clip 単位で直接シークし、`ProgramMonitor.tsx` が CSS で字幕を載せる。
2. preview API
   `editor/server/routes/preview.ts` が V1 clip を単純切り出しして `scale=-2:720` で preview MP4 を作る。
3. final render / package
   `runtime/render/assembler.ts` と `runtime/render/pipeline.ts` が別経路で assembly, caption burn, audio mix を処理する。

このため、以下が起きる。

1. ProgramMonitor は `metadata.zoom` を反映していない。
2. preview API は transition / subtitle burn / final audio mix を共有していない。
3. final render と preview API で字幕・オーディオ処理の実装が別。
4. `Export Render` は preview MP4 を生成するが、その `previewUrl` は ProgramMonitor 再生に接続されていない。

## 5. 方針比較

| 方針 | 一致性 | レイテンシ | 実装複雑度 | 運用負荷 | 現行資産との相性 | 評価 |
| --- | --- | --- | --- | --- | --- | --- |
| A: エディタ近似再現 | 低い | 低い | 中 | 低い | 高い | 不採用 |
| B: リアルタイム ffmpeg frame streaming | 高い | 高い | 非常に高い | 高い | 低い | 不採用 |
| C: ハイブリッド exact mode | 中〜高 | 中 | 中 | 中 | 中 | UX 方針としては有効 |
| D: 事前生成 preview artifact | 高い | 中 | 中 | 中 | 非常に高い | 推奨 |

### A を推奨しない理由
- CSS / `<video>` / Canvas で ffmpeg + libass + loudnorm + audio mixing を完全一致させるのは原理的に難しい。
- 一致対象が字幕だけでなくズーム、トランジション、音声処理まで含まれるため、近似路線では最終的に破綻する。

### B を推奨しない理由
- exact ではあるが、プレイヘッド移動やシャトルまで frame streaming で受ける設計は重すぎる。
- エディタ用途として server cost とレイテンシが釣り合わない。

### C の位置づけ
- UX としては必要。
- ただし C は「体験方針」であって、技術実装の核ではない。
- 核を A 側に置くと parity は得られず、核を B 側に置くと重すぎる。

### 推奨: D
推奨方針は D とする。

ただし、そのまま「低解像度 preview」を採ると字幕折返し、アウトライン太さ、クロップ位置、色補正後の見え方が final とズレる。したがって本設計では D を以下の形に修正して採用する。

1. ProgramMonitor exact モードは、server が事前生成した preview artifact を `<video>` で再生する。
2. preview artifact は final と同じ composition resolution で生成する。
3. 速度改善は「解像度を落とす」ではなく「encode preset / bitrate / cache / incremental invalidation」で稼ぐ。
4. low-res proxy は将来の scrub 用補助アセットとしては許可するが、exact preview の真実源泉にはしない。

結論として、推奨方針は「D を基軸にし、dirty 時の fallback UX は C 的に扱う」である。

## 6. 推奨アーキテクチャ

### 6.1 基本原則
1. final と preview は別実装にしない。
2. ProgramMonitor の exact preview は「最終 MP4 と同じ仕様で作られた preview artifact」だけを再生する。
3. CSS 字幕は editor fallback 用であり、exact preview のソースオブトゥルースではない。
4. すべての render input を `RenderSpec` に正規化してから ffmpeg graph を組む。

### 6.2 テキストアーキテクチャ図
```text
                        ┌──────────────────────────────┐
                        │  TimelineIR                  │
                        │  caption_approval.json       │
                        │  edit_blueprint.yaml         │
                        │  source_map / preview-manifest│
                        └──────────────┬───────────────┘
                                       │
                                       ▼
                        ┌──────────────────────────────┐
                        │ RenderSpec Builder           │
                        │ - clip trim normalization    │
                        │ - transform normalization    │
                        │ - transition expansion       │
                        │ - caption style resolution   │
                        │ - audio mix/master defaults  │
                        └──────────────┬───────────────┘
                                       │
                              RenderSpec + Hash
                                       │
                 ┌─────────────────────┴─────────────────────┐
                 │                                           │
                 ▼                                           ▼
   ┌──────────────────────────────┐            ┌──────────────────────────────┐
   │ Preview Render Job          │            │ Final Render Job            │
   │ profile=preview_exact       │            │ profile=final_delivery      │
   │ same composition resolution │            │ same composition resolution │
   │ faster encode preset        │            │ delivery encode profile     │
   └──────────────┬──────────────┘            └──────────────┬──────────────┘
                  │                                           │
                  ▼                                           ▼
   ┌──────────────────────────────┐            ┌──────────────────────────────┐
   │ 05_timeline/previews/...     │            │ 07_package/video/final.mp4   │
   │ preview.mp4 + preview.json   │            │ + captions + final_mix + QA  │
   └──────────────┬──────────────┘            └──────────────────────────────┘
                  │
                  ▼
   ┌──────────────────────────────┐
   │ ProgramMonitor               │
   │ exact: preview.mp4           │
   │ stale: source fallback       │
   └──────────────────────────────┘
```

### 6.3 ProgramMonitor の表示モード
ProgramMonitor の表示モードを以下に変更する。

1. `rendered_exact`
   preview artifact が current `renderSpecHash` と一致するとき。表示も音声も preview MP4 のみを使う。
2. `source_approx`
   dirty, preview rendering 中, preview 失敗時。現行の source playback + CSS overlay を使うが、stale badge を必ず表示する。
3. `none`
   source map も preview artifact も無いとき。

## 7. 単一仕様レイヤ: RenderSpec

### 7.1 目的
`TimelineIR` は editorial 構造を表すが、preview / final render に必要な情報は散在している。これを render-ready な単一仕様へ正規化する。

### 7.2 RenderSpec の責務
- trim / fps / source range の正規化
- `metadata.zoom` など legacy field の吸収
- transition の timeline overlap 展開
- caption / overlay cue の確定
- caption style preset の解決
- audio policy, bgm, mastering defaults の確定
- effect chain の順序確定
- hash 計算

### 7.3 代表型
```ts
interface RenderSpec {
  version: '1';
  timelineRevision: string;
  renderSpecHash: string;
  sequence: {
    fps: number;
    width: number;
    height: number;
    sampleRate: number;
    outputAspectRatio?: string;
    letterboxPolicy?: 'none' | 'pillarbox' | 'letterbox';
  };
  video: {
    clips: RenderVideoClip[];
    transitions: RenderTransition[];
  };
  text: {
    speechCaptions: RenderTextCue[];
    overlays: RenderTextCue[];
    stylePreset: CaptionStylePreset;
  };
  audio: {
    dialogueClips: RenderAudioClip[];
    bgm?: RenderBgmSpec;
    mastering: MasteringDefaults;
  };
  effects: RenderEffectSpec[];
}
```

### 7.4 互換方針
- 現行 `clip.metadata.zoom` は `metadata.transform.zoom.scale` に読み替える。
- 将来は `clip.metadata.render` を正式 field とし、`zoom` 単独値は移行期間のみサポートする。
- `transition_type` のうち未実装のものは `degraded` として明示的に cut 相当に落とし、preview と final で同じ degrade を使う。

## 8. スタイル定義の一元化

### 8.1 問題
現状は字幕スタイルが以下で分裂している。

1. ProgramMonitor の CSS inline style
2. `scripts/render-ax1-promo.ts` の `force_style`
3. `runtime/render/pipeline.ts` の素の `subtitles=...`

これでは exact parity は得られない。

### 8.2 設計
字幕 / テキストスタイルの真実源泉を `CaptionStylePreset` に統一する。

```ts
interface CaptionStylePreset {
  presetId: string;
  fontFamily: string;
  fontWeight: 400 | 700;
  fontSizePx1080: number;
  lineHeightPx1080: number;
  fillRgba: string;
  outlineRgba: string;
  outlinePx1080: number;
  shadowPx1080: number;
  alignment: 'bottom_center' | 'center' | 'top_center';
  marginV1080: number;
  maxWidthRatio: number;
  safeArea: { top: number; right: number; bottom: number; left: number };
}
```

### 8.3 実装原則
1. libass で表現できない装飾は preset に入れない。
2. exact preview は CSS でなく burn-in result を見る。
3. approximate fallback の CSS は `CaptionStylePreset` から生成する。
4. `force_style` は preset から自動生成する。手書き禁止。

### 8.4 生成物
- `buildAssForceStyle(preset, sequence)`
- `buildCssCaptionStyle(preset, sequence)`
- `buildTextOverlayLayout(preset, cue)`

## 9. 各要素の具体実装

### 9.1 映像クリップ

#### 入力
- `src_in_us`
- `src_out_us`
- `timeline_in_frame`
- `timeline_duration_frames`
- `sequence.width/height`
- `clip.metadata.zoom`
- 将来の `clip.metadata.render.transform`

#### 実装
1. `RenderSpec Builder` が clip ごとに `RenderVideoClip` を生成する。
2. 変換は以下の順で固定する。
   1. trim
   2. scale to cover / contain
   3. crop
   4. translate
   5. color / effect
   6. format / setsar
3. `zoom` は P0 では center anchor のみサポートする。
4. `crop/position` は将来の structured transform に備えて `metadata.render.transform` へ昇格する。
5. preview / final ともに同じ filter fragment builder を使う。

#### 推奨型
```ts
interface RenderVideoClip {
  clipId: string;
  assetId: string;
  sourcePath: string;
  timelineInFrame: number;
  durationFrames: number;
  sourceInSec: number;
  sourceOutSec: number;
  transform: {
    mode: 'cover';
    zoom: number;
    anchor: 'center';
    crop?: { x: number; y: number; width: number; height: number };
    position?: { x: number; y: number };
  };
  effects: RenderEffectSpec[];
}
```

#### 注意点
- preview だけ 720p に落とすと字幕位置も crop もズレるため、exact preview では sequence resolution を維持する。
- `runtime/render/assembler.ts` の現在の `buildAspectRatioFitFilter()` だけでは parity 不足。

### 9.2 トランジション

#### 現状
- schema には `transitions[]` がある。
- preview API も assembler も活用していない。

#### P0 サポート範囲
1. `cut`
2. `crossfade`
3. `fade_to_black`
4. `j_cut`
5. `l_cut`

`match_cut` は P0 では effect でなく semantic marker として扱い、実描画は cut に degrade する。

#### 実装
1. `RenderSpec Builder` が transition を adjacency 単位で正規化する。
2. video graph builder が `xfade` / `fade` を構成する。
3. audio graph builder が `acrossfade`, `adelay`, `volume envelope` を構成する。
4. `transition_frames` と `transition_params.crossfade_sec` は fps から片方に正規化する。
5. preview / final は同じ transition builder を使う。

#### 受け入れ条件
- transition middle frame が preview / final で一致する。
- overlap duration が frame 単位で一致する。

### 9.3 テロップ / キャプション

#### 現状
- ProgramMonitor は CSS overlay。
- final render は ffmpeg subtitles。

#### 実装
1. `caption_approval.json` の `speech_captions` と `text_overlays` を `RenderSpec.text` へ投影する。
2. exact preview では preview artifact 側に burn-in する。
3. ProgramMonitor 側の CSS caption overlay は `source_approx` 専用に限定する。
4. line-break は existing approval result を尊重し、render path で再折返ししない。
5. ASS style と CSS style は `CaptionStylePreset` から生成する。
6. `delivery_mode=sidecar` の場合、exact preview では burn-in しない。

#### CSS / libass 差異最小化策
1. source of truth を CSS でなく preset に置く。
2. exact preview は burn-in 済み映像を見る。
3. approximate fallback は preset 由来 CSS を使う。
4. editor で使う style subset は libass 互換プロパティに限定する。

### 9.4 オーディオ

#### 現状
- preview API は簡易 `loudnorm` のみ。
- final path は `runtime/audio/mixer.ts` と `mastering.ts` を持つ。

#### 実装
1. preview でも final と同じ `mixAudio()` と `masterAudio()` を使う。
2. `AudioPolicy` は preview / final どちらでも同じ解釈に統一する。
3. BGM, ducking, nat gain, fade を shared audio plan へ投影する。
4. exact preview の audio stream を ProgramMonitor 再生音とする。

#### 重要方針
- exact preview で 2-pass mastering を省略しない。
- 省略すると LUFS が final とズレるため、D を選ぶ意味が薄れる。

### 9.5 カラー / エフェクト

#### 現状
- 明示的な共通モデルがない。

#### 実装
1. `clip.metadata.render.effects[]` を追加し、render path はその配列順に適用する。
2. P0 では `none` / `eq` / `curves` など ffmpeg native filter だけ許可する。
3. preview / final は同一 filter serialization を使う。
4. unsupported effect は render error にせず degrade とし、preview metadata に警告を記録する。

## 10. ProgramMonitor / API / ジョブ制御

### 10.1 preview artifact
preview artifact は MP4 本体と metadata JSON のペアとする。

```ts
interface PreviewArtifactMeta {
  renderSpecHash: string;
  timelineRevision: string;
  sequence: { width: number; height: number; fps: number };
  generatedAt: string;
  status: 'ready' | 'rendering' | 'error';
  warnings: string[];
  videoPath: string;
}
```

### 10.2 生成トリガー
1. timeline save 完了後
2. caption approval 更新後
3. blueprint caption/audio policy 更新後
4. AI compile / review apply 完了後

### 10.3 ジョブ制御
1. project 単位 single-flight
2. 新しい revision が来たら旧 job は cancel 可能なら cancel、不可なら結果破棄
3. artifact path は `renderSpecHash` 基準
4. `render.changed` websocket で ready/error を通知

### 10.4 ProgramMonitor の挙動
1. `usePlayback` は current `timelineRevision` と `renderSpecHash` を持つ。
2. exact artifact が ready で hash 一致なら preview MP4 を `video.src` に設定する。
3. dirty になったら `previewStale=true`、source fallback へ切り替える。
4. save 完了後に preview render を自動要求する。
5. preview ready 通知を受けたら、現在の playheadFrame を維持したまま exact preview へ戻す。

### 10.5 既存 API の扱い
既存 `POST /api/projects/:id/preview` は以下に再定義する。

1. `mode=full` は shared renderer による exact preview job 作成
2. `mode=range` / `mode=clip` は将来の spot preview 用として残すが、同じ `RenderSpec` 経由にする
3. 返り値には `previewUrl` だけでなく `renderSpecHash` と `status` を含める

推奨 API 契約は以下とする。

```ts
POST /api/projects/:id/preview
Request {
  mode: 'full' | 'range' | 'clip';
  timelineRevision: string;
  startFrame?: number;
  endFrame?: number;
  clipId?: string;
}

Response {
  status: 'queued' | 'rendering' | 'ready' | 'error';
  timelineRevision: string;
  renderSpecHash: string;
  previewUrl?: string;
  warnings?: string[];
  error?: string;
}

GET /api/projects/:id/preview/status
Response {
  timelineRevision: string | null;
  renderSpecHash: string | null;
  status: 'idle' | 'rendering' | 'ready' | 'error';
  previewUrl?: string;
  warnings?: string[];
  error?: string;
}
```

## 11. 変更が必要なファイル一覧

### 11.1 既存ファイル
- `editor/client/src/components/ProgramMonitor.tsx`
  exact preview 時は CSS caption overlay を描画しない。stale badge と mode badge を追加。
- `editor/client/src/components/PreviewPlayer.tsx`
  source / rendered_exact / none を扱うように変更。preview URL 再生を追加。
- `editor/client/src/hooks/usePlayback.ts`
  preview artifact state, renderSpecHash, websocket 連携, preview fallback 制御を追加。
- `editor/client/src/App.tsx`
  save 後の auto preview refresh, render.changed 連携を整理。
- `editor/client/src/hooks/useProjectSync.ts`
  `render.changed` payload の `status`, `timelineRevision`, `renderSpecHash` を扱う。
- `editor/client/src/types.ts`
  preview artifact metadata 型と preview mode 型を拡張。
- `editor/server/routes/preview.ts`
  単純切り出し実装を廃止し、shared renderer を呼ぶジョブ API へ差し替え。
- `editor/server/index.ts`
  preview status / render.changed の配線を維持しつつ preview job service を組み込む。
- `editor/server/services/watch-hub.ts`
  preview ready / error 通知に `timelineRevision` と `renderSpecHash` を載せる。
- `runtime/render/assembler.ts`
  clip trim primitive 専用へ責務を縮退するか、RenderSpec ベース segment builder へ再編する。
- `runtime/render/pipeline.ts`
  preview / final 共通 orchestration に整理し、caption/audio/effects を shared path 化。
- `runtime/audio/mixer.ts`
  preview / final 共通の audio plan 入力を受けられるよう境界を明確化する。
- `runtime/audio/mastering.ts`
  preview / final 共通 mastering default の供給源として使用する。
- `runtime/commands/package.ts`
  preview と final で同じ RenderSpec builder / render entrypoint を使うよう変更。
- `scripts/render-ax1-promo.ts`
  手書き `force_style` / zoom filter を shared helper 呼び出しへ移行するか、example-only として凍結。

### 11.2 新規ファイル
- `editor/shared/render-spec.ts`
  canonical `RenderSpec`, hash helper, preview artifact metadata。
- `editor/shared/caption-style-tokens.ts`
  `CaptionStylePreset`, ASS/CSS builder。
- `editor/server/services/preview-job-service.ts`
  single-flight queue, cancel, cache, state 管理。
- `runtime/render/spec-builder.ts`
  `TimelineIR + caption approval + blueprint + source map -> RenderSpec`。
- `runtime/render/filtergraph.ts`
  video/audio/transitions/effects の ffmpeg graph builder。
- `runtime/render/subtitles.ts`
  ASS / SRT / overlay cue builder。
- `runtime/render/profiles.ts`
  preview_exact / final_delivery encode profile 定義。

## 12. フェーズ分け

### Phase 1: 経路統一
目的: exact preview を ProgramMonitor へ接続する。

1. `RenderSpec` と `renderSpecHash` を導入
2. preview artifact metadata を導入
3. ProgramMonitor が preview MP4 を再生できるようにする
4. dirty / stale / ready のモード遷移を実装する

完了条件
- preview API が返した artifact を ProgramMonitor が再生する
- `Export Render` ボタン押下で exact preview へ切り替わる

### Phase 2: 映像 parity
目的: trim / zoom / aspect / crop / position を shared renderer 化する。

1. `metadata.zoom` を RenderSpec transform へ正規化
2. shared video filter builder を導入
3. preview / final が同じ video filter fragment を使うようにする

完了条件
- sample timeline のズームフレームが preview / final で一致

### Phase 3: 字幕 parity
目的: CSS/ASS の分裂を止める。

1. style token を導入
2. preview exact では CSS overlay を停止
3. ASS / CSS builder を shared 化

完了条件
- caption content / position / outline が preview / final で一致

### Phase 4: transition と audio parity
目的: 切替効果と音を shared 化する。

1. shared transition builder
2. `mixAudio()` / `masterAudio()` を preview にも適用
3. `AudioPolicy` の解釈を preview / final で統一

完了条件
- crossfade middle frame と LUFS が preview / final で一致

### Phase 5: color/effects と QA
目的: 最終仕上げと CI 検証。

1. effect chain を shared 化
2. parity test を追加
3. preview cache cleanup と telemetry を追加

完了条件
- parity CI が通る
- preview generation failure が UI と log で追跡できる

## 13. テスト戦略と受け入れ条件

### 13.1 単体テスト
- `RenderSpec Builder` が `metadata.zoom`, `AudioPolicy`, `transitions[]`, `caption_policy` を正しく正規化する。
- `CaptionStylePreset` から ASS/CSS が正しく生成される。
- transition builder が overlap / offset を frame 単位で正しく計算する。

### 13.2 統合テスト
- preview route が shared renderer を呼び、`preview.json` に `renderSpecHash` を書く。
- package command が同じ `renderSpecHash` の spec から final render を生成する。

### 13.3 parity テスト
代表フレームを抽出して比較する。

1. 各 clip の先頭
2. 各 clip の中間
3. 各 transition の中間
4. caption on/off 境界

判定基準
- frame hash または SSIM >= 0.999
- caption text と cue timing 完全一致
- integrated LUFS 差 <= 0.1 LU
- true peak 差 <= 0.2 dBTP

### 13.4 E2E
- dirty 編集後に stale badge が出る
- save 後 preview render が自動起動する
- ready 後 exact preview へ戻る
- seek / play / pause / end で playhead が timeline frame に一致する

## 14. 非機能要件

### 14.1 性能
- preview render は project 単位 single-flight
- 同一 `renderSpecHash` の再生成を避ける
- encode preset は preview で高速化してよいが、composition resolution は変えない

### 14.2 信頼性
- preview artifact metadata が hash 不一致なら exact 扱いしない
- preview render failure 時は source fallback へ戻し、error を明示する
- final render は preview の有無に依存しない

### 14.3 保守性
- ffmpeg graph string の手書き散在をやめ、builder に集約する
- style token と mastering default を定数化する

### 14.4 セキュリティ
- preview artifact serve は現状と同じく path traversal を防ぐ
- server job は safeProjectDir 配下のみを扱う

## 15. 運用・監視・移行

### 15.1 監視
- project ごとに `preview.last_requested_at`, `preview.last_completed_at`, `preview.last_error` を持つ
- render.changed に `status`, `timelineRevision`, `renderSpecHash` を含める

### 15.2 キャッシュ掃除
- `05_timeline/previews/` 以下は最新 N 世代だけ保持する
- orphan artifact は起動時または定期掃除で削除する

### 15.3 段階移行
1. feature flag `programMonitorExactPreview`
2. preview exact を opt-in で有効化
3. parity test 安定後に default on

### 15.4 ロールバック
- flag off で現行 source playback に即戻せる
- final render path は Phase 2 完了までは既存 package path を温存する

## 16. 既知の制約・リスク

1. unsaved timeline に対する exact parity は保証しない。
   exact preview の保証対象は saved revision のみ。
2. low-res preview は parity を崩す。
   したがって ProgramMonitor exact では採用しない。
3. `match_cut` など意味論的 transition は P0 で degrade される。
4. libass に存在しない CSS 装飾は preset に載せられない。
5. 2-pass mastering を preview にも使うため、preview 完成までの待ち時間は残る。
6. 既存 `runtime/render/assembler.ts` と `editor/server/routes/preview.ts` の責務整理を誤ると、重複実装が再発する。

## 17. 最終提案
推奨方針は D とする。

ただし実体は「同一 RenderSpec から server が preview artifact を事前生成し、ProgramMonitor exact モードではその artifact を再生する」構成である。これにより、ズーム、トランジション、字幕、音声、カラー / エフェクトを browser 近似再現ではなく shared renderer の責務に戻せる。

UX 上は dirty 時の source fallback を残すが、それは exact preview の代替ではなく「preview 再生成完了までの暫定表示」と位置づける。ProgramMonitor を最終 MP4 の信頼できる検証面にしたいなら、この責務の切り分けが必要である。
