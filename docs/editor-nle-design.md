# Video OS v2 — Editor NLE-Grade UI 再設計書

> Date: 2026-03-27
> Status: Proposed
> Scope: `editor/` を MVP UI から、プロ編集者が違和感なく使える NLE グレードの編集 UI へ再設計する
> Authority:
> - sync / save / lock / watcher / `timeline.json` canonical rule は `docs/editor-v3-design.md` を正本とする
> - AI artifact / review / patch / alternatives の意味論は `docs/editor-ai-workflow-design.md` を継承する
> - 本書は UI / interaction / panel choreography / timeline editing UX の正本とする

---

## 0. 目的と成功条件

### 0-1. 目的

Video OS v2 Editor を、AI が生成した粗編集を人間が即座にファインチューンできる「AI ネイティブな NLE」に引き上げる。

思想は Cursor モデルを採る。

- ベースは Premiere Pro / DaVinci Resolve / Final Cut Pro に学んだ標準的 NLE レイアウト
- その上に AI の review / alternatives / patch / compile / render を重ねる
- AI 機能は編集の主線を邪魔せず、必要時に前面化する
- 将来は Agent Mode を追加できるが、今回の主対象は Human-in-the-loop の NLE Mode / AI Mode である

### 0-2. モード概念

#### NLE Mode

- 既定モード
- Source Monitor / Program Monitor / Timeline / Inspector を主画面に固定
- AI 情報は控えめなバッジ、オーバーレイ、CommandBar に抑える
- 編集者が trim / shuttle / cut / replace に集中する

#### AI Mode

- 同一画面の workspace preset
- 右 dock を Inspector 優先から AI Workspace 優先へ切り替える
- Timeline 上に confidence / weakness / patch / diff を強く出す
- alternatives / patch approval / review rationale / compile trigger を一連のフローとして見せる

#### Future: Agent Mode

- 今回は UI contract のみ確保する
- AI が変更案を staging queue に積み、人間が承認する
- save / lock / revision contract は NLE Mode / AI Mode と同一

### 0-3. 成功条件

以下を満たしたら本設計は成功とみなす。

1. 映像編集経験者が初見でも迷わず、Source / Program / Timeline / Inspector の位置関係に違和感を持たない。
2. AI が生成した `timeline.json` を開いて 10 秒以内に trim / J-cut / L-cut / replace / review approval を始められる。
3. Ripple / Roll / Slip / Slide が視覚的にもキーボード的にも一貫し、フレーム単位の微調整が可能である。
4. JKL シャトル、I/O、フレームステップ、トリムプレビューが NLE 的に連携し、粗編集の確認と微調整が往復しやすい。
5. AI 機能は別画面ではなく同じ editor shell 内で完結し、Compile / Review / Render の起動と結果確認が中断なく行える。
6. `timeline.json` canonical、`ETag` / `If-Match`、WebSocket 同期、advisory lock は `editor-v3-design.md` と矛盾しない。

### 0-4. スコープ境界

#### 今回やること

- NLE グレードの画面レイアウト再設計
- タイムライン編集 UX の再定義
- 精密トリム、J/L cut、波形、JKL、Source / Program 2画面の定義
- AI panel 群の NLE との共存設計
- 現行コードベースに落とすための実装フェーズ分解

#### 今回やらないこと

- CRDT/OT による同時多人編集
- ブラウザ内フルレンダラーによる最終画質プレビュー
- トラックレスの完全な FCP 風 magnetic timeline への移行
- timeline canonical source を `timeline.json` 以外へ変えること
- AI による無承認自動編集の本実装

---

## 1. レイアウト設計

### 1-1. 基本レイアウト

標準レイアウトは 4 分割を基本とする。

```text
┌──────────────────────────────────────────────────────────────────────┬───────────────┐
│ Source Monitor                   │ Program Monitor                  │ Inspector /   │
│ source preview + I/O             │ timeline playback + trim preview │ AI Workspace  │
├──────────────────────────────────────────────────────────────────────┼───────────────┤
│ Timeline Toolbar / Track Header / Time Ruler / Tracks / Dock                       │
│ Timeline                                                                   Dock      │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

推奨グリッド:

- 上段左: Source Monitor
- 上段中央: Program Monitor
- 右列: Inspector or AI Workspace
- 下段: Timeline + docked panels

### 1-2. パネル構成

#### 上部ヘッダ

- Project selector
- Save state
- Mode toggle: `NLE | AI`
- CommandBar trigger
- transport summary
- sync / lock / dirty status

#### 競合導線

- dirty 中に remote revision を受信した場合、または save / patch / run start のいずれかが `409 Conflict` を返した場合、v3 正本に合わせて `MergeDialog` を即時表示する
- ヘッダ直下の merge banner は informational のみとし、`local revision`, `remote revision`, `dirty/conflict state` を見せるが、解決操作は置かない
- `MergeDialog` は session baseline 差分、local changes summary、remote changes summary を固定表示し、v3 と同じく auto-merge は許可しない
- `MergeDialog` の解決操作は `Reload Remote`, `Keep Local (stay dirty)`, `Compare First` の 3 つに固定する
- `Compare First` は `MergeDialog` 内から下段 dock の `Diff` tab を `Local vs Remote` 比較モードで前面化する

#### 右 dock

- NLE Mode: Inspector が主、AI 情報は折りたたみセクション
- AI Mode: AI Workspace が主、Inspector はタブへ退避

#### 下段 dock

- Timeline は常時表示
- Dock tabs は `Timeline`, `Patches`, `Alternatives`, `Diff`, `Review`
- NLE Mode では dock 高さを低めに保ち、Timeline 面積を優先
- AI Mode では dock を拡張し、review / diff / patch を即参照できる

### 1-3. リサイズ・最小化

- Source / Program の境界はドラッグで比率変更可能
- 右 dock は `320px - 480px` の間でリサイズ可能
- Timeline 高さは `280px` を下限に上方向へ拡大可能
- Source / Inspector / AI Workspace は最小化できる
- Program Monitor は最小化不可
- 最小化状態でもヘッダ内に reopen affordance を残す

### 1-4. NLE Mode と AI Mode の表示差分

| 領域 | NLE Mode | AI Mode |
|---|---|---|
| Timeline overlay | playhead, markers, selection, trim guide を優先 | confidence, patch, diff, review warnings を追加表示 |
| 右 dock | Inspector 主体 | AI Workspace 主体 |
| CommandBar | compact buttons + status | command palette + job history + blocking issues |
| クリップ表示 | clip label / waveform / trim handles が主 | confidence badge / weakness outline / alternative availability を強調 |
| 下段 dock | 初期タブは Timeline | 初期タブは Review または Patches |

### 1-5. レスポンシブ考慮

サポート下限は `1280px` とする。

#### 1600px 以上

- Source / Program を同時表示
- 右 dock 常時表示
- Timeline と dock の両方に十分な高さを確保

#### 1280px - 1599px

- Source / Program は 2 画面維持
- 右 dock は overlay collapse 可能
- AI Mode では Source Monitor を tab 化して Program と切り替えることを許容

#### 1280px 未満

- 編集品質を保証しない
- 横幅不足 warning を表示
- Source / Program の片側 tab 化のみで暫定表示
- 保存や再生はできても、精密トリム用途では非推奨と明示する

---

## 2. タイムライン詳細設計

### 2-1. トラック構造

UI は明示トラック型を維持する。
Final Cut Pro 的な磁力補助は `magnetic assist` として別モードに分離し、通常の NLE 既定挙動は Premiere / Resolve ライクな sync-lock ベースに固定する。

- Video tracks: `V1`, `V2`, `V3`...
- Audio tracks: `A1`, `A2`, `A3`...
- `V1` は既定の picture lane だが、ripple 伝播や gap close の特例は持たない
- `A1` は dialogue / nat の主音声 lane を推奨するが、同期基準 track ではない
- linked V/A pair は別トラック上に存在しても 1 つの編集単位として選択可能

トラックヘッダに持つ操作:

- lock
- mute
- solo
- sync-lock
- visibility/video enable
- track height preset: `S`, `M`, `L`, `XL`

### 2-2. クリップ表示

クリップはズームレベルに応じて情報密度を変える。

#### Video clip

- filmstrip thumbnail
- clip label
- beat / role
- confidence badge
- quality flag / warning indicator
- link badge when paired audio exists

#### Audio clip

- waveform
- clip label
- dialogue / nat / bgm の色分け
- J/L cut offset badge

#### 共通

- selected / primary selected / linked-selected の視覚差
- AI review weakness は赤、warning は黄、patch suggestion は op type ごとの色で輪郭表示
- trimmed edge は glow ではなく edit-point 強調線で見せる

### 2-3. 色とラベルルール

- トラック色は lane 固定でなく clip role ベース + track tint を合成
- `confidence >= 0.8` 緑、`>= 0.6` 黄、`< 0.6` 赤
- warning / weakness / patch は clip fill を塗り替えず border / top-band で示す
- AI 情報は編集視認性を阻害しないことを優先する

### 2-4. ルーラー

- 上段に time ruler を常時表示
- 表示は `Sequence.timecode_format` に従う
- `DF` は `HH:MM:SS;FF`
- `NDF` は `HH:MM:SS:FF`
- `AUTO` は `29.97` / `59.94` 系のみ DF 推奨を表示し、sequence 設定を優先する
- zoom に応じて major / minor tick を切り替える
- loop range / I/O range / playhead / markers を ruler 上に重ねる

### 2-5. 磁石スナップ

スナップ対象:

- playhead
- clip start / end
- trim edit point
- markers
- sequence In / Out
- linked pair の相手 edit point

仕様:

- snap 閾値は `6px` または `3 frames` の小さい方
- `S` で snap 全体を toggle
- modifier 押下中は一時的に snap 無効化
- snap 成立時は縦ガイド + timecode tooltip を表示

### 2-6. マルチセレクト

- click: 単一選択
- `Shift+click`: 範囲追加
- `Cmd/Ctrl+click`: 個別追加 / 除外
- drag marquee: 範囲選択
- linked selection が ON の場合、V/A pair はまとめて選ばれる
- multi-select 時の Inspector は batch edit 可能項目のみ表示

### 2-7. トラック操作

トラックヘッダ操作は editor-local workspace state として扱う。canonical との境界は 8-6 に定義する。

- lock: その track への edit / trim / insert / overwrite を client で禁止する。patch apply への作用は 5-6 の client preflight に従う
- mute: その audio track を playback mix から除外する
- solo: solo が 1 本以上ある場合、solo track のみを再生対象にする
- sync-lock: ripple trim / insert の伝播対象に参加する
- visibility / video enable: Program Monitor 上の描画参加を切り替える
- height change: waveform / filmstrip 解像度を連動変更する
- track target: Source からの Insert / Overwrite の destination arm を切り替える

track target UI:

- 各 `Vn` / `An` ヘッダに target toggle を置く
- video target は常に 1 本だけ active。既定は `V1`
- audio target は 0 本以上 active。既定は `A1`
- armed state は editor-local persisted workspace state として保持し、`timeline.json` には保存しない

source patch matrix:

- Source payload は `SV1` と `SA1...n` の patch rows に正規化して扱う
- stereo pair は 1 つの `SAx` row として扱い、row 単位で target audio track へ送る
- `SV1 -> active video target`
- `SA1...n -> active audio targets` を画面上の上から順に 1:1 で割り当てる
- `source audio rows <= active audio targets` の場合、先頭から source row 数ぶんだけ割り当て、余剰 target は無視する
- `source audio rows > active audio targets` の場合、Insert / Overwrite は block し、不足 target を UI で示す
- video-only source は `SV1` のみを適用し、audio patch rows を無視する
- audio-only source は `SA1...n` のみを適用し、video target を要求しない

### 2-8. 波形表示

- 音声 track では clip 内 waveform を常時描画
- 低 zoom では envelope 近似、中 zoom では mono peaks、高 zoom では左右チャンネル差も表現可能
- linked video clip を選択したとき、対応 audio clip もハイライトされる
- waveform は track height `M` 以上で full 表示、`S` では simplified envelope に落とす

---

## 3. トリム設計

### 3-1. トリムの基本原則

- トリムは `Selection Tool` と別に `Trim Tool Context` を持つ
- active trim target は clip 自体ではなく edit point である
- mouse と keyboard は常に同じ underlying operation を叩く
- trim 中は playhead と monitor が trim preview モードへ入る

### 3-2. トリムモード

| モード | 主作用 | シーケンス長 | 典型用途 |
|---|---|---|---|
| Ripple | edit point を動かし、後続を詰める/押す | 変わる | 尺詰め、無音削減 |
| Roll | 隣接 2 クリップの cut point を動かす | 変わらない | cut timing 微調整 |
| Slip | clip の timeline 位置を固定し source in/out をずらす | 変わらない | 良い瞬間を同尺で探す |
| Slide | clip を前後へ滑らせ、両隣を補正する | 変わらない | 構成位置だけ変えたい |

### 3-3. Ripple Trim

仕様:

- ripple の伝播境界は edit point で決め、`V1` / `A1` の primary 特例は持たない
- head ripple / tail ripple ともに、edited track の downstream material を delta 分だけシフトする
- 他 track への伝播は `sync-lock === ON` かつ `lock === OFF` の track のみに限る
- ripple 参加 track で edit point をまたぐ clip がある場合は、その位置で split した上で downstream 側だけをシフトする
- `sync-lock === OFF` の track は絶対時間を維持し、結果として非同期になることを許容する
- magnetic assist は opt-in の editor-local mode とし、既定 OFF。通常 NLE モードでは ripple / sync-lock の結果以外で gap close しない
- linked V/A pair は linked selection ON なら同時 ripple、`Option` で片側だけ ripple

### 3-4. Roll Trim

仕様:

- 選択した edit point の前後クリップを同時に更新
- シーケンス長は変えない
- 隣接 clip が存在しない場合は roll 不可
- linked V/A pair は対応する相手 edit point にも preview line を出す

### 3-5. Slip Trim

仕様:

- clip の `timeline_in_frame` と `timeline_duration_frames` は不変
- `src_in_us` / `src_out_us` のみ変える
- source の範囲外には出られない
- Source Monitor は slipped source の in/out を、Program Monitor は前後つながりを見せる

### 3-6. Slide Trim

仕様:

- clip 本体を timeline 上で移動
- 前後クリップの end / start を対称に補正
- 対象 clip の尺は不変
- 隣接 clip が不足する場合は slide 不可

### 3-7. トリムモード切替 UI

提供場所:

- timeline toolbar
- clip context menu
- keyboard shortcut

既定:

- pointer hover では edge cursor を見せるが、操作結果は active trim mode に従う
- 初期モードは `Selection`

推奨ショートカット:

- `A`: Selection
- `B`: Ripple
- `N`: Roll
- `Y`: Slip
- `U`: Slide

### 3-8. J-cut / L-cut 用の独立 V/A トリム

J/L cut は UI の最重要差別化機能とする。

#### 表現

- linked V/A pair は細い link line と同色 badge で結ぶ
- 同期している場合は unified outline
- オフセットがある場合は `J +12f` / `L +08f` のような badge を表示

#### 操作

- clip 選択時、video と audio に別々の trim handles を表示
- linked selection ON では両方選択されるが、`Option` 押下で片側のみ操作
- `Cmd/Ctrl+L` で link / unlink
- `Shift+L` で linked selection toggle

#### 保存方針

- canonical は従来どおり `timeline.json`
- V/A は別 clip として保持
- durable な pair 関係の正本は `clip.metadata.link_group_id` とする
- 同じ `link_group_id` を共有する video / audio clips 群を 1 つの linked group とみなし、link / unlink はこの値を更新する
- `segment_id` + timeline overlap は legacy timeline 読み込み時の bootstrap heuristic に限定し、trim / relink / save の正本には使わない
- `transitions.transition_type = j_cut | l_cut` は表示や export のための derived annotation とし、リンク解決の正本にはしない

### 3-9. トリムプレビュー

trim 中は monitors が trim preview に切り替わる。

#### Ripple / Roll

- left pane: outgoing frame
- right pane: incoming frame
- 中央に delta frames

#### Slip

- Source Monitor: slipped in/out
- Program Monitor: before / after のつながり

#### Slide

- Program Monitor を 3 面 preview にし、前後の影響範囲を見せる

補助表示:

- 現在 frame
- delta `+/-nf`
- snap target 名

### 3-10. キーボードトリム

active trim target がある時:

- `,`: -1 frame
- `.`: +1 frame
- `Shift+,`: -10 frames
- `Shift+.`: +10 frames

仕様:

- step は active trim mode に従う
- active edit point が無い場合は何も起こさない
- trim commit は即時だが undo は 1 操作単位でまとめる

### 3-11. スナップとトリムの関係

- drag trim / keyboard trim の双方に snap を適用
- keyboard trim で snap に吸着した場合は一度 stop し、再押下で越えられる
- roll / ripple / slide では snap line を edit point 基準で表示

### 3-12. エラーハンドリング

- preview 上で block するのは illegal overlap のみであり、same-start stack group は合法とする
- illegal overlap 判定は server save contract と同じ canonical track semantics を使う
  - track ごとに clips を `timeline_in_frame` 昇順、同値なら `clip_id` 昇順で整列する
  - 同一 start frame の clips は stack group とみなす
  - stack group の次境界は、その group 内の最短 end frame とする
  - 前 group の境界が次 group の start frame を超えた時だけ overlap と判定する
- client preflight も `editor/shared/` の shared normalization / overlap validator module を通し、DOM 上の見た目の重なりや raw array 順序では判定しない
- source 範囲外は hard stop
- lock / sync-lock 不整合で ripple 不能な場合は toast で理由を出す
- server save で reject される invariants は client preflight にも反映する

---

## 4. 再生設計

### 4-1. 2画面構成

#### Source Monitor

- 単一 asset / subclip を再生
- `I` / `O` で source In / Out を設定
- `F9` Insert、`F10` Overwrite を実行
- alternatives preview の確認先でもある
- source に video がある場合は picture + waveform を表示する
- audio-only source の場合は black frame / poster、audio meters、large waveform、I/O range を表示する
- monitor 下部に source patch matrix と current target tracks を常時表示する

#### Program Monitor

- timeline 再生の正本
- current playhead と trim preview を表示
- save 前の dirty state でも live playback は可能
- playhead 上に video が無い場合、または sequence 全体が audio-only の場合は black frame + master timecode + audio meters / waveform を表示する
- empty timeline では black frame と `sequence.start_frame` 起点の timecode を表示する

### 4-2. `usePlayback` の役割

既存 `usePlayback` の思想は維持する。

- Program 再生の master clock
- `requestVideoFrameCallback` 優先、RAF fallback
- gap playback
- transcode fallback

拡張方針:

- Source / Program とは別に `active monitor` を editor-local UI state として持つ。初期値は Program Monitor
- active monitor は monitor surface への click、または monitor chrome 上での `Tab` 巡回で切り替える
- DOM focus は text input / menu / slider などの keyboard capture を決めるが、global transport shortcut の routing 正本は active monitor とする
- Program と Source の monitor state を分離
- Program 側は現行 `usePlayback` を拡張し、active video clip が無い区間では sequence / audio clock を master とする
- Source 側は別 playback channel を持つが、media resolution と transcode fallback は共通化する
- audio-only source / audio-only sequence でも black frame state のまま meters / waveform と同期して再生できるようにする

### 4-3. JKL シャトル

仕様:

- JKL は常に active monitor へ route する。text input などが DOM focus を持って shortcut を捕捉している間だけ global routing を抑止する
- `L`: forward play
- `J`: reverse shuttle
- `K`: stop
- `L` 連打で `1x -> 2x -> 4x -> 8x`
- `J` 連打で `-1x -> -2x -> -4x -> -8x`

補足:

- `K+L` は slow forward shuttle `0.25x`
- `K+J` は slow reverse shuttle `-0.25x`
- `K` を離した時点で現在 frame に pause する
- `K` を挟まず逆方向へ切り替えた場合は 1x から再開
- trim 中の JKL は trim preview を保ったまま対象近辺を shuttle
- audio-only monitor でも同じ shortcut を使い、映像面は black frame のまま audio clock で進行する
- 逆再生がブラウザ制約で完全再現できない場合は frame stepping + cached seek で degrade する

### 4-4. フレームステップ

- `Left`: -1 frame
- `Right`: +1 frame
- `Shift+Left`: -10 frames
- `Shift+Right`: +10 frames

優先順位:

- trim target active 時は trim step
- それ以外は playhead step

### 4-5. ループ再生

- Program Monitor は sequence In/Out 間ループ
- Source Monitor は source In/Out 間ループ
- loop range は ruler と monitor 下部に表示

### 4-6. Mark In / Mark Out

- `I`: mark in
- `O`: mark out
- `Option+I` / `Option+O`: clear mark
- active monitor に対して作用する
- Source / Program の monitor chrome に active monitor ring を常時見せ、JKL / I/O / TransportBar が同じ active monitor contract を共有する
- monitor 内の button / slider / menu に DOM focus が移っても、ユーザーが click または `Tab` で monitor 自体を切り替えない限り active monitor は変わらない

### 4-7. 挿入操作

Source から timeline へ入れる操作は Program playhead を edit point とし、2-7 の source patch matrix に従う。timeline が空の場合、既定 playhead は `sequence.start_frame` とし、ユーザーが明示的に動かしていればその frame を edit point とする。

Insert:

- patched tracks に source を配置し、inserted duration 分の ripple delta を発生させる
- ripple 参加 track は `patched tracks + sync-lock === ON + lock === OFF` の track
- ripple 参加 track で edit point をまたぐ clip は split し、downstream 側だけを delta 分だけ後ろへ送る
- `sync-lock === OFF` の track は絶対位置を維持し、意図的な非同期を許容する
- audio-only source は audio tracks のみ、video-only source は video track のみを書き込む

Overwrite:

- ripple しない
- patched tracks の `[edit point, edit point + source duration)` を source で置換する
- 置換区間と重なる clip は trim / split / remove して解決する
- non-patched tracks は変更しない
- overwrite tail が current sequence end を超えた場合のみ、sequence length をその tail まで延長する
- source duration が短くても sequence を自動で短縮しない

Replace from alternative:

- 選択 clip の start frame と destination track set を維持したまま source の I/O を差し替える
- 明示的に repatch しない限り track target UI は変更しない

blocking conditions:

- required target 不足
- target track が lock 中
- source audio rows > active audio targets

これらの場合、Insert / Overwrite は開始しない

### 4-8. 再生中の表示

- dropped frame が疑われる場合は subtle warning を出す
- lock 中や AI job 中でも再生は基本許可
- render/export 進行中は Program monitor を奪わない

---

## 5. AI 機能パネル設計

### 5-1. AI モード切替

切替方式は workspace toggle を採る。

- ヘッダ右上に `NLE | AI` segmented control
- `Tab` ではなく明示 toggle を primary とする
- キーボードでは `Cmd/Ctrl+Shift+A`

切替しても以下は不変:

- `timeline.json` canonical
- save / ETag / lock / WS sync contract
- playhead / selection / undo history

### 5-2. AI レビューフロー

AI が構築した timeline を開いたら、以下の順で読めることを目標にする。

1. Timeline 上で confidence / warning / weakness を把握する
2. 右 dock の AI Decision で clip rationale を読む
3. Alternatives で候補比較をする
4. Patch proposal を承認 / 却下する
5. Diff で baseline 差分を確認する
6. Compile / Review / Render を再実行する

### 5-3. Confidence Overlay

- clip 右上に confidence badge
- timeline top band に section-level confidence summary
- filter: `show all / low confidence only / warnings only`
- AI Mode では低 confidence clip を自動的に目立たせる

### 5-4. AI Decision Panel

右 dock 内の中核パネル。

表示内容:

- motivation
- confidence
- quality flags
- beat / purpose
- why selected
- related review weaknesses
- link to source candidate / fallback candidates

NLE Mode では Inspector 内の折りたたみセクション、AI Mode では独立タブとする。

### 5-5. 代替候補パネル

- selected clip の alternatives を card list で表示
- thumbnail, duration, why it matches, risk, quality flags を表示
- hover で Source Monitor preview
- click で compare, double-click で staged replace
- replace 実行前に diff summary を出す

### 5-6. パッチ提案パネル

ワークフロー:

1. patch list を読む
2. Preview
3. Approve or Reject
4. Apply 後は timeline revision を更新
5. Diff panel に変化を反映

仕様:

- operation ごとに `Apply`, `Reject`, `Preview`
- patch apply 前に client preflight が各 op の target track を検査し、locked track を触る op は request へ載せず skip + warn する
- `Apply All` は許可するが、preflight 後の送信対象に対して `423` / `409` が返った場合はその batch を全件 abort する
- preflight の結果、送信対象が 0 件なら patch request 自体を送らない
- patch apply は `base_timeline_revision` を持つ現行 contract を維持する
- server patch API は revision-authoritative であり、editor-local track lock は知らない。track lock の担保は client preflight の責務とする
- patch apply が `409 Conflict` を返した場合も merge banner だけで解決させず、同じ `MergeDialog` 即時表示フローへ入れる

### 5-7. CommandBar

CommandBar は Cursor 的な AI entry point とする。

表示方法:

- compact header buttons
- `Cmd/Ctrl+K` で command palette

コマンド:

- `Compile`
- `Review`
- `Render`
- `Reload from disk`
- `Reveal low confidence clips`
- `Apply selected patch`
- `Open diff`

Save then Run contract:

- `Review` / `Compile` / `Render` は常に disk 上に保存済みの `timeline.json` revision に対してのみ実行する
- `dirty === true` の場合、CommandBar は必ず `Save -> revision capture -> Run` を 1 本の chain として実行する
- save 成功で得た `timeline_revision` を job request に渡し、server job はその revision の disk artifact だけを読む
- `dirty === false` の場合でも、現在 UI が保持している `timeline_revision` を request に含める
- save または run start が `409 Conflict` の場合、job は開始せず `MergeDialog` を即時表示する。merge banner は informational のみとし、`Compare First` は dialog 内から `Diff(Local vs Remote)` を前面化する
- save または run start が `423 Locked` の場合、job は開始せず `lock_kind`, `holder_pid`, `holder_operation`, `acquired_at` に基づく lock holder / operation / retry affordance を表示する

AI job 実行中は:

- phase
- progress
- ETA
- lock reason
- last updated artifact

を表示する。

### 5-8. Diff Panel

- baseline は session baseline
- clip add / remove / replace / trim / move / audio policy change を区別
- selected diff から timeline 上の対象へ jump
- AI Mode では右 dock と下段 dock の両方から開ける

### 5-9. NLE と AI の責務分離

- NLE Mode は edit intent を最優先し、AI 情報は背景化
- AI Mode は rationale と decision support を最優先し、編集面積を少し譲る
- 同じ shell で往復すること自体が価値であり、別 route / 別 app にはしない

---

## 6. キーボードショートカット

### 6-1. 再生・マーク

| Shortcut | 動作 |
|---|---|
| `Space` | Play / Pause |
| `J` | Reverse shuttle |
| `K` | Stop |
| `L` | Forward shuttle |
| `K+J` | Slow reverse shuttle on active monitor |
| `K+L` | Slow forward shuttle on active monitor |
| `I` | Mark In |
| `O` | Mark Out |
| `Option+I` / `Option+O` | Mark clear |
| `Left` / `Right` | 1 frame step |
| `Shift+Left` / `Shift+Right` | 10 frame step |
| `Shift+/` | Loop on/off |

### 6-2. 編集・トリム

| Shortcut | 動作 |
|---|---|
| `A` | Selection tool |
| `B` | Ripple trim |
| `N` | Roll trim |
| `Y` | Slip trim |
| `U` | Slide trim |
| `,` / `.` | trim -1 / +1 frame |
| `Shift+,` / `Shift+.` | trim -10 / +10 frames |
| `S` | Snap toggle |
| `Cmd/Ctrl+L` | Link / unlink selected V/A pair |
| `Shift+L` | Linked selection toggle |
| `Delete` | Lift |
| `Shift+Delete` | Ripple delete |

### 6-3. Source 操作

| Shortcut | 動作 |
|---|---|
| `F9` | Insert |
| `F10` | Overwrite |
| `F` | Match frame / open selected clip in Source |

### 6-4. 保存・履歴

| Shortcut | 動作 |
|---|---|
| `Cmd/Ctrl+S` | Save |
| `Cmd/Ctrl+Z` | Undo |
| `Shift+Cmd/Ctrl+Z` | Redo |
| `Escape` | Clear selection / exit trim target |

### 6-5. AI 機能

| Shortcut | 動作 |
|---|---|
| `Cmd/Ctrl+Shift+A` | NLE / AI mode toggle |
| `Cmd/Ctrl+K` | Command palette |
| `Cmd/Ctrl+Shift+B` | Compile |
| `Cmd/Ctrl+Shift+R` | Review |
| `Cmd/Ctrl+Shift+E` | Render |
| `Option+Enter` | Apply selected patch |
| `Shift+D` | Open Diff panel |

---

## 7. 既存コードとの差分

### 7-1. 現状の要点

現状コードの特徴:

- [`editor/client/src/App.tsx`](../editor/client/src/App.tsx) にレイアウト責務が集中
- [`editor/client/src/components/Timeline.tsx`](../editor/client/src/components/Timeline.tsx) は `Canvas backdrop + DOM clip blocks`
- [`editor/client/src/components/ClipBlock.tsx`](../editor/client/src/components/ClipBlock.tsx) は単純な左右 trim のみ
- [`editor/client/src/hooks/usePlayback.ts`](../editor/client/src/hooks/usePlayback.ts) は Program 再生に相当する source-based playback を既に持つ
- [`editor/client/src/hooks/useTimeline.ts`](../editor/client/src/hooks/useTimeline.ts) は canonical state, undo/redo, validation, save の核として十分活かせる
- AI 系は `CommandBar`, `PatchPanel`, `AlternativesPanel`, `DiffPanel`, `PropertyPanel`, `useReview`, `useAiJob`, `useProjectSync` が既にある

### 7-2. 変更対象

| 対象ファイル / モジュール | 変更内容 |
|---|---|
| `editor/client/src/App.tsx` | monolith layout を解体し、workspace mode, panel persistence, dock orchestration を担当させる |
| `editor/client/src/components/Timeline.tsx` | layered timeline shell に変更し、ruler / track header / canvas layers / overlay layers を分離する |
| `editor/client/src/components/TrackLane.tsx` | migration wrapper から timeline item renderer へ役割縮小、最終的には selected/hover DOM overlay のみ担当 |
| `editor/client/src/components/ClipBlock.tsx` | clip fill renderer ではなく focused interaction layer へ縮退。J/L trim handles, linked badge, edit-point affordance を担当 |
| `editor/client/src/components/PreviewPlayer.tsx` | Program Monitor 化。trim preview state, dual/tri preview, loop indicator を追加 |
| `editor/client/src/components/TransportBar.tsx` | monitor-aware transport へ拡張。JKL state, loop, I/O, active monitor を表示 |
| `editor/client/src/components/PropertyPanel.tsx` | Inspector / AI Context / Review を再編し、NLE Mode と AI Mode の両方に対応 |
| `editor/client/src/hooks/usePlayback.ts` | Program playback 拡張、audio-only clock fallback、active-monitor JKL、reverse shuttle fallback、trim preview integration を追加 |
| `editor/client/src/hooks/useTimeline.ts` | trim operation engine、source patch matrix、sync-lock aware ripple、`editor/shared/` 由来の canonical overlap validator import、batch selection を追加 |
| `editor/client/src/types.ts` | editor UI state、track workspace state、trim mode、`metadata.link_group_id`、waveform cache refs などの UI 型を追加 |
| `editor/client/src/index.css` | panel chrome, resizer, monitor frame, timeline contrast, density token を追加 |
| `editor/shared/timeline-validation.ts` | canonical normalization と overlap validator を shared module 化し、client / server の両方から import する |
| `editor/server/routes/media.ts` | Source / Program monitor 共通の media resolution を整理し、seek 安定化と reverse shuttle fallback を補助する |
| `editor/server/routes/thumbnails.ts` | filmstrip 用の複数 thumbnail 解像度を返せるようにする |
| `editor/server/routes/timeline.ts` | `metadata.link_group_id` を含む optional metadata、same-start stack group semantics、`editor/shared/` の save contract normalization import、`423 Locked` 共通 response schema を追従させる |
| `editor/server/utils.ts` | advisory lock payload から `holder_pid`, `holder_operation`, `acquired_at` を route へ渡せるように整理する |
| `editor/server/services/watch-hub.ts` | waveform / thumbnail cache 再生成時に timeline repaint を起こすべきかを整理する |

### 7-3. 新規コンポーネント一覧

- `components/layout/EditorShell.tsx`
- `components/layout/WorkspaceHeader.tsx`
- `components/layout/ModeToggle.tsx`
- `components/monitors/SourceMonitor.tsx`
- `components/monitors/ProgramMonitor.tsx`
- `components/monitors/TrimPreviewOverlay.tsx`
- `components/timeline/TimelineShell.tsx`
- `components/timeline/TimelineToolbar.tsx`
- `components/timeline/TrackHeaderColumn.tsx`
- `components/timeline/TimelineCanvasLayer.tsx`
- `components/timeline/TimelineInteractionLayer.tsx`
- `components/timeline/TimelineSelectionOverlay.tsx`
- `components/timeline/TimelineSnapOverlay.tsx`
- `components/timeline/AudioWaveformLayer.tsx`
- `components/timeline/TrimModeToolbar.tsx`
- `components/ai/AiWorkspacePanel.tsx`
- `components/ai/AiDecisionPanel.tsx`
- `components/ai/ReviewPanel.tsx`

### 7-4. 新規 hooks / state

- `useTimelineViewport`
- `useTrimTool`
- `useKeyboardShortcuts`
- `useSourceMonitor`
- `useWaveformPeaks`
- `useLinkedSelection`
- `usePanelLayoutPersistence`

server 追加候補:

- `editor/server/routes/waveforms.ts`
- `editor/server/services/waveform-cache.ts`
- `editor/server/services/thumbnail-strip.ts`

既存 hooks は以下の役割を維持する。

- `useTimeline`: canonical timeline state, save, validation, undo/redo
- `usePlayback`: Program playback の正本
- `useReview`: AI artifacts の data source
- `useAiJob`: Compile / Review / Render orchestration
- `useProjectSync`: remote change ingestion

### 7-5. 段階的実装フェーズ

#### Phase 0. Foundation / Layout Refactor

- `editor/shared/timeline-validation.ts` を新設し、canonical normalization + overlap validator を client / server 共通化する
- App を shell + dock + mode toggle に分解
- Source / Program / Timeline / Inspector の 4 分割を先に成立させる
- 既存 timeline renderer と panels は一旦流用する

#### Phase 1. Timeline Renderer Upgrade

- Timeline を layered hybrid に再構成
- track header, ruler, selection, snap, marquee を追加
- waveform / thumbnail の lazy draw を入れる

#### Phase 2. Trim Engine

- Ripple / Roll / Slip / Slide の operation model を追加
- J/L cut の independent handles を実装
- keyboard trim と trim preview を統合

#### Phase 3. Playback Upgrade

- Source Monitor を追加
- JKL, loop, mark in/out, insert/overwrite を実装
- reverse shuttle fallback を詰める

#### Phase 4. AI Workspace Integration

- AI Mode を実装
- AI Decision / Review / Diff / Alternatives / Patches の panel choreography を再編
- CommandBar を palette 化

#### Phase 5. Performance / Polish

- 300 clips / 8 tracks の perf tuning
- visual polish
- shortcut / focus / pointer affordance の最終調整

---

## 8. 技術的考慮

### 8-1. 描画戦略: 現状維持ではなく「強化ハイブリッド」へ変更

結論:

- 完全 DOM には寄せない
- 完全 Canvas にも寄せない
- 現状の「Canvas 背景 + DOM クリップ」を、`layered hybrid` に進化させる

推奨レイヤ:

1. Background Canvas
   - ruler, ticks, lane backgrounds, markers, snap guides
2. Content Canvas
   - clip rects, filmstrip, waveform, confidence band, selection fill
3. Thin DOM Overlay
   - active trim handles, hover affordance, context menu, focus ring, tooltip, text input

理由:

- waveform / thumbnails / 300 clip scaleでは DOM ノード数が増えすぎる
- 一方で trim handles, accessibility, context menu は DOM の方が扱いやすい
- React 19 + Vite の現行基盤に素直に収まる

### 8-2. 波形データ生成・キャッシュ

方針:

- server 側で peaks を生成し cache する
- asset 単位、zoom bucket 単位の multi-resolution cache を持つ
- client は可視範囲の clip に対応する waveform だけを遅延取得する

想定 API:

- `GET /api/projects/:id/waveform/:assetId?detail=coarse|medium|fine`
- `GET /api/projects/:id/thumbnail/:assetId?frame_us=...&width=...&height=...`

キャッシュ例:

- `05_timeline/.waveform-cache/{assetId}.{mtimeHash}.coarse.json`
- `05_timeline/.waveform-cache/{assetId}.{mtimeHash}.medium.json`
- `05_timeline/.waveform-cache/{assetId}.{mtimeHash}.fine.json`

仕様:

- cache key は asset real path + mtime + sample rate
- mono mix と stereo channel peaks を両方保持可能にする
- track height / zoom に応じて nearest resolution を選ぶ
- cold miss 時は placeholder envelope を先に出し、生成完了後に差し替える

### 8-3. サムネイル

- 既存 thumbnail route を継続利用する
- video clip は可視範囲分のみ filmstrip を hydration する
- low zoom では representative frame 1 枚、高 zoom では strip 数を増やす

### 8-4. パフォーマンス目標

最低目標:

1. 300 clips / 8 tracks / markers 60 個で scroll, zoom, scrub が破綻しない
2. trim drag 中の UI update は `p95 < 16ms`
3. playhead 表示遅延は `<= 1 frame` 相当を目標
4. timeline 初回表示は waveform / thumbnail の lazy hydrate 前提で `p50 < 1.5s`

非目標:

- 1000 clips / 30 tracks を初期段階で最適化しきること
- 波形 / filmstrip を全 clip 常時フル解像度で描くこと

### 8-5. 既存 sync / save / lock との整合

本 UI 設計は以下を前提とし、変更しない。

- `timeline.json` が canonical source of truth
- `ETag = timeline_revision`
- save は `If-Match`
- 409 conflict は auto-merge しない
- save / patch / compile / review / render は advisory lock を共有
- WebSocket 通知は `fs.watch + hash sweep` モデルを継承する

UI に必要な追加振る舞い:

- AI Mode でも dirty state なら remote auto reload しない
- patch apply / compile / review 実行中は trim editing を disable する
- lock 中は toolbar と CommandBar から理由を見せる
- `Review` / `Compile` / `Render` は `Save then Run` を必須とし、unsaved memory state をそのまま job に渡さない
- save 成功後に確定した `timeline_revision` を run request に含め、job はその revision の disk 上 `timeline.json` を読む
- dirty 中 remote change 受信または `409` 発生時は `MergeDialog` を即時表示し、merge banner は informational のみとする。`Compare First` は dialog 内から下段 dock `Diff(Local vs Remote)` を前面化する
- `423 Locked` は save / patch / run start で共通扱いとし、response body は `{ lock_kind, holder_pid, holder_operation, acquired_at }` に正規化する
- UI は `423 Locked` の共通 schema から lock holder / operation / retry affordance を出し、save / patch / run のどこで止まっても同じ文脈で説明する

### 8-6. データモデル上の注意点

- canonical timeline data は既存の clips / tracks / transitions を維持しつつ、linked V/A pair の durable identity を `clip.metadata.link_group_id` で保持する
- `Transition.transition_type = 'j_cut' | 'l_cut'` はあくまで derived annotation とし、リンク関係の正本にはしない
- `lock` / `mute` / `solo` / `sync-lock` / `visibility` / `track height` / `track target` / trim mode / linked selection / active monitor / panel layout は editor-local persisted workspace state とする
- server は editor-local track lock を知らず、save / patch / merge の authoritative input には含めない
- persisted workspace state は browser localStorage の `video-os-editor.workspace.<projectId>.<sequence.name>` に保存し、`timeline.json` / `timeline_revision` / merge 対象には含めない

### 8-7. セキュリティ・信頼性

- waveform / thumbnail / source preview は既存 path guard を継承する
- reverse shuttle fallback のための追加キャッシュを入れる場合も project 配下に閉じる
- save 前 client validation は UX 補助であり、server validation を置き換えない

---

## 9. 検証・受け入れ条件

### 9-1. 受け入れシナリオ

1. AI が生成した timeline を開き、低 confidence clip を見つけ、alternative へ差し替え、save できる。
2. V/A linked pair に対して video だけを先に切り、L-cut を作って playback で確認できる。
3. Roll trim を keyboard だけで 3 frame 動かし、undo/redo できる。
4. audio-only source と AV source の両方で、Source Monitor から適切な target tracks へ Insert / Overwrite できる。
5. empty timeline でも black frame + master clock を維持したまま最初の Insert を `sequence.start_frame` 起点で実行できる。
6. review patch を 1 件 preview して Apply し、Diff panel に反映される。
7. external CLI が `timeline.json` を書き換えた時、dirty でなければ自動 reload、dirty なら informational banner とともに `MergeDialog` が即時表示される。
8. dirty 状態で `Review` を押した時は save 完了後 revision 付きで job が始まり、`409` なら `MergeDialog`、`423` なら lock holder / operation / retry を含む lock 待機 UI に遷移する。
9. same-start stack group を含む timeline は save できるが、canonical overlap は client / server の両方で block される。

### 9-2. テスト観点

- trim mode unit tests
- keyboard shortcut routing tests with active monitor / DOM focus separation
- linked selection / J/L cut interaction tests
- source patch matrix tests
- audio-only monitor / playback tests
- canonical overlap semantics parity tests with same-start stack group fixtures via `editor/shared/` shared validator
- patch apply track-lock preflight skip / warn tests
- Save then Run / dirty remote change / 409 / immediate MergeDialog / Compare First flow tests
- `423 Locked` response schema tests for save / patch / run
- track header workspace persistence tests
- waveform cache miss / hit tests
- 409 / 423 / websocket reconnect UI tests
- performance fixture tests with synthetic 300-clip timeline

### 9-3. UX 受け入れ基準

- 編集者が mouse のみ、keyboard のみ、AI panel 併用の 3 通りで主要操作を完遂できる
- clip 情報過多で読みにくくならない
- AI 情報を隠しても NLE として成立する
- AI Mode に切り替えても selection / playhead / context を失わない

---

## 10. リスク・代替案・ロールアウト

### 10-1. 主リスク

- reverse shuttle はブラウザ実装差で完全再現が難しい
- legacy timeline に `link_group_id` が無い場合、初回読込時の bootstrap heuristic と relink UX が必要になる
- waveform と filmstrip を DOM で描くとパフォーマンスが悪化する
- App.tsx の責務分割が不十分だと mode switch が再び肥大化する

### 10-2. 代替案

- reverse shuttle は初期段階では `K` 停止 + frame stepping を優先し、段階的に高速 seek へ拡張する
- `link_group_id` だけで不足する場合は、将来 `link_role` などの補助 metadata を追加する
- layered hybrid が不足するなら content canvas の比率をさらに上げる

### 10-3. ロールアウト

- Phase 0 完了時点で既存 AI panels と save contract を壊していないことを確認する
- Phase 1-2 の間は feature flag で旧 timeline を戻せるようにする
- Phase 3 以降で Source Monitor / JKL を default ON にする

### 10-4. ロールバック条件

以下が出た場合は旧 UI へ戻せることを必須とする。

- trim 操作が save invariant と食い違う
- 300 clip fixture で scroll / zoom が著しく劣化する
- dirty + remote change 時に state 破損が出る
- AI Mode が NLE Mode より優先され、通常編集の生産性を落とす

---

## 11. 最終判断

1. Video OS v2 Editor は NLE を捨てず、NLE の上に AI を重ねる。
2. 既定体験は NLE Mode とし、AI Mode は workspace preset として提供する。
3. Timeline は明示トラック型を維持しつつ、磁石スナップと opt-in `magnetic assist` で FCP 的な気持ちよさを部分導入する。
4. 最重要 UX は trim precision, J/L cut, waveform, JKL であり、ここに実装優先度を集中する。
5. 技術的には `timeline.json` canonical、`useTimeline` / `usePlayback` / `useReview` の既存思想、WebSocket sync、ETag optimistic lock を維持したまま UI を全面再構成する。
