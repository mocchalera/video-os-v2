# Video OS Studio UX User Stories

Date: 2026-06-25
Audience: 日本語ユーザー。Premiere Pro、DaVinci Resolve、Final Cut Pro などにある程度慣れている編集者を主対象にしつつ、初めて映像編集ソフトを触るユーザーにも次の行動が分かるUIを目標にする。

Canonical tracker: `docs/ux/video-os-studio-ux-tracker.xlsx`

M6 completion audit: `docs/ux/video-os-studio-m6-completion-audit.md`

Evidence screenshots:

- `docs/ux/screenshots/01-main-before-1240x778.png`
- `docs/ux/screenshots/02-main-after-1240x778.png`
- `docs/ux/screenshots/03-main-after-ja-1240x778.png`
- `docs/ux/screenshots/04-main-final-1240x778.png`
- `docs/ux/screenshots/05-main-after-flow-localization-1240x778.png`
- `docs/ux/screenshots/06-command-palette-ja-1240x778.png`
- `docs/ux/screenshots/07-command-palette-final-ja-1240x778.png`
- `docs/ux/screenshots/09-command-palette-ax-open-ja-1240x778.png`
- `docs/ux/screenshots/10-project-shelf-scroll-affordance-ja-1240x778.png`
- `docs/ux/screenshots/11-footage-search-menu-open-ja-1240x778.png`
- `docs/ux/screenshots/12-footage-search-query-state-ja-1240x778.png`
- `docs/ux/screenshots/13-footage-search-results-fixed-ja-1240x778.png`
- `docs/ux/screenshots/14-current-candidate-swap-entry-check-1240x778.png`
- `docs/ux/screenshots/15-demo-project-selected-check-1240x778.png`
- `docs/ux/screenshots/16-candidate-swap-open-ja-1240x778.png`
- `docs/ux/screenshots/17-main-compact-ja-1180x760.png`
- `docs/ux/screenshots/18-main-compact-role-preview-ja-1180x760.png`
- `docs/ux/screenshots/19-candidate-swap-role-ja-1180x760.png`
- `docs/ux/screenshots/20-candidate-swap-demo-role-ja-1180x760.png`
- `docs/ux/screenshots/21-main-agent-ja-1180x760.png`
- `docs/ux/screenshots/23-candidate-swap-tags-ja-1180x760.png`
- `docs/ux/screenshots/25-footage-search-empty-ja-1180x760.png`
- `docs/ux/screenshots/26-footage-search-results-tags-ja-1240x778.png`
- `docs/ux/screenshots/27-footage-search-results-tags-ja-1180x760.png`
- `docs/ux/screenshots/28-footage-search-results-accessible-ja-1180x760.png`
- `docs/ux/screenshots/29-main-min-window-ja-980x700.png`
- `docs/ux/screenshots/30-delivery-min-window-ja-980x700.png`
- `docs/ux/screenshots/31-delivery-export-buttons-ja-980x700.png`
- `docs/ux/screenshots/32-delivery-export-actions-ja-980x700.png`
- `docs/ux/screenshots/33-delivery-handoff-actions-ja-980x700.png`
- `docs/ux/screenshots/34-delivery-export-buttons-visible-ja-980x700.png`
- `docs/ux/screenshots/37-main-preview-contract-menu-ja-1240x778.png`
- `docs/ux/screenshots/38-main-surface-compile-project-panel-ja-1240x778.png`
- `docs/ux/screenshots/39-main-preview-diagnostics-header-ja-1240x778.png`
- `docs/ux/screenshots/40-candidate-swap-shortcut-focus-ja-920x580.png`
- `docs/ux/screenshots/41-candidate-swap-empty-primary-action-ja-3024x1964.png`
- `docs/ux/screenshots/42-lively-talk-preview-gap-main-window.png`
- `docs/ux/screenshots/43-lively-talk-preview-gap-fixed-status.png`
- `docs/ux/screenshots/44-lively-talk-collapsed-gap-preview.png`
- `docs/ux/screenshots/45-timeline-preview-composition-warning.png`
- `docs/ux/screenshots/46-timeline-marlin-localized-ja.png`
- `docs/ux/screenshots/47-candidate-swap-fka-tab-order-ja.png`
- `docs/ux/screenshots/48-footage-search-search-button-tab-ja.png`
- `docs/ux/screenshots/49-timeline-zoom-controls-current.png`
- `docs/ux/screenshots/50-magnetic-drag-displacement-unsaved.png`
- `docs/ux/screenshots/51-magnetic-drag-discard-reset.png`
- `docs/ux/screenshots/52-crossfade-drop-live-preview.png`

## Scope

この文書は、現行コードと起動確認したmacOS Studio UIに基づく主要導線のユーザーストーリーである。Web editor は既存の編集面として設計上残っているが、今回の検証と修正対象は `apps/macos-studio` のネイティブ操作面に絞った。

## Benchmark Notes

- Premiere Pro は公式キーボードショートカットでタイムラインのZoom Inを `=`、Zoom Outを `-` として扱う。Video OS Studioはタイムラインフォーカス時の隠しショートカット、Command Palette、表示メニュー、画面上の倍率ボタンを同じ操作に接続し、熟練者の手癖と初見ユーザー向けの可視導線を両立する。参照: [Adobe Premiere Pro keyboard shortcuts](https://helpx.adobe.com/premiere/desktop/get-started/keyboard-shortcuts/default-keyboard-shortcuts.html)
- Final Cut Pro は公式ショートカットでZoom In / Zoom Out / Zoom to Fitを持ち、タイムライン全体把握と詳細編集を切り替える前提になっている。Video OS Studioは `全体`、倍率スライダー、`100%` リセットを常時見える `Timeline.ViewportControls` として置き、ショートカットを知らないユーザーにも状態と戻し方を提示する。参照: [Final Cut Pro keyboard shortcuts](https://support.apple.com/guide/final-cut-pro/keyboard-shortcuts-ver90ba5929/mac)
- CapCutは公式ヘルプ/リソースで、フレーム単位の細かい編集とタイムライン全体の見渡しを行き来するワークフローを説明している。Video OS Studioの倍率スライダー、`全体`、現在倍率ラベルは、CapCut寄りの直感的な表示切替を、M6のpatch-first編集フロー上に載せるための最小実装である。参照: [CapCut iPad vs Desktop](https://www.capcut.com/resource/capcut-ipad-vs-desktop), [CapCut help: split subtitles](https://www.capcut.com/help/split-the-subtiltes)

## Stories

### US-01 新規プロジェクトを作る

映像素材を持っている日本語ユーザーとして、私は「新規プロジェクト」から素材フォルダを選び、編集準備用のプロジェクトIDを作りたい。そうすることで、CLIやファイル構造を知らなくても最初の取り込みを始められる。

期待体験:

- 最初の入口が日本語で見える。
- プロジェクトIDの入力ルールが日本語で説明される。
- 素材フォルダをリンクする意味が分かる。
- 作成中、成功、キャンセル、失敗の状態が明示される。

### US-02 既存プロジェクトを選び、状態を把握する

既存案件を再開する編集者として、私はプロジェクトメニューから案件を選び、timeline、review、package などの状態をすぐ把握したい。そうすることで、どの案件が続きから作業できるか迷わない。

期待体験:

- 選択中プロジェクトが視覚的に分かる。
- 未初期化、下書き、承認済みなどの状態が見える。
- プロジェクト切替は必要な時だけメニューで開け、常時表示領域はViewer、Inspector、Timelineへ渡される。

### US-03 素材解析と準備状況を見る

初回準備を進めるユーザーとして、私は「素材解析」工程で解析、検索インデックス、音声波形、プレビュー素材の準備状況を確認したい。そうすることで、編集前に何が不足しているか判断できる。

期待体験:

- 工程が日本語で並び、現在の工程が分かる。
- 解析可能、未リンク、インデックス未作成などの状態文が日本語で読める。
- 専門語は必要最小限にし、次の操作へつながる文言にする。

### US-04 タイムラインを再生して内容を確認する

粗編集を確認する編集者として、私はViewer、Transport、Timeline、Audio laneを同時に見ながら再生・停止・ステップ送りしたい。そうすることで、映像と音声の流れをNLEに近い感覚で確認できる。

期待体験:

- 最小ウィンドウ近辺でも再生操作、タイムライン、音声レーン、下部ステータスが画面内に残る。
- 近接マーカーが重ならず、beatやchapterの区別が読める。
- timeline.json の状態が必要な範囲で見えるが、操作文言は日本語で補助される。
- Viewer上で、現在の再生が照合済みタイムラインプレビューかソース確認か分かり、プレビュー動画がタイムライン全尺を覆っているか、V1/A1素材数、トランジション種別、素材再利用の有無が確認できる。
- A1音声クリップがある場合は、プレビュー動画に音声ストリームが入っているか分かり、完成音声を確認できない状態を承認用プレビューとして誤認しない。

### US-05 クリップを選択して根拠を見る

選択したカットの意図を確認したい編集者として、私はタイムライン上のクリップを選び、右側のクリップ/素材/QAパネルで素材、区間、信頼度、文字起こし、音声根拠を確認したい。そうすることで、AIが選んだ理由を人間が検証できる。

期待体験:

- 選択状態がタイムライン上で明確に見える。
- 右タブが日本語で、どの情報を見る場所か分かる。
- 技術的なartifact名は必要な時だけ補助情報として見える。

### US-06 差し替え候補を探す

候補カットを入れ替えたい編集者として、私はタイムラインのコンテキストメニューやコマンド検索から候補ブラウザ/素材検索を開き、現在のカットと代替候補を比較したい。そうすることで、編集意図を保ったまま差し替え判断ができる。

期待体験:

- 「差替え」「素材検索」が導線として見つかる。
- 候補数、現在のカット、候補の理由、fallback が読める。
- 検索モードやクエリ入力が初見でも意味を推測できる。

### US-07 レビュー修正を反映し、戻せる

AIレビューや人間の判断で修正を試したい編集者として、私は承認/却下/差し替えの保留件数を見て、「反映して確認」し、問題があれば「戻す」か「破棄」したい。そうすることで、確定前に安全に試行錯誤できる。

期待体験:

- 下部ステータスバーが常に見える。
- 保留、承認、却下、差替え、競合が短く読める。
- 反映、採用、戻す、破棄のボタン状態が分かる。

### US-10 クリップを直接編集する

NLEに慣れている編集者として、私はタイムラインでクリップを選択した直後に、承認、却下、先頭/末尾トリム、差し替え、素材検索、反映、戻すを近くのツールバーから実行したい。そうすることで、右クリックや隠しショートカットを知らなくても、粗編集の修正をタイムライン文脈のまま始められる。

期待体験:

- 未選択時はツールバーがdisabled状態になり、何を選ぶ必要があるか分かる。
- クリップ選択後に主要編集ボタンが有効化され、選択中クリップID、トラック、役割が読める。
- 先頭/末尾トリムは既存のpatch preview lifecycleに入り、保留件数、反映ボタン、タイムライン上の保留アイコンが同期する。
- 破棄/戻す後は、ツールバーと下部ステータスバーのボタン状態が同じ状態へ戻る。

### US-11 リップル削除で粗編集を詰める

粗編集を詰めたい編集者として、私は不要なクリップを選択し、同じトラックの後続クリップを前へ詰めながら削除したい。そうすることで、削った後の隙間処理を手作業で考えずに、NLEで期待される前詰め削除をStudio内で試せる。

期待体験:

- `リップル削除` が選択クリップの近くにあり、未選択時はdisabledになる。
- 実行前のhelpと実行後のステータスで、同じトラックの後続クリップが前へ移動することが分かる。
- 削除対象は却下/削除保留として見え、後続移動対象も保留状態として視覚的に分かる。
- `反映して確認` と `破棄` により、patch preview lifecycleから外れない。

### US-12 再生位置に合わせてクリップを詰める

粗編集の間を素早く詰めたい編集者として、私は選択クリップ内に再生位置を置き、先頭または末尾をその位置まで詰めたい。そうすることで、ドラッグトリム未実装の段階でも、NLEで基本となるplayhead基準のトリムを安全なpatch previewとして試せる。

期待体験:

- 未選択時や再生位置が選択クリップ外/境界にある時は、`先頭を再生位置へ` と `末尾を再生位置へ` がdisabledになる。
- クリップ内に再生位置を移動すると、両ボタンが有効になり、操作可能な状態が明確に分かる。
- 実行後は `trim_segment` と duration-aware `move_segment` の2操作として保留され、保留件数、反映ボタン、クリップ上の保留アイコンが同期する。
- `破棄` 後は、保留件数、反映ボタン、ステータスメッセージが元の安全な状態に戻る。

### US-13 再生位置でクリップを分割する

NLEに慣れている編集者として、私は選択クリップ内に再生位置を置き、クリップを左右2つへ分割したい。そうすることで、前半と後半を別々に削除、トリム、差し替え、移動できる編集単位に変えられる。

期待体験:

- 未選択時や再生位置が選択クリップ外/境界にある時は、`分割` がdisabledになる。
- クリップ内に再生位置を移動すると、`分割` が有効になり、実行可能な状態が明確に分かる。
- 実行後は `split_segment` として保留され、同一素材/同一トラック上のleft/right clipへ分かれるpatchとして反映/破棄できる。
- 保留件数、反映ボタン、クリップ上の分割保留アイコン、破棄後の状態がツールバーと下部ステータスバーで同期する。

### US-14 クリップ端をドラッグして詰める

NLEに慣れている編集者として、私は選択クリップの先頭または末尾ハンドルを直接ドラッグし、見た目のタイムライン上で不要な部分を詰めたい。そうすることで、固定秒数ボタンや再生位置合わせだけでなく、Premiere/FCPX/CapCutに近い直接操作で粗編集を調整できる。

期待体験:

- クリップを選択すると、左右端にドラッグ可能なトリムハンドルが見える。
- 先頭は右へ、末尾は左へドラッグするとクリップを短くでき、逆方向や境界外は安全に拒否される。
- 実行後は `trim_segment` と duration-aware `move_segment` の2操作として保留され、保留件数、反映ボタン、クリップ上の保留アイコンが同期する。
- `破棄` 後は、保留件数、反映ボタン、ステータスメッセージが元の安全な状態に戻る。

### US-15 複数クリップを一括で承認/却下する

NLEに慣れている編集者として、私はタイムライン上の複数クリップを選択し、まとめて承認または却下したい。そうすることで、粗編集の明らかな採用/不採用判断を1クリップずつ繰り返さず、タイムライン全体のレビューを速く進められる。

期待体験:

- `複数選択` モードをオンにすると、通常クリックで選択に追加/解除できることが分かる。
- Command/Shiftクリックでも追加/解除でき、NLE経験者が期待する操作に近い。
- 複数選択中は承認/却下、同一トラック内のリップル削除、0.5秒移動、選択範囲ループが一括操作として有効になり、トリム、分割、差し替え、検索は誤操作を避けるためdisabledになる。
- 実行後は保留件数、承認/却下件数、反映/破棄ボタンが下部ステータスバーとツールバーで同期する。
- 複数選択モードをオフにすると、選択は主クリップ1件へ即時に戻る。

### US-16 1フレーム単位とショートカットで再生位置を確認する

NLEに慣れている編集者として、私はタイムラインにフォーカスした状態でキーボード再生操作と1フレーム送り/戻しを使いたい。そうすることで、カット点や発話の頭を細かく確認しながら、マウス操作に戻らず粗編集を評価できる。

期待体験:

- タイムラインにフォーカスしている時だけ `J` / `K` / `L` が効き、テキスト入力や検索欄の入力を奪わない。
- `Space` は通常の再生/一時停止、`,` は1フレーム戻し、`.` は1フレーム送りとして維持される。
- ViewerのTransportボタン、help、Command Paletteから初回ユーザーでも操作を発見できる。
- 再生中/停止中のボタンラベルとタイムコードが即時に更新され、いま再生しているか、どこにいるかが分かる。

### US-17 ロールトリムで編集点を微調整する

NLEに慣れている編集者として、私は選択クリップの前後の編集点を左右へロールし、隣接クリップ同士の尺を入れ替えたい。そうすることで、タイムラインに隙間を作らず、発話の頭やリアクションの切れ目を0.5秒単位で素早く調整できる。

期待体験:

- 選択クリップに接している前後クリップがある時だけ、前/次の編集点ロール操作が有効になる。
- `前編集点←/→` と `次編集点←/→` のhelpで、どちらの隣接クリップとの境界をどちらへ動かすのか分かる。
- 実行後は左右2クリップの `trim_segment` と `move_segment` 合計4操作として保留され、隙間なしのpatch previewとして反映/破棄できる。
- 保留件数、反映/破棄ボタン、ステータスメッセージが、前編集点側と次編集点側のどちらでも同じルールで同期する。

### US-18 スリップトリムで素材範囲をずらす

NLEに慣れている編集者として、私は選択クリップのタイムライン上の位置と尺を変えずに、使っている素材範囲だけを前後へずらしたい。そうすることで、同じ長さと構成を保ったまま、より自然な表情、発話、手振り、リアクションを0.5秒単位で探せる。

期待体験:

- 単一クリップを選択していて、source in/outに前後の余裕がある時だけ、スリップ操作が有効になる。
- `スリップ←/→` のhelpで、タイムライン上の位置と尺は変わらず、素材範囲だけが0.5秒移動することが分かる。
- 実行後は選択クリップ1件の `trim_segment` だけが保留され、timeline in/out と duration は維持される。
- 素材の先頭/末尾を超える場合、素材尺が分からない場合、削除保留中の場合は安全に無効化または拒否される。
- 保留件数、反映/破棄ボタン、ステータスメッセージが左右どちらのスリップでも同じルールで同期する。

### US-19 クリップ端を空きスペースへ伸ばす

NLEに慣れている編集者として、私は選択クリップの先頭または末尾を、前後の空きスペースと素材の余白がある範囲で外側へ伸ばしたい。そうすることで、切りすぎた発話頭やリアクション末尾を0.5秒単位で戻し、小さな隙間を手作業の移動なしに埋められる。

期待体験:

- 単一クリップを選択していて、前後に空きスペースとsource handleがある時だけ、`先頭を伸ばす` / `末尾を伸ばす` が有効になる。
- 未選択、複数選択、削除保留中、隣接clipに重なる場合、source inが0を下回る場合、素材durationが足りない場合は安全にdisabledまたは拒否される。
- 実行後は `trim_segment` と duration-aware `move_segment` の2操作として保留され、既存のpatch preview lifecycleで反映/破棄できる。
- 保留件数、反映/破棄ボタン、ステータスメッセージが先頭/末尾どちらのextendでも同じルールで同期する。

### US-20 ソースモニターで素材を確認する

素材を選ぶ編集者として、私はMediaパネルから解析済み素材をViewerへ直接出し、タイムラインプレビューと区別して確認したい。そうすることで、候補を差し替える前に元素材の尺、画、音を迷わず確認できる。

期待体験:

- Mediaパネルの準備済み素材には `ソース確認` の主操作が見える。
- ソース確認中はViewer/Transportに素材名、source range、`ソース確認中` badgeが出て、Program previewと取り違えない。
- `タイムラインへ戻る` またはタイムラインclip選択でProgram previewへ復帰できる。
- ソース確認へ入る時と戻る時に下部ステータスが現在の文脈を説明する。

### US-21 J/K/Lシャトルで前後に再生確認する

NLEに慣れている編集者として、私は `J` / `K` / `L` とTransportボタンで逆再生、停止、順再生を切り替えたい。そうすることで、カット点前後の動きや発話頭を、Premiere/FCPX/CapCutに近い手癖で確認できる。

期待体験:

- `J` は逆再生、`K` は停止、`L` は順再生として動作する。
- `J` / `L` を繰り返すと 1x / 2x / 4x のシャトル速度が循環し、方向変更時は1xから始まる。
- ViewerのTransportには逆再生、再生/停止、順再生、1フレーム送り/戻しが分かれて表示される。
- 再生中は `再生 1x` / `逆再生 1x` のような速度バッジが見え、停止すると消える。
- 逆再生で先頭へ到達した場合は停止し、操作不能ではなく先頭にいることが分かる。

### US-22 選択クリップをループ再生する

NLEに慣れている編集者として、私は選択したクリップをすぐループ範囲にし、同じ発話やカット点を繰り返し確認したい。そうすることで、トリム、ロール、スリップ、差し替え判断の前後で動きや音のつながりを手早く評価できる。

期待体験:

- クリップ選択後に `R` またはTransportのループボタンで選択クリップの範囲をループ対象にできる。
- ループ有効時はTransportに `ループ 00:00:00:00-00:00:11:15` のような範囲表示が出る。
- `R` またはループボタンでもう一度押すと範囲は保持したままオン/オフを切り替えられる。
- ループ範囲外から再生を始めた場合は範囲先頭へ移動し、範囲終端を越えると範囲先頭へ戻って再生を続ける。
- コマンド検索と再生メニューから、選択クリップをループ範囲にする、ループ再生をオン/オフする、ループ範囲を解除する操作を発見できる。

### US-23 タイムライン表示倍率を切り替える

NLEに慣れている編集者として、私はタイムライン全体を見渡す表示と、カット点を細かく調整する拡大表示をすぐ切り替えたい。そうすることで、構成全体の把握とフレーム単位の編集を同じ画面で行き来できる。

期待体験:

- タイムライン上部に拡大、縮小、全体表示、100%へ戻す操作がまとまって見える。
- 現在の表示倍率が `100%`、`160%`、`全体表示` のように常時表示される。
- `全体` を押すとシーケンス全体が現在の幅へ収まり、表示倍率スライダーは一時的に無効化される。
- `拡大`、`縮小`、`100%` のいずれかを押すと詳細表示へ戻り、スライダーとラベルが現在倍率へ更新される。
- コマンド検索、`表示` メニュー、タイムラインフォーカス時の `-` / `=` からも同じ操作を発見できる。

### US-24 クリップとトランジションをドラッグで編集する

FCPXのマグネティックタイムラインに慣れた編集者として、私はクリップ本体をドラッグして空き位置や編集点へ吸い付くように移動し、トランジションプリセットを編集点へドラッグして反映したい。そうすることで、ボタン操作だけでなく手元の感覚に近いタイムライン編集ができる。

期待体験:

- クリップ本体を左右へドラッグすると、移動量がフレームに変換され、同一トラック上でその場で表示位置が変わる。重なる位置へ置いた場合は、重なった後続クリップが右へ押し出される。
- ドラッグ先が隣接クリップの編集点、再生位置、マーカー、タイムライン先頭に近い場合は磁石のように吸着し、ステータスに吸着先が表示される。
- 未保存の手編集がある間、Viewerは古いrough-cutプレビューではなく、現在のin-memoryタイムライン位置から元素材を選んで再生する。
- 再生ヘッド下に複数のvideo/overlay/audio clipが重なる場合は、Viewerが実際に読んでいる映像clipと有効な音声clipだけがTimeline上で `Viewer参照中` cueとして示され、下位の重なりclipや単なる再生位置下のclipと区別できる。
- Viewer側にも `Viewer.ProgramSourceCue` として現在の映像/音声track、clip ID、source時刻が短く出るため、Timeline上のcueと実際のProgram再生が対応していることを目線移動なしに確認できる。
- Viewer側で次に切り替わるclipが現在の映像/音声と異なる場合は `Viewer.ProgramSourceCue.Next` の `次` chipが出るため、scrub/play中に次のcut先を先読みできる。
- クリップ端のトリムハンドルと本体ドラッグは干渉せず、端を掴むと既存のドラッグトリム、本体を掴むと移動として扱われる。
- ツールバー上のトランジションプリセットを、編集点上の見える `+` ターゲットへドラッグすると、その編集点にトランジションが即表示される。
- 適用済みトランジションはクリックで選択でき、横ドラッグでdurationを調整できる。
- 未保存のクロスフェード範囲ではViewerに簡易ライブクロスフェードが重なり、durationを伸縮するとプレビューされるfade範囲も変わる。
- 削除保留中のクリップ、隙間のある編集点、音声トラックへのビデオトランジション適用は拒否され、未保存の編集として保存/破棄できる。

### US-25 M6.5 Editing Feel / Magnetic UX

FCPXやCapCutに慣れた編集者として、私はAIが荒編集したタイムラインを、通常の映像編集ソフトとしてドラッグ中心に微調整したい。そうすることで、AIに任せた後の詰め作業を、提案承認UIではなくNLEらしい手触りで行える。

期待体験:

- クリップ本体を掴んだ瞬間から、drop後の結果と同じ移動先がタイムライン上に見える。
- クリップ本体をドラッグしている間、移動量がframes/secondsで手元に出て、別レーンへ逃がす場合のtarget lane、押し出されるclip数、吸着先が読める。
- 吸着対象が編集点、再生位置、マーカー、タイムライン先頭のどれなのかが、縦ラインやアイコンで分かる。
- 重なる位置へドラッグした場合、video/overlayクリップは一時レーンへ持ち上がり、drop後はV2などの互換レーンへ残る。音声クリップは後続クリップが押し出される予定位置もドラッグ中に見える。
- 既存の空き互換レーンへ逃がせる場合は、そのtarget row自体がhighlightされ、移動先clip ghostがdrop後の位置に出る。
- clip本体を上下にもdragすると、互換の空きtrackへ明示移動でき、target row highlight/ghostでdrop後のtrackが分かる。
- clip本体を上下にdragした先が互換違いや重なりで受けられない場合は、target rowが赤いblocked cueになり、drop前に失敗理由が分かる。
- 複数選択したクリップは、選択中の1クリップを掴むだけで相対位置を保ったまま一つの塊として動き、選択中クリップ同士には不要に吸着/衝突しない。
- 複数トラックをまたぐ複数選択でも、drag開始行以外の選択clipがdropまで静止せず、同じgroup previewとして移動先を示す。
- 複数選択中はtoolbar summaryがclip count、target tracks、selected range、durationを表示し、group move/nudge/delete/loop前に対象範囲を確認できる。
- 選択範囲をループにしたときはTransport badgeだけでなく、Timeline rulerとOverviewにも `Timeline.Ruler.LoopRange` / `Timeline.Overview.LoopRange` のrange bandが出るため、繰り返し確認中の範囲をTimeline上で見失わない。
- ズームしたTimelineで再生レビューするときは `Timeline.FollowPlayhead` をオンにしておくと、再生位置が表示範囲の端へ近づいた時だけ詳細Timelineが追従し、全体表示や手動スクロールの邪魔を最小化しながらcut位置を見失わない。
- drag previewとdrop commitは同じ `TimelineClipMovePlan` を使い、プレビューと実際のpatch結果がズレない。
- クリップ端をドラッグトリムしている間から、clipの表示位置と表示長が同じtrim計画で縮み、離した直後にViewer/Transportの再生対象もin-memory timelineへ反映される。
- クリップ端は再生位置、マーカー、同一トラックの編集点へ磁気的に吸着し、drag中に境界線、trim量、吸着先が見える。
- trim可能なclipはhover/selection時に左右端gripが見え、選択後に同じ位置で実際のtrim handleを掴めるため、端を探すための試行錯誤が少ない。
- トランジションは、編集点周辺へ落とせる広い受け皿、drop前hover中のpreset名とViewer preview、適用済みduration調整、drop commitまでが一連の操作としてつながる。
- 隣接clipの編集点には低濃度のlanding guideが常時見え、既存transitionには左右duration gripが見えるため、drop先と長さ調整の掴み所を探さなくてよい。
- transition presetを掴んだ時点で、空の隣接編集点すべてがcandidate cueとして強調され、どこへ持っていけるかをdrag開始直後に判断できる。
- transition presetを編集点へdrag hoverすると、磁石cue、seam line、preset名、from/to clip IDが出て、drop先へ吸着していることが分かる。
- 既存transitionを横ドラッグして長さ調整している間、増減フレーム、最終フレーム数、秒数がtransitionの近くに出るため、下部statusや目測に頼らず微調整できる。
- transitionをクリックまたはdrop hoverで選択すると、toolbar左の選択summaryがclipではなくtransitionの種別、長さ、編集点へ切り替わり、いま何を調整しているかが残る。
- 選択中transitionはtoolbarの `長さ−` / `長さ＋` で0.5秒ずつ短縮/延長でき、横ドラッグに頼らなくてもTimelineとViewerへ即時反映される。
- 選択中transitionの長さ調整はCommand Paletteから `トランジションを短く` / `トランジションを長く` として検索でき、timeline focus時は `Shift-[` / `Shift-]` で連続調整できる。
- transition presetやdrop targetを探せない場合でも、Command Paletteの `クロスフェードを適用` またはtimeline focus時の `Command-T` で、選択中または再生位置近くの映像編集点へdefault crossfadeを即適用できる。
- クロスフェードpreset chipはdefault transitionであることが視覚的なcommand icon、tooltip、accessibility hintで分かり、`Command-T` を知らない初回ユーザーも標準transition導線を見つけられる。
- 選択中transitionはtoolbarの削除ボタンからcutへ戻せ、Timeline/Viewer/未保存patch/保存後compilerが同じようにtransitionなしへ戻る。
- タイムラインルーラーをクリック/ドラッグすると、再生ヘッドとViewerがその場で追従し、ドラッグ中はtimecode badgeで移動先が分かる。
- クリップのないトラック背景をクリック/ドラッグしても再生ヘッドを置けるため、空き時間を探す時にSliderやルーラーへ視線を戻さずに済む。
- ルーラー/空きトラック背景でplayheadを置く時も、近い編集点、マーカー、タイムライン先頭/末尾へ磁気的に吸着し、drag中にsnap lineと吸着先labelで止まり先が分かる。
- クリップ本体にhover/選択/ドラッグ中の視覚cueがあり、初見でも「本体を掴んで動かす」「端を掴んでトリムする」の違いが分かる。
- ソースモニターで確認中の素材は、`再生位置へ追加` からplayhead位置へそのまま入り、roleに応じてV1/V2/A1/A2へ置かれ、TimelineとViewerが即時にProgram previewへ戻って挿入後の状態を示す。
- ソースモニターの追加候補にはsegment、source range、role、target track、confidence、理由、候補番号が出て、前後候補へ切り替えてから追加できる。
- Mediaパネルのready素材rowは、クリックでsource monitor確認へ入り、row上のcandidate segment、role、target track、duration、confidenceを見てから、quick insert iconで再生位置へ即追加するか、直接dragしてtimelineへ落とせる。quick insertは表示中のbest candidateをplayheadへ入れ、drag中は既存source candidate dragと同じghost、snap rail、blocked lane、occupied-lane lift cueが見える。
- ソースモニターで確認中の候補は、選択中のvideo/audio clipへ直接置換でき、clipのタイムライン位置と尺は維持したまま、素材、source range、candidate ref、Viewer previewが即時に置き換わる。
- source monitor insertも `insert_segment` として未保存セッションへ積まれ、保存後のcompilerでも不足するtarget trackが作られるため、UI上の即時反映と `timeline.json` の反映がズレない。
- AI Agentは補助として使えるが、AIなしでもclip move、trim、transition、preview確認が成立する。
- Agentパネルでは選択中のclip/transitionを `短く整える`、`代替を探す`、`カットを説明` の文脈で読み取り専用相談へ渡せる。`相談を実行` はAgentセッションがある場合だけそのままread-only turnへ進み、ない場合はprompt準備と開始案内に留まるため、AI提案はPREVIEWでありtimelineには勝手に適用されない。
- Agent相談プロンプトには選択clipのtimeline文脈、既存note、QA、transcript、segment summaryに加えて、segment interest/peak、Marlin temporal/find、audio event/story、BGM section cuesが入るため、AIの説明や差し替え提案は既に解析済みの映像・音声根拠を参照できる。
- Agentが `review_patch` を返した場合、Timelineへ表示反映する前に、現在のtimelineから計算した before/after 差分行がAgentパネルに出る。対応外や解決できないoperationは差分として誤表示せずblocked reasonに留める。

### US-08 エージェントに相談・実行する

AI支援を使いたいユーザーとして、私は右側のエージェントパネルで接続状態を確認し、読み取り専用相談または書き込みジョブを承認して実行したい。そうすることで、AIの提案と決定的エンジンの書き込み境界を理解したまま作業できる。

期待体験:

- 接続方式、状態、作業フォルダ、起動コマンドが日本語ラベルで読める。
- 書き込みがあるジョブは「書き込み計画を確認」として明示される。
- 実行結果が完了前/完了後で区別できる。

### US-09 書き出し・納品する

編集結果を次工程へ渡すユーザーとして、私はPremiere XML、編集者パケット、最終動画を書き出したい。そうすることで、Video OSの編集結果を既存NLEや納品ワークフローへ安全に渡せる。

期待体験:

- 納品工程から書き出し状態と不足要件が分かる。
- 実行できない場合は理由と次の作業が見える。
- 書き出し後の検証状態が追跡できる。

## Current Findings Summary

- 修正前は、1240x778 のメイン画面でフィードバックバーが画面外へ押し出され、音声レーンも下端で大きく見切れていた。
- 修正前は、近接する timeline markers が重なり、b02/b04 の判別が難しかった。
- 初回導線の多くが英語または技術語で、日本語ユーザーには次の操作が伝わりにくかった。
- 修正後は、同じ 1240x778 条件でフィードバックバー、動画/音声レーン、近接マーカー、日本語化した主要ラベルを確認済み。
- 追加修正後は、macOSメニュー、設定、プロジェクト詳細、素材/QA/エージェント詳細、コマンド検索、候補差替え、素材検索の主要ラベルとステータス文を日本語化した。
- コマンド検索は `07-command-palette-final-ja-1240x778.png` と `09-command-palette-ax-open-ja-1240x778.png` で、無効理由が「有効なスレッドがありません」など日本語で出ることを確認した。
- プロジェクト切替は `37-main-preview-contract-menu-ja-1240x778.png` で、横スクロール棚ではなく上部メニューに収まり、Viewer/Inspector/Timelineへ縦方向の領域が渡されていることを確認した。
- 素材検索は `11-footage-search-menu-open-ja-1240x778.png` で、スタジオメニューの直接導線から開けることを確認した。
- 素材検索の結果カードは `12-footage-search-query-state-ja-1240x778.png` でサムネイルが説明/スコア欄に重なる課題を発見し、`13-footage-search-results-fixed-ja-1240x778.png` で固定枠に収まることを確認した。
- Candidate Swap は `16-candidate-swap-open-ja-1240x778.png` で候補カード表示を確認し、さらに新ビルドの `19-candidate-swap-role-ja-1180x760.png` と `20-candidate-swap-demo-role-ja-1180x760.png` で空状態/候補カード状態を再確認した。
- `18-main-compact-role-preview-ja-1180x760.png` で、1180x760でもViewer、タイムライン、下部フィードバックバーが画面内に残り、プレビュー状態、下書き/レビュー状態、役割ラベルが日本語で出ることを確認した。
- 今回の追加修正で、Candidate Swap と Footage Search のタグ/品質フラグを日本語表示にマップし、元タグはツールチップに残す形にした。`23-candidate-swap-tags-ja-1180x760.png` では差し替え候補がない場合の空状態と、現在クリップの「選定理由（原文）」ラベルを確認した。
- `25-footage-search-empty-ja-1180x760.png` で、素材検索モーダルの検索モード、入力欄、空状態が日本語で表示されることを再確認した。
- `26-footage-search-results-tags-ja-1240x778.png` で実データ検索結果のタグ表示に英語の品質フラグが残る課題を確認し、辞書を正規化して追加した後、`27-footage-search-results-tags-ja-1180x760.png` と `28-footage-search-results-accessible-ja-1180x760.png` で「ほぼ無音」「軽いハイライト」「AI研修」「参加者の声」「業務活用」が表示されることを確認した。AXツリーでも同じ日本語ラベルを取得できた。
- `35-footage-search-focus-ax-ja-980x680.png` で素材検索モーダルを再確認し、AX focused element が `AXTextField / 検索語句` になることを確認した。検索後も検索語句へフォーカスを戻すようにした。
- `36-candidate-swap-focus-ax-ja-920x580.png` でCandidate Swap空状態を再確認した。空状態では「素材をさらに検索」が次アクションとして見えるが、再起動直後に選択クリップがない場合はショートカットで再オープンできず、Full Keyboard Access有効時のフォーカス順は継続検証としていた。
- `40-candidate-swap-shortcut-focus-ja-920x580.png` で、アプリ再起動直後に `Cmd+Shift+S` からCandidate Swapが開き、「素材をさらに検索」ボタンへ視覚フォーカスリングが出ることを確認した。追加修正後はComputer UseのAX focused elementも同ボタンを返すようになり、EnterでFootage Searchへ進む。
- `41-candidate-swap-empty-primary-action-ja-3024x1964.png` で、候補0件の空状態中央に「素材をさらに検索」ボタンを出し、FocusState連動の明示フォーカスリングが見えることを確認した。空状態の説明と次アクションが同じ視線位置に入り、上部右端のボタンだけに頼らない導線になった。
- `21-main-agent-ja-1180x760.png` ではエージェントパネルの接続状態、作業フォルダ、起動コマンド、接続前ガイダンスが日本語ラベルで表示されている。さらにコード上ではジョブ名、サンドボックス、書き込み契約モード、承認済み書き込み範囲、許可/禁止される成果物、契約違反理由、実行結果ステータスにも表示専用の日本語化を追加した。パスや契約値そのものはツールチップに残し、診断精度を落とさない。
- `29-main-min-window-ja-980x700.png` で、ContentViewの最小サイズ付近でもViewer、右パネル、タイムライン、下部フィードバックバーが破綻なく残ることを確認した。
- `30-delivery-min-window-ja-980x700.png` から `34-delivery-export-buttons-visible-ja-980x700.png` で、納品工程と素材タブ内の書き出し/受け渡し状態を確認した。Premiere XML書き出しボタンは確認できたが、納品操作は右パネル内の深いスクロールに埋もれるため、初見の発見性は継続課題とする。
- 今回の追加修正で、納品工程の右パネル上部に、最終動画/書き出し可否/Premiere XML/編集者パケットだけでなく、不足成果物、QA結果、QAチェック件数、最終出力有無、パケット内ファイル数、最終素材/最終音声の同梱状態、検証根拠、XML/パケット出力先を表示するようにした。深いスクロールに入る前に「押せるか」「何が足りないか」「書き出し後に何を検証したか」が読める。
- `37-main-preview-contract-menu-ja-1240x778.png` で、上部プロジェクト切替が横スクロール棚ではなくメニューになり、Viewer/Timelineへ縦方向の領域が渡されていることを確認した。
- `39-main-preview-diagnostics-header-ja-1240x778.png` で、Viewerが `timeline-preview / rough-cut.mp4` を表示し、`照合済みプレビュー`、`V1 2素材/5クリップ・A1 1素材/3クリップ / カット4件 / 素材再利用` が同じ画面で見えることを確認した。今回の追加修正では、同じ診断に `プレビュー全尺` / `プレビュー不足` / `プレビュー動画なし` の判定を加え、hash一致だけでは見えない「実プレビュー動画が短く後半で元素材確認へフォールバックする」状態も区別できるようにした。
- `42-lively-talk-preview-gap-main-window.png` で、`lively-talk-pv` の `timeline.json` は57.33秒だが `rough-cut.mp4` は46.25秒で、実画面上も `プレビュー不足 46.2s/57.3s` と表示されることを確認した。
- `43-lively-talk-preview-gap-fixed-status.png` で、preview-manifestのhashが一致していても実プレビュー動画が短い場合は、緑の `照合済みプレビュー` ではなく `再生契約: プレビュー不足` として警告表示されることを一度確認した。
- その後 `render-report.json` を再確認したところ、`lively-talk-pv` の `rough-cut.mp4` はtimeline上の空白を詰めるrenderer契約で `expected_rendered_sec: 46.302`、`actual_rendered_sec: 46.25`、`parity_pass: true` だった。`44-lively-talk-collapsed-gap-preview.png` で、現行UIが `再生契約: 空白詰めプレビュー`、`46.2s/期待46.3s（空白10.3s詰め）`、`クロスフェード 1件` と表示することを確認した。
- `operator-participant-voices` では `timeline.json` と `preview-manifest.json` のhashは一致していたが、修正前の `09_output/rough-cut.mp4` は映像streamのみで、A1の3音声クリップを再現していなかった。`render-rough-cut.ts` をA1音声対応に修正し、再レンダー後は `ffprobe` でvideo/audioとも `start_time=0`、duration `69.875s`、audio `aac 2ch` を確認した。`render-report.json` も `audio_clip_count: 3`、`audio_rendered: true` を記録する。
- 同じ `ax1` の `timeline.json` はV1が2素材/5クリップ、A1が1素材/3クリップ、transitionはcut 4件のみである。したがって、修正後も残る繰り返し感や非cut transition不在はプレビュー不一致ではなく、生成timeline側の素材分散/transition選定の改善課題として扱う。
- 実測では `lively-talk-pv` が `preview-manifest` exact、timeline span 57.33秒、`09_output/rough-cut.mp4` 46.25秒だった。単純なtimeline span比較では短く見えるが、`render-report.json` は `gap_sec: 10.333`、`crossfade_overlap_sec: 0.5`、`expected_rendered_sec: 46.302`、`parity_pass: true` を示す。したがって現行rough-cutは「途中で切れたpreview」ではなく、timeline上の空白を詰めた確認用プレビューとして扱う。`lively-alt-vol5` は全尺プレビューがある一方、V1が6クリップ/4素材で同一素材隣接2件、transitionはcut 5件のみだったため、繰り返し感はプレビュー不一致ではなく生成timeline由来と判定した。
- 今回の追加修正で、古い `preview-manifest.json` の動画はViewerのタイムラインプレビュー候補から除外し、A1音声の同一素材隣接も繰り返し診断に含めるようにした。Viewerが元素材を表示している場合は `ソース確認中` のorange badgeを出し、timeline.jsonのトランジション、完成音声、複数トラック合成はそこで再現されないことを明示する。
- `45-timeline-preview-composition-warning.png` で、`operator-participant-voices` の現行画面が `再生契約: 照合済みプレビュー、構成注意`、`プレビュー全尺 1m10s/1m10s`、`プレビュー音声あり`、`カットのみ 4件`、`同一素材連続 A1 2件` を同時に出すことを確認した。つまり、今回のax1はtimeline/previewの再生契約は一致しているが、非cut transition不在と音声素材連続は生成timelineの編集品質課題として扱う。
- 工程セグメントは中央キャンバスの切替ではなく右パネル文脈の切替であるため、上部ラベルを `右パネル表示` に変更し、ヘルプで `ViewerとTimelineは固定` と明示した。選択中の表示先パネル名は上部とInspectorバナーに出し、プロジェクト切替は横スクロール棚ではなくProjectMenuに集約済み。
- Clip Inspector には `根拠サマリー` を追加し、素材/セグメント/文字起こし/Marlin/音声根拠の有無と件数が先に分かるようにした。トラック種別、役割、品質フラグ、タグ、Marlin source pass、ピーク根拠、音声イベント、ストーリーノード、BGM強度は日本語表示へ寄せ、raw値はツールチップや「原文」ラベルで残した。
- Media/Settings/Command Paletteの解析準備、source_map、preview status、proxy/relink/index/audio-story/synthetic/smoke statusは日本語補助付きにした。今回の追加修正で、Marlin評価パネルの長い英語recommendation、代表バケット説明、RAG件数、編集者パケット検証文、タイムラインマーカー `hook/value/breakthrough/application/conviction`、音声キュー `audio-story/utterance/payoff`、`original clip audio` を表示層で日本語化した。`46-timeline-marlin-localized-ja.png` とComputer Use AXで `b01: 導入`、`b02: 価値訴求`、`音声ストーリー / 発話 / 回収`、`元クリップ音声` を確認した。
- `47-candidate-swap-fka-tab-order-ja.png` とComputer Use AXで、`Cmd+Shift+S` からCandidate Swapを開くと `素材をさらに検索` が初期フォーカスになり、Tabで閉じるボタン、Tabで主操作、Shift+Tabで閉じるボタンへ移動することを確認した。左側の現在クリップ情報はAX上で見出し、メタデータ行、選定理由、ビート目標に分かれ、`ビート目標 導入、240フレーム` として読める。
- `48-footage-search-search-button-tab-ja.png` とComputer Use AXで、Candidate Swapの主操作をReturn実行するとFootage Searchが開き、初期フォーカスは `検索語句`、次のTabは `素材を検索` ボタンになることを確認した。修正前に検索ボタンを飛ばして `画像の手がかり` へ移動していた導線は再現しない。
- 今回のM6直接編集スライスで、Timeline上部に `Timeline.EditToolbar` を追加した。未選択時は承認/却下/トリム/差し替え/検索/反映/戻すがdisabledになり、クリップ選択後は `V1 / 会話` と `CLP_0001` のような選択情報と主操作が同じ場所で有効化される。
- Computer Useで `CLP_0001` を選択し、「先頭を詰める」を実行すると、下部ステータスバーが `保留 1` になり、ツールバーと下部の反映ボタンが有効化され、タイムライン上のクリップにトリム保留アイコンが出ることを確認した。
- 初回実装では「破棄」後に下部ステータスバーだけがdisabledへ戻り、ツールバー側の反映ボタンが古い有効状態のまま残る同期不整合をComputer Useで見つけた。`TimelineEditToolbar` が `StudioFeedbackSession` を直接監視するよう修正し、破棄後は両方の反映ボタンがdisabledへ戻ることを再確認した。
- 追加のM6スライスで `Timeline.EditToolbar.RippleDelete` を追加した。`TimelineRippleDeletePlan` が選択clipの `remove_segment` と同一トラック後続clipの `move_segment` を生成し、schema変更なしにリップル削除を表現する。
- Computer Useで `CLP_0001` を選択し、`リップル削除` を実行すると、下部ステータスバーが `保留 5 / 却下 1` になり、`後続4件を 11.6秒 前へ詰めます` と表示され、反映ボタンが有効化されることを確認した。
- リップル削除の初回確認で、破棄後にステータスメッセージ本文だけが直前操作のまま残る不整合を発見した。`discardPendingStudioFeedback()` を追加し、破棄後は `保留 0`、反映disabled、`保留中のStudio修正を破棄しました。` に戻ることを再確認した。
- `split at playhead` は既存patch契約だけでは安全に表現できないことを確認した。`insert_segment` は候補由来のsource/trackを使うため、選択済みV1クリップの同一素材・同一トラック分割としては使えない。schema変更なしの代替として、既にcompilerが対応している `move_segment.new_duration_frames` をmacOS patch modelへ通し、再生位置基準トリムを実装した。
- Computer Useで `CLP_0001` を選択し、再生位置がclip境界の時は `先頭を再生位置へ` / `末尾を再生位置へ` がdisabledであること、再生位置をframe 104へ移動すると両ボタンがenabledになることを確認した。
- `先頭を再生位置へ` 実行後は `保留 2`、`CLP_0001 の先頭を再生位置まで 4.3秒 詰めました`、ツールバー/下部の反映enabledを確認した。破棄後は `保留 0`、反映/破棄disabled、`保留中のStudio修正を破棄しました。` に戻る。
- 今回のM6追加スライスで `split_segment` を review patch schema / TS compiler / Swift patch model へ追加し、`Timeline.EditToolbar.SplitAtPlayhead` を実装した。`insert_segment` の候補由来track/source問題を避け、選択clipを同一トラック上で左右2clipへ分割する契約にした。
- TS runtimeでは、分割後のleft/right source range、timeline duration、同一metadata保持、caption分割、境界playhead拒否をテストで固定した。Swift側では `ReviewPatchDocument` round-trip、`TimelineSplitPlan`、`StudioFeedbackSession` の競合/changedClip追跡をテストした。
- Computer Useで `CLP_0001` を選択し、clip境界では `分割` disabled、再生位置 `00:00:09:03` ではenabled、実行後は `保留 1` と反映enabled、破棄後は `保留 0` と反映disabledに戻ることを確認した。
- 今回のM6追加スライスで、選択クリップの左右端に `Timeline.TrimHandle.Start.*` / `Timeline.TrimHandle.End.*` を追加し、ドラッグ量をフレームへ変換して `TimelineDragTrimPlan` から既存の `trim_segment` + duration-aware `move_segment` 保留patchへ変換するようにした。
- Computer Useで `CLP_0001` を選択し、先頭ハンドルを右へドラッグすると `保留 2`、`CLP_0001 の先頭をドラッグで 0.7秒 詰めました`、反映enabledになることを確認した。破棄後は `保留 0` と反映disabledへ戻る。
- 同じく末尾ハンドルを左へドラッグすると `保留 2`、`CLP_0001 の末尾をドラッグで 0.5秒 詰めました`、反映enabledになることを確認した。破棄後は `保留 0` と反映disabledへ戻る。
- このM6追加スライスでは、`Timeline.EditToolbar.MultiSelectMode` を追加し、`selectedTimelineClipIDs` を使って複数選択状態を保持するようにした。初期実装は承認/却下の一括操作から開始し、トリム/分割/差し替え/検索は誤操作を避けるためdisabledにした。後続M6.5では同一トラック複数リップル削除、0.5秒移動、選択範囲ループへ拡張済み。
- 当時のComputer Useでは `複数選択` をオンにし、`CLP_0001` と `CLP_0002` を通常クリックで選択すると、両方のAX Valueが `選択中` になり、ツールバーが `2クリップ選択` と表示し、承認/却下の一括操作がenabledになることを確認した。
- 同じ状態で `却下` を実行すると `保留 2 / 却下 2` と `2件のクリップを却下として保留しました。` が表示され、破棄後は `保留 0` と反映/破棄disabledへ戻る。複数選択モードをオフにすると `CLP_0001` が未選択、主クリップ `CLP_0002` だけが選択中へ即時に戻ることも確認した。
- `build_and_run --verify` は初回openがAppleSystemPolicyで即終了した場合に再openしない検証スクリプト側の弱さを露出した。verifyループ内でプロセス不在時に再openするようにし、同じコマンドが再度passすることを確認した。
- 今回のM6追加スライスで、Transportのstep backward/forwardを1秒単位から1フレーム単位へ変更した。`Transport.StepBackward` は `1フレーム戻る（,）`、`Transport.StepForward` は `1フレーム進む（.）` としてAX helpにも出る。
- `J/K/L` はmacOSメニューの素のkeyEquivalentにはせず、既存の `TimelineShortcutButtons` に合わせてタイムラインフォーカス時だけ効く隠しボタンとして実装した。`J` は逆シャトル、`K` は停止、`L` は順シャトルで、`J` / `L` の連打は 1x / 2x / 4x を循環する。これにより検索欄やテキスト入力を奪わず、NLE経験者向けの手癖だけをタイムライン上で有効にする。
- Command Paletteには `逆再生`、`再生を停止`、`1フレーム戻る`、`1フレーム進む` を追加し、`transport`、`j`、`k`、`l`、`space`、`comma`、`1フレーム` などで検索できるようにした。`j` は逆再生に紐づけ、1フレーム戻しは `,` / `comma` へ寄せた。
- Computer UseでTransportを再確認し、`L` で `再生 1x` が出てタイムコードが進むこと、終端付近から `Transport.PlayReverse` で `逆再生 1x` が出て `00:01:09:23` から `00:01:03:07` まで戻ること、`Transport.StepForward` / `Transport.StepBackward` で `00:00:00:00` と `00:00:00:01` を1フレーム単位で往復できることを確認した。
- 今回のM6追加スライスで、`TimelineRollTrimPlan` を追加し、選択clipの前/次編集点を0.5秒単位で左右へ送る `Timeline.EditToolbar.RollIncomingLeft/Right` と `Timeline.EditToolbar.RollOutgoingLeft/Right` を実装した。
- ロールトリムは隣接clipが同一track上で接していること、素材duration、削除保留がないことを確認し、左右2clipの `trim_segment` と `move_segment` 合計4操作へ変換する。schema変更は不要で、既存patch preview lifecycleを使う。
- Computer Useで `CLP_0002` を選択し、前/次編集点のロールボタンがenabledになることを確認した。`前編集点←` は `CLP_0001 / CLP_0002` の `保留 4`、`次編集点→` は `CLP_0002 / CLP_0004` の `保留 4` として生成され、どちらも破棄後に `保留 0`、反映/破棄disabledへ戻った。
- 今回のM6追加スライスで、`TimelineSlipTrimPlan` を追加し、選択clipのタイムライン位置と尺を固定したまま、source in/outだけを0.5秒前後へ送る `Timeline.EditToolbar.SlipLeft/Right` を実装した。
- スリップトリムはsource range、素材duration、削除保留を確認し、選択clip1件の `trim_segment` 1操作へ変換する。schema変更は不要で、既存patch preview lifecycleを使う。
- Computer Useで `CLP_0002` を選択し、`スリップ←/→` がenabledになることを確認した。`スリップ←` と `スリップ→` はそれぞれ `保留 1` として生成され、ステータスに「タイムライン上の位置と尺は変わりません。」を表示し、どちらも破棄後に `保留 0`、反映/破棄disabledへ戻った。
- 今回のM6追加スライスで、`TimelineExtendTrimPlan` を追加し、選択clipの先頭/末尾を前後の空きスペースとsource handleの範囲で0.5秒外側へ伸ばす `Timeline.EditToolbar.ExtendStart/End` を実装した。
- エクステンドトリムは隣接clipに重ならないgap、source range、素材duration、削除保留を確認し、選択clip1件の `trim_segment` と duration-aware `move_segment` の2操作へ変換する。schema変更は不要で、既存patch preview lifecycleを使う。
- Computer UseでA1の `CLP_0003` を選択し、`先頭を伸ばす` / `末尾を伸ばす` がenabledになることを確認した。どちらも `保留 2` として生成され、ステータスに「空きスペースと素材の余白を使って保留しました。」を表示し、破棄後に `保留 0`、反映/破棄disabledへ戻った。
- 今回のM6追加スライスで、Mediaパネルの `プレビュー準備` に `MediaPanel.SourcePreviewButton.*` を追加し、解析済み素材をViewerで直接確認できる最小source monitor/bin導線を実装した。
- `StudioViewModel.sourceMonitorAssetID` を追加し、source monitor中はViewer selection/audio/nextをタイムライン文脈から切り離す。Viewerは素材のdisplayName、`ソース確認中` badge、source range、Transportの `ソース確認中 <filename>` を表示する。
- Computer Useで `AST_610FB4A0` の `ソース確認` をクリックし、Viewerが `hybrid / AST_610FB4A0 / D4892.MP4 / 0:00-12:47` と `ソース確認中` に切り替わることを確認した。`タイムラインへ戻る` と、source monitor中のタイムラインclip選択はいずれもProgram previewへ戻り、下部ステータスも `タイムラインプレビューに戻りました。` に更新される。
- 今回のM6追加スライスで、Transportに `Transport.ToggleLoop` と `Transport.LoopRange` を追加し、選択clipからループ範囲を設定できるようにした。`TimelinePlaybackLoop` は範囲正規化、再生開始位置の準備、順/逆方向の境界ラップをCore側で扱う。
- Command Paletteと再生メニューには `選択クリップをループ`、`ループ再生をオン/オフ`、`ループ範囲を解除` を追加した。タイムラインフォーカス時の `R` は選択clipをループ範囲にし、以後はオン/オフを切り替える。
- Computer Useで `CLP_0001` を選択して `R` を押すと、Transportが `ループ 00:00:00:00-00:00:11:15` を表示し、終端手前 `00:00:11:05` から順方向再生すると `00:00:06:00 再生 1x` として範囲内へ戻って再生継続することを確認した。
- 今回のM6追加スライスで、Timeline上部に `Timeline.ViewportControls` を追加した。拡大、縮小、倍率スライダー、全体表示、100%リセット、現在倍率ラベルを同じ操作群として表示する。
- `TimelineViewportScale` が `fit to window` と倍率表示のlane幅計算を担い、固定の `totalFrames * 3.2` 表示から、全体把握と詳細編集を切り替えられる状態へ変更した。
- Computer Useで `Timeline.FitToWindow` を押すと `Timeline.ZoomLabel` が `全体表示` になり、`Timeline.ZoomSlider` がdisabledになることを確認した。続けて `Timeline.ZoomIn` を押すと `160%` へ戻り、`Timeline.ResetZoom` で `100%` へ戻ることも確認した。
- M6 benchmark auditで、CapCut / FCPX / Premiere CCに共通する「全体表示と詳細編集の切替」「ズーム状態の可視化」「ショートカットと画面操作の併存」を `Benchmark Notes` に正準化した。
- `49-timeline-zoom-controls-current.png` で、現在の実画面に `Timeline.ViewportControls`、倍率スライダー、`全体`、`100%`、現在倍率ラベルが表示されることを証跡化した。
- Computer UseのAX stateでも `Timeline.ZoomOut`、`Timeline.ZoomSlider`、`Timeline.ZoomIn`、`Timeline.FitToWindow`、`Timeline.ResetZoom`、`Timeline.ZoomLabel` を確認し、公式NLEベンチマークに基づく表示切替導線が現行UIに存在することを再確認した。
- 今回のM6後追加スライスで、クリップ本体ドラッグによる `TimelineClipMovePlan` を追加し、移動先が編集点、再生位置、マーカー、タイムライン先頭に近い場合は吸着して `move_segment` として保留するようにした。
- 追加のユーザー確認で、見た目の移動後に再生が古いrough-cutへ残ること、重なる移動が拒否されること、トランジションdrop先が分かりにくいことが分かったため、未保存手編集中はtimeline preview再生を外し、重なった同一トラックclipを右へ押し出す複数 `move_segment` に変換し、空の編集点drop targetをアクセント付きの `+` として広げた。
- 同じスライスで `Timeline.TransitionPresetPalette` と編集点上の `Timeline.TransitionDropTarget.*` を追加し、トランジションプリセットのドラッグ&ドロップを `set_transition` patch operationとして `timeline.transitions` へ反映できる契約にした。保存前のViewerは元素材を追従再生し、未保存transition範囲では `Viewer.TransitionPreviewBadge` と2枚目のsource overlayで簡易クロスフェードを表示する。完成音声や複数トラック合成を含む正確な確認は保存/更新後のrender previewで行う。
- 実機smokeで、`CLP_0001` を重なる位置へドラッグするとdrop位置に残り、`未保存 5` と `重なった 4 件を後ろへ送っています` が表示され、Viewer/Transportは古いrough-cutではなくin-memory timeline由来のsource playbackへ切り替わることを確認した。破棄後は `未保存 0`、`保存して更新` / `破棄` disabledへ戻る。
- 初回のAX確認では `Timeline.TransitionPreset.crossfade` が横スクロールの右外へ押し出されていたため、プリセットパレットを選択clip/複数選択の直後へ移動した。再確認ではプリセットが表示範囲内に出て、そこからV1編集点の `+` へdropできた。
- `クロスフェード` を `CLP_0001 → CLP_0002` の編集点へdropすると、`未保存 1`、編集点 `crossfade 12f`、Viewer `クロスフェード 50%` badge/overlayが出ることをComputer Useで確認した。証跡は `50-magnetic-drag-displacement-unsaved.png`、`51-magnetic-drag-discard-reset.png`、`52-crossfade-drop-live-preview.png`。
- `swift test --filter TimelineClipMovePlanTests --filter TimelineTransitionDropPlanTests --filter ReviewPatchDocumentTests` は 15 tests / 0 failures、`npx vitest run tests/e2e.test.ts --testNamePattern "set_transition|move_segment updates timeline position"` は 2 tests / 0 failures、`npx tsc --noEmit` は成功した。

## Remaining Risks

- M6/M6.5の直接編集は、可視ツールバー、承認/却下、複数選択の一括承認/却下、先頭/末尾トリム、リップル削除、再生位置基準トリム、split at playhead、ドラッグトリム、クリップ本体の磁気スナップ移動、重なり時の後続clip押し出し、トランジションのドラッグ/クリック適用、ロールトリム、スリップトリム、エクステンドトリム、Mediaパネルからのsource monitor確認、source monitor素材の再生位置追加、source-bin rowのquick drag/candidate cue/quick insert、source候補カードのtimeline drag/drop、source candidate drag-time ghost、source candidate occupied-lane lift、source候補のmarked insert/drop範囲、source range handle drag、marked source rangeでの選択clip差し替え、edge/middle-spanning marked overwriteとpre-click範囲/影響preview、差し替え/検索入口、J/K/Lシャトル、1フレーム送り/戻し、選択clipのloop/range再生、タイムライン拡大/縮小/全体表示、反映/戻す/破棄、保留状態同期まで実装済み。永続bin/thumbnail管理はM8級の拡張として残る。
- `video-os-studio-m6-completion-audit.md` でM6スコープを要件ごとに監査し、source in/out、insert/overwrite、永続bin/thumbnail、overview mini-map、長尺密度/性能、VoiceOver実読み上げ/FKA設定変更/コントラスト定量をM8/M9または非ブロッキングなスポット確認へ明示的に分離した。
- Candidate Swap / Footage Search / Clip Inspector / Media / Settings / Timeline の主要ラベル、型、品質フラグ、準備状態、頻出データラベルは日本語表示へ寄せた。候補理由、文字起こし、解析本文、CLI契約値、ファイル名、モデル名、プロジェクトIDはデータ由来の原文または診断値として残す。現状は「原文」ラベル、ツールチップ、monospace診断として明示し、検索/実行契約値は壊していない。
- Footage Search は直接メニュー導線、空状態、実データ検索結果カード、AX初期フォーカス、検索語句から検索ボタンへのTab順を再確認済み。検索語句入力とEnter検索は動作し、Candidate SwapからReturnで開いた場合も検索語句フィールドへフォーカスする。
- Candidate Swap は再起動直後の `Cmd+Shift+S` 起動と、候補0件空状態の中央主要ボタンへの視覚/AXフォーカスを確認済み。Tab/Shift+Tabで閉じるボタンと主操作を往復でき、ReturnでFootage Searchへ遷移する。
- エージェントパネルのジョブ、サンドボックス、書き込み契約、成果物範囲、違反理由は日本語補助付きにした。各パネルのartifact名、CLI由来の実行ログ、データ本文には英語/技術語が残るため、編集者向けに翻訳すべき値と診断情報として残すべき値の線引きは継続課題。
- プロジェクト切替はメニュー化済みで、常時1行分の横スクロール領域は使わない。多数プロジェクト時の検索/最近使った順は追加改善候補として残る。
- アクセシビリティはスクリーンショットとAXツリー中心の確認であり、主要導線のキーボード操作ブロッカーは解消した。実VoiceOverの音声読み上げ、macOSシステム設定を変更したFull Keyboard Access検証、コントラスト定量測定は追加のスポット確認として残る。
- 追加した工程コンテキストバナー、ソース確認中バッジ、プレビュー全尺/A1連続診断、納品Quick Actionsの不足/QA/検証サマリーは、コード、単体テスト、ビルド、直接artifact検査に加えて、Computer Use の実ウィンドウ確認でも再確認した。
- A1音声入りrough-cutの再レンダーと `./script/build_and_run.sh verify` は成功した。今回の追加確認で、`プレビュー音声あり` と `構成注意` の画面証跡を `45-timeline-preview-composition-warning.png` として取得済み。
- 納品工程は右パネル上部で実行可否、不足成果物、QA、パケット検証、出力先を読めるようにしたため、US-09はコード/状態テスト上は解消済みとする。VoiceOver実読み上げとコントラスト定量は非ブロッキングなスポット確認として残る。
- `lively-talk-pv` は現行UIで `空白詰めプレビュー` として区別できるようになった。再レンダー後の `rough-cut.mp4` は映像/音声とも46.25秒、format metadata `video_os_xfade_count=1`、`render-report.json` は `parity_pass: true` で、末尾crossfade 1件はrenderer出力に反映されている。残る論点は、NLE経験者がtimeline span 57.33秒とrough-cut 46.25秒の違いを「空白を詰める仕様」と受け入れられるか、また黒尺込みの全尺確認が必要な導線をどう出すかである。

## Retest Notes

- `swift test --filter TimelineClipMovePlanTests --filter TimelineTransitionDropPlanTests --filter ReviewPatchDocumentTests` は、クリップ本体ドラッグの磁気スナップ移動、トランジションドロッププラン、`set_transition` patch round-trip追加後に 15 tests / 0 failures で成功した。追加の全体確認として `swift test` も 312 tests / 0 failures で成功した。
- `npx tsc --noEmit` と `npx vitest run tests/e2e.test.ts tests/m45-schema-compat.test.ts` は、TypeScript compiler patch契約の `set_transition` 追加後に成功した。Vitestは 38 tests / 0 failures。
- `./script/build_and_run.sh --verify` は、署名済み `.app` bundle metadata / `PkgInfo` / `Contents/Resources` を補った後に成功した。
- Computer Use / CGEvent / `screencapture` による実ドラッグ確認で、クリップ本体の重なりdrag、source playback追従、クロスフェードchipのV1編集点drop、Viewer badge/overlay、`未保存` count、`破棄` 復帰を確認した。`保存して更新` はユーザー指示どおり今回の直接操作修正から切り分け、非破壊fixtureで別途確認する。
- 追加修正で、クリップ本体ドラッグとトランジションdropは `model.timeline` を即時更新するようにした。既存トランジションはクリック選択と横ドラッグduration調整に対応し、下部バーの文言は `未保存` / `保存して更新` に変更した。
- `swift test --filter TimelineClipMovePlanTests --filter TimelineTransitionDropPlanTests` は、即時表示更新helperとtransition upsert追加後に 10 tests / 0 failures で成功した。`swift build --target VideoOSStudio` も成功した。
- 追加修正で、未保存の手編集がある間は古いtimeline previewではなくin-memory timelineのclip選択から元素材を再生するようにした。重なるクリップ本体移動は同一trackの後続clipを右へ押し出す複数 `move_segment` として即時表示/保存patchの両方へ反映する。
- `swift test --filter TimelineClipMovePlanTests --filter TimelineTransitionDropPlanTests` は、重なり押し出しと未保存手編集の即時再生参照切替後に 10 tests / 0 failures で成功した。
- 追加修正で、未保存transition範囲をCore側の `activeVisualTransitionPreview` で判定し、Viewerに簡易クロスフェードoverlayと `Viewer.TransitionPreviewBadge` を出すようにした。durationを伸ばしたtransitionはactive範囲も広がり、`cut` は空の編集点として扱われる。
- `swift test --filter TimelineTransitionDropPlanTests` は、active transition preview判定追加後に 7 tests / 0 failures で成功した。`swift build --target VideoOSStudio` も成功した。
- `swift test --filter TimelineClipMovePlanTests --filter TimelineTransitionDropPlanTests` は、実機smoke前の最終集中確認として 12 tests / 0 failures で成功した。`swift build --target VideoOSStudio` と `git diff --check` も成功した。
- `保存して更新` は、一時fixture `m6-save-update-smoke-20260626` で保存更新が内部実行するpatch compile pathを検証した。6/6 opsが反映され、timeline hashは `4beac091ea8dce45` から `de65c94659385c8c` へ変わり、`CLP_0001/0002/0004/0005/0007` は `24/303/663/1002/1422` frameへ保存され、`CLP_0001 → CLP_0002` は `crossfade 12f` として保存された。preview manifestの `base_timeline_hash` とpatch historyの `result_timeline_hash` も `de65c94659385c8c` で一致し、backupは元のframeを保持していた。
- ただしComputer Useは同時点で `VideoOSStudio` / bundle id / app pathいずれも `cgWindowNotFound` を返し、直接 `FeedbackStatus.ApplyAndPreviewButton` をクリックする可視smokeは未完了だった。2026-06-26 19:06 JSTにも一時fixtureを再作成してアプリを再起動したが、CGWindowには `Video OS Studio` が出る一方でAX windowsは空、frontmost/isActiveはfalse、`screencapture` も `could not create image from rect` で同じブロッカーだった。2026-06-26 19:21 JSTの再試行では、Computer Useは引き続き `cgWindowNotFound`、全画面 `screencapture` は3024x1964の黒画像になった。その後、人間操作で `000-m6-save-update-human-20260626` fixture上の `保存して更新` を押して想定通り完了することを確認した。
- 人間操作後のartifact readbackでは、`studio_patch_2026-06-26T14-20-49Z.json` が5件の `move_segment` を保存し、timeline hashは `4beac091ea8dce45` から `6c63eef0c16f4bb8` へ変わった。`CLP_0001/0002/0004/0005/0007` は `0/279/639/978/1398` frameから `12/291/651/990/1410` frameへ保存され、`preview-manifest.json` の `base_timeline_hash` とpatch historyの `result_timeline_hash` は `6c63eef0c16f4bb8` で一致し、backupは元のhashを保持していた。正準トラッカーでは `TEST-49 Passed` として閉じた。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUS-24/UX-41/TEST-48/TEST-49を更新し、114件の追跡行（Story 24 / Issue 41 / Test 49）、残課題0件、修正/合格114件、未解決P0/P1 0件、重複ID 0件として更新した。inspect NDJSONとOverviewプレビューも更新済み。
- `swift build --target VideoOSStudio` は、Footage Searchのタグ正規化とAXラベル追加後に成功した。
- `swift build --package-path .` は、Footage Search / Candidate Swap のFocusStateとAXヒント追加後に成功した。
- `swift test --package-path apps/macos-studio --filter ProjectTimelinePreviewDiagnosticsTests` は、プレビュー全尺/不足/なし、非隣接の素材再利用検出を追加後に 5 tests / 0 failures で成功した。
- `swift build --package-path apps/macos-studio` は、プレビュー全尺診断と工程コンテキストバナー追加後に成功した。
- `swift build --target VideoOSStudio` は、エージェント書き込み契約/違反理由の日本語補助表示追加後に成功した。`swift test --filter VideoOSAgentJobReadinessTests` は 3 tests / 0 failures、`swift test --filter VideoOSAgentJobTests` は 10 tests / 0 failures、`swift test` は 260 tests / 0 failures で成功した。`./script/build_and_run.sh --verify` も終了コード0で通過した。
- `swift build --target VideoOSStudio` は、Clip Inspector の根拠サマリーとroot evidence label日本語化後に成功した。`swift test --filter ProjectEvidenceStoreTests` は 2 tests / 0 failures で成功した。
- Node/ffprobeの直接検査で、`projects/lively-talk-pv` は timeline 57.33秒に対して rough-cut 46.25秒、`projects/lively-alt-vol5` は timeline 91.33秒に対して preview 91.36秒、同一素材隣接2件、cut 5件のみと確認した。
- `swift test --filter ProjectMediaResolverTests` は、古い `preview-manifest.json` のプレビュー候補を除外する回帰テスト追加後に 30 tests / 0 failures で成功した。
- `swift test --filter ProjectTimelinePreviewDiagnosticsTests` は、A1音声の同一素材隣接を含む診断更新後に 5 tests / 0 failures で成功した。
- `npx vitest run tests/render-rough-cut.test.ts` は、A1音声抽出、timeline audio mix filter、mux args追加後に 22 tests / 0 failures で成功した。
- `npm run build -- --pretty false` は、`render-rough-cut.ts` のA1音声mux追加後に成功した。
- `npx tsx scripts/render-rough-cut.ts --project projects/operator-participant-voices` は、A1音声mix追加後に成功した。`ffprobe` では `rough-cut.mp4` のvideo/audio streamがともに `start_time=0`、duration `69.875s`、audio `aac 2ch`。`render-report.json` は `parity_pass: true`、`audio_clip_count: 3`、`audio_rendered: true`、`bgm_rendered: false`。
- `swift test --filter ProjectTimelinePreviewDiagnosticsTests` は、プレビュー音声stream欠落診断追加後に 6 tests / 0 failures で成功した。
- `swift build --target VideoOSStudio` は、Viewerヘッダーの `プレビュー音声あり/なし` 診断追加後に成功した。
- `swift build --target VideoOSStudio` は、Viewerのソース確認中バッジ、右パネル工程表示、解析準備/素材接続文言の日本語化後に成功した。
- `swift build --target VideoOSStudio` は、納品Quick Actionsに不足成果物、QA、パケット検証、出力先を追加後に成功した。`swift test --filter ProjectRenderPackageStatusTests` は 3 tests / 0 failures、`swift test --filter ProjectHandoffExportTests` は 7 tests / 0 failures で成功した。
- Computer Use/AX/`screencapture` による最終画面再撮影は環境側でブロックされたため、今回追加分の視覚証跡は未追加。`list_apps`、CGWindow一覧、失敗コードを記録し、コード/テスト/artifact検査の合格とは分離して扱う。
- `swift build --package-path .` と `./script/build_and_run.sh --verify` は、Viewerヘッダー診断表示の追加後に成功した。
- `swift test --package-path . --filter StudioCommandPaletteCommandTests` は、Candidate Swapコマンド有効条件の追加後に 4 tests / 0 failures で成功した。
- `swift build --package-path .` と `./script/build_and_run.sh --verify` は、Candidate Swapのショートカット有効状態再発行とAccessibilityFocusState追加後に成功した。
- `swift build --package-path apps/macos-studio --target VideoOSStudio` と `./script/build_and_run.sh --verify` は、Candidate Swap空状態の中央主要ボタンと明示フォーカスリング追加後に成功した。`41-candidate-swap-empty-primary-action-ja-3024x1964.png` で視覚フォーカスリングを確認し、追加確認ではAX focused elementも「素材をさらに検索」ボタンになった。
- `swift build --package-path apps/macos-studio --target VideoOSStudio` と `./script/build_and_run.sh --verify` は、短いプレビューを `プレビュー不足` として警告表示する修正後に成功した。
- `swift test --package-path apps/macos-studio --filter ProjectTimelinePreviewDiagnosticsTests --filter ProjectMediaResolverTests --filter ProjectPlaybackContractStatusTests` は 42 tests / 0 failures で成功した。
- Computer Useで `lively-talk-pv` へ切り替え、修正後のAX/実画面状態が `再生契約: プレビュー不足`、上部ラベルが `右パネル表示`、ProjectMenuが縦メニューであることを確認した。
- `npx tsx scripts/render-rough-cut.ts --project projects/lively-talk-pv` は現行timelineからの再レンダーに成功した。出力は21 clips、crossfades 1、duration 46.3s。`render-report.json` は `timeline_span_sec: 57.333`、`gap_sec: 10.333`、`expected_rendered_sec: 46.302`、`actual_rendered_sec: 46.25`、`parity_pass: true`、`audio_rendered: true`、`bgm_rendered: true`。
- `ffprobe projects/lively-talk-pv/09_output/rough-cut.mp4` では video h264 46.25s、audio aac 46.25s、format tag `video_os_xfade_count=1` を確認した。
- `swift test --package-path apps/macos-studio --filter ProjectTimelinePreviewDiagnosticsTests` は、`render-report.json` の期待尺に一致する空白詰めrough-cutを `プレビュー不足` にしない回帰テスト追加後に 7 tests / 0 failures で成功した。
- `swift test --package-path apps/macos-studio --filter ProjectTimelinePreviewDiagnosticsTests --filter ProjectMediaResolverTests --filter ProjectPlaybackContractStatusTests` は最終確認で 43 tests / 0 failures で成功した。
- `./script/build_and_run.sh --verify` は、空白詰めプレビュー表示修正後に成功した。Computer Useで `lively-talk-pv` を選び、Viewer/AX stateが `再生契約: 空白詰めプレビュー`、`空白詰めプレビュー 46.2s/期待46.3s（空白10.3s詰め）`、`クロスフェード 1件` を含むことを確認した。
- `swift test --package-path apps/macos-studio --filter ProjectTimelinePreviewDiagnosticsTests` は、`カットのみ` と `同一素材連続` の構成注意ラベル追加後に 7 tests / 0 failures で成功した。
- `swift build --package-path apps/macos-studio --target VideoOSStudio` は、Viewerの短い `構成注意` バッジとProjectPanelの `照合済み・構成注意` 状態追加後に成功した。
- Computer Useで `operator-participant-voices` の実画面を再確認し、ProjectMenu、`右パネル表示`、`構成注意` バッジ、`カットのみ 4件`、`同一素材連続 A1 2件` が縦折れせず表示されることを確認した。証跡は `45-timeline-preview-composition-warning.png`。
- Computer Useで `Cmd+Shift+S` からCandidate Swapを開き、AX focused elementが `素材をさらに検索` ボタンになること、EnterでFootage Searchへ遷移して `検索語句` text fieldへフォーカスすることを確認した。
- `swift build --package-path apps/macos-studio --target VideoOSStudio` は、Marlin/タイムラインのデータラベル日本語化後に成功した。`swift test --package-path apps/macos-studio --filter ProjectTimelinePreviewDiagnosticsTests` は 7 tests / 0 failures、`swift test --package-path apps/macos-studio --filter ProjectMarlinEvaluationStatusTests` は 6 tests / 0 failures で成功した。
- `./script/build_and_run.sh --verify` は、最終ローカライズ後の署名済みアプリ起動とメインウィンドウ確認まで成功した。Computer Useで `Marlin評価` の説明/代表バケット、RAG `492件`、タイムラインマーカー `b01: 導入` / `b02: 価値訴求`、音声キュー `音声ストーリー / 発話 / 回収`、A1音声 `元クリップ音声` を確認した。証跡は `46-timeline-marlin-localized-ja.png`。
- `swift build --package-path apps/macos-studio --target VideoOSStudio` と `./script/build_and_run.sh --verify` は、Candidate Swap / Footage Search のAX focusable化後に成功した。Computer Useで `Cmd+Shift+S`、Tab、Shift+Tab、Returnを操作し、Candidate Swap主操作と閉じるボタンの循環、Footage Searchの検索語句から検索ボタンへのTab順を確認した。証跡は `47-candidate-swap-fka-tab-order-ja.png` と `48-footage-search-search-button-tab-ja.png`。
- `swift test --package-path apps/macos-studio` は最終確認で 263 tests / 0 failures まで通った。
- `swift test --package-path apps/macos-studio --filter TimelineViewportScaleTests --filter StudioCommandPaletteCommandTests` は、タイムライン表示倍率のlane幅計算とコマンド検索を追加後に 8 tests / 0 failures で成功した。
- `swift test --package-path apps/macos-studio` は、タイムライン拡大/縮小/全体表示追加後に 305 tests / 0 failures で成功した。`./script/build_and_run.sh --verify` も終了コード0で通過した。
- Computer Useで `Timeline.ViewportControls`、`Timeline.ZoomOut`、`Timeline.ZoomSlider`、`Timeline.ZoomIn`、`Timeline.FitToWindow`、`Timeline.ResetZoom`、`Timeline.ZoomLabel` を確認した。`全体` は `全体表示` とslider disabled、`拡大` は `160%`、`100%` は標準倍率へ戻ることを確認した。
- M6 benchmark/completion auditでは、Adobe / Apple / CapCut公式ソース、現行UIスクリーンショット `49-timeline-zoom-controls-current.png`、Computer Use AX state、正準UXトラッカーの108追跡行を突合し、CapCut / FCPX / Premiere CC基準の表示倍率導線が文書とトラッカーに残ることを確認した。
- M6 full completion auditでは、`swift test --package-path apps/macos-studio` 305/0、`npx tsc --noEmit`、`npx vitest run tests/e2e.test.ts tests/m45-schema-compat.test.ts` 37/0、`./script/build_and_run.sh --verify`、Computer Useの選択/ズーム/source monitor可視smokeを2026-06-25 19:44-19:46 JSTに取り直した。M6スコープ内の残課題は0件として扱う。
- `swift build --package-path . --target VideoOSStudio`、`swift test --package-path .`、`./script/build_and_run.sh --verify` は、2026-06-25 15:14 JSTの再確認で成功した。Swiftテストは 263 tests / 0 failures。
- Computer Useでタイムライン再生ボタンをクリックし、AX上の再生位置が `00:00:00:00` から `00:00:02:01` へ進むこと、停止後に `00:01:09:23` でボタンが `タイムラインを再生` に戻ることを確認した。Viewer/Timelineの再生契約表示は維持された。
- `docs/ux/video-os-studio-ux-tracker.xlsx` は追加更新で64件の追跡行（Story 9 / Issue 24 / Test 31）、残課題0件、修正/合格64件、未解決P0/P1 0件、数式エラー0件、重複ID 0件として再importできた。
- `docs/ux/video-os-studio-ux-tracker-preview.png` はOverviewプレビューとして再生成済みで、最新スクリーンショットは `docs/ux/screenshots/48-footage-search-search-button-tab-ja.png` を指す。
- `git diff --check` は空出力で通過した。
- `swift build --package-path . --target VideoOSStudio` は、M6直接編集ツールバー追加後に成功した。
- `swift test --package-path .` は、`StudioFeedbackSession` の approve/reject/pending trim 回帰テスト追加後に 266 tests / 0 failures で成功した。
- `./script/build_and_run.sh --verify` は、直接編集ツールバーとセッション同期修正後に成功した。
- Computer Useで `Timeline.EditToolbar` を確認した。未選択時は主操作がdisabled、`CLP_0001` 選択後は承認/却下/トリム/差し替え/検索がenabled、「先頭を詰める」後は `保留 1` と反映enabled、破棄後は `保留 0` とツールバー/下部ステータスバー両方の反映disabledを確認した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はM6直接編集スライスを追加し、67件の追跡行（Story 10 / Issue 25 / Test 32）、残課題0件、修正/合格67件、未解決P0/P1 0件として再生成した。Overviewプレビューも `docs/ux/video-os-studio-ux-tracker-preview.png` として更新済み。
- `swift build --package-path . --target VideoOSStudio` は、リップル削除追加後に成功した。
- `swift test --package-path .` は、`TimelineRippleDeletePlanTests` 追加後に 269 tests / 0 failures で成功した。
- `./script/build_and_run.sh --verify` は、リップル削除と破棄メッセージ修正後に成功した。
- Computer Useで `Timeline.EditToolbar.RippleDelete` を確認した。未選択時はdisabled、`CLP_0001` 選択後はenabled、実行後は `保留 5 / 却下 1` と `後続4件を 11.6秒 前へ詰めます`、反映enabledを確認した。破棄後は `保留 0`、反映disabled、`保留中のStudio修正を破棄しました。` に戻ることを確認した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はリップル削除スライスを追加し、70件の追跡行（Story 11 / Issue 26 / Test 33）、残課題0件、修正/合格70件、未解決P0/P1 0件として再生成した。Overviewプレビューも更新済み。
- `swift test --package-path apps/macos-studio` は、duration-aware `move_segment` と `TimelinePlayheadTrimPlanTests` 追加後に 273 tests / 0 failures で成功した。
- `./script/build_and_run.sh --verify` は、再生位置基準トリム追加後に成功した。
- Computer Useで `Timeline.EditToolbar.TrimStartToPlayhead` / `Timeline.EditToolbar.TrimEndToPlayhead` を確認した。未選択時disabled、選択clip境界disabled、clip内playheadでenabled、`先頭を再生位置へ` 実行後に `保留 2` / 反映enabled / 4.3秒トリムmessage、破棄後に `保留 0` / 反映disabledへ戻ることを確認した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` は再生位置基準トリムとsplit契約gapを追加し、74件の追跡行（Story 12 / Issue 28 / Test 34）、残課題1件、未解決P0/P1 1件として更新した。残課題はtrue split-at-playheadのpatch/compile契約設計。
- `npx tsc --noEmit` は、`split_segment` runtime追加後に成功した。
- `npx vitest run tests/e2e.test.ts tests/m45-schema-compat.test.ts` は、split schema/runtime回帰テスト追加後に 37 tests / 0 failures で成功した。
- `swift test --package-path apps/macos-studio` は、`ReviewPatchDocument`、`StudioFeedbackSession`、`TimelineSplitPlanTests` 追加後に 278 tests / 0 failures で成功した。
- `./script/build_and_run.sh --verify` は、split at playhead追加後に成功した。
- Computer Useで `Timeline.EditToolbar.SplitAtPlayhead` を確認した。未選択時disabled、選択clip境界disabled、clip内playheadでenabled、`分割` 実行後に `保留 1` / 反映enabled / 前半9.1秒・後半2.5秒message、破棄後に `保留 0` / 反映disabledへ戻ることを確認した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はsplit at playhead解消を追加し、76件の追跡行（Story 13 / Issue 28 / Test 35）、残課題0件、未解決P0/P1 0件として更新した。Overviewプレビューとinspect NDJSONも更新済み。
- `swift build --package-path apps/macos-studio --target VideoOSStudio` は、ドラッグトリムハンドル追加後に成功した。
- `swift test --package-path apps/macos-studio` は、`TimelineDragTrimPlanTests` 追加後に 281 tests / 0 failures で成功した。
- `./script/build_and_run.sh --verify` は、ドラッグトリム追加後に成功した。
- Computer Useで `Timeline.TrimHandle.Start.V1.CLP_0001` / `Timeline.TrimHandle.End.V1.CLP_0001` を確認した。先頭ハンドルを右へドラッグすると `保留 2` / 0.7秒message / 反映enabled、破棄後に `保留 0`。末尾ハンドルを左へドラッグすると `保留 2` / 0.5秒message / 反映enabled、破棄後に `保留 0` へ戻ることを確認した。
- `swift test --package-path apps/macos-studio` は、複数clip承認/却下テスト追加後に 283 tests / 0 failures で成功した。
- `npx tsc --noEmit` と `npx vitest run tests/e2e.test.ts tests/m45-schema-compat.test.ts` は複数選択スライス後も成功した。Vitestは 37 tests / 0 failures。
- `./script/build_and_run.sh --verify` は初回openのAppleSystemPolicy即終了で一度失敗したため、verifyループでプロセス不在時に `open_app` を再試行するよう修正し、同じコマンドが成功することを確認した。
- 当時のComputer Useで `Timeline.EditToolbar.MultiSelectMode` を確認した。オン後に `CLP_0001` と `CLP_0002` を通常クリックで複数選択でき、ツールバーは `2クリップ選択`、承認/却下enabled、トリム/リップル削除/分割/差し替え/検索disabledになった。M6.5第56/74で同一トラック複数選択の `リップル削除` はenabledへ拡張済み。`却下` 実行後は `保留 2 / 却下 2`、破棄後は `保留 0`、モードオフ直後に主クリップ1件へ即時復帰した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` は複数選択スライスを追加し、82件の追跡行（Story 15 / Issue 30 / Test 37）、残課題0件、修正/合格82件、未解決P0/P1 0件として更新した。Overviewプレビューとinspect NDJSONも更新済み。
- `swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests` は、transport command追加後に 5 tests / 0 failures で成功した。
- `swift build --package-path apps/macos-studio --target VideoOSStudio` は、Transportの1フレームstepとJ/K/Lショートカット追加後に成功した。
- `swift test --package-path apps/macos-studio` は、transport polish後の最終確認で 284 tests / 0 failures まで通った。
- `./script/build_and_run.sh --verify` は、transport polish後も成功した。
- Computer UseでTransportを再確認した。`Transport.StepBackward` / `Transport.PlayPause` / `Transport.StepForward` のAX label/helpが1フレーム操作を示し、ボタンクリックで1フレーム進み、タイムラインフォーカス時の `L` で再生、`K` で停止できることを確認した。`J` は後続のreverse shuttleスライスで逆再生へ変更済み。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はtransport polishスライスを追加し、85件の追跡行（Story 16 / Issue 31 / Test 38）、残課題0件、修正/合格85件、未解決P0/P1 0件として更新した。Overviewプレビューとinspect NDJSONも更新済み。
- `swift test --package-path apps/macos-studio --filter TimelineRollTrimPlanTests` は、ロールトリム追加後に 4 tests / 0 failures で成功した。
- `swift test --package-path apps/macos-studio` は、ロールトリム追加後の最終確認で 288 tests / 0 failures まで通った。
- `./script/build_and_run.sh --verify` は、ロールトリム追加後も成功した。
- Computer Useで `Timeline.EditToolbar.RollIncomingLeft/Right` と `Timeline.EditToolbar.RollOutgoingLeft/Right` を確認した。未選択時はdisabled、`CLP_0002` 選択後は前/次編集点ロールがenabledになり、`前編集点←` は `保留 4` と `CLP_0001 / CLP_0002` message、`次編集点→` は `保留 4` と `CLP_0002 / CLP_0004` messageを表示した。どちらも破棄で `保留 0`、反映/破棄disabledへ戻る。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はロールトリムスライスを追加し、88件の追跡行（Story 17 / Issue 32 / Test 39）、残課題0件、修正/合格88件、未解決P0/P1 0件として更新した。Overviewプレビューとinspect NDJSONも更新済み。
- `swift test --package-path apps/macos-studio --filter TimelineSlipTrimPlanTests` は、スリップトリム追加後に 4 tests / 0 failures で成功した。
- `swift test --package-path apps/macos-studio` は、スリップトリム追加後の最終確認で 292 tests / 0 failures まで通った。
- `./script/build_and_run.sh --verify` は、スリップトリム追加後も成功した。
- Computer Useで `Timeline.EditToolbar.SlipLeft` と `Timeline.EditToolbar.SlipRight` を確認した。未選択時はdisabled、`CLP_0002` 選択後は左右スリップがenabledになり、`スリップ←` は `保留 1` と「左へ 0.5秒」、`スリップ→` は `保留 1` と「右へ 0.5秒」のmessageを表示した。どちらも「タイムライン上の位置と尺は変わりません。」を明示し、破棄で `保留 0`、反映/破棄disabledへ戻る。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はスリップトリムスライスを追加し、91件の追跡行（Story 18 / Issue 33 / Test 40）、残課題0件、修正/合格91件、未解決P0/P1 0件として更新した。Overviewプレビューとinspect NDJSONも更新済み。
- `swift test --package-path apps/macos-studio --filter TimelineExtendTrimPlanTests` は、エクステンドトリム追加後に 4 tests / 0 failures で成功した。
- `swift test --package-path apps/macos-studio` は、エクステンドトリム追加後の最終確認で 296 tests / 0 failures まで通った。
- `./script/build_and_run.sh --verify` は、エクステンドトリム追加後も成功した。
- Computer Useで `Timeline.EditToolbar.ExtendStart` と `Timeline.EditToolbar.ExtendEnd` を確認した。未選択時はdisabled、A1の `CLP_0003` 選択後は先頭/末尾extendがenabledになり、`先頭を伸ばす` は `保留 2` と「先頭を 0.5秒 伸ばしました」、`末尾を伸ばす` は `保留 2` と「末尾を 0.5秒 伸ばしました」のmessageを表示した。どちらも破棄で `保留 0`、反映/破棄disabledへ戻る。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はエクステンドトリムスライスを追加し、94件の追跡行（Story 19 / Issue 34 / Test 41）、残課題0件、修正/合格94件、未解決P0/P1 0件として更新した。Overviewプレビューとinspect NDJSONも更新済み。
- `swift test --package-path apps/macos-studio --filter ProjectMediaResolverTests` は、source monitor用 `resolvePreviewStatus` 追加後に 31 tests / 0 failures で成功した。
- `swift test --package-path apps/macos-studio` は、source monitor/bin workflow追加後の最終確認で 297 tests / 0 failures まで通った。
- `./script/build_and_run.sh --verify` は、source monitor/bin workflow追加後も成功した。
- Computer Useで `MediaPanel.SourcePreviewButton.AST_610FB4A0`、`MediaPanel.ReturnToTimelineButton`、`MediaPanel.SourceMonitorStatus` を確認した。source確認クリックでViewer/Transportが `ソース確認中 D4892.MP4` になり、戻るボタンとタイムラインclip選択の両方でタイムラインプレビューへ復帰する。初回smokeで下部ステータスがsource monitor文言のまま残る不整合を見つけ、タイムライン選択時にも `タイムラインプレビューに戻りました。` へ更新するよう修正して再確認した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はsource monitor/bin workflowスライスを追加し、97件の追跡行（Story 20 / Issue 35 / Test 42）、残課題0件、修正/合格97件、未解決P0/P1 0件として更新した。Overviewプレビューとinspect NDJSONも更新済み。
- `swift test --package-path apps/macos-studio --filter TimelinePlaybackTransportTests` は、J/Lシャトル速度循環とsigned rate helper追加後に 2 tests / 0 failures で成功した。
- `swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests` は、`逆再生` コマンド追加と `j` の意味変更後に 5 tests / 0 failures で成功した。
- `swift test --package-path apps/macos-studio` は、reverse shuttle追加後の最終確認で 299 tests / 0 failures まで通った。
- `./script/build_and_run.sh --verify` は、reverse shuttle追加後も成功した。
- Computer UseでTransportを再確認した。`Transport.PlayReverse`、`Transport.PlayForward`、`Transport.PlaybackRate` が見え、`L` は `再生 1x`、`Transport.PlayReverse` は `逆再生 1x` を表示してタイムコードを逆方向へ進める。`Transport.StepForward` / `Transport.StepBackward` は `00:00:00:00` と `00:00:00:01` を1フレーム単位で往復した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はreverse shuttleスライスを追加し、100件の追跡行（Story 21 / Issue 36 / Test 43）、残課題0件、修正/合格100件、未解決P0/P1 0件として更新した。Overviewプレビューとinspect NDJSONも更新済み。
- `swift test --package-path apps/macos-studio --filter TimelinePlaybackTransportTests --filter StudioCommandPaletteCommandTests` は、loop/range helperとコマンド追加後に 10 tests / 0 failures で成功した。
- `swift test --package-path apps/macos-studio` は、loop/range playback追加後の最終確認で 302 tests / 0 failures まで通った。
- `./script/build_and_run.sh --verify` は、loop/range playback追加後も成功した。
- Computer Useで `CLP_0001` の選択、`R` によるループ範囲設定、Transportの範囲表示、終端手前からの順方向再生で範囲内へ戻ることを確認した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はloop/range playbackスライスを追加し、103件の追跡行（Story 22 / Issue 37 / Test 44）、残課題0件、修正/合格103件、未解決P0/P1 0件として更新した。Overviewプレビューとinspect NDJSONも更新済み。
- M6.5 Editing Feel / Magnetic UXを開始した。M6でclip move/drop後の反映は成立したが、FCPX/CapCut的な手触りには、ドラッグ中に移動先、吸着対象、押し出されるclipが見えることが必要だと整理した。
- 最初のM6.5スライスでは、`TimelineTrackRow` へ現在の `TimelineDocument` を渡し、drag changed中にも `TimelineClipMovePlan.make` を実行するようにした。target clipとdisplaced clipsはdrop後と同じ計算結果からoffsetし、snapがある場合は `Timeline.MagneticSnapIndicator` の縦ライン/アイコンで表示する。
- `swift build --target VideoOSStudio` はM6.5 drag-time MovePlan preview追加後に成功した。`swift test --filter TimelineClipMovePlanTests` は 5 tests / 0 failures、`./script/build_and_run.sh --verify` も終了コード0で成功した。
- ただしmacOS native画面取得は引き続きブロックされている。CGWindowには `Video OS Studio` が出るが、`screencapture -l` は `could not create image from window`、全画面screenshotは黒画像、AX windowsは空になるため、drag中のsnap line / target outline / displaced clip previewの可視motion確認は人間確認待ちとして `TEST-50 Blocked` に記録した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はM6.5開始行を追加し、117件の追跡行（Story 25 / Issue 42 / Test 50）、残課題2件、修正/合格115件、未解決P0/P1 2件として更新した。残課題はUS-25全体storyの継続とTEST-50可視motion確認ブロッカー。
- M6.5第2スライスでは、既存transitionの横ドラッグ中にも `StudioViewModel.previewTimelineTransitionDuration` が一時的な `TimelineTransitionDurationPreview` を保持し、`timelineWithTransitionDurationPreview` 経由でViewer overlayへ反映するようにした。drag中は完成済みtimeline preview playbackより素材ベースのProgram Viewerを優先するため、クロスフェードのduration変更がViewer側で見える前提になる。
- `TimelineTransitionDropTarget` はhover/drop対象の面積と反応を強め、空編集点の `+` targetを36pxから44pxへ広げた。既存transition dragはローカル幅だけでなくViewModel preview callbackを発火し、drop commitは従来通り `adjustTimelineTransitionDuration` で1回だけpatchへ積む。
- `swift build --target VideoOSStudio` はtransition drag live preview追加後に成功した。`swift test --filter TimelineTransitionDropPlanTests` は 7 tests / 0 failuresで成功した。`./script/build_and_run.sh --verify` も終了コード0で成功し、VideoOSStudio app PID 62402 が起動していることを確認した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-43/TEST-51を追加し、119件の追跡行（Story 25 / Issue 43 / Test 51）、残課題3件、修正/合格116件、未解決P0/P1 3件、重複ID 0件として更新した。残課題はUS-25全体story、TEST-50 clip drag motion確認、TEST-51 transition drag motion確認。
- M6.5第3スライスでは、video/overlayクリップを重なる位置へドラッグした場合に `TimelineClipMovePlan.laneLift` を作り、既存の空き互換レーンを再利用するかV2/O2などを生成して `move_segment.target_track_id` として保持するようにした。`TimelineTrackRow` はdrag中に一時レーンを開き、移動対象を上段へ見せる。audio clipは従来通り `displacements` で後続を押し出す。
- `ReviewPatchOperation.moveSegment`、`TimelineDocument.movingClip`、`runtime/compiler/patch.ts`、`schemas/review-patch.schema.json` は任意の `target_track_id` に対応した。別トラックへ移る場合はSwift即時表示とTS compiler適用の両方で古いtransition参照を除去する。
- `swift build --target VideoOSStudio`、`swift test --filter TimelineClipMovePlanTests`（9 tests / 0 failures）、`swift test --filter ReviewPatchDocumentTests`（8 tests / 0 failures）、`npx tsc --noEmit`、`npx vitest run tests/e2e.test.ts --testNamePattern "move_segment"`（3 passed）、`npx vitest run tests/m45-schema-compat.test.ts`（15 passed）が成功した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-44/TEST-52を追加し、121件の追跡行（Story 25 / Issue 44 / Test 52）、残課題3件、修正/合格118件、未解決P0/P1 3件、重複ID 0件として更新した。native drag中の可視motion確認は引き続きTEST-50/TEST-51の人間確認ブロッカーに集約している。
- M6.5第4スライスでは、空編集点のtransition可視targetを72pxへ広げ、実drop hit areaを最低112pxにした。編集点左右に細いaccent railを追加し、hover/drop中は高さ、scale、shadow、rail opacityが上がる。既存transitionのクリック選択と横ドラッグduration調整は維持した。
- `swift build --target VideoOSStudio` と `swift test --filter TimelineTransitionDropPlanTests`（7 tests / 0 failures）が成功した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-45/TEST-53を追加し、123件の追跡行（Story 25 / Issue 45 / Test 53）、残課題3件、修正/合格120件、未解決P0/P1 3件、重複ID 0件として更新した。実機drag/drop中の可視確認は引き続きTEST-50/TEST-51の人間確認ブロッカーに集約している。
- M6.5第5スライスでは、複数選択したclipを `TimelineClipGroupMovePlan` で一つのdrag groupとして移動できるようにした。anchor clipのsnap解決後の差分を選択clip全体へ適用し、選択中clipはsnap/overlap障害物から除外し、未選択clipだけを磁気的に後ろへ送る。`StudioViewModel.dragMoveTimelineClip` は選択内dragをgroup moveとして即時timelineへ適用し、`TimelineTrackRow` は同一行内のgroup previewを表示する。
- `swift build --target VideoOSStudio` は成功した。`swift test --filter TimelineClipMovePlanTests` は一度 12 tests / 0 failuresで成功したが、その後の再実行では生成 `.xctest` bundle がmacOSの `library load denied by system policy` でロード拒否された。`dist/VideoOSStudio.app` はPID 20281で起動し、`Video OS Studio` ウィンドウ 1063x685 を確認済み。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-46/TEST-54を追加し、125件の追跡行（Story 25 / Issue 46 / Test 54）、残課題3件、修正/合格122件、未解決P0/P1 3件、重複ID 0件として更新した。残る操作感の磨き込みは、複数トラックをまたぐgroup drag previewの共有state化と人間のmotion確認。
- M6.5第6スライスでは、`activeMovePreview` / `activeGroupMovePreview` を `TimelineTrackRow` ローカルstateから `TimelinePanel` 所有のstateへ引き上げ、全track rowへBindingで渡すようにした。これにより、複数トラックをまたぐgroup selectionでも、drag中に各rowが同じ `TimelineClipGroupMovePlan` を参照して移動先を表示できる。単体clipのlane-lift previewはsource rowだけに限定し、他trackを不必要に広げない。
- `swift build --target VideoOSStudio` はcross-track group preview共有後に成功した。Core move operationsは変えていないため、新しいplanner testは追加していない。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-47/TEST-55を追加し、127件の追跡行（Story 25 / Issue 47 / Test 55）、残課題3件、修正/合格124件、未解決P0/P1 3件、重複ID 0件として更新した。実機drag中のmotion確認は引き続き人間確認待ち。
- M6.5第7スライスでは、ドラッグトリム完了時に `trim_segment` と duration-aware `move_segment` を未保存patchへ積むだけでなく、同じ操作列を `TimelineDocument.applyingTimelineTrimOperations` でin-memory timelineへ即時反映するようにした。これによりクリップ端を離した時点で表示位置、表示長、source range、Viewer/Transportの対象が更新される。
- `swift build --target VideoOSStudio` と `swift test --filter TimelineDragTrimPlanTests`（5 tests / 0 failures）が成功した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-48/TEST-56を追加し、129件の追跡行（Story 25 / Issue 48 / Test 56）、残課題3件、修正/合格126件、未解決P0/P1 3件、重複ID 0件として更新した。実機drag中のmotion確認は引き続き人間確認待ち。
- M6.5第8スライスでは、`TimelineTrackRow` にdrag trim中だけの `activeTrimPreview` を追加し、`TimelineTrimHandle` の `onChanged` から `TimelineDragTrimPlan` を生成して、drop前からclip offset/widthとscissors preview ringを更新するようにした。drag中の見た目とdrop後のcommitは同じtrim planを使う。
- `swift build --target VideoOSStudio` はdrag-time trim preview追加後に成功した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-49/TEST-57を追加し、131件の追跡行（Story 25 / Issue 49 / Test 57）、残課題3件、修正/合格128件、未解決P0/P1 3件、重複ID 0件として更新した。実機drag中のmotion確認は引き続き人間確認待ち。
- M6.5第9スライスでは、`TimelineDragTrimPlan` に `proposedBoundaryFrame` と `snap` を追加し、drag trim境界が再生位置、マーカー、同一トラック編集点へ吸着できるようにした。SwiftUI側はdrag中の境界線、trim量badge、snap lineを表示し、drop commitも同じsnap threshold/playheadを使う。
- `swift build --target VideoOSStudio` と `swift test --filter TimelineDragTrimPlanTests`（8 tests / 0 failures）が成功した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-50/TEST-58を追加し、133件の追跡行（Story 25 / Issue 50 / Test 58）、残課題3件、修正/合格130件、未解決P0/P1 3件、重複ID 0件として更新した。実機drag中のmotion確認は引き続き人間確認待ち。
- M6.5第10スライスでは、transition presetを編集点へdrag hoverした時点で `TimelineTransitionDropDelegate` がpreset IDを読み取り、`StudioViewModel.previewTransitionPresetDrop` へ渡すようにした。targetはhover中のpreset名を表示し、Viewerはdrop後と同じ `TimelineDocument.settingTransition` / `activeVisualTransitionPreview` 経路で簡易クロスフェードを出す。
- `swift build --target VideoOSStudio` と `swift test --filter TimelineTransitionDropPlanTests`（8 tests / 0 failures）が成功した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-51/TEST-59を追加し、135件の追跡行（Story 25 / Issue 51 / Test 59）、残課題3件、修正/合格132件、未解決P0/P1 3件、重複ID 0件として更新した。実機drag中のmotion確認は引き続き人間確認待ち。
- M6.5第11スライスでは、`TimelineRuler` に直接スクラブ用の薄いレーンを追加し、クリック/ドラッグを既存の `onScrubPlayhead` / `StudioViewModel.scrubPlayhead(to:)` へ流すようにした。ドラッグ中はtimecode badgeを表示し、再生ヘッド、Viewer、audio sync generationは既存のforce seek経路で即時更新される。
- `swift build --target VideoOSStudio` は成功した。UI入力経路の追加でCore planner契約は変えていないため、今回はSwift buildと実機起動確認をTEST-60の検証対象にする。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-52/TEST-60を追加し、137件の追跡行（Story 25 / Issue 52 / Test 60）、残課題3件、修正/合格134件、未解決P0/P1 3件、重複ID 0件として更新した。実機drag中のmotion確認は引き続き人間確認待ちだが、ルーラー直接スクラブは人間がその場で確認できる状態にする。
- M6.5第12スライスでは、`TimelineClipBlock` にhover/選択/ドラッグ中のdirect-manipulation cueを追加した。hover時は枠線、軽いshadow、左grab rail、hand cueを出し、drag中は強いaccent borderとhand-raised cueを出す。アクセシビリティ値にも「クリップ本体をドラッグできます」「端をドラッグしてトリムできます」を追加した。
- `swift build --target VideoOSStudio` は成功した。Core planner契約は変更せず、SwiftUIの操作affordanceだけを追加した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-53/TEST-61を追加し、139件の追跡行（Story 25 / Issue 53 / Test 61）、残課題3件、修正/合格136件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第13スライスでは、各 `TimelineTrackRow` の空き背景に直接scrub gestureを追加した。clipやtransitionの上では既存の前面操作を維持し、空きlaneをクリック/ドラッグした時だけ `onScrubPlayhead` へ流す。drag中は `Timeline.TrackScrubPreview` badgeでtimecodeを表示し、既存のViewer force-seek経路を再利用する。
- `swift build --target VideoOSStudio` は成功した。Core planner契約は変更せず、空きlane背景の入力経路だけを追加した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-54/TEST-62を追加し、141件の追跡行（Story 25 / Issue 54 / Test 62）、残課題3件、修正/合格138件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第14スライスでは、ルーラーと空きlaneのplayhead scrubに `TimelinePlayheadScrubSnapResolver` を追加した。drag/click位置が編集点、マーカー、タイムライン先頭/末尾の近くなら、playheadはそのframeへ吸着し、`Timeline.PlayheadScrubSnapIndicator` とtimecode badgeで吸着先を示す。
- `swift build --target VideoOSStudio` と `./script/build_and_run.sh --verify` は成功した。CoreGraphicsで `Video OS Studio` window 1件（1063x685）を確認した。Core planner契約は変更せず、playhead配置のUI-only magnetic snapを追加した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-55/TEST-63を追加し、143件の追跡行（Story 25 / Issue 55 / Test 63）、残課題3件、修正/合格140件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第15スライスでは、空編集点の `TimelineTransitionDropTarget` に `Timeline.TransitionLandingGuide` を追加し、既存transitionには `Timeline.TransitionDurationGrip` を追加した。idle状態でもdrop zoneとduration drag handleが分かり、hover/drop中は既存のpreset preview/Viewer previewへつながる。
- `swift build --target VideoOSStudio` と `./script/build_and_run.sh --verify` は成功した。CoreGraphicsで `Video OS Studio` window 1件（1063x685）を確認した。Core planner契約は変更せず、transition配置/長さ調整のdiscoverabilityだけを補強した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-56/TEST-64を追加し、145件の追跡行（Story 25 / Issue 56 / Test 64）、残課題3件、修正/合格142件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第16スライスでは、既存transitionのduration drag中に `Timeline.TransitionDurationPreviewBadge` を表示するようにした。badgeはdrag delta、preview後の総フレーム数、秒数を表示し、既存の `previewTimelineTransitionDuration` / `adjustTimelineTransitionDuration` 経路は維持する。
- `swift build --target VideoOSStudio` は成功した。Core planner契約は変更せず、transition duration調整中の定量feedbackだけを追加した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-57/TEST-65を追加し、147件の追跡行（Story 25 / Issue 57 / Test 65）、残課題3件、修正/合格144件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第17スライスでは、`TimelineEditToolbar` の左側summaryをclip専用から選択対象summaryへ拡張した。transition選択中は `Timeline.EditToolbar.SelectedTransition` として、track、transition種別、長さframes/seconds、from/to clipを表示する。
- `swift build --target VideoOSStudio` は成功した。Core planner契約は変更せず、transition選択後の状態表示だけを補強した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-58/TEST-66を追加し、149件の追跡行（Story 25 / Issue 58 / Test 66）、残課題3件、修正/合格146件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第18スライスでは、`TimelineClipBlock` に `TimelineClipTrimAffordance` を追加し、trim可能clipがhover/selection/trim preview中に左右端gripを出すようにした。選択中は既存 `Timeline.TrimHandle.Start/End` と同じ端が強調され、未選択clipのAX値にも「選択すると端をドラッグしてトリムできます」が残る。
- `swift build --target VideoOSStudio` は成功した。Core planner契約は変更せず、SwiftUI上のtrim開始位置のdiscoverabilityだけを補強した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-59/TEST-67を追加し、151件の追跡行（Story 25 / Issue 59 / Test 67）、残課題3件、修正/合格148件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第19スライスでは、clip body drag preview中に `Timeline.MovePreviewBadge` を表示するようにした。単体moveではsigned frames/seconds、target laneまたはlane lift先、押し出し件数、吸着先を表示し、group moveでは移動clip数と同じdeltaを表示する。
- `swift build --target VideoOSStudio` は成功した。Core planner契約は変更せず、既存の `TimelineClipMovePlan` / `TimelineClipGroupMovePlan` からdrag中の状態表示だけを追加した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-60/TEST-68を追加し、153件の追跡行（Story 25 / Issue 60 / Test 68）、残課題3件、修正/合格150件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第20スライスでは、`TimelineClipMovePlan.laneLift` が既存互換trackを再利用する場合に、target row側へ `Timeline.LaneLiftTargetLane.*` highlightと `Timeline.LaneLiftTargetGhost.*` を表示するようにした。新規track作成時は従来通りsource row内の一時2段previewを使う。
- `swift build --target VideoOSStudio` は成功した。Core planner契約は変更せず、lane liftのdrop先表示だけをtarget rowへ寄せた。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-61/TEST-69を追加し、155件の追跡行（Story 25 / Issue 61 / Test 69）、残課題3件、修正/合格152件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第21スライスでは、transition presetを空編集点へdrag hoverした時に `Timeline.TransitionDropMagnetCue` を表示し、磁石icon、preset label、縦seam line、from/to clip IDsでdrop先が吸着対象になっていることを示すようにした。
- `swift build --target VideoOSStudio` は成功した。Core planner/schema契約は変更せず、既存のdrop hover previewとViewer preview経路の上にdrag-time target cueだけを追加した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-62/TEST-70を追加し、157件の追跡行（Story 25 / Issue 62 / Test 70）、残課題3件、修正/合格154件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第22スライスでは、`TimelineTransitionPresetChip.onDrag` から `TimelinePanel` がactive preset drag stateを持ち、全 `TimelineTransitionDropTarget` へ渡すようにした。空編集点はhover前から `Timeline.TransitionDropCandidateCue` と強めのlanding guideを出し、drop可能な候補をdrag開始時点で見せる。
- `swift build --target VideoOSStudio` は成功した。Core planner/schema契約は変更せず、drop commit時にactive drag stateをclearし、cancel時は短いtimeoutで戻すUI-only feedbackとして実装した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-63/TEST-71を追加し、159件の追跡行（Story 25 / Issue 63 / Test 71）、残課題3件、修正/合格156件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第23スライスでは、clip本体の縦dragを `preferredTargetTrackID` 付きの `TimelineClipMovePlan` へ接続した。互換の空きtrackがtargetになる場合、source clipは薄く残り、target rowに `Timeline.TrackMoveTargetLane.*` と `Timeline.TrackMoveTargetGhost.*` が出てdrop後のtrack/位置を示す。
- `swift build --target VideoOSStudio` は成功し、`swift test --filter TimelineClipMovePlanTests` は14 tests / 0 failuresで成功した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-64/TEST-72を追加し、161件の追跡行（Story 25 / Issue 64 / Test 72）、残課題3件、修正/合格158件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第24スライスでは、clip本体の縦drag先が受けられない場合に `Timeline.TrackMoveBlockedLane.*` と `Timeline.TrackMoveBlockedCue.*` をtarget rowへ表示するようにした。互換違いtrackと占有trackの失敗をmouse-up前に赤く示す。
- `swift build --target VideoOSStudio` は成功し、`swift test --filter TimelineClipMovePlanTests` は生成xctest bundleをad-hoc署名後に15 tests / 0 failuresで成功した。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-65/TEST-73を追加し、163件の追跡行（Story 25 / Issue 65 / Test 73）、残課題3件、修正/合格160件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第25スライスでは、clip本体のdrag preview中に `Timeline.ClipMoveLandingCue.*` を表示するようにした。single move/group moveの既存preview planからdrop commitと同じ `newTimelineInFrame` / `targetTrackID` を読み、着地点の縦rail、target track、timecode chipをmouse-up前に見せる。
- `swift build --target VideoOSStudio` は成功し、`swift test --filter TimelineClipMovePlanTests` は15 tests / 0 failuresで成功し、`./script/build_and_run.sh --verify` も成功した。CoreGraphicsでは `Video OS Studio` ウィンドウ1件を確認したが、AXは引き続き0 windowsを返すため、実際のdrag motion確認は人間確認待ち。
- `docs/ux/video-os-studio-ux-tracker.xlsx` はUX-66/TEST-74を追加し、165件の追跡行（Story 25 / Issue 66 / Test 74）、残課題3件、修正/合格162件、未解決P0/P1 3件、重複ID 0件として更新した。
- M6.5第26スライスでは、clip本体のdrag changed中に `StudioViewModel.previewTimelineClipMove` を呼び、drop commit前の `TimelineClipMovePlan` / `TimelineClipGroupMovePlan` を一時timelineとしてViewerへ流すようにした。Viewer media、audio media、next media、source time、playhead labelは `activeViewerTimeline` / `activeViewerFrame` を参照し、drag中に着地点の映像位置へ追従する。
- `TimelineTrackRow` は `onPreviewMove` / `onEndMovePreview` を受け取り、validなsingle/group move previewがある時だけViewModel previewを更新する。trim preview、empty lane scrub、drag end、transition preview/selectionへ移る時はclip move previewをclearし、drop commitは従来通り同じframe delta/snap/targetTrackIDで `dragMoveTimelineClip` へ流す。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineClipMovePlanTests`（15 tests / 0 failures）、`./script/build_and_run.sh --verify` は第26スライス実装後に成功した。CoreGraphicsでは `Video OS Studio` ウィンドウ1件（1063x685）を確認したが、AXは引き続き0 windowsを返す。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-67/TEST-75を追加し、167件の追跡行（Story 25 / Issue 67 / Test 75）、残課題3件、修正/合格164件、未解決P0/P1 3件、重複ID 0件として更新した。drag中Viewer追従の人間確認は引き続き残す。
- M6.5第27スライスでは、横方向のzoom/fitとは別に、trackの縦密度を切り替える `Timeline.TrackDensityPicker` を `Timeline.ViewportControls` へ追加した。`密`、`標準`、`広` のsegmented controlで、荒編集後の長いtimelineを見渡すcompact表示と、精密操作用の広め表示を切り替えられる。
- `TimelineTrackDensity` はCore側でrow height、clip height、lane-lift row height、transition target heightを定義する。`StudioViewModel.timelineTrackDensity` が状態を保持し、`TimelineTrackRow`、`TimelineClipBlock`、`TimelineTransitionDropTarget`、`TimelineClipTrimAffordance` が同じdensityから高さを算出する。標準密度は既存の32px row / 28px clipを維持する。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineViewportScaleTests`（4 tests / 0 failures）、`./script/build_and_run.sh --verify` は成功した。CoreGraphicsでは `Video OS Studio` ウィンドウ1件（1063x685）を確認したが、AXは引き続き0 windowsを返す。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-68/TEST-76を追加し、169件の追跡行（Story 25 / Issue 68 / Test 76）、残課題3件、修正/合格166件、未解決P0/P1 3件、重複ID 0件として更新した。density切替の人間目視確認は引き続き残す。
- M6.5第28スライスでは、detail zoom中でも全体位置を見失わないように `Timeline.OverviewStrip` をtimeline上部へ追加した。全trackのclip分布、markers、現在playheadを圧縮表示し、overview上のclick/dragは既存のscrub pathへ流れる。
- 同じスライスで `Timeline.Overview.LocatePlayhead` と `Timeline.PlayheadScrollAnchor` を追加した。scope buttonから `ScrollViewReader.scrollTo` で現在playheadへ寄せるため、長いsequenceを拡大したまま編集していても、現在位置へ戻りやすい。
- `TimelineOverviewScale` はCore側でframe/x変換とclip range clippingを定義し、`TimelineViewportScaleTests` にoverview mappingの境界値を追加した。`git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineViewportScaleTests`（5 tests / 0 failures）、`./script/build_and_run.sh --verify` は成功し、CoreGraphicsでは `Video OS Studio` ウィンドウ1件（1063x685）を確認した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-69/TEST-77を追加し、171件の追跡行（Story 25 / Issue 69 / Test 77）、残課題3件、修正/合格168件、未解決P0/P1 3件、重複ID 0件として更新した。overview stripとplayhead locateの人間目視確認は引き続き残す。
- M6.5第29スライスでは、transition presetをドラッグだけでなくクリックでも文脈適用できるようにした。`TimelineTransitionPlacementResolver` が選択中transition、選択clipに接する編集点、playhead最寄りのvideo/overlay seamの順で候補を選び、削除保留中のclipを含む編集点は除外する。
- `TimelineTransitionPresetChip` は既存のdrag/dropを維持しつつtap/clickを受け、`StudioViewModel.applyTransitionPresetNearContext` が既存の `applyTransitionPreset` 経路へ流す。これによりクリック適用でもin-memory timeline、Viewer transition preview、pending `set_transition` が即時更新される。
- `swift build --target VideoOSStudio`、`swift test --filter TimelineTransitionDropPlanTests`（12 tests / 0 failures）、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-70/TEST-78を追加し、173件の追跡行（Story 25 / Issue 70 / Test 78）、残課題3件、修正/合格170件、未解決P0/P1 3件、重複ID 0件として更新した。transition preset click-to-applyと既存drag/drop退行なしの人間目視確認は引き続き残す。
- M6.5第30スライスでは、ソースモニターで確認中の素材を `再生位置へ追加` でTimelineへ即時挿入できるようにした。`TimelineSourceInsertPlan` がsource assetに一致する候補を選び、未使用segmentを優先し、roleからtarget trackを解決して、同じ `insert_segment` をStudio未保存セッションへ積む。
- `StudioViewModel.insertSourceMonitorAtPlayhead` はin-memory timelineにclipを追加し、追加clipを選択し、Viewerをsource monitorからProgram previewへ戻す。`runtime/compiler/patch.ts` は `insert_segment` 時にV2/A2など不足するtarget trackを自動作成するため、保存後の `timeline.json` も即時プレビューと同じレーン構造になる。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineSourceInsertPlanTests`（3 tests / 0 failures）、`npx tsc --noEmit`、`npx vitest run tests/e2e.test.ts --testNamePattern "insert_segment"`（2 tests / 0 failures）、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-71/TEST-79を追加し、175件の追跡行（Story 25 / Issue 71 / Test 79）、残課題3件、修正/合格172件、未解決P0/P1 3件、重複ID 0件として更新した。running appでsource monitor insertの実操作確認は引き続き残す。
- M6.5第31スライスでは、ソースモニター中に `MediaPanel.SourceCandidateCard` を表示し、追加されるselect候補のsegment、source range、role、target track、confidence、理由、候補番号を見えるようにした。前後ボタンで同一asset内の候補を切り替えられる。
- `TimelineSourceInsertPlan.insertCandidates` は安定ソート済み候補一覧を返し、`TimelineSourceInsertPlan.make(candidateID:)` は明示candidateIDを優先する。`StudioViewModel.sourceMonitorCandidateID` はasset変更や候補データ読み込み時に正規化され、`insertSourceMonitorAtPlayhead` は選択中candidateIDをCore planへ渡す。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineSourceInsertPlanTests`（4 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-72/TEST-80を追加し、177件の追跡行（Story 25 / Issue 72 / Test 80）、残課題3件、修正/合格174件、未解決P0/P1 3件、重複ID 0件として更新した。running appでcandidate cardの視認性と前後候補切替の操作感を人間確認する余地は残る。
- M6.5第32スライスでは、適用済みtransitionを選択した状態で `Timeline.EditToolbar.RemoveTransition` からcutへ戻せるようにした。UIは既存transition選択summaryの隣に削除ボタンを出し、`StudioViewModel.removeSelectedTimelineTransition` が未保存patchへ `set_transition` / `transition_type: cut` を積む。
- `TimelineDocument.settingTransition` は `cut` 指定時に同じedit pointのtransitionをin-memory timelineから取り除き、`runtime/compiler/patch.ts` の `opSetTransition` も保存後 `timeline.json` から同じtransitionを削除する。新しいschema opは増やさず、apply/adjust/removeを同じ `set_transition` contractに揃えた。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineTransitionDropPlanTests`（12 tests / 0 failures）、`npx tsc --noEmit`、`npx vitest run tests/e2e.test.ts --testNamePattern "set_transition"`（2 tests / 24 skipped）、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-73/TEST-81を追加し、179件の追跡行（Story 25 / Issue 73 / Test 81）、残課題3件、修正/合格176件、未解決P0/P1 3件、重複ID 0件として更新した。running appでtransition選択、削除ボタン有効化、Viewerからfade overlayが消えることの人間確認は残る。
- M6.5第33スライスでは、source monitorで確認中の候補を選択中clipへ直接置換する `MediaPanel.ReplaceSelectedClipWithSourceButton` を追加した。`TimelineSourceReplacePlan` はvideo/audio kindの互換を確認し、選択候補から `replace_segment` / `with_candidate_ref` を作る。
- `StudioViewModel.replaceSelectedClipWithSourceMonitorCandidate` は未保存patchへ置換操作を積み、`TimelineDocument.replacingClip` でin-memory timelineを即時更新し、source monitorからProgram previewへ戻して置換clip先頭へseekする。`runtime/compiler/patch.ts` は保存後 `candidate_ref` も選択候補に更新する。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineSourceReplacePlanTests`（3 tests / 0 failures）、`npx tsc --noEmit`、`npx vitest run tests/e2e.test.ts --testNamePattern "replace_segment"`（1 test / 25 skipped）、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-74/TEST-82を追加し、181件の追跡行（Story 25 / Issue 74 / Test 82）、残課題3件、修正/合格178件、未解決P0/P1 3件、重複ID 0件として更新した。running appでsource monitor候補の置換ボタン、置換後Program preview、未保存状態、保存後candidate_refを人間確認する余地は残る。
- M6.5第34スライスでは、audio clipを重なる位置へドラッグしたときも、後続clip押し出しではなく空きAレーンまたは新規Aレーンへ自動リフトできるようにした。
- `TimelineClipMovePlan.makeLaneLift` はvideo/overlayに加えてaudio trackを対象にし、`nextTrackID` はtrack kindごとに `A` / `V` / `O` / `C` prefixを生成する。既存の `move_segment target_track_id` を使うため、Studio即時表示と `runtime/compiler/patch.ts` の保存後反映は同じ契約のまま揃う。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineClipMovePlanTests`（16 tests / 0 failures）、`npx tsc --noEmit`、`npx vitest run tests/e2e.test.ts --testNamePattern "move_segment"`（4 tests / 23 skipped）、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-75/TEST-83を追加し、183件の追跡行（Story 25 / Issue 75 / Test 83）、残課題3件、修正/合格180件、未解決P0/P1 3件、重複ID 0件として更新した。running appでA1上のaudio clip overlap drag、A2ゴースト/着地点HUD、Viewer preview、保存後A2反映を人間確認する余地は残る。
- M6.5第35スライスでは、source monitorの候補カードをタイムライン上の入れたいレーンと位置へ直接ドラッグして追加できるようにした。ユーザー体験としては、候補カードを掴み、V/Aのcompatible laneへ持っていくとdrop cueとtimecodeが出て、離した時点でTimeline/ViewerがProgram previewへ戻り、未保存patchにも同じinsertが積まれる。
- `StudioDragPayload` はsource candidate payloadとtransition preset payloadを分離する。`MediaPanel.SourceCandidateCard.onDrag` がcandidateID/sourceAssetIDを渡し、`TimelineSourceCandidateDropDelegate` がtrack row上のdrop x座標からframeを算出して `StudioViewModel.dropSourceMonitorCandidateOnTimeline` へ流す。
- `TimelineSourceInsertPlan` は `preferredTargetTrackID` を受け取り、compatibleなV/A laneだけをinsert targetとして許可する。`ReviewPatchOperation.insertSegment` と `runtime/compiler/patch.ts` は `target_track_id` を保持し、保存後の `timeline.json` でもStudio即時表示と同じlaneへ追加される。不一致のtarget kindはCore planとcompilerの両方で拒否する。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineSourceInsertPlanTests`（7 tests / 0 failures）、`swift test --filter ReviewPatchDocumentTests`（8 tests / 0 failures）、`swift test --filter StudioFeedbackSessionTests`（15 tests / 0 failures）、`npx tsc --noEmit`、`npx vitest run tests/e2e.test.ts --testNamePattern "insert_segment"`（4 tests / 25 skipped）、`npx vitest run tests/m45-schema-compat.test.ts`（15 tests / 0 failures）、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-76/TEST-84を追加し、185件の追跡行（Story 25 / Issue 76 / Test 84）、残課題3件、修正/合格182件、未解決P0/P1 3件、重複ID 0件として更新した。running appでsource候補card drag、drop cue、Program preview復帰、未保存状態、保存後target laneを人間確認する余地は残る。
- M6.5第36スライスでは、source monitorの候補カード上でIN/OUT範囲を0.5秒単位で詰め、追加ボタンまたはcandidate card drag/dropでそのマーク範囲だけをtimelineへ入れられるようにした。カードには候補全体範囲、現在のマーク範囲、マーク尺、reset状態が表示される。
- `StudioViewModel` は `sourceMonitorMarkedSourceInUS` / `sourceMonitorMarkedSourceOutUS` を選択候補に紐づけて保持し、候補が切り替わったらmark stateをリセットする。`MediaPanel.SourceMarkedRangeControls` は `IN-` / `IN+` / `OUT-` / `OUT+` / resetを出し、候補外や逆転するrangeは押せない状態にする。
- `TimelineSourceRangeOverride` はmarked source rangeをCore planへ渡し、即時preview clipのsource in/outとdurationを候補全体ではなくマーク範囲へ合わせる。`ReviewPatchOperation.insertSegment` は任意の `new_src_in_us` / `new_src_out_us` を持ち、`runtime/compiler/patch.ts` は候補外rangeを拒否しながら保存後の `timeline.json` に同じsource rangeを反映する。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineSourceInsertPlanTests`（9 tests / 0 failures）、`swift test --filter ReviewPatchDocumentTests`（8 tests / 0 failures）、`swift test --filter StudioFeedbackSessionTests`（15 tests / 0 failures）、`npx tsc --noEmit`、`npx vitest run tests/e2e.test.ts --testNamePattern "insert_segment"`（6 tests / 25 skipped）、`npx vitest run tests/m45-schema-compat.test.ts`（15 tests / 0 failures）、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-77/TEST-85を追加し、187件の追跡行（Story 25 / Issue 77 / Test 85）、残課題3件、修正/合格184件、未解決P0/P1 3件、重複ID 0件として更新した。running appでIN/OUT調整、marked insert、drag/drop insert、保存後source rangeを人間確認する余地は残る。
- M6.5第37スライスでは、source monitor候補カードに `MediaPanel.SourceMarkedRangeScrubber` を追加し、候補全体rangeとmarked rangeを一本のバーで見ながら、左右の `MediaPanel.SourceMarkInDragHandle` / `MediaPanel.SourceMarkOutDragHandle` をドラッグしてIN/OUTを直接調整できるようにした。
- `TimelineSourceRangeMarkPlan` はdrag fractionをsource microsecondsへ変換し、候補範囲外へのdragをclampし、IN/OUTが逆転しない最小durationを保証する。`StudioViewModel.dragSourceMonitorMark` はこのplanを使ってmark stateとstatusを更新し、`SourceMonitorInsertCandidateSummary` はmarked rangeのfractionをUIへ渡す。
- 既存の `IN-` / `IN+` / `OUT-` / `OUT+` / resetボタンは残し、初回ユーザー向けの明示操作とNLE経験者向けの直接操作を両立させた。追加/drag-drop時の保存契約はUX-77と同じ `insert_segment new_src_in_us/new_src_out_us` で、drag handle専用の隠れ状態は作らない。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineSourceInsertPlanTests`（12 tests / 0 failures）、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-78/TEST-86を追加し、189件の追跡行（Story 25 / Issue 78 / Test 86）、残課題3件、修正/合格186件、未解決P0/P1 3件、重複ID 0件として更新した。running appでrange bar handle drag、表示更新、marked insert/dropは人間確認キューへ集約する。
- M6.5第38スライスでは、source monitorでマークしたIN/OUT範囲を、選択中clipのreplaceにも反映するようにした。ユーザー体験としては、source候補カードの範囲バーで使いたい部分を詰め、`置換` を押すと、タイムライン上の選択clipは同じ位置/尺に残りつつ、source in/outだけがそのマーク範囲へ切り替わる。
- `StudioViewModel.makeSourceMonitorReplacePlan` は `sourceMonitorMarkedRangeOverride` を `TimelineSourceReplacePlan` へ渡す。`TimelineSourceReplacePlan` は `replace_segment new_src_in_us/new_src_out_us` をemitし、候補外rangeを拒否する。`TimelineDocument.replacingClip` は即時preview用clipにも同じsource rangeを入れる。
- `ReviewPatchDocument` と `StudioFeedbackSession` は replace の任意source rangeをserialize/dedupeで保持する。`runtime/compiler/patch.ts` は保存後の `timeline.json` に同じsource in/outを反映し、candidate範囲外のreplace source rangeを拒否する。既存のCandidate Browser/Footage Search replaceはrangeなしのnil/nilで従来通り動く。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineSourceReplacePlanTests`（5 tests / 0 failures）、`swift test --filter TimelineSourceInsertPlanTests`（13 tests / 0 failures）、`swift test --filter ReviewPatchDocumentTests`（8 tests / 0 failures）、`swift test --filter StudioFeedbackSessionTests`（15 tests / 0 failures）、`swift test --filter CandidateBrowserDataSourceTests`（6 tests / 0 failures）、`swift test --filter FootageSearchRunnerTests`（6 tests / 0 failures）、`npx tsc --noEmit`、`npx vitest run tests/e2e.test.ts --testNamePattern "replace_segment"`（3 tests / 30 skipped）、`npx vitest run tests/m45-schema-compat.test.ts`（15 tests / 0 failures）、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-79/TEST-87を追加し、191件の追跡行（Story 25 / Issue 79 / Test 87）、残課題3件、修正/合格188件、未解決P0/P1 3件、重複ID 0件として更新した。running appでmarked range handle drag後のreplace、Program preview復帰、未保存状態、保存後source rangeは人間確認キューへ集約する。
- M6.5第39スライスでは、source monitorでマークしたIN/OUT範囲を、再生位置からの上書きにも反映するようにした。ユーザー体験としては、source候補カードの範囲バーで使いたい部分を詰め、playheadを置いて `上書き` を押すと、target track上の重なったclip端はtrimされ、完全に覆われるclipはremoveされ、Timeline/Viewerは即時にProgram previewへ戻る。
- `TimelineSourceOverwritePlan` は `TimelineSourceInsertPlan` を先に使って挿入clip IDを安定させ、その後にedge overlap用の `trim_segment` / duration-aware `move_segment` と、fully covered clip用の `remove_segment` を積む。`TimelineDocument.removingClips` はStudio即時previewから削除clipと関連transitionを除去し、`runtime/compiler/patch.ts` も `remove_segment` 後に削除clipを参照するtransition metadataを消す。
- 既存clip中央をまたぐoverwriteは、左右の残りclipを安定IDでsplitする設計が必要なため、このスライスでは明示的に拒否する。失敗時はsource候補なしとsplit-requiredを分けてstatus/helpに出し、人間確認はまとめて `docs/project-memory/CONTINUITY.md` のHuman Confirmation Queueへ残す。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineSourceOverwritePlanTests`（3 tests / 0 failures）、`swift test --filter TimelineSourceInsertPlanTests`（13 tests / 0 failures）、`npx tsc --noEmit`、`npx vitest run tests/e2e.test.ts --testNamePattern "source overwrite|remove_segment drops"`（2 tests / 33 skipped）、`npx vitest run tests/m45-schema-compat.test.ts`（15 tests / 0 failures）、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-80/TEST-88を追加し、193件の追跡行（Story 25 / Issue 80 / Test 88）、残課題3件、修正/合格190件、未解決P0/P1 3件、重複ID 0件として更新した。running appでmarked overwrite、edge trim、covered remove、transition cleanup、split-required statusは人間確認キューへ集約する。
- M6.5第40スライスでは、source monitor overwriteが既存clip中央をまたぐ場合も、元clipを左右remainderに分けて中央だけ置き換えられるようにした。ユーザー体験としては、長いclipの途中へmarked source rangeを上書きすると、左側の元clip、挿入されたsource clip、右側の元clipがその場で並び、保存後も同じclip ID順とsource rangeになる。
- `TimelineSourceOverwritePlan` は新schema operationを増やさず、`insert_segment` を先に積み、`split_segment` をoverwrite out frameへ積み、元clipをoverwrite in frameまで `trim_segment` / duration-aware `move_segment` で短くする。これにより、compilerの `generateClipId` とStudio previewの `nextClipID` が同じ順序になり、挿入clipと右remainderのIDがずれない。
- `TimelineDocument.splittingClip` と `TimelineClip.splitting` はStudio即時previewで右remainderを作り、`runtime/compiler/patch.ts` は `opSplitSegment` 後にsplit元clipのoutgoing transitionを生成された右remainderへ移す。中央overwrite後も、元clip後方に付いていたtransition関係が左remainderへ残ってしまわない。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineSourceOverwritePlanTests`（3 tests / 0 failures）、`swift test --filter TimelineSourceInsertPlanTests`（13 tests / 0 failures）、`npx tsc --noEmit`、`npx vitest run tests/e2e.test.ts --testNamePattern "source overwrite|middle of a clip|remove_segment drops"`（3 tests / 33 skipped）、`npx vitest run tests/m45-schema-compat.test.ts`（15 tests / 0 failures）、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-81/TEST-89を追加し、195件の追跡行（Story 25 / Issue 81 / Test 89）、残課題3件、修正/合格192件、未解決P0/P1 3件、重複ID 0件として更新した。running appでmiddle split preview、左/挿入/右remainder、split count status、保存後transition remapは人間確認キューへ集約する。
- M6.5第41スライスでは、source monitor overwriteを押す前に、Timeline上で置き換え範囲と影響clipを見られるようにした。ユーザー体験としては、source候補のmarked range、playhead、target trackを変えると、対象trackに上書き範囲、IN/OUT境界、削除/trim/split予定clipが先に出るので、ボタンを押した後の結果を予測できる。
- `StudioViewModel.sourceMonitorOverwritePreview` はcommit時と同じ `TimelineSourceOverwritePlan` から preview model を作り、`TimelinePanel` 経由で各 `TimelineTrackRow` へ渡す。`TimelineSourceOverwritePreviewBand` はtarget track上にrange bandとoperation summaryを描き、`TimelineSourceOverwriteImpactBadge` は対象clipへ `削除` / `trim` / `split` badgeを重ねる。
- preview overlay は `Timeline.SourceOverwritePreview.<track>` と `Timeline.SourceOverwriteImpact.<track>.<clip>` のAX IDを持ち、`allowsHitTesting(false)` なのでtimeline scrub、clip drag、transition操作を邪魔しない。実操作は既存の `MediaPanel.OverwriteSourceAtPlayheadButton` と同じpatch/save契約を使う。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineSourceOverwritePlanTests`（3 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-82/TEST-90を追加し、197件の追跡行（Story 25 / Issue 82 / Test 90）、残課題3件、修正/合格194件、未解決P0/P1 3件、重複ID 0件として更新した。running appでplayhead/marked range/target selection変更時のpreview band、delete/trim/split badge、click後の結果一致は人間確認キューへ集約する。
- M6.5第42スライスでは、source monitor候補カードをTimelineへドラッグしている間に、drop後に入るclipの尺と互換レーンを先に見られるようにした。ユーザー体験としては、候補カードを掴んでV/Aレーンへ持っていくと、marked rangeの長さを持つghost clipとdrop先timecodeが出る。映像候補をaudio laneへ持っていくなど互換しない場合は赤いblocked ghost/cueになる。
- `StudioViewModel.previewSourceMonitorCandidateDropOnTimeline` はsource candidate ID、marked source range、drop frame、target trackから `TimelineSourceCandidateDropPreview` を作る。`TimelinePanel` は `onPreviewSourceCandidateDrop` を各rowへ渡し、`TimelineSourceCandidateDropDelegate` がdrag update中にpreviewを更新する。
- `TimelineSourceCandidateDropGhost` と `TimelineSourceCandidateDropCue` は `Timeline.SourceCandidateDropGhost.<track>` / `Timeline.SourceCandidateDropCue.<track>` のAX IDを持ち、保存contractには混ぜない。mouse-up後の実操作は既存の `dropSourceMonitorCandidateOnTimeline` と `TimelineSourceInsertPlan.make` の `insert_segment` 一件に任せる。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineSourceInsertPlanTests`（13 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-83/TEST-91を追加し、199件の追跡行（Story 25 / Issue 83 / Test 91）、残課題3件、修正/合格196件、未解決P0/P1 3件、重複ID 0件として更新した。running appでsource candidate card drag、ghost尺、timecode cue、非互換lane red blocked、drop後insert結果一致は人間確認キューへ集約する。
- M6.5第43スライスでは、source candidate cardをoccupiedな互換laneへdropする時、同じ位置へ重ねるのではなく、FCPX/CapCut的に空きlaneまたは新規laneへ持ち上げる。`TimelineSourceInsertPlan.LaneLift` はrequested lane、target lane、new track creation、overlapped clip IDsを保持し、commitは既存の `insert_segment target_track_id` を使う。
- `TimelineSourceInsertPlan` はsource dropの要求laneが重なる場合、要求lane以上の番号を持つ同種trackから空きlaneを探し、なければV3/A3のような次laneを作る。これによりV2が埋まっている時にV1へ降りる挙動は避け、primary trackを壊さない。
- `StudioViewModel.previewSourceMonitorCandidateDropOnTimeline` はcommitと同じplannerからpreviewを作り、`TimelinePanel` はsource drop previewをrow間で共有する。既存空きlaneへliftする場合は実着地rowへghostを出し、新規lane作成やblocked laneではhover row上のcueでtargetを示す。
- `git diff --check`、`swift build --target VideoOSStudio`、`swift test --filter TimelineSourceInsertPlanTests`（16 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-84/TEST-92を追加し、201件の追跡行（Story 25 / Issue 84 / Test 92）、残課題3件、修正/合格198件、未解決P0/P1 3件、重複ID 0件として更新した。running appでsource candidate cardをoccupied V/A laneへdragし、open/new lane ghost、primaryへ降りないこと、drop後のinsert結果一致は人間確認キューへ集約する。
- M6.5第44スライスでは、source candidate cardをTimelineへdrag/dropする時、rawなcursor frameではなく近い編集点、再生位置、マーカー、タイムライン先頭へ磁気的に吸着するようにした。ユーザー体験としては、候補カードをlaneへ近づけるとghost clipが吸着後の位置へ寄り、`SNAP` cueと縦railで吸着先が見え、離した後のinsertも同じframeに残る。
- `TimelineSourceInsertPlan` は `TimelineSourceInsertSnap` と `proposedTimelineInFrame` を持ち、source dropではsnap解決後の `timelineInFrame` を `insert_segment.new_timeline_in_frame` へ書く。snap後にrequested laneと重なる場合は、既存の `LaneLift` 解決を同じsnapped frameに対して行うため、吸着とopen/new lane liftが矛盾しない。
- `TimelineSourceCandidateDropDelegate` はclip move/trimと同じ12px相当の `magneticSnapThresholdFrames` をpreviewとcommitの両方に渡す。`TimelineSourceCandidateDropCue` / `TimelineSourceCandidateDropGhost` はSNAP badgeを表示し、`TimelineSourceDropSnapIndicator` はsource drop専用の吸着railを出す。
- `swift build --target VideoOSStudio`、`swift test --filter TimelineSourceInsertPlanTests`（20 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-85/TEST-93を追加し、203件の追跡行（Story 25 / Issue 85 / Test 93）、残課題3件、修正/合格200件、未解決P0/P1 3件、重複ID 0件、formula error 0件として更新した。running appでsource candidate cardをedit point/playhead/marker付近へdragし、SNAP cue/rail、ghost位置、drop後insert結果、occupied lane lift併用は人間確認キューへ集約する。

- M6.5第45スライスでは、適用済みtransitionをpresetから作り直さず、transition本体を掴んで別の編集点へ移動できるようにした。NLE経験者向けには、既存transitionの中央handleをdragし、別のedit pointへhoverするとmove candidate cueとmagnet cueが出る。初回ユーザー向けには、選択時のstatus/helpが「中央ドラッグで移動、左右ドラッグで長さ調整」と役割を分けて伝える。
- `TimelineTransitionRelocatePlan` はsource transition IDとtarget edit pointから、targetへ元transition type/skill/durationを `set_transition` し、sourceを `cut` へ戻す2つの既存operationを作る。target handlesが短い場合はdurationをclampし、同じsource/targetやgapped targetは拒否する。schema/compiler contractは増やさず、既存の `set_transition` だけで保存可能にした。
- `StudioDragPayload.transition` と `TimelineTransitionMoveHandle` を追加し、`TimelineTransitionDropDelegate` はpreset payloadとtransition payloadを分岐する。hover中は `StudioViewModel.previewTimelineTransitionMove` がViewer transition previewを出し、drop時は `moveTimelineTransition` がin-memory timelineを即時更新し、未保存patchへtarget set/source cutを積む。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests`（15 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-86/TEST-94を追加し、205件の追跡行（Story 25 / Issue 86 / Test 94）、残課題3件、修正/合格202件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで中央handle drag、move cue/magnet cue、Viewer preview、drop後source cut/target反映、既存target transition置換は人間確認キューへ集約する。

- M6.5第46スライスでは、source monitorからのinsert/drop/replace/overwriteが成功した直後に、変わったクリップがTimeline上で青く光るようにした。ユーザー体験としては、ボタンを押す/カードをdropする/overwriteするたびに、どこが即時反映されたかをTimeline上で見失わない。
- `TimelineSourceInsertPlan`、`TimelineSourceReplacePlan`、`TimelineSourceOverwritePlan` は、それぞれUIでハイライトすべき `changedClipIDs` を返す。`StudioViewModel.insertSourceMonitorAtPlayhead`、`dropSourceMonitorCandidateOnTimeline`、`replaceSelectedClipWithSourceMonitorCandidate`、`overwriteSourceMonitorAtPlayhead` はcommit成功後に既存の `showChangedClipHighlight` を呼び、AI patch適用後と同じchanged-clip glowを手動source editにも使う。
- 同じスライスで、source overwriteはsource insertのoccupied-lane liftを使わず、選んだ互換target track上に直接insert clipを作ってからtrim/remove/splitを計画するようにした。これにより通常のsource drag/dropはFCPX/CapCut的に空きlaneへliftしつつ、overwriteは「そのレーンを置き換える」操作として残る。
- `swift test --package-path apps/macos-studio --filter TimelineSource`（28 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-87/TEST-95を追加し、207件の追跡行（Story 25 / Issue 87 / Test 95）、残課題3件、修正/合格204件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでinsert/drop/replace/overwrite直後の青いchanged-clip glow、overwriteが選択target laneへ残ること、Program preview復帰、未保存状態は人間確認キューへ集約する。

- M6.5第47スライスでは、MediaPanelの素材一覧をsource binとして少し使いやすくした。ユーザー体験としては、素材をテキスト一覧で探すのではなく、サムネイル付きrowを見ながら、全て/再生可/映像/音声/要対応で絞り、ready素材をクリックまたは `ソース確認` でsource monitorへ送れる。
- `ProjectMediaSourceBinFilter` と `ProjectMediaPreviewSummary.items(matching:)` / `count(matching:)` を追加し、source bin filterの分類をCoreで固定した。`StudioViewModel.mediaSourceBinFilter` はUserDefaultsへ保存されるため、表示条件はプロジェクト切替や再起動後も残る。
- `MediaPanel.SourceBinFilter` と `MediaPanel.SourceBinItem.*` を追加した。各rowは既存の `ProjectThumbnailCache.thumbnailURL` を使うため、key frame、representative frame、poster、user cache fallbackの順序はCandidate Swap / Footage Searchと揃う。選択中のsource monitor assetはrow背景とborderで見える。
- `swift test --package-path apps/macos-studio --filter ProjectMediaResolverTests`（32 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、tracker inspect（209 rows / Story 25 / Issue 88 / Test 96 / duplicate IDs 0 / formula errors 0）は成功した。running appでfilter切替、thumbnail表示、rowクリック/ボタンでsource monitorへ入ること、選択row highlight、要対応filterの見え方は人間確認キューへ集約する。

- M6.5第48スライスでは、MediaPanelのsource binに検索と並び替えを追加した。ユーザー体験としては、素材が増えた時に `camera` やasset ID、status文字列で絞り込み、元の順/名前順/状態順/種類順を切り替えながら、目的のready素材をすぐsource monitorへ送れる。
- `ProjectMediaSourceBinSort` と `ProjectMediaPreviewStatus.matchesSourceBinQuery(_:)` を追加し、`ProjectMediaPreviewSummary.items(matching:query:sort:)` がfilter、検索、sortをCore側で一貫して処理するようにした。検索はasset ID、filename、path、resolvedFrom、playback status、recommendationを対象にし、複数tokenはすべて一致で絞る。
- `StudioViewModel.mediaSourceBinQuery` と永続化された `mediaSourceBinSort` を追加した。`MediaPanel.SourceBinSearchField`、`MediaPanel.SourceBinSearchClear`、`MediaPanel.SourceBinSortPicker`、`MediaPanel.SourceBinResultCount` により、source binは「表示条件を変えながら素材を選ぶ」操作へ近づいた。
- `swift test --package-path apps/macos-studio --filter ProjectMediaResolverTests`（33 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、tracker inspect（211 rows / Story 25 / Issue 89 / Test 97 / duplicate IDs 0 / formula errors 0）は成功した。running appで検索入力、clear、sort切替、表示件数、row click/source monitor遷移は人間確認キューへ集約する。

- M6.5第49スライスでは、選択中clipをドラッグせず0.5秒単位で前後へ動かせるようにした。ユーザー体験としては、clipを選んで `位置←` / `位置→` を押す、またはtimeline focus中に `[` / `]` を押すと、その場でclip位置が変わり、Timeline/Viewerが即時にProgram previewへ更新される。
- `StudioViewModel.nudgeSelectedTimelineClipEarlier` / `nudgeSelectedTimelineClipLater` は単体clipでは `TimelineClipMovePlan`、複数選択では `TimelineClipGroupMovePlan` を使う。重なる位置へのnudgeは既存clip body dragと同じ `move_segment target_track_id` lane-liftやmagnetic displacementを使うため、ドラッグ操作と保存後の `timeline.json` が別挙動にならない。
- `TimelineEditToolbar.NudgeEarlier` / `TimelineEditToolbar.NudgeLater` と `TimelineShortcutButtons` の `[` / `]` を追加した。初回ユーザーには明示ボタン、NLE経験者には反復しやすいキーボード操作を用意し、AIが粗編集したsequenceを人間が短時間で詰める操作へ近づけた。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests`（18 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check`、tracker inspect（213 rows / Story 25 / Issue 90 / Test 98 / duplicate IDs 0 / formula errors 0）は成功した。running appで位置nudge button、`[` / `]` shortcut、単体0.5秒移動、重なり時lane lift、複数選択nudge、Viewer即時反映は人間確認キューへ集約する。

- M6.5第50スライスでは、選択clipの端ドラッグを「内側に詰める」だけでなく、空きと素材ハンドルがある方向へ外側に伸ばせるようにした。ユーザー体験としては、FCPX/CapCutのedge resizeに近く、start edgeを左へ、end edgeを右へdragすると、その場でclipが伸び、Timeline/Viewerが即時にProgram previewへ更新される。
- `TimelineDragTrimPlan` は `durationDeltaFrames`、`addedFrames`、`changedFrames`、`isExtension` を持ち、same-track前後clipとの隣接境界、timeline start、source in下限、asset duration上限を見て、trim/extensionの両方を同じplanで解決する。snap候補もclip内だけでなく、伸長先gap内のedit point/playhead/marker/timeline startへ広げた。
- `StudioViewModel.dragTrimTimelineClip` は一方向guardを外し、`assetDurationsUSByID` をplanへ渡す。commitは既存の `trim_segment` とduration-aware `move_segment` のままなので、in-memory previewと保存後の `timeline.json` の契約は分かれない。`TimelinePanel` / `TimelineTrackRow` はasset duration mapを受け取り、drag-time previewもcommitと同じ制約で表示する。
- `TimelineTrimPreviewBadge` は伸ばす時に `+Nf`、詰める時に `-Nf` を出し、boundary iconとhelp textもdrag方向とactionに合わせる。初回ユーザーには「左右へドラッグして詰める/伸ばす」と伝え、NLE経験者には端を掴めばその場でresizeできる感覚を優先する。
- `swift test --package-path apps/macos-studio --filter TimelineDragTrimPlanTests`（11 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check`、tracker inspect（215 rows / Story 25 / Issue 91 / Test 99 / duplicate IDs 0 / formula errors 0）は成功した。running appでstart/end edgeの内外drag、`+Nf`/`-Nf` badge、snap rail、overlap/source-handle rejection、Viewer即時反映、未保存状態は人間確認キューへ集約する。

- M6.5第51スライスでは、NLE経験者が期待するBlade tool相当の「クリックした位置で切る」操作を追加した。ユーザー体験としては、`B` キー、ツールバーの `ブレード`、またはCommand PaletteでBlade modeをオンにし、タイムライン上のclipをクリックすると、そのクリック位置でclipが即座に左右へ分割される。
- `TimelineBladeClickOverlay` はclip上のローカルx座標を安全な内部frameへ変換し、clipの端1frameは拒否する。Blade mode中はtrim handleを隠し、`Timeline.BladeCue.*` のオレンジscissor cueで「クリックで分割」の状態を示す。通常クリック選択とBladeクリック分割が混ざらないよう、Bladeをオンにするとmulti-select modeはオフになる。
- `StudioViewModel.bladeSplitTimelineClip` と既存の `splitSelectedTimelineClipAtPlayhead` は共通helperへ寄せ、`TimelineSplitPlan` から既存の `split_segment` operationを作る。`TimelineSplitPlan.nextClipID(in:)` はcompilerと同じ `CLP_####` 採番範囲を使うため、Studioの即時previewで作られる右clip IDと保存後の `timeline.json` がずれない。
- 分割後はin-memory Timelineを即時更新し、Viewer/playheadをsplit frameへseekし、生成された右clipを選択し、左右clipをchanged highlightする。これにより「保存して更新しないと切れた感じがしない」状態を避け、AIが粗編集したsequenceを人間が通常の映像編集ソフトとして切れる導線に近づけた。
- `swift test --package-path apps/macos-studio --filter TimelineSplitPlanTests`（5 tests / 0 failures）、`swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio` は成功した。running appでBlade toggle、`B` shortcut、Command Palette、click split位置、端click拒否、右clip選択/highlight、Viewer/playhead即時反映、multi-select解除、保存/破棄状態は人間確認キューへ集約する。

- M6.5第52スライスでは、磁気的な操作感を保ちながら、プロ編集者が必要な瞬間だけ吸着を切れるようにした。ユーザー体験としては、デフォルトではFCPX/CapCut的に近い編集点、再生位置、マーカー、タイムライン先頭へ吸着し、`N` キー、ツールバーの `吸着`、またはCommand PaletteでOFFにするとカーソル位置を優先して細かく置ける。
- `StudioViewModel.isTimelineSnappingEnabled` はUserDefaultsへ保存され、`toggleTimelineSnapping` が状態表示を更新する。`TimelineEditToolbar.Snapping` は `magnet` icon付きtoggleとして、初回ユーザーには現在ON/OFFを明示し、NLE経験者にはキーボードで素早く切り替えられる導線を提供する。
- `TimelinePanel` はSnapping状態を `TimelineRuler`、`TimelineOverviewStrip`、`TimelineTrackRow`、source candidate drop delegateへ渡す。OFF時はclip body drag、edge drag trim、ruler scrub、overview scrub、empty-lane scrub、source candidate card dropが既存planner/resolverへ `snapThresholdFrames = 0` を渡すため、snap rail/badgeを出さず、ON時は既存のmagnetic preview/commitがそのまま戻る。
- `TimelineClipMovePlan.resolveSnap` と `TimelinePlayheadScrubSnapResolver.resolve` は0閾値を「完全に吸着なし」として扱うようにした。これにより、Snapping OFFでも完全一致のedit pointがsnap metadataとして表示される曖昧さを避け、ON/OFFの意味を操作面全体で揃えた。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests`（19 tests / 0 failures）、`swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio` は成功した。running appでSnapping toolbar toggle、`N` shortcut、Command Palette、ON時snap rail/badge、OFF時cursor priority、source drop/ruler/overview/empty-lane scrubの挙動差は人間確認キューへ集約する。

- M6.5第53スライスでは、Multi-select中にタイムラインの空レーンをドラッグして、範囲内のclipをまとめて選べるようにした。ユーザー体験としては、NLE経験者が期待するmarquee/range selectionに近く、通常時は空レーンdragでplayhead scrub、複数選択モード中だけ空レーンdragで選択範囲を作る。
- `TimelineDocument.clipIDs(inTrack:intersectingFrameRange:)` は指定track内で範囲と交差するclip IDをtimeline順で返す。`StudioViewModel.selectTimelineClips(in:frameRange:)` はその結果を `selectedTimelineClipIDs` へ即時反映し、選択範囲先頭へplayheadをseekし、下部statusにtrack・件数・timecode rangeを表示する。
- `TimelineTrackRow` は空レーン背景のdragを `laneInteractionGesture` に統合し、通常時は既存のscrub、Multi-select中は `TimelineMarqueeSelectionOverlay` の半透明range表示と範囲選択commitへ分岐する。Clip body drag、transition drag/drop、source candidate dropは前面要素のgestureを維持するため、range selectionは空白部分だけで発火する。
- `swift test --package-path apps/macos-studio --filter TimelineDocumentTests`（8 tests / 0 failures）は成功した。running appでMulti-select on後のempty-lane drag、marquee overlay、選択highlight、status件数、Multi-select off時のscrub維持、clip body dragとの競合なしは人間確認キューへ集約する。

- M6.5第54スライスでは、タイムライン上の選択状態をキーボードだけで作り、抜けられるようにした。ユーザー体験としては、タイムラインフォーカス中に `Command-A` で全クリップを複数選択し、`Esc` でクリップ選択、transition選択、Multi-select、Blade、一時プレビューをまとめて解除できる。
- `StudioViewModel.selectAllTimelineClips` は全trackのclipをtimeline順で集め、最初のclipへplayheadをseekし、source monitorやtransition/drag preview状態を解除した上で `selectedTimelineClipIDs` へ即時反映する。`clearTimelineSelectionAndTemporaryTools` は選択と一時ツール状態をクリアし、drag/transitionの一時Viewer previewが残っていた場合はmedia/audio sync generationも更新する。
- `ContentView` はCommand Paletteに `タイムラインを全選択` と `タイムライン選択を解除` を追加し、`TimelineShortcutButtons` へ `Command-A` と `Esc` を追加した。これにより、marqueeや複数選択後にマウスで空白を探して解除する必要がなく、FCPX/CapCutに近い「選んで、すぐ戻る」編集リズムへ寄せた。
- `swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）は成功した。running appでtimeline focus中の `Command-A`、コマンドパレット実行、全clip highlight、playhead seek、`Esc` 解除、Blade/Multi-select/transition選択の解除、通常編集操作への復帰は人間確認キューへ集約する。

- M6.5第55スライスでは、選択したものを `Delete` キーで消せる基本編集操作を追加した。ユーザー体験としては、timeline focus中にclipを選んでDeleteを押すと単体clipはリップル削除され、transitionを選んでDeleteを押すとcutへ戻る。Command Paletteからも同じ `選択項目を削除` を実行できる。
- `TimelineDocument.applyingRippleDelete(_:)` を追加し、既存の `TimelineRippleDeletePlan` が作る `remove_segment` + downstream `move_segment` operationsを、保存前のin-memory Timelineへ即時適用できるようにした。これによりtoolbarの `リップル削除` とDelete shortcutは、保留patchを積むだけでなく、消えたclipと詰まった後続clipをその場でTimeline/Viewerへ反映する。
- `StudioViewModel.deleteTimelineSelection` は選択transitionがあれば既存の `removeSelectedTimelineTransition` を使い、単体clipなら `rippleDeleteSelectedTimelineClip` を使う。第55時点では複数選択の一括ripple deleteはtrackごとの磁気削除仕様がまだ危険なため、disabled reason/statusで単体削除に分けるよう明示した。
- `swift test --package-path apps/macos-studio --filter TimelineRippleDeletePlanTests`（4 tests / 0 failures）、`swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-96/TEST-104を追加し、225件の追跡行（Story 25 / Issue 96 / Test 104）、残課題3件、修正/合格222件、未解決P0/P1 3件、重複ID0件、実formula error0件として更新した。running appでclip選択後Delete、transition選択後Delete、Command Palette実行、Timeline/Viewer即時反映、未保存状態、複数選択時disabled reasonは人間確認キューへ集約する。

- M6.5第56スライスでは、同一track上の複数clipを選んだ状態でも `Delete` / `リップル削除` でまとめて消し、後続clipを累積削除尺ぶん前へ詰められるようにした。ユーザー体験としては、Multi-select marqueeでV1上の不要な複数clipを囲んでDeleteを押すと、選択clipが消え、同じtrackの後続clipがその場で詰まり、Timeline/Viewerが保存前に即時更新される。
- `TimelineRippleDeleteGroupPlan` は選択clip ID集合を同一trackに限定し、timeline順の `remove_segment` 群と、各未選択後続clipに対して「自分より前で削除されたclip尺の合計」だけ前へ動かす `move_segment` 群を作る。途中に未選択clipがある場合は前方削除分だけ、すべての選択clipより後ろのclipは累積削除分だけ動くため、削除前のgap構造を壊しにくい。
- `TimelineDocument.applyingRippleDelete(_ group:)` は複数clipをまとめて取り除き、同じoperation列でin-memory timelineを更新する。`StudioFeedbackSession.queueRippleDelete(_ group:)` は削除clipの既存replace/trim/move/split/audio policyやtransition参照を掃除してからremove/moveを積むので、保存前previewとpatch queueが同じ結果を指す。
- `StudioViewModel.rippleDeleteSelectedTimelineClip` は単体clipと同一track複数選択clipを同じgroup planで扱う。複数trackをまたぐ選択は映像/音声同期を壊しうるため、今回は「複数トラックをまたぐリップル削除は未対応」と明示して拒否する。
- `swift test --package-path apps/macos-studio --filter TimelineRippleDeletePlanTests`（7 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-97/TEST-105を追加し、227件の追跡行（Story 25 / Issue 97 / Test 105）、残課題3件、修正/合格224件、未解決P0/P1 3件、重複ID0件、実formula error0件として更新した。running appでsame-track marquee選択後のDelete/リップル削除、後続clip累積詰め、Viewer/playhead即時反映、未保存状態、複数track選択時の拒否statusは人間確認キューへ集約する。

- M6.5第57スライスでは、`R` / `選択範囲をループ` を単体clipだけでなく、複数選択clip範囲と選択transition周辺にも効くようにした。ユーザー体験としては、複数clipを削除/移動/trimした直後にその範囲をそのままloop再生でき、transitionを調整した直後は選択transitionの前後を短く繰り返してViewerで確認できる。
- `TimelinePlaybackLoop.range(covering:)` は複数clipの最小 `timelineInFrame` から最大 `timelineOutFrame` までを1つのレビュー範囲にする。`TimelinePlaybackLoop.transitionReviewRange(timeline:transition:)` は隣接した可視transitionの編集点を中心に、transition duration分だけ前後を含めた短いレビュー範囲を作る。
- `StudioViewModel.canSetLoopPlaybackRangeToSelection` と `setLoopPlaybackRangeToSelectedClip` は、選択transitionを優先し、なければ現在のclip selection集合を使ってloop範囲を設定する。ソース確認中は従来通りtimelineへ戻るよう促し、無効な選択ではCommand Paletteのdisabled reasonを出す。
- Command Palette、Viewer help、macOS Transport menuの文言は `選択クリップ` から `選択範囲` に寄せた。検索語には `transition` / `トランジション` / `複数` を追加し、NLE経験者が「範囲レビュー」目的で見つけやすくした。
- `swift test --package-path apps/macos-studio --filter TimelinePlaybackTransportTests`（7 tests / 0 failures）、`swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-98/TEST-106を追加し、229件の追跡行（Story 25 / Issue 98 / Test 106）、残課題3件、修正/合格226件、未解決P0/P1 3件、重複ID0件、実formula error0件として更新した。running appでmulti-select範囲loop、transition選択loop、Rでのon/off、LoopRange badge、Viewer再生折り返しは人間確認キューへ集約する。

- M6.5第58スライスでは、複数トラックにまたがるclip選択を `Delete` / `選択項目を削除` でブロックせず、リップルしないlift deleteとして削除できるようにした。ユーザー体験としては、映像と音声、またはV/O/Aにまたがって不要な素材を選んだ時、危険な同期詰めを勝手に行わず、選択clipだけがその場で消え、未選択clipは元の位置に残る。
- `TimelineLiftDeletePlan` は選択clipをdisplay track順、timeline順で決定的に並べ、`remove_segment` だけを作る。`TimelineDocument.applyingLiftDelete(_:)` は選択clipとそれに接続するtransitionをin-memory timelineから除去し、後続clipの `timelineInFrame` は変えない。
- `StudioFeedbackSession.queueLiftDelete` は削除clipの既存replace/trim/move/split/audio policyとtransition参照を掃除してからremove operationsを積む。`StudioViewModel.deleteTimelineSelection` は、同一trackで安全にrippleできる選択なら従来通りripple deleteを優先し、それ以外のclip selectionではlift deleteへフォールバックする。Toolbarの `リップル削除` は今後も同一track ripple専用で、cross-track rippleを暗黙実行しない。
- Command Paletteの `選択項目を削除` subtitleは、同一track clipはリップル削除、複数track clipは空きを保持して削除、transitionはcutへ戻す、と明示した。検索語には `lift` / `cross-track` / `複数トラック` を追加し、NLE経験者が「複数トラック削除」を探した時にも見つかるようにした。
- `swift test --package-path apps/macos-studio --filter TimelineRippleDeletePlanTests`（9 tests / 0 failures）、`swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-99/TEST-107を追加し、231件の追跡行（Story 25 / Issue 99 / Test 107）、残課題3件、修正/合格228件、未解決P0/P1 3件、重複ID0件、実formula error0件として更新した。running appでcross-track clip selection後のDelete/Command Palette、未選択clip位置保持、接続transition除去、Viewer/playhead seek、未保存状態、Toolbar ripple disabledは人間確認キューへ集約する。

- M6.5第59スライスでは、source monitorで再生/シークして見ている位置を、そのままsource candidateのIN/OUTへマークできるようにした。ユーザー体験としては、AIが選んだ素材候補を人間がViewerで確認し、よい開始/終了位置を見つけた瞬間にMediaPanelの `I` / `O` を押す、またはCommand Paletteから `ソースINを現在位置へ` / `ソースOUTを現在位置へ` を実行すると、そのマーク範囲がinsert/drop/replace/overwriteへ使われる。
- `MediaVideoPlayer` はAVPlayerのperiodic time observerとseek時刻を `ViewerSurface` / `ViewerPanel` 経由で `StudioViewModel.updateSourceMonitorPlaybackTime` へ返す。ViewModelはsource monitor表示中だけ現在source時刻を保持し、既存の `TimelineSourceRangeMarkPlan` でcandidate rangeへclampしながらIN/OUT反転を防ぐ。
- `SourceMonitorInsertCandidateSummary` は現在source時刻、現在位置でIN/OUTを打てるか、marked range表示を持つ。`MediaPanel.SourceMarkedRangeControls` は現在時刻と `I` / `O` ボタンを表示し、既存の0.5秒nudge、range handle drag、resetと並べて使える。
- `StudioCommandPaletteCommand` と `ContentView.commandItems` にsource monitor current-time mark commandsを追加した。単キー `I` / `O` shortcutはTextFieldやCommand Palette入力中の誤発火を避けるため、focus modelが整理できるまで今回は見送る。
- `swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-100/TEST-108を追加し、233件の追跡行（Story 25 / Issue 100 / Test 108）、残課題3件、修正/合格230件、未解決P0/P1 3件、重複ID0件、実formula error0件として更新した。running appでsource monitor再生/seek、I/Oボタン、Command Palette、marked range反映、insert/drop/replace/overwriteへの反映、Program preview復帰、未保存状態は人間確認キューへ集約する。

- M6.5第60スライスでは、source monitorの現在位置IN/OUTマークを `I` / `O` キーでも実行できるようにした。ユーザー体験としては、source monitorで素材を見ながら、開始点で `I`、終了点で `O` を押せば、MediaPanelのボタンを探さずマーク範囲が更新される。
- `StudioWorkspaceView` に `sourceMonitorFocused` を追加し、source monitor assetが選ばれた時とViewerをクリックした時だけsource monitor shortcut focusへ入るようにした。`timelineFocused` がtrueになったらsource focusは解除されるため、Timeline操作中にI/Oがsource markへ誤発火しない。
- `SourceMonitorShortcutButtons` は隠しbuttonとして `keyboardShortcut("i")` / `keyboardShortcut("o")` を持ち、source monitor focus中かつsource monitor assetがある時だけ `markSourceMonitorInAtPlaybackTime` / `markSourceMonitorOutAtPlaybackTime` を呼ぶ。Command PaletteのsubtitleもSource Monitor focus時のI/Oキーを案内する。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-101/TEST-109を追加し、235件の追跡行（Story 25 / Issue 101 / Test 109）、残課題3件、修正/合格232件、未解決P0/P1 3件、重複ID0件、実formula error0件として更新した。running appでsource monitor asset選択後のI/O、Viewer click後のI/O、timeline focus後の無効化、source-bin search TextField入力中のi/o文字入力、marked range反映は人間確認キューへ集約する。

- M6.5第61スライスでは、複数選択したclipをドラッグ移動するときに、個々のclipだけでなく選択グループ全体の着地範囲をTimeline上で見えるようにした。ユーザー体験としては、Multi-selectやCommand-Aで選んだ複数clipを掴んで動かすと、紫のrange bandと開始/終了railが出て、FCPX/CapCut的に「選択した塊がどこへ吸い付くか」をmouse-up前に確認できる。
- `TimelineTrackRow.groupMoveRangeCue` は `TimelineClipGroupMovePlan` の `newTimelineInFrames` からtrackごとの新しいgroup rangeを計算する。`TimelineGroupMoveRangeCue` は紫の破線band、開始/終了rail、group badgeを描き、badgeにはclip数、秒数delta、押し出し数、snap状態を短く表示する。
- 既存のgroup move operations、Viewer preview、snap/displacement planはそのまま使い、schema/compiler契約は増やしていない。Clipのaccessibility valueにも、グループ移動中の着地点と押し出し先を追加した。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests`（19 tests / 0 failures）と `swift build --package-path apps/macos-studio --target VideoOSStudio` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-102/TEST-110を追加し、237件の追跡行（Story 25 / Issue 102 / Test 110）、残課題3件、修正/合格234件、未解決P0/P1 3件、重複ID0件、実formula error0件として更新した。running appでmulti-select drag中のgroup range band、start/end rails、group badge、snap indicator、押し出しclip表示、Viewer preview、mouse-up後のin-memory位置反映は人間確認キューへ集約する。

- M6.5第62スライスでは、同じtrack上の複数選択clipを、1つの塊として上/下の空いている互換trackへドラッグ移動できるようにした。ユーザー体験としては、V1上の複数clipをMulti-selectで選んだあと、上下へドラッグすると、単体clipと同じようにV2/O2/A2などの空きレイヤーへタイミングを保ったまま移せる。
- `TimelineClipGroupMovePlan` は `preferredTargetTrackID` を受け取り、同一source track内の複数選択だけを `move_segment.target_track_id` 付きoperationsへ変換する。空き互換trackへの移動を先に成立させ、occupied互換targetは第63でlane-liftへ発展させた。kindが違う場合、または選択clipが複数trackにまたがる場合はnilで拒否する。
- `StudioViewModel.dragMoveTimelineClip` と `previewTimelineClipMove` はgroup moveにも `targetTrackID` を渡す。`TimelineTrackRow` はgroup drag中の縦移動でtarget rowにgroup range cueを表示し、元rowのclipは薄く残し、不可時はblocked cueを表示する。`TimelineGroupMoveRangeCue` のbadge/helpにも `→targetTrackID` を出す。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests`（21 tests / 0 failures）と `swift build --package-path apps/macos-studio --target VideoOSStudio` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-103/TEST-111を追加し、239件の追跡行（Story 25 / Issue 103 / Test 111）、残課題3件、修正/合格236件、未解決P0/P1 3件、重複ID0件、実formula error0件として更新した。running appでsame-track multi-selectionの上下drag、target row cue、元row残像、Viewer preview、mouse-up後のtarget track反映、cross-kind/cross-track拒否表示は人間確認キューへ集約する。

- M6.5第63スライスでは、同じtrack上の複数選択clipをoccupiedな互換targetへ縦dragした時にも、拒否ではなくopen/new compatible trackへまとめてlane-liftできるようにした。ユーザー体験としては、選択グループを1つの磁気オブジェクトとして掴み、重なるtrack上に置こうとした時にFCPX/CapCut的に別レイヤーへ逃げる。
- `TimelineClipGroupMovePlan` は `laneLift` を持ち、occupied target上のoverlapを検出したら既存の空き互換trackを再利用し、なければV3/A3/O3などの新規trackを作る。commitは全selected clipに既存の `move_segment.target_track_id` を付けるだけなので、schema/compiler契約は増やしていない。
- `TimelineTrackRow` はgroup lane-lift中にopen target rowまたはsource row上のnew-lane band、`→V3 新規` のtarget label、source row ghost、landing cue、move badgeを表示する。`StudioViewModel` はdrop後statusで既存trackへまとめてliftしたか、新規trackを作ったかを明示する。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests`（22 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-104/TEST-112を追加し、241件の追跡行（Story 25 / Issue 104 / Test 112）、残課題3件、修正/合格238件、未解決P0/P1 3件、重複ID0件、実formula error0件として更新した。running appでsame-track groupのoccupied target drag、open/new lane cue、Viewer preview、mouse-up後target track反映、cross-kind/cross-track拒否表示は人間確認キューへ集約する。

- M6.5第64スライスでは、選択clipの先頭/末尾を再生位置へ詰める編集を、FCPX/Premiereで期待されるQ/W系の即時操作に寄せた。ユーザー体験としては、clipを選び、playheadをclip内に置いて `Q` を押すと先頭がplayheadへ詰まり、`W` を押すと末尾がplayheadへ切られ、保存前でもTimelineとViewerがその場で新しい範囲を再生する。
- `StudioViewModel.trimSelectedTimelineClipToPlayhead` は既存の `TimelinePlayheadTrimPlan` が作る `trim_segment` / `move_segment` operationsをpatch queueへ残しながら、同じoperationsをin-memory Timelineへ即時適用する。source monitor、transition選択、drag-time previewなどの一時状態はクリアし、playheadとmedia/audio sync generationを更新してProgram previewへ戻す。
- `ContentView` はtimeline focus中の `Q` / `W` hidden shortcut buttonと、Command Paletteの `先頭を再生位置へトリム` / `末尾を再生位置へトリム` を追加した。Command Paletteのsubtitleは、選択clipの先頭/末尾が再生位置へ詰まり、Timeline/Viewerへ即時反映されることを明示する。
- `swift test --package-path apps/macos-studio --filter TimelinePlayheadTrimPlanTests`（5 tests / 0 failures）、`swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-105/TEST-113を追加し、243件の追跡行（Story 25 / Issue 105 / Test 113）、残課題3件、修正/合格240件、未解決P0/P1 3件、重複ID0件として更新した。running appでQ/W key focus、Command Palette、toolbar、Viewer即時反映、text field/source monitor誤発火なしは人間確認キューへ集約する。

- M6.5第65スライスでは、Q/Wやdrag trimだけでなく、toolbarの0.5秒trim、roll、extend、slipも「押したらその場で変わる」操作感へ揃えた。ユーザー体験としては、選択clipに対して `先頭0.5` / `末尾0.5`、incoming/outgoing roll、`先頭を伸ばす` / `末尾を伸ばす`、`スリップ←` / `スリップ→` を押すと、保存前でもTimeline形状またはViewer source frameが即時に更新される。
- `StudioViewModel.queueAndApplyTimelineTrimOperations` は既存の `trim_segment` / `move_segment` operationsをpatch queueへ残しつつ、同じoperationsを `TimelineDocument.applyingTimelineTrimOperations` へ流してin-memory Timelineへ即時適用する。source monitor、transition selection、drag-time previewはクリアし、playheadとmedia/audio sync generationを更新してProgram previewへ戻す。
- 固定0.5秒trimは手書きのsource-range-only trimから `TimelineDragTrimPlan` へ寄せたため、drag trimと同じようにclip duration/timelineIn/source rangeが一緒に変わる。Roll、extend、slipも同じ共通helperを使うので、隣接編集点やViewer source frameが保存前に見える。
- `swift test --package-path apps/macos-studio --filter TimelineRollTrimPlanTests`（5 tests / 0 failures）、`TimelineExtendTrimPlanTests`（5 tests / 0 failures）、`TimelineSlipTrimPlanTests`（5 tests / 0 failures）、`TimelineDragTrimPlanTests`（11 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-106/TEST-114を追加し、245件の追跡行（Story 25 / Issue 106 / Test 114）、残課題3件、修正/合格242件、未解決P0/P1 3件、重複ID0件として更新した。running appでtoolbar trim suiteのbutton feel、Viewer即時反映、保存後一致は人間確認キューへ集約する。

- M6.5第66スライスでは、Mediaパネルの素材bin ready rowを直接timelineへdragできるようにした。ユーザー体験としては、素材選定中にsource monitor内の候補カードを探す前でも、ready素材rowを掴んでtimelineへ落とすだけで、最適な未使用select候補を既存source-dropと同じ磁気挙動で追加できる。
- `StudioViewModel.sourceBinQuickDragPayload` は、ready素材、読み込み済みtimeline、candidateDataSourceが揃う場合だけ `TimelineSourceInsertPlan.bestCandidate` でcandidateを選び、既存の `StudioDragPayload.sourceCandidate` を返す。`MediaSourceBinRow` はpayloadがあるrowにだけ `onDrag` とhand cueを出すため、非ready素材やcandidateがない素材はdrag可能に見せない。
- drop preview/commitは既存の `TimelineSourceCandidateDropDelegate` を通るため、source candidate card dragと同じghost、snap rail、blocked lane、occupied-lane lift、drop後の即時Timeline/Viewer反映を使う。source monitorでmarked rangeを調整してからdropしたい場合は、従来通りsource monitor candidate cardをdragする。
- `swift build --target VideoOSStudio`、`swift test --filter TimelineSourceInsertPlanTests`（21 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-107/TEST-115を追加し、247件の追跡行（Story 25 / Issue 107 / Test 115）、残課題3件、修正/合格244件、未解決P0/P1 3件、重複ID0件として更新した。running appでready row drag、hand cue、timeline ghost/snap/lane-lift、drop後Viewer/Timeline反映、非ready/candidate-less rowのcue非表示は人間確認キューへ集約する。

- M6.5第67スライスでは、source-bin row quick dragの前に、row上で実際にdragされるbest candidateを確認できるようにした。ユーザー体験としては、ready素材rowにcandidate segment、role、default target track、duration、confidenceが小さく表示され、素材を掴む前から何がtimelineへ入るか分かる。
- `StudioViewModel.sourceBinQuickDragSummary` は `sourceBinQuickDragPayload` と同じ `sourceBinQuickDragCandidate` helperを使うため、表示cueと実drag payloadが同じcandidate IDを指す。`MediaSourceBinRow` はsummaryがある時だけmetadata pillを表示し、payloadがある時だけhand cue/onDragを出す。
- 候補なしready素材や非ready素材にはcue/payloadを出さない。表示されるtarget trackはdefault targetの予告で、hover lane、snap、occupied-lane liftは従来通りdrop plannerが最終解決するため、schema/compiler契約は増えていない。
- `swift build --target VideoOSStudio`、`swift test --filter TimelineSourceInsertPlanTests`（22 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-108/TEST-116を追加し、249件の追跡行（Story 25 / Issue 108 / Test 116）、残課題3件、修正/合格246件、未解決P0/P1 3件、重複ID0件として更新した。running appでcandidate cueの視認性、drag payload一致、長いsegment IDでの崩れなし、非ready/candidate-less rowのcue非表示は人間確認キューへ集約する。

- M6.5第68スライスでは、source-bin ready rowからsource monitorやdrag操作を挟まず、row上のquick insert iconでbest candidateをplayheadへ即追加できるようにした。ユーザー体験としては、素材binで良さそうな素材を見つけたら、表示cueを確認して、そのまま再生位置へ入れられる。
- `MediaSourceBinRow` はcandidate summaryがあるrowだけに `MediaPanel.SourceBinQuickInsertButton.*` を表示する。`StudioViewModel.insertSourceBinQuickCandidateAtPlayhead` は `sourceBinQuickDragCandidate` を再利用し、row cue/drag payloadと同じcandidate IDを `TimelineSourceInsertPlan` へ渡す。
- quick insert実行後は、既存 `insert_segment` operationをfeedback sessionへ積み、in-memory timeline、選択、changed-clip highlight、playhead、Viewer sync generationを即更新する。schema/compiler契約は増やしていない。任意のdrop位置やtarget laneを選びたい場合は、引き続きsource-bin row dragを使う。
- `swift build --target VideoOSStudio`、`swift test --filter TimelineSourceInsertPlanTests`（23 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-109/TEST-117を追加し、251件の追跡行（Story 25 / Issue 109 / Test 117）、残課題3件、修正/合格248件、未解決P0/P1 3件、重複ID0件として更新した。running appでquick insert buttonの視認性、candidate cueとの一致、click後のTimeline/Viewer即時反映、非ready/candidate-less rowのdisabled状態は人間確認キューへ集約する。

- M6.5第69スライスでは、選択中の適用済みtransitionをtoolbarから0.5秒単位で短縮/延長できるようにした。ユーザー体験としては、transition side gripを正確に掴めない場合でも、transitionを選んで `長さ−` / `長さ＋` を押すだけで長さを微調整できる。
- `StudioViewModel.shortenSelectedTimelineTransitionDuration` / `lengthenSelectedTimelineTransitionDuration` は、選択中transition、隣接clip handles、sequence fpsから0.5秒分のframe deltaを解決し、既存 `adjustTimelineTransitionDuration` の即時in-memory更新pathを再利用する。operation reasonはtoolbar操作用に分けたが、schema/compiler契約は増やしていない。
- `TimelineEditToolbar` はtransition preset paletteの隣に `Timeline.EditToolbar.TransitionDurationShorter` / `Timeline.EditToolbar.TransitionDurationLonger` を追加し、handle上限/下限に達した場合はdisabledになる。実行後は既存pathによりset_transition patch、timeline transition duration、selection、playhead/Viewer sync、status textが保存前に揃う。
- `swift build --target VideoOSStudio`、`swift test --filter TimelineTransitionDropPlanTests`（15 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-110/TEST-118を追加し、253件の追跡行（Story 25 / Issue 110 / Test 118）、残課題3件、修正/合格250件、未解決P0/P1 3件、重複ID0件として更新した。running appでtoolbar buttonの視認性、disabled境界、クリック後のViewer fade preview、side grip dragとの併用は人間確認キューへ集約する。

- M6.5第70スライスでは、前スライスの選択中transition 0.5秒短縮/延長を、toolbarだけでなくCommand Paletteとtimeline focus shortcutからも呼べるようにした。ユーザー体験としては、細いtransition gripやtoolbarまで視線を戻さず、`Shift-[` / `Shift-]` を連打してViewerを見ながら尺を詰められる。
- `StudioCommandPaletteCommand` は `shorten-selected-transition` / `lengthen-selected-transition` を追加し、title、system image、検索語にtransition/duration/長さ/短く/長く/クロスフェードを登録した。`ContentView.commandItems` は選択中transitionのhandle制約に応じてenabled/disabledを出し、Command Paletteからも既存 `shortenSelectedTimelineTransitionDuration` / `lengthenSelectedTimelineTransitionDuration` を呼ぶ。
- `TimelineShortcutButtons` はtimeline focus中だけ `Shift-[` / `Shift-]` を受け、選択clipの `[ ]` nudgeとは衝突しない。実行時は前スライスと同じ `adjustTimelineTransitionDuration` pathを通るため、schema/compiler契約は増やしていない。
- `swift test --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-111/TEST-119を追加し、255件の追跡行（Story 25 / Issue 111 / Test 119）、残課題3件、修正/合格252件、未解決P0/P1 3件、重複ID0件として更新した。running appでCommand Palette検索/disabled reason、timeline focus時の `Shift-[` / `Shift-]`、TextFieldやsource monitor中の誤発火なしは人間確認キューへ集約する。

- M6.5第71スライスでは、FCPXのdefault transition感に近い導線として、選択中または再生位置近くの映像編集点へクロスフェードを即適用するCommand Palette項目とtimeline-focus `Command-T` を追加した。ユーザー体験としては、transition preset paletteのdrop targetを探せない時でも、Command Paletteで `クロスフェードを適用` を検索するか、timelineにfocusして `Command-T` を押せばdefault crossfadeが入り、TimelineとViewerへ反映される。
- `StudioCommandPaletteCommand` は `apply-default-crossfade-transition` を追加し、title、system image、検索語にcrossfade/default/Command-T/FCP/編集点を登録した。`ContentView.commandItems` と `TimelineShortcutButtons` は既存 `applyTransitionPresetNearContext(TimelineTransitionPreset.crossfade.id)` を呼び、transition placement resolver、in-memory timeline update、Viewer transition preview、pending `set_transition` の既存経路を再利用する。
- このスライスではschema/compiler契約を増やさず、drop/click-to-applyと同じtransition quick apply pathを増やしただけに留めた。Command Palette disabled reasonはtimeline未読込時に限定し、隣接映像編集点が見つからない場合の具体的な案内は既存ViewModel statusに任せる。
- `swift test --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 25091で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-112/TEST-120を追加し、257件の追跡行（Story 25 / Issue 112 / Test 120）、残課題3件、修正/合格254件、未解決P0/P1 3件、重複ID0件として更新した。running appでCommand Palette検索、`Command-T` focus gating、選択transition/clip/playhead-nearest edit pointの解決、Viewer fade preview、TextField/source monitor中の誤発火なしは人間確認キューへ集約する。

- M6.5第72スライスでは、クロスフェードpreset chipをdefault transitionとして識別できるようにした。ユーザー体験としては、Command Paletteやshortcutを知らなくても、transition palette上のクロスフェードに小さなcommand iconが出て、tooltip/accessibility hintから `Command-T` のdefault apply導線も発見できる。
- `TimelineTransitionPresetChip` は `preset == .crossfade` の時だけcommand iconを追加し、help textに「デフォルトトランジションとしてCommand-Tでも適用できます」を加える。accessibility label/hintもdefault transitionとして読むが、visible textを増やしてtoolbarを重くしない。
- click apply、drag/drop、Command Palette、`Command-T` は既存のtransition quick apply/drop pathを維持する。schema/compiler契約は増やさず、今回の変更はpalette affordanceとaccessibilityに閉じた。
- `swift build --target VideoOSStudio`、`swift test --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 47793で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-113/TEST-121を追加し、259件の追跡行（Story 25 / Issue 113 / Test 121）、残課題3件、修正/合格256件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでcrossfade chipのcommand icon、tooltip/accessibility hint、toolbar混雑なし、click/drag/Command-T退行なしは人間確認キューへ集約する。

- M6.5第73スライスでは、複数選択中のtoolbar summaryを、単なる件数表示から選択scopeが読める表示へ更新した。ユーザー体験としては、marquee selectionや `Command-A` 後に、group move、0.5秒nudge、Delete、`R` loopを実行する前に、対象clip数、track、timecode range、durationを確認できる。
- `TimelinePanel.selectedClipSelections(in:)` は現在の `selectedClipIDs` と主clipから実際の `TimelineClipSelection` 配列を再構築し、`TimelineEditToolbar` へ渡す。`TimelineEditToolbar` は複数選択時に `multiSelectionRangeDetail` でmin in-frameからmax out-frameまでを計算し、track summaryとrange/durationを2行summaryとhelpへ出す。
- 複数選択時だけsummaryの最大幅を広げ、単一clip/transition選択時のtoolbar密度は維持した。schema/compiler/patch契約は増やさず、既存のgroup move、lane-lift、nudge、Delete、loop pathも変更していない。
- `swift build --target VideoOSStudio`、`swift test --filter TimelineClipMovePlanTests`（22 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 88093で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-114/TEST-122を追加し、261件の追跡行（Story 25 / Issue 114 / Test 122）、残課題3件、修正/合格258件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでmulti-select、marquee selection、`Command-A` 後のtoolbar summary count/tracks/range/duration、長いtimecodeでの詰まり、group move/nudge/Delete/R対象との一致は人間確認キューへ集約する。

- M6.5第74スライスでは、toolbarの `リップル削除` を同一トラック複数選択でも実行できるようにした。ユーザー体験としては、marquee selectionでV1上の不要clipを複数選んだら、DeleteキーやCommand Paletteだけでなく、目の前のtoolbar buttonからも同じ即時ripple deleteを実行できる。
- `TimelineEditToolbar` は `リップル削除` のdisabled条件を `!hasSingleSelectedClip || !canRippleDeleteSelectedClip` から `!hasSelectedClip || !canRippleDeleteSelectedClip` へ変更した。`canRippleDeleteSelectedClip` は既存の `TimelineRippleDeleteGroupPlan` を使うため、同一track複数選択ではenabled、複数track選択ではdisabledのままになる。
- help textは複数選択時に「選択中のN件を削除し、同じトラックの後続クリップを累積で前へ詰める」と説明する。schema/compiler/patch契約は増やさず、UX-97で実装済みのsame-track group ripple pathをtoolbarから呼べるようにしただけに留めた。
- `swift build --target VideoOSStudio`、`swift test --filter TimelineRippleDeletePlanTests`（9 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 1324で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-115/TEST-123を追加し、263件の追跡行（Story 25 / Issue 115 / Test 123）、残課題3件、修正/合格260件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでsame-track marquee/multi-select後のtoolbarリップル削除、cross-track selectionでのdisabled/help、Deleteキー/Command Paletteとの結果一致は人間確認キューへ集約する。

- M6.5第75スライスでは、toolbarに汎用の `削除` buttonを追加し、`リップル削除` との意味差を見えるようにした。ユーザー体験としては、DeleteキーやCommand Paletteを知らない初回ユーザーでも、選択clipやtransitionを目の前のtoolbarから削除でき、同一trackでは磁気的に詰まり、複数trackでは空きを保持する安全な削除になる。
- `TimelinePanel` は `canDeleteSelection` と `onDeleteSelection` を `TimelineEditToolbar` へ渡し、`TimelineEditToolbar.DeleteSelection` は既存 `StudioViewModel.deleteTimelineSelection()` を呼ぶ。これにより単体clip / same-track multi-select / cross-track multi-select / transition remove-to-cut はDeleteキーやCommand Paletteと同じ経路を共有する。
- `リップル削除` は同一track gap close専用buttonとして残し、system imageを `trash` から詰め方向の `arrow.left.to.line.compact` へ変えた。通常の `削除` は `trash` iconのままなので、削除そのものとgap close専用操作を視覚的に分ける。schema/compiler/patch契約は増やしていない。
- `swift build --target VideoOSStudio`、`swift test --filter TimelineRippleDeletePlanTests`（9 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 24871で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-116/TEST-124を追加し、265件の追跡行（Story 25 / Issue 116 / Test 124）、残課題3件、修正/合格262件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtoolbar `削除` button、same-track ripple結果、cross-track lift delete結果、transition remove-to-cut、`リップル削除` とのicon/help差は人間確認キューへ集約する。

- M6.5第76スライスでは、timeline zoom、全体表示、track densityを起動後も維持するようにした。ユーザー体験としては、編集者がdetail zoomやcompact/expanded densityを決めたら、プロジェクト切替や次回起動でも同じ作業密度から続けられる。
- `StudioViewModel.timelinePixelsPerFrame` / `isTimelineFitToWindowEnabled` / `timelineTrackDensity` は、既存 `isTimelineSnappingEnabled` や source-bin filter/sort と同じ `UserDefaults` patternで読み込み、`didSet` で保存する。manual zoomはclamp済みの `TimelineViewportScale` を使い、fit/reset/density pickerの既存UIは変えない。
- 表示設定だけをapp-local defaultsへ保存し、timeline.json、review patch、compiler schemaには触れない。Invalid density raw valueや未保存時は標準値へ戻すfail-open挙動を保つ。
- `swift build --target VideoOSStudio`、`swift test --filter TimelineViewportScaleTests`（5 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 39624で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-117/TEST-125を追加し、267件の追跡行（Story 25 / Issue 117 / Test 125）、残課題3件、修正/合格264件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでzoom/fit/density/snappingの再起動後保持、project switch後保持は人間確認キューへ集約する。

- M6.5第77スライスでは、source-bin検索語とsource monitorの確認中asset/candidateを起動後も維持するようにした。ユーザー体験としては、編集者が素材棚で検索しながら候補素材をsource monitorで確認している途中でも、再起動後に同じ絞り込みと確認文脈から素材選定を続けられる。
- `StudioViewModel.mediaSourceBinQuery` / `sourceMonitorAssetID` / `sourceMonitorCandidateID` は `UserDefaults` patternで読み込み、`didSet` で保存する。`selectedProjectID` は初回default project選択では復元済みsource monitorを消さず、実project切替時だけsource monitor / transient preview / loop stateをclearする。
- `loadTimelineForSelection()` は復元されたsource monitor assetが現在projectに存在し、かつ再生可能な場合だけ保持する。missing/unready asset、戻るbutton、実project切替ではsafeにnilへ戻るため、timeline.json、review patch、compiler schemaには影響しない。
- `swift build --target VideoOSStudio`、`swift test --filter ProjectMediaResolverTests`（33 tests / 0 failures）、`swift test --filter TimelineSourceInsertPlanTests`（23 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 67555で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-118/TEST-126を追加し、269件の追跡行（Story 25 / Issue 118 / Test 126）、残課題3件、修正/合格266件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで検索語、source monitor asset/candidate、検索clear、戻る、再起動、実project切替、missing/unready素材のclearは人間確認キューへ集約する。

- M6.5第78スライスでは、source-binの検索結果をsmart bin的に分類して見られるようにした。ユーザー体験としては、編集者が素材棚で検索・filter・sortを使った後、結果を一覧のまま見るだけでなく、フォルダ、再生状態、種類のまとまりで素材をスキャンできる。
- `ProjectMediaSourceBinGroupMode` / `ProjectMediaSourceBinGroup` / `ProjectMediaPreviewSummary.groupedItems(...)` を追加し、filter/search/sort後の `ProjectMediaPreviewStatus` を一覧、folder、status、kindで安定したgroupへ変換する。`StudioViewModel.mediaSourceBinGroupMode` は既存source-bin設定と同じ `UserDefaults` patternで読み込み、`MediaPanel.SourceBinGroupModePicker` とgroup headerが表示する。
- この変更はview groupingとapp-local preferenceだけを追加し、source monitor preview、quick insert、source row drag、timeline.json、review patch、compiler schemaには触れない。分類表示中も同じrow componentを使うため、既存のソース確認、再生位置へ追加、drag/drop経路は維持される。
- `swift build --target VideoOSStudio`、`swift test --filter ProjectMediaResolverTests`（34 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 90808で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-119/TEST-127を追加し、271件の追跡行（Story 25 / Issue 119 / Test 127）、残課題3件、修正/合格268件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで分類picker、group header件数、検索/filter/sortとの組み合わせ、分類mode再起動後保持、source monitor highlight、quick insert、source-row dragは人間確認キューへ集約する。

- M6.5第79スライスでは、Source Monitorで確認中の素材を、buttonだけでなくCommand PaletteとSource Monitor focus中のkeyboard shortcutからtimelineへ投入できるようにした。ユーザー体験としては、編集者が素材を再生しながらIN/OUTやcandidateを決めた後、`W` で追加、`D` で上書き、`R` で選択clip置換を実行できる。
- `StudioCommandPaletteCommand` は `insert-source-monitor-at-playhead` / `overwrite-source-monitor-at-playhead` / `replace-selected-clip-with-source-monitor` を追加した。`ContentView.commandItems` は既存 `StudioViewModel.insertSourceMonitorAtPlayhead()` / `overwriteSourceMonitorAtPlayhead()` / `replaceSelectedClipWithSourceMonitorCandidate()` へ接続し、disabled reasonは既存source monitor helpを使う。
- `SourceMonitorShortcutButtons` はSource Monitor focusかつsource monitor assetがある時だけ `W` / `D` / `R` を受ける。timeline focus時の `W` trim、`R` loop、text field入力とは衝突させず、schema/compiler/patch契約も増やさない。
- `swift build --target VideoOSStudio`、`swift test --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 7104で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-120/TEST-128を追加し、273件の追跡行（Story 25 / Issue 120 / Test 128）、残課題3件、修正/合格270件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor focus中の `W` / `D` / `R`、Command Palette検索/disabled reason、timeline focus/TextFieldとのshortcut衝突なしは人間確認キューへ集約する。

- M6.5第80スライスでは、Source Monitorで確認中の素材をFCPXの `E` appendに近い感覚でタイムライン末尾へ追加できるようにした。ユーザー体験としては、編集者がIN/OUTやcandidateを決めた後、再生位置を末尾へ移動しなくても、`E` またはCommand Paletteからrough sequenceの後ろへ続けて積める。
- `StudioViewModel.appendSourceMonitorToTimelineEnd()` は既存 `TimelineSourceInsertPlan.make(...)` に `playheadFrame: timeline.totalFrames` を渡し、既存 `insert_segment` と同じ未保存patch、即時Timeline更新、Viewer同期、changed-clip highlightを使う。`TimelineSourceInsertPlanTests` はappend insertが `timeline.totalFrames` に入ることを固定した。
- `StudioCommandPaletteCommand` は `append-source-monitor-to-timeline-end` を追加し、`ContentView.commandItems` と `SourceMonitorShortcutButtons` はSource Monitor focus中の `E` へ接続した。timeline focusやtext field入力とは衝突させず、timeline.json、review patch schema、compiler schemaは増やしていない。
- `swift build --target VideoOSStudio`、`swift test --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`swift test --filter TimelineSourceInsertPlanTests`（24 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 36099で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-121/TEST-129を追加し、275件の追跡行（Story 25 / Issue 121 / Test 129）、残課題3件、修正/合格272件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor focus中の `E`、Command Palette検索/disabled reason、marked IN/OUT範囲の末尾追加、`W` / `D` / `R` 退行なし、timeline focus/TextFieldとのshortcut衝突なしは人間確認キューへ集約する。

- M6.5第81スライスでは、MediaPanelのsource-bin素材にproject別のお気に入りスターと `★` filterを追加した。ユーザー体験としては、AIが選んだ素材候補を人間が見直しながら「これは使いたい」と思った素材へスターを付け、検索・並び・分類をまたいで軽くcurateした素材棚へ戻れる。
- `ProjectMediaSourceBinFilter.favorites` と `ProjectMediaPreviewSummary.items/count/groupedItems(... favoriteAssetIDs:)` を追加し、既存のfilter/search/sort/groupingにfavorite ID setを合成できるようにした。`StudioViewModel.mediaSourceBinFavoriteAssetIDsByProject` はproject別に `UserDefaults` へ保存するため、timeline.json、review patch、compiler schemaには影響しない。
- `MediaSourceBinRow` には `MediaPanel.SourceBinFavoriteButton.*` のスターbuttonを追加し、`sourceBinFilterLabel` は `★` 件数を表示する。source monitor preview、quick insert、quick dragのrow操作は同じ `ProjectMediaPreviewStatus` rowを使い続けるので、素材投入経路は変えない。
- `swift build --target VideoOSStudio`、`swift test --filter ProjectMediaResolverTests`（34 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify` は成功した。`dist/VideoOSStudio.app` はPID 61851で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-122/TEST-130を追加し、277件の追跡行（Story 25 / Issue 122 / Test 130）、残課題3件、修正/合格274件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでスター付け/解除、`★` filter、検索/並び/分類との組み合わせ、project別保持、既存source monitor/quick insert/source-row drag退行なしは人間確認キューへ集約する。

- M6.5第82スライスでは、同じ時間範囲を覆う複数トラック選択を、常に空きを保持する削除ではなく、磁気的なリップル削除として扱えるようにした。ユーザー体験としては、映像と同期音声などを同じ範囲で選択して削除すると、その範囲が消え、対象トラックの後続クリップが同じ秒数だけ前へ詰まる。
- `TimelineRippleDeleteGroupPlan` は `trackIDs`、`rangeInFrame`、`rangeOutFrame`、`isCrossTrackRipple` を持ち、複数トラック選択では各トラックの選択clipが同一の連続範囲を覆う場合だけ `remove_segment` と後続 `move_segment` を生成する。未選択clipが範囲内に重なる場合や、選択範囲がずれる場合はripple planを拒否する。
- `StudioViewModel.rippleDeleteSelectedTimelineClip` と `TimelineEditToolbar` / Command Paletteの文言は、同じ時間範囲の複数トラックはリップル可能で、範囲がずれる複数トラックは通常削除で空きを保持することが分かる表現に更新した。review patch schemaやcompiler schemaは増やさず、既存 `remove_segment` / `move_segment` contractだけを使う。
- `swift test --filter TimelineRippleDeletePlanTests`（11 tests / 0 failures）、`swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 83568で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-123/TEST-131を追加し、279件の追跡行（Story 25 / Issue 123 / Test 131）、残課題3件、修正/合格276件、未解決P0/P1 3件、重複ID0件として更新した。running appで同一時間範囲V/A/O選択のリップル、範囲ズレ選択のlift fallback、toolbar/help/status、保存/破棄整合は人間確認キューへ集約する。

- M6.5第83スライスでは、MediaPanelのsource-binにtimelineで使用済み/未使用のfilterと使用中badgeを追加した。ユーザー体験としては、AIが荒編集で既に使った素材を避けて未使用素材を探したり、使用済み素材だけに絞って差し替え候補を確認したりできる。
- `ProjectMediaSourceBinFilter.used` / `.unused` を追加し、`ProjectMediaPreviewSummary.items/count/groupedItems` は `usedAssetIDs` を受け取って既存favorite/search/sort/grouping pipelineと組み合わせる。`StudioViewModel.mediaSourceBinUsedAssetIDs` は現在のin-memory timelineからclip assetID集合を計算するため、未保存のinsert/delete後も素材棚の状態が追従する。
- `MediaPanel` はfilter segmented controlへ `使用` / `未使用` を追加し、source-bin rowには `MediaPanel.SourceBinUsedBadge.*` の `使用中` badgeを表示する。source monitor preview、quick insert、source-row drag/drop、timeline.json、review patch schema、compiler schemaは変更していない。
- `swift test --filter ProjectMediaResolverTests`（34 tests / 0 failures）、`swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 13345で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-124/TEST-132を追加し、281件の追跡行（Story 25 / Issue 124 / Test 132）、残課題3件、修正/合格278件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで使用/未使用filter幅、使用中badge、検索/並び/分類/favoritesとの組み合わせ、未保存timeline編集後の状態更新は人間確認キューへ集約する。

- M6.5第84スライスでは、MediaPanelのsource-bin分類に `使用状況` を追加した。ユーザー体験としては、AI荒編集後に素材棚を `未使用` と `使用中` の2グループで見渡し、未使用素材を探しながら、すでにcutに入っている素材も同じ一覧内で確認できる。
- `ProjectMediaSourceBinGroupMode.usage` と `ProjectMediaPreviewSummary.groupedItems(... groupMode: .usage, usedAssetIDs:)` を追加し、既存filter/search/sort/grouping pipelineの後段で `unused` / `used` groupへ分ける。`未使用` を先に表示するため、追加素材探しを優先しながら使用済み素材へ戻れる。
- `MediaPanel` の分類pickerは `使用状況` を表示し、group headerは `未使用` / `使用中` と件数を出す。各rowの `使用中` badge、favorite、source monitor preview、quick insert、source-row drag/drop、timeline.json、review patch schema、compiler schemaは変更していない。
- `swift test --filter ProjectMediaResolverTests`（34 tests / 0 failures）、`swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 37321で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-125/TEST-133を追加し、283件の追跡行（Story 25 / Issue 125 / Test 133）、残課題3件、修正/合格280件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで `使用状況` grouping、未使用/使用中group順、filter/search/sort/favoritesとの組み合わせ、未保存timeline編集後のgroup移動は人間確認キューへ集約する。

- M6.5第85スライスでは、MediaPanelのsource-bin filterを8項目segmented controlからcompact menu pickerへ変更した。ユーザー体験としては、favorites、使用/未使用、再生可、映像、音声、要対応などfilter条件が増えても、狭い素材棚上部が横に詰まらず、現在条件と件数をすぐ確認できる。
- `MediaPanel.SourceBinFilter` は既存のaccessibility identifierを維持したまま `.menu` pickerになり、`MediaPanel.SourceBinFilterSummary` が選択中filterと件数を表示する。`ProjectMediaSourceBinFilter`、`StudioViewModel.mediaSourceBinFilter` のUserDefaults保持、`ProjectMediaPreviewSummary` のfilter/search/sort/grouping/count pipeline、timeline.json、review patch schema、compiler schemaは変更していない。
- `sourceBinFilterName` と `sourceBinFilterLabel` を分け、menu候補とsummaryで同じlabel/countを使う。source monitor preview、quick insert、source-row drag/drop、favorites、used/unused filter、usage groupingは既存経路を維持する。
- `swift build --target VideoOSStudio`、`swift test --filter ProjectMediaResolverTests`（34 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 56868で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-126/TEST-134を追加し、285件の追跡行（Story 25 / Issue 126 / Test 134）、残課題3件、修正/合格282件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでfilter menu幅、menu label/count、選択中summary、狭幅でのclippingなし、source monitor/quick insert/source-row drag退行なしは人間確認キューへ集約する。

- M6.5第86スライスでは、transition presetをドラッグ中に、toolbar palette内でどのpresetを持っているかが分かるactive状態を追加した。ユーザー体験としては、クロスフェードなどの効果を掴んだ直後から、編集点へ運んでいる途中も「今このtransitionを持っている」状態が消えず、drop targetを探しやすい。
- `TimelinePanel` は `activeTransitionPresetDragID` を `TimelineEditToolbar` / `TimelineTransitionPresetPalette` へ渡し、`TimelineTransitionPresetChip.isActiveDrag` がactive presetだけaccent highlightを出す。`TimelineTransitionPresetPalette` は `Timeline.TransitionPresetDragStatus` で `クロスフェード ドラッグ中` などのcompact status pillを表示する。
- この変更はUI状態表示だけに閉じ、既存drag payload、eligible edit point landing guides、drop magnet cue、drop-hover Viewer preview、click-to-apply、`Command-T`、`set_transition` commit pathは維持する。timeline.json、review patch schema、compiler schemaは変更していない。
- `swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 90495で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-127/TEST-135を追加し、287件の追跡行（Story 25 / Issue 127 / Test 135）、残課題3件、修正/合格284件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでcrossfade/dip/match presetのdrag中status、chip highlight、drop/cancel/timeout後の消灯、toolbar狭幅、landing guides/Viewer preview退行なしは人間確認キューへ集約する。

- M6.5第87スライスでは、Timeline edit toolbarの常用command buttonを、長い日本語text button列からicon-firstの固定幅tool stripへ寄せた。ユーザー体験としては、trim、delete、nudge、roll、slip、split、swap、search、apply、undoをタイムラインを見ながら連続操作するとき、横に伸びるlabel列を探す負荷が減る。
- `TimelineEditToolbar.toolbarButton` は `Label(title, systemImage:)` を `.iconOnly` で描画し、各buttonを24x22ptの安定した面にした。元titleは `accessibilityLabel` と既存help tooltipで残すため、初回ユーザーやassistive technologyでは操作名を確認できる。
- この変更は表示密度だけに閉じ、各toolbar buttonのaction closure、disabled条件、help text、accessibility identifier、mode toggles、transition preset palette、selected item summary、timeline.json、review patch schema、compiler schemaは変更していない。
- `swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 3754で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-128/TEST-136を追加し、289件の追跡行（Story 25 / Issue 128 / Test 136）、残課題3件、修正/合格286件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでicon-only buttonの視認性、tooltip/VoiceOver label、disabled states、狭幅での横scroll改善、主要編集button退行なしは人間確認キューへ集約する。

- M6.5第88スライスでは、icon-first化したTimeline edit toolbarを操作カテゴリごとの視覚clusterへ分けた。ユーザー体験としては、長いbutton labelを戻さなくても、モード、トランジション、評価/削除/移動、トリム、編集点/素材範囲、素材差し替え、保留中修正のまとまりが見え、初回ユーザーもNLE経験者も操作の場所を探しやすくなる。
- `TimelineEditToolbar.toolbarSection` は既存control群を小さなclusterへ包み、薄いbackground/stroke、section accessibility label、section accessibility identifierを追加する。`Timeline.EditToolbar.Section.Modes`、`Section.Transitions`、`Section.SelectionEdits`、`Section.Trim`、`Section.EditPoint`、`Section.Source`、`Section.Session` が新しい確認単位になる。
- 既存buttonのicon-only描画、action closure、disabled条件、help tooltip、button accessibility identifierは維持した。visible text labelは増やさず、timeline.json、review patch schema、compiler schema、Core planner、transition/source commit pathにも触れていない。
- `swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-129/TEST-137を追加し、291件の追跡行（Story 25 / Issue 129 / Test 137）、残課題3件、修正/合格288件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでcluster境界、狭幅/通常幅でのscroll量、tooltip/VoiceOver/FKA、disabled状態、主要button action退行なしは人間確認キューへ集約する。

- M6.5第89スライスでは、Timelineのrole color semanticsをOverviewとclip本体で揃えた。ユーザー体験としては、AIが並べたrough cutを人間が見直すとき、主役、補助、会話、音楽、現場音/環境音などの役割を、zoomed-out overviewと各clip badgeから同じ色体系で即読できる。
- `TimelineOverviewRoleLegend` は現在timelineに存在するroleだけを小さな横scroll凡例として出し、`TimelineOverviewClipPill`、`TimelineClipBlock`、`Timeline.Clip.RoleBadge.*` は共通の `timelineClipRoleColor` helperを使う。短いclipでは `timelineClipRoleAbbreviation` で略号に切り替え、通常幅では既存の日本語role labelを残す。
- この変更はUI-onlyで、timeline.json、review patch schema、compiler schema、Core planner、clip drag/trim/transition/source commit pathには触れていない。既存のrole fillを消さず、Overview凡例とclip badgeを足して、FCPXのrole colorに近い編集上の手がかりを追加した。
- `swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-130/TEST-138を追加し、293件の追跡行（Story 25 / Issue 130 / Test 138）、残課題3件、修正/合格290件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでOverview role legend、clip role badge、短いclip/compact densityでの可読性、Overview pill色との一致、drag/trim/transition/overview scrub退行なしは人間確認キューへ集約する。

- M6.5第90スライスでは、Timeline左端のtrack/marker headerをIDだけの表示から、kind icon、ID、短い日本語kind labelを持つ表示へ更新した。ユーザー体験としては、V1/A1/O1/C1/Mの意味を推測せず、映像、音声、重ね、字幕、マーカーのlane種別をTimeline上で即読できる。
- `TimelineTrackHeader` はtrack kindごとのsystem image、track ID、`映像` / `音声` / `重ね` / `字幕` labelを表示する。`TimelineMarkerLaneHeader` はflag iconと `マーカー` labelを表示する。`timelineTrackHeaderWidth` を共有定数化して、playhead scroll anchor、marker lane、track rowの開始位置がずれないようにした。
- この変更はUI-onlyで、timeline.json、review patch schema、compiler schema、Core planner、clip drag/trim/transition/source commit pathには触れていない。lane scrubのaccessibility labelにはtrack kindも含め、初回ユーザーとVoiceOver/FKAの文脈を補強した。
- `swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-131/TEST-139を追加し、295件の追跡行（Story 25 / Issue 131 / Test 139）、残課題3件、修正/合格292件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでleft gutterの可読性、lane alignment、compact/standard/expanded density、Light/Dark、scrub/marquee/drag/trim/transition退行なしは人間確認キューへ集約する。

- M6.5第91スライスでは、Timeline rulerに常時playhead timecode HUDを追加した。ユーザー体験としては、ruler scrubやoverview scrub後に、細いplayhead lineだけではなく上部ルーラー上の時間表示から現在位置を確認できる。
- `TimelineRulerPlayheadBadge` は `Timeline.Ruler.PlayheadTimecode` としてidle時にplayhead位置へ表示し、active scrub中は既存の `Timeline.RulerScrubPreview` と `Timeline.PlayheadScrubSnapIndicator` を前面に出す。これにより「今の再生位置」と「ドラッグ中の候補位置/吸着先」を同時に混ぜず、操作後に現在位置HUDへ戻る。
- この変更はUI-onlyで、timeline.json、review patch schema、compiler schema、Core planner、scrub resolver、clip drag/trim/transition/source commit pathには触れていない。FCPX/CapCut的なruler上の現在位置把握を足しつつ、既存のmagnetic scrub feedbackは維持する。
- `swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify` は成功し、`dist/VideoOSStudio.app` はPID 86647で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-132/TEST-140を追加し、297件の追跡行（Story 25 / Issue 132 / Test 140）、残課題3件、修正/合格294件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでidle HUD、scrub中preview切替、snap indicator共存、狭幅/密度/zoomでの可読性、clip drag/trim/transition/overview/empty-lane scrub退行なしは人間確認キューへ集約する。

- M6.5第92スライスでは、Timeline overview stripのscrubにもsnap cueを追加した。ユーザー体験としては、ズームアウトした全体俯瞰から再生位置を大きく移動するとき、近くのedit point、marker、timeline start/endへ吸着したことをOverview上のrailと `SNAP` badgeで確認できる。
- `TimelineOverviewStrip` は `activeScrubSnap` を保持し、`TimelineOverviewCanvas` は共有の `TimelinePlayheadScrubSnapIndicator` をOverviewにも表示する。`TimelineOverviewScrubBadge` はsnap中だけsnap iconと `SNAP` を出し、help/accessibility labelにも吸着先labelを含める。
- この変更はUI-onlyで、timeline.json、review patch schema、compiler schema、Core planner、scrub resolver、clip drag/trim/transition/source commit pathには触れていない。FCPX/CapCut的な「全体俯瞰から磁気的に狙う」感覚を補強しつつ、ruler/empty-lane scrubと同じsnap resolver結果を表示するだけに留めた。
- `swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`git diff --check` は成功し、`dist/VideoOSStudio.app` はPID 2029で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-133/TEST-141を追加し、299件の追跡行（Story 25 / Issue 133 / Test 141）、残課題3件、修正/合格296件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでOverview snap cue、snapping off/on、狭幅/密度/zoomでの可読性、clip drag/trim/transition/ruler/empty-lane scrub退行なしは人間確認キューへ集約する。

- M6.5第93スライスでは、Timeline overviewに現在の詳細表示範囲を示すviewport windowを追加した。ユーザー体験としては、ズームして横スクロールしているときでも、全体俯瞰のどこを今編集しているのかをOverview上の薄いwindowで確認できる。
- `TimelinePanel` はdetail `ScrollView` のcontent frameを `TimelineScrollContentFramePreferenceKey` で読み取り、`TimelineViewportScale.visibleFrameRange(...)` がlane offset、viewport lane width、lane widthから現在表示中のframe rangeへ変換する。`TimelineOverviewCanvas` は `Timeline.Overview.ViewportWindow` を描き、Overviewのaccessibility valueにも表示範囲timecodeを含める。
- この変更はUI-onlyで、timeline.json、review patch schema、compiler schema、Core planner、scrub resolver、clip drag/trim/transition/source commit pathには触れていない。FCPX/CapCut的な「全体俯瞰と詳細編集の往復」を補強しつつ、既存のOverview scrub/snap cue、locate playhead、ruler/empty-lane scrubは維持する。
- `swift test --filter TimelineViewportScaleTests`（7 tests / 0 failures）、`swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify` は成功し、`dist/VideoOSStudio.app` はPID 26577で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-134/TEST-142を追加し、301件の追跡行（Story 25 / Issue 134 / Test 142）、残課題3件、修正/合格298件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでviewport windowの横スクロール追従、fit/reset時の見え方、Overview scrub/snap、locate playhead、既存timeline direct manipulation退行なしは人間確認キューへ集約する。

- M6.5第94スライスでは、TimelineにFCPX的なskim previewを追加した。ユーザー体験としては、再生ヘッドを動かす前にclip bodyや空lane上をなぞるだけで、Viewerがそのhover位置の映像/音声とtimecodeを一時表示し、cut確認のための「見るだけ」の動作がscrubやdragより軽くなる。
- `StudioViewModel.timelineSkimPreview` はhover中だけの一時状態で、`activeViewerFrame` はclip move previewを最優先し、その次にskim frame、その後に実playheadを使う。`activeViewerPlayheadLabel` はskim中だけ `SKIM 00:00:00:00` と表示し、Viewer media/source time/audioは既存のProgram preview解決を使う。
- `TimelineTrackRow` はclip bodyとempty laneの `onContinuousHover` から `previewTimelineSkim` を呼び、`Timeline.SkimPreview.*` のcyan skimmer line/badgeと `Timeline.ClipSkimCue.*` のclip cueを表示する。Skimは選択やkeyboard focusを奪わず、source monitor、playback、playhead scrub、clip drag、trim、Blade、transition drag/drop、source drop、timeline reloadでclearされる。
- この変更はUI/viewer-onlyで、timeline.json、review patch schema、compiler schema、Core planner、clip move/trim/transition/source commit pathには触れていない。`TimelineViewportScale.timelineFrame(atLaneX:)` と `timelineFrame(atClipLocalX:)` はhover位置をframeへ安全に丸めるためのhelperで、clip hoverはclip duration内の最終表示frameを越えない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter TimelineViewportScaleTests`（10 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、tracker inspect、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 33800で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-140/TEST-148を追加し、313件の追跡行（Story 25 / Issue 140 / Test 148）、残課題3件、修正/合格310件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでViewerの `SKIM` timecode、skimmer line/clip cue、hover exit clear、playback/source monitor/drag/trim/blade/transition/source-drop優先は人間確認キューへ集約する。

- M6.5第100スライスでは、Timeline clip本体に既存project thumbnail cacheを使ったサムネイル/フィルムストリップ表示を追加した。ユーザー体験としては、AIが並べたrough cutを人間が整えるとき、clip labelやrole色だけでなく映像内容そのものをTimeline上で見分けられる。
- `StudioViewModel.timelineThumbnailURLByAssetID` は現在のtimelineで使われているasset IDだけを対象に `ProjectThumbnailCache` からthumbnail URLを引き、`TimelinePanel` / `TimelineTrackRow` 経由で各 `TimelineClipBlock` へ渡す。thumbnailが無いassetは従来のrole-colored blockへfail-openし、音声/字幕trackには表示しない。
- `TimelineClipThumbnailStrip` はvideo/overlay clipだけに表示され、clip幅に応じて最大4セルまで同じthumbnailを繰り返す。狭すぎるclipでは非表示にし、role badge、segment ID、drag cue、trim handle、Blade cue、Viewer active cue、skim cue、transition/source drop cueを前面に残すため、操作対象や状態表示を邪魔しない。
- この変更はUI-onlyで、timeline.json、review patch schema、compiler schema、Core planner、clip move/trim/transition/source commit pathには触れていない。`TimelineViewportScale.thumbnailCellCount(...)` はclip幅からセル数を決める純粋helperとして追加し、密なTimelineでラベルを潰さない条件をテスト可能にした。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter TimelineViewportScaleTests`（11 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、tracker inspect、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 47974で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-141/TEST-149を追加し、315件の追跡行（Story 25 / Issue 141 / Test 149）、残課題3件、修正/合格312件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでthumbnail有無、wide/narrow clip、compact/standard/expanded density、Light/Dark、selection/hover/drag/trim/blade/skim/Viewer cueとの重なりは人間確認キューへ集約する。

- M6.5第101スライスでは、Timeline clipから元素材をSource Monitorへ戻すmatch-frame導線を追加した。ユーザー体験としては、AIが配置したclipの内容を確認している途中で、右クリック、Command Palette、timeline-focus `F` から元素材をすぐSource Monitorへ開き、IN/OUT調整や置換/上書きへつなげられる。
- `StudioViewModel.revealTimelineClipInSourceMonitor(_:)` は対象clipを選択し、既存 `previewSourceMonitorAsset` でSource Monitorへ切り替え、candidate ref、segment id、source inに近い候補を選ぶ。clipのsource rangeがcandidate内にあればSource Monitorのmarked rangeへ復元し、Viewerのsource位置もclipのsource inまたは現在playhead位置に近づける。
- `Timeline.ContextMenu.RevealSource.*`、Command Paletteの `選択クリップをソース確認`、timeline-focus `F` は同じ操作を呼ぶ。source candidate dataが未読込でも素材previewはfail-openし、読み込み後の通常candidate正規化へ任せる。timeline.json、review patch schema、compiler schema、Core planner、clip move/trim/transition/source commit pathには触れていないため、この操作単体では未保存patchを作らない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、tracker inspect、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 73363で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-142/TEST-150を追加し、317件の追跡行（Story 25 / Issue 142 / Test 150）、残課題3件、修正/合格314件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで右クリック/Command Palette/Fキー、Source Monitor candidate/range復元、`置換` / `上書き` 退行なし、`戻る` でProgram previewへ復帰することは人間確認キューへ集約する。

- M6.5第102スライスでは、Timeline-to-source match-frame導線にsource-bin auto revealを追加した。ユーザー体験としては、Timeline clipから元素材を開いた直後に、MediaPanelの素材棚でも該当source rowが見える位置へスクロールし、どの素材へ戻ったのかを見失わない。
- `StudioViewModel.revealSourceBinAsset(_:)` はmatch-frame reveal時だけ、現在のsource-bin filter/searchで対象assetが隠れている場合に `all` filterと空searchへ戻す。通常のsource-bin filter/search/sort/grouping、favorites、used/unused、quick insert、quick dragの状態モデルはそのまま維持する。
- `MediaPanel` のsource-bin一覧は `ScrollViewReader` と安定ID `MediaPanel.SourceBinRow.<assetID>` を持ち、`sourceMonitorAssetID`、source-bin filter、source-bin searchの変化に合わせて選択asset rowへスクロールする。既存の `MediaPanel.SourceBinItem.*`、選択highlight、`確認中` button、row accessibility labelは変更しない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter ProjectMediaResolverTests`（34 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、tracker inspect、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 84888で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-143/TEST-151を追加し、319件の追跡行（Story 25 / Issue 143 / Test 151）、残課題3件、修正/合格316件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでfilter/searchに隠れたTimeline clip assetをrevealしたときのfilter reset、row scroll、selected highlight、`確認中` button、通常のmanual filter/search退行なしは人間確認キューへ集約する。

- M6.5第103スライスでは、transition presetをdragし始めた瞬間に、現在の選択clip、選択transition、再生位置から見た推奨drop targetをTimeline上で強調し、Viewer fade previewも開始するようにした。ユーザー体験としては、クロスフェードなどを掴んだ時点で「どの編集点へ落とすのか」が先に見え、FCPX/CapCut的な磁気的な落としどころを探しやすくなる。
- `TimelinePanel.recommendedTransitionDropTarget(in:)` は既存 `TimelineTransitionPlacementResolver` を再利用し、選択clip/transition優先、なければplayhead近傍のedit pointを1つ選ぶ。削除保留/却下clipを含むedit pointは従来通り候補から外し、click-applyの解決順とdrag affordanceを揃える。
- `beginTransitionPresetDrag(_:)` はpreset drag開始時に推奨targetへ `onPreviewTransitionPresetDrop` を呼び、既存のtransition hover preview/Viewer fade previewをdrop前から使う。`TimelineTransitionDropTarget` は推奨targetだけ `推奨 <preset>` cueと `ここへ吸着` magnet railを出し、実際に別targetへhoverした場合は従来のdropEntered previewへ切り替わる。
- この変更はUI/viewer-onlyで、`set_transition` operation、timeline.json、review patch schema、compiler schema、Core planner、transition commit pathには触れていない。drag cancel/timeout時は `onEndTransitionDurationPreview` でpreviewをclearし、既存のtransition move handle、duration grip、click-apply、Command Palette applyは維持する。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests`（15 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、tracker inspect、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 64836で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-144/TEST-152を追加し、321件の追跡行（Story 25 / Issue 144 / Test 152）、残課題3件、修正/合格318件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで推奨target、`ここへ吸着` cue、drag-start Viewer preview、実target hoverへのpreview切替、drop/cancel/timeout clearは人間確認キューへ集約する。

- M6.5第104スライスでは、transition presetを小さな編集点targetへ正確に落とさなくても、video/overlay lane body上へ大まかにdropすれば、同一laneの近いgapless edit pointへ吸着する経路を追加した。ユーザー体験としては、FCPX/CapCut的に「このあたりのcutへtransitionを入れる」操作が、狭いdrop targetを探す前に成立する。
- `TimelineTransitionPlacementResolver.resolveNearestOnTrack(...)` はdrop位置のframeから同一video/overlay track上の隣接clip境界を走査し、gapなし、削除保留/却下clipなしの最も近いedit pointを返す。audio track、gapがある境界、blocked clipを含む境界は拒否し、tieは早い境界を優先する。
- `TimelineSourceCandidateDropDelegate` はsource candidate payloadとtransition preset payloadを分岐するようになった。transition preset payloadの場合だけlane-level nearest targetをpreview/applyし、対象drop targetへ `近傍` cueと `近い編集点へ吸着` railを出す。source candidate lane dropは既存経路を維持し、既存transitionのmoveは従来通りexact transition targetで扱う。
- この変更はlane-level UI/core resolverだけで、`set_transition` operation、timeline.json、review patch schema、compiler schema、Core planner、source insert path、transition move exact-target pathには触れていない。Viewer hover previewとpending transition applyは既存のtransition preset apply経路を再利用する。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests`（17 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、tracker inspect、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 98170で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-145/TEST-153を追加し、323件の追跡行（Story 25 / Issue 145 / Test 153）、残課題3件、修正/合格320件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでlane body上の近傍target cue、Viewer preview、drop commit、audio/gapped/blocked lane拒否、source candidate drop退行なしは人間確認キューへ集約する。

- M6.5第105スライスでは、選択済みの適用済みtransitionについて、細い左右gripだけでなく本体の左右領域を横ドラッグして長さ調整できるようにした。ユーザー体験としては、FCPX/CapCut的にtransitionを選んだ後、body上の自然な横dragでduration previewとcommitへ進める。
- `TimelineTransitionDurationDragRegion.allowsDurationDrag(...)` は、edge dragを常時許可し、選択中だけ中央move handleを避けたbody左右領域もduration dragとして許可する。未選択transition bodyは誤調整を避けるため従来通りedgeだけを受ける。
- `TimelineTransitionDropTarget.isDurationDragStart(_:)` はこのhelperを使い、help textも選択中は `本体の左右領域を横ドラッグ` と説明する。中央丸ハンドルの `onDrag` relocation、existing transition move target、toolbar duration buttons、Command Palette duration commandsは既存経路のまま維持した。
- この変更はduration drag hit-testとhelp文言だけで、`set_transition` operation、timeline.json、review patch schema、compiler schema、Core planner、transition relocation pathには触れていない。duration preview badgeとViewer fade previewは既存 `previewTimelineTransitionDuration` / `adjustTimelineTransitionDuration` を再利用する。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests`（19 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、tracker inspect、`git diff --check` は成功した。`dist/VideoOSStudio.app` はPID 43366で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-146/TEST-154を追加し、325件の追跡行（Story 25 / Issue 146 / Test 154）、残課題3件、修正/合格322件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでselected transition body drag、central move handle、edge grip、Viewer preview、duration badge、commit挙動は人間確認キューへ集約する。

- M6.5第106スライスでは、単体clipを明示的に別レーンへ縦ドラッグしたとき、target laneが占有済みでもブロックせず、空いている同種laneまたは新規laneへ逃がすようにした。ユーザー体験としては、FCPX的に「ここへ置きたいが重なっている」操作が、赤い拒否ではなく自然なlane liftとして成立する。
- `TimelineClipMovePlan.make(...)` は、`preferredTargetTrackID` が同種trackで、drop後の範囲が占有済みの場合、group moveと同じ `TimelineClipMoveLaneLift` 解決へ進む。既存のopen same-kind trackを優先し、見つからない場合は `V3` / `A3` / `O3` のような次track IDを作り、`move_segment.target_track_id` に反映する。
- この変更は単体clipのexplicit target overlap解決だけで、異種track拒否、caption拒否、same-track magnetic displacement、selected group lane-lift、timeline.json、review patch schema、compiler schemaには触れていない。既存のlanding cue、source row ghost、new-lane target label、Viewer drag-time previewの表示経路をそのまま使う。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests`（23 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 54195）、tracker inspect、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-147/TEST-155を追加し、327件の追跡行（Story 25 / Issue 147 / Test 155）、残課題3件、修正/合格324件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで単体video/overlay/audio clipを占有済み同種laneへ縦ドラッグした時のopen/new lane landing cue、mouse-up placement、Viewer playback即時反映は人間確認キューへ集約する。

- M6.5第107スライスでは、手編集の永続化UIコピーを「反映待ち」から「表示済み編集を保存する」モデルへ寄せた。ユーザー体験としては、clip drag、trim、transition duration、source insertなどでTimeline/Viewerがすでに変わった後、下部バーやtoolbarを見ても「まだ適用されていない」と誤解しにくくなる。
- `FeedbackStatusBar.ApplyAndPreviewButton` は `保存` と表示し、helpで「表示済みのStudio編集をtimeline.jsonへ保存し、プレビューを更新」と説明する。`Timeline.EditToolbar.Section.Session` は `Studio編集の保存` clusterになり、`Timeline.EditToolbar.ApplyPatch` も `保存` icon buttonになった。Command menuの項目も `表示中のStudio編集を保存` へ変更した。
- `StudioViewModel.applyStudioPatch()` のstatus copyは、プロジェクト未選択、粗編集なし、dirtyなし、preflight不可、stale baseline、保存中、失敗時の各メッセージを `Studio編集の保存` / `表示済みのStudio編集を保存` へ揃えた。`review_patch.json` を反映する別機能、patch serialization、compiler schema、timeline operation contract、即時Timeline/Viewer更新には触れていない。
- `rg` による古い手編集向けapply-wait文言の確認、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 79163）、tracker inspect、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-148/TEST-156を追加し、329件の追跡行（Story 25 / Issue 148 / Test 156）、残課題3件、修正/合格326件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで未保存手編集後の下部バー、Timeline toolbar保存button/help、Command menu、保存中/status文言が保存待ちとして読めるかは人間確認キューへ集約する。

- M6.5第108スライスでは、空のvideo/overlay編集点wellをクリックすると、そのseamへ既定クロスフェードを直接追加できるようにした。ユーザー体験としては、トランジションpaletteを掴む前に「ここが落とし所で、ここから効果を追加できる」と分かり、FCPX/CapCut的なedit point起点の操作に近づく。
- `TimelineTransitionPreset.defaultPreset` は既定transitionを `crossfade` として明示し、`ContentView` のCommand Palette / `Command-T` pathもこの既定値を参照する。`TimelineTransitionDropTarget` は空seamの表示iconを `rectangle.on.rectangle` にし、短いクリックがvisible well内で終わった場合だけ、seam固有の `onApplyTransitionPreset(defaultPreset.id, trackID, fromClipID, toClipID)` を呼ぶ。
- クリック判定は中央のvisible well内に限定し、drop用の広いhit area全体では誤適用しない。既存transitionのtap選択、中央move handle、左右duration drag、preset drag/drop、lane-level magnetic drop、`set_transition` patch、timeline.json、review patch schema、compiler schemaは変更していない。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は20 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 89903）、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-149/TEST-157を追加し、331件の追跡行（Story 25 / Issue 149 / Test 157）、残課題3件、修正/合格328件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでempty seam click、visible well外clickの誤適用なし、既存transition操作退行なしは人間確認キューへ集約する。

- M6.5第109スライスでは、空のvideo/overlay編集点wellへポインタを乗せるだけで、既定クロスフェードのプレビューがViewerとTimeline上に出るようにした。ユーザー体験としては、クリックやdropの前に「このseamへ入れるとどう見えるか」が分かり、FCPX/CapCut的な磁気的な試し置きに近づく。
- `StudioViewModel.previewTransitionPresetDrop` は共通の `previewTransitionPreset(...)` helperへ分岐し、新しい `previewDefaultTransitionEditPointHover` は同じ `TimelineTransitionDropPlan` / transient transition previewを使いながら、status copyだけ `クリックすると適用します。` にする。これによりdrag/drop previewの `離すと適用します。` とクリック前hover previewを混同しない。
- `TimelineTransitionDropTarget` はvisible well内の `onContinuousHover` だけでhover previewを開始し、広いdrop hit areaへ入っただけでは発火しない。hover previewはpreset drag、transition move drag、duration drag、既存transition上では開始せず、hover exit、view disappear、または実transition化でclearする。既存のpreset drag/drop、lane-level magnetic drop、transition relocation、duration drag、`set_transition` patch、timeline.json、review patch schema、compiler schemaは変更していない。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は20 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 41122）、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-150/TEST-158を追加し、333件の追跡行（Story 25 / Issue 150 / Test 158）、残課題3件、修正/合格330件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでempty seam hover preview、hover exit clear、別seamへのpreview移動、click commit、既存transition操作退行なしは人間確認キューへ集約する。

- M6.5第110スライスでは、複数選択clipの暗黙group move/nudgeでも、未選択clipと重なる場合に押し出しではなく空き/新規互換laneへ逃がすようにした。ユーザー体験としては、複数clipをまとめて `位置←` / `位置→`、`[` / `]`、またはgroup dragで動かした時も、FCPX的に別レイヤーへ自然に上がる。
- `TimelineClipGroupMovePlan.make(...)` は、preferred targetがない同一track内group moveで未選択clipとのoverlapを検出した場合、`TimelineClipMoveLaneLift` を解決し、空き同種laneを優先して、なければ `V2` などの新規laneを `move_segment.target_track_id` へ入れる。mixed-track groupや非対応kindでは既存のdisplacement fallbackを維持する。
- `SelectedTimelineClipMovePlan.laneLift` はgroup planのlane liftもstatusへ渡し、`TimelineTrackRow` はgroup lane-lift時もtarget lane highlight、group cue、help textを表示する。単体clip move、明示target track、transition/source/trim path、timeline.json、review patch schema、compiler schemaは変更していない。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 47585）、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-151/TEST-159を追加し、335件の追跡行（Story 25 / Issue 151 / Test 159）、残課題3件、修正/合格332件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで複数選択nudge/dragのlane lift、空きlane再利用、新規lane作成、Viewer/playback即時反映、保存/破棄UIの理解、単体clip/transition/source操作退行なしは人間確認キューへ集約する。

- M6.5第111スライスでは、Source Binにプロジェクト単位で永続する手動の作業binを追加した。ユーザー体験としては、AIが荒編集したあとに人間が見直したい素材、差し替え候補、保留素材だけを自分で束ねて、後から再表示できる。
- `ProjectMediaSourceBinFilter.manual` と `manualAssetIDs` を追加し、`ProjectMediaPreviewSummary.items/count/groupedItems(...)` は作業bin、検索、sort、folder/status/kind/usage groupingを同じ経路で解決する。既存のfavorite、used、unused、ready、video/audio、needs-action filterは維持する。
- `StudioViewModel` は `VideoOSStudio.mediaSourceBinManualAssetIDsByProject` へプロジェクト単位の作業binを保存し、`toggleSourceBinManualBin(_:)` で追加/解除する。`MediaPanel` は素材行へtrayボタン、作業bin badge、accessibility labelを追加し、表示メニューの `作業中` filterで手動選定素材だけを表示できる。
- `swift test --package-path apps/macos-studio --filter ProjectMediaResolverTests` は34 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 60739）、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-152/TEST-160を追加し、337件の追跡行（Story 25 / Issue 152 / Test 160）、残課題3件、修正/合格334件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで作業bin toggle、`作業中` filter、search/sort/group併用、永続復元、Source Monitor preview、quick insert/drag、favorite退行なしは人間確認キューへ集約する。

- M6.5第112スライスでは、Source Binを `一覧` と `サムネイル` で切り替えられるようにした。ユーザー体験としては、AIが荒編集したあとに人間が差し替え候補や未使用素材を探す時、ファイル名だけでなく映像の見た目を手がかりにFCPX/CapCut的に素材棚をスキャンできる。
- `MediaSourceBinViewMode` は `VideoOSStudio.mediaSourceBinViewMode` へ保存され、起動後も前回の表示密度から続けられる。`MediaPanel.SourceBinViewModePicker` は既存のfilter/search/sort/group controlsの横に置き、素材棚を大きく移動しなくても表示形式を切り替えられる。
- `MediaSourceBinTile` は既存の `ProjectThumbnailCache` を使って16:9サムネイルを出し、source preview、作業bin、favorite、quick insert、quick drag、使用中/作業bin badgeをtile内に保持する。list rowと同じ `sourceBinQuickDragPayload` / `sourceBinQuickDragSummary` を使うため、タイムラインへの投入導線は表示形式を変えても同じ。
- この変更はUI-onlyで、timeline.json、review patch schema、compiler schema、Core media resolver、source insert/drop pathには触れていない。`swift build --package-path apps/macos-studio --target VideoOSStudio` は成功済み。running appでthumbnail grid密度、tile preview、work-bin/favorite toggle、quick insert/drag、group/search/filter併用、狭幅/広幅での文字詰まりなし、一覧表示への戻りは人間確認キューへ集約する。

- M6.5第113スライスでは、Source Bin row/tile thumbnailのhover skimを追加した。ユーザー体験としては、AIが荒編集したあとに人間が素材棚をなぞるだけで内容や候補範囲をViewerに一時表示し、クリックしてSource Monitorへ入る前、またはquick insert/dragする前に素材の使い所を軽く確認できる。
- `ProjectMediaSkimPreviewTime.previewTimeUS(...)` はpointer fractionをassetまたはbest candidateのsource rangeへclampしてpreview時刻を算出する。`StudioViewModel.previewSourceBinSkim(assetID:fraction:)` は `sourceMonitorAssetID` やinsert candidate selectionを変更せず、ready assetだけを `sourceBinSkimPreview` としてViewerへ渡す。
- `activeViewerMediaReference` はSource Bin skim中だけ `sourceBinSkimMediaReference` をSource Monitor/Programより優先し、Transport側は `SOURCE SKIM <source time>` を表示する。hover exit、再生開始、Timeline skim、Source Monitor確定、clip/transition preview、timeline/playhead state changeではclearして既存のProgram/Source Monitor previewへ戻る。
- この変更はview-only/source-preview-onlyで、source insert/quick drag/drop、timeline.json、review patch schema、compiler schemaには触れていない。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter ProjectMediaResolverTests`（35 tests / 0 failures）、`npx tsc --noEmit` は成功済み。running appでrow/tile hover skim、`SOURCE SKIM`時刻、hover横移動、hover exit clear、クリックでSource Monitor確定、quick insert/drag、Timeline skim/再生開始との優先順位、狭幅/広幅は人間確認キューへ集約する。

- M6.5第114スライスでは、transition preset名を日本語UI内で一貫させた。ユーザー体験としては、クロスフェード以外のpresetも、dragし始めた瞬間、推奨target、近傍吸着cue、drop preview、help/accessibilityで `Dip` / `Match` ではなく `黒へディップ` / `ソフトカット` と読める。
- `TimelineTransitionPreset.localizedLabel` は `クロスフェード`、`黒へディップ`、`ソフトカット` を返す。Timeline preset chip、active drag pill、`推奨` cue、`近傍` cue、exact drop preview label、hover preview label、help、accessibility labelはこの同じlabelを参照するため、画面上のpreset名が分岐しない。
- この変更はUI label-onlyで、`transition_type`、`applied_skill_id`、`set_transition` operation、timeline.json、review patch schema、compiler schema、transition drop/click/duration/move commit pathには触れていない。`swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests`（21 tests / 0 failures）と `swift build --package-path apps/macos-studio --target VideoOSStudio` は成功済み。
- running appでtransition palette、drag中pill、recommended/nearby/drop cue、hover preview、help/VoiceOver、狭幅toolbarでのclippingなし、既存transition click/drop/duration/move退行なしは人間確認キューへ集約する。

- M6.5第115スライスでは、Source Binにactiveな名前付き選別binを追加した。ユーザー体験としては、AIが荒編集した後に、編集者が `差し替え候補`、`使うかも`、`B-roll確認` のような短い名前を付け、その時点の観点で素材をrow/tileからすぐ束ねられる。
- `ProjectMediaSourceBinFilter.collection` は `collectionAssetIDs` を受け取り、既存のSource Bin filter/search/sort/groupingと同じ経路でactive collection内のassetだけを返す。`ProjectMediaResolverTests` はcollection filter、count、検索、filename sort、folder groupingを固定する。
- `StudioViewModel.mediaSourceBinActiveCollectionName` と `mediaSourceBinCollectionAssetIDsByProject` はUserDefaultsに保存する。`MediaPanel` はactive collection名のTextField、collection filter button、count、row/tileの `rectangle.stack` toggle、collection badgeを追加し、Source Monitor preview、hover skim、quick insert、row/tile drag、favorite、作業bin、used/unusedは既存経路を維持する。
- この変更はSource Bin UIとローカル編集者状態だけで、timeline.json、review patch schema、compiler schema、source insert/drop/replace/overwrite operation、project artifactには触れていない。running appでactive collection名入力、row/tile toggle、filter、search/sort/group併用、復元、狭幅clippingなし、既存Source Bin操作退行なしは人間確認キューへ集約する。

- M6.5第116スライスでは、タイムライン選択をAgentパネルの読み取り専用相談プロンプトへ渡す導線を追加した。ユーザー体験としては、AIが荒編集した後に、編集者が手動で選んだclipやtransitionの文脈を保ったまま、AIへ「短く整える」「代替を探す」「カットを説明」を相談できる。
- `TimelineAgentConsultationPrompt` はselected clipのtrack、timecode、source range、asset/segment、role、motivation、既存editor note、transition ID/type/duration/handles、transcript/Marlin/audio evidenceをまとめ、すべての変更案をPREVIEW-onlyとして返すように指示する。
- `StudioViewModel.prepareTimelineSelectionAgentPrompt()` はprompt fieldを埋めるだけで、Codex turn開始、write approval、timeline.json、review patch schema、compiler schema、clip/transition/source commit pathには触れない。Agentセッションがない状態でも相談文は準備でき、実行は既存の `読み取り専用で実行` の状態制御に従う。
- `swift test --package-path apps/macos-studio --filter TimelineAgentConsultationPromptTests` は成功済み。running appで単体/複数clip、transition選択、各相談intent、prompt内容、PREVIEW/read-only表現、session未開始時の実行button disabled、prompt生成時に未保存timeline編集が増えないこと、狭幅Agentパネルclippingなしは人間確認キューへ集約する。

- M6.5第117スライスでは、Source Binの名前付き選別binを複数管理できるようにした。ユーザー体験としては、AIが荒編集したあとに、人間が `差し替え候補`、`B-roll確認`、`使うかも` のような観点別collectionを作り、Pickerで切り替えながら素材をrow/tileから振り分けられる。
- `ProjectMediaSourceBinCollectionCatalog` はcollection名の正規化、既定名生成、名前一覧、リネーム時のmembership移動/mergeを固定する。`StudioViewModel` は選択、作成、リネーム、削除をproject-scoped UserDefaults collection stateへ接続し、active collection filter/countを即時更新する。
- `MediaPanel` はcollection Picker、plus、trash confirmation、rename TextField、active countをSource Bin controlsへ追加する。新規作成直後や最後の素材を外した後の空collectionも、trashで明示削除するまでPickerに残る。既存のcollection toggle、作業bin、favorite、used/unused、Source Monitor preview、hover skim、quick insert、row/tile drag、検索/並び/分類は同じ経路で残る。
- `swift test --package-path apps/macos-studio --filter ProjectMediaSourceBinCollectionCatalogTests` は5 tests / 0 failuresで成功した。running appで複数collection作成/切替、row/tile toggle、rename membership移動、既存collection名へのmerge、delete fallback、狭幅clippingなし、既存Source Bin操作退行なしは人間確認キューへ集約する。

- M6.5第118スライスでは、選択clipのIN/OUT edgeをドラッグトリムしている間もProgram Viewerが仮トリム済みtimelineを読むようにした。ユーザー体験としては、端を掴んでフレームを探している最中から、FCPX/CapCut的にViewerで切り位置を確認できる。
- `TimelineDragTrimPlan.viewerPreviewFrame` はIN trimで新しい先頭、OUT trimで新しい末尾直前を返す。`StudioViewModel.previewTimelineDragTrim()` は既存trim planのoperationsを一時timelineへ適用し、Viewerのtimecodeを `TRIM` として表示する。
- `TimelinePanel` / `TimelineTrackRow` は既存のtrim boundary、badge、magnetic snap indicatorを維持したまま、drag changed時にViewModel previewを更新し、drag endやzero deltaでclearする。commitは既存 `dragTrimTimelineClip()` の `trim_segment` + `move_segment` patch pathを使うため、timeline.json、review patch schema、compiler schemaは変わらない。
- `swift test --package-path apps/macos-studio --filter TimelineDragTrimPlanTests` は11 tests / 0 failuresで成功した。running appでIN/OUT handle drag中の `TRIM` Viewer、snap rail/badge、mouse-up commit、cancel/zero delta clear、timeline/source-bin skimやclip move/transition previewとの優先順位は人間確認キューへ集約する。

- M6.5第119スライスでは、選択clipの中に `SLIP` stripを追加し、Timeline上で直接dragして素材範囲だけを前後へずらせるようにした。ユーザー体験としては、clipの位置と尺は固定したまま、中身だけをFCPX/CapCut的に滑らせて、Viewerで新しいsource rangeを確認できる。
- `StudioViewModel.previewTimelineSlipTrim()` は `TimelineSlipTrimPlan` の `trim_segment` operationを一時timelineへ適用し、Viewer timecodeを `SLIP` として表示する。playheadがclip内なら現在位置、外ならclip先頭をpreview frameにするため、drag中に変更後の中身を見られる。
- `TimelineTrackRow` は単一選択clipだけに小さな `SLIP` handleとpreview badgeを出し、clip body move、IN/OUT trim handles、Blade modeとは別のhit areaにした。preview開始時はclip move、trim、skim、transition/source previewと相互clearし、commitは既存 `queueAndApplyTimelineTrimOperations` を使うためschema/compiler/timeline position contractは変えない。
- `swift test --package-path apps/macos-studio --filter TimelineSlipTrimPlanTests` は6 tests / 0 failuresで成功した。running appで `SLIP` strip drag中のViewer preview、mouse-up commit、zero/cancel clear、clip body move/trim/Blade/skim/transition/source monitorとの優先順位は人間確認キューへ集約する。

- M6.5第120スライスでは、単一選択clipのincoming/outgoing編集点へ `ROLL` handleを追加し、gaplessな隣接clip同士のcut位置をTimeline上で直接ロールできるようにした。ユーザー体験としては、toolbarの0.5秒ボタンだけでなく、FCPX/CapCut的に編集点そのものを掴んで左右へ動かせる。
- `StudioViewModel.previewTimelineRollTrim()` は `TimelineRollTrimPlan` の `trim_segment` / `move_segment` operationを一時timelineへ適用し、Viewer timecodeを `ROLL` として新しい境界frameへ切り替える。drag中は左右clipのgapless resizeをViewerで確認でき、mouse-up時のcommitは同じplan経路を使う。
- `TimelineTrackRow` は単一選択かつgaplessでロール可能なincoming/outgoing境界だけに小さな `ROLL` handleとpreview badgeを出す。clip body move、IN/OUT trim handles、`SLIP` strip、Blade mode、transition edit-point wellとは別のhit areaにし、preview同士は相互clearする。
- commitは既存 `TimelineRollTrimPlan` と `queueAndApplyTimelineTrimOperations` を使うため、timeline.json、review patch schema、compiler schemaは変更していない。`TimelineRollTrimPlanTests` は任意drag deltaでも左右clipがgaplessにresizeされることを固定する。
- running appでincoming/outgoing `ROLL` handle drag中のViewer preview、左右clip resize、mouse-up commit、zero/cancel clear、trim/SLIP/body move/transition/Blade/skim/source monitorとの優先順位は人間確認キューへ集約する。

- M6.5第121スライスでは、Source Binの現在表示中素材をactiveな選別binへ一括追加/解除できるようにした。ユーザー体験としては、検索、未使用filter、folder/status/kind/usage groupingで絞った素材群を、row/tileごとに1件ずつtoggleせず、FCPX/CapCut的なbin整理としてまとめて選別できる。
- `StudioViewModel.filteredMediaSourceBinAssetIDs` は現在のSource Bin filter/search/sort後のasset IDを重複なしで返す。`addVisibleSourceBinItemsToActiveCollection()` と `removeVisibleSourceBinItemsFromActiveCollection()` はその表示集合だけをactive collectionへ追加/解除し、timeline、favorites、作業bin、source monitor selection、source candidate selectionは変更しない。
- `ProjectMediaSourceBinCollectionCatalog.adding/removing` はbulk操作をCore側で固定し、空文字/重複を正規化し、remove後も空collectionを保持する。collectionの明示削除は既存trash confirmationだけが担当する。
- `MediaPanel.SourceBinCollectionBulkAddVisibleButton` / `BulkRemoveVisibleButton` はSource Bin result count行のicon-only controlとして追加した。追加できる未登録素材がないとき、または外せる登録済み素材がないときはdisabledになる。
- running appでfilter/search/grouping後のvisible resultをactive collectionへbulk add/removeし、collection count/filter、空collection保持、button disabled state、row/tile per-asset toggle、Source Monitor/hover skim/quick insert/drag/favorite/作業bin退行なしは人間確認キューへ集約する。

- M6.5第122スライスでは、選択中のtimeline clip/transitionからAgentパネルで `相談を実行` できるようにした。ユーザー体験としては、AIが荒編集した後の手編集文脈を保ったまま、prompt作成とread-only実行を一段でつなげられる。
- `StudioViewModel.prepareTimelineSelectionAgentPrompt()` は成功/失敗を返すため、選択がない状態で古いpromptを誤って送らない。`prepareAndRunTimelineSelectionAgentPrompt()` はAgent sessionがある場合だけ既存のread-only turnへ進み、session未開始ならprompt準備と開始案内で止まる。
- `AgentPanel.RunTimelineSelectionConsultationButton` は既存の `プロンプトへ` と `読み取り専用で実行` を残したまま追加される。timeline.json、review patch schema、compiler schema、clip/transition/source commit path、書き込み承認には触れず、AI相談はPREVIEW-onlyとして扱う。
- running appでclip/transition選択後に `相談を実行` を押し、session未開始時はpromptだけ準備されること、session開始後はread-only turnが始まること、timeline/unsaved edit不変、既存二段階path退行なしは人間確認キューへ集約する。

- M6.5第123スライスでは、読み取り専用Agent相談の結果を、選択clipの編集メモ下書きへ手動で追加できるようにした。ユーザー体験としては、AIが荒編集後のcut判断を説明・提案しても、その場でtimelineへ反映するのではなく、人間編集者の確認メモとしてClip inspectorへ持ち帰れる。
- `TimelineAgentResultHandoffDraft` はassistant本文を `AI相談メモ (読み取り専用/PREVIEW)` として整形し、対象clip、参照turn、切り詰め済み本文、handoff用のPREVIEW警告を作る。既存のnote/handoff draftがある場合は区切り線付きで追記し、上書きしない。
- `StudioViewModel.pinSelectedAgentTurnToClipNoteDraft()` は選択中Agent turnと主選択clipだけを使って `selectedClipNoteDraft` / `selectedClipHandoffInstructionDraft` を更新する。`saveSelectedClipNote()`、`ProjectEditorAnnotationStore`、timeline reload、review patch、compiler、書き込み承認は呼ばない。
- `AgentPanel.PinTurnToSelectedClipNoteButton` は選択中ターン詳細へ置き、assistant本文または選択clipがない場合はdisabledになる。multi-selection時は主clipへ追加したことをstatusで示す。
- `swift test --package-path apps/macos-studio --filter TimelineAgentResultHandoffDraftTests` は4 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`、tracker inspectも成功し、`dist/VideoOSStudio.app` はPID 58299で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-164/TEST-172を追加し、361件の追跡行（Story 25 / Issue 164 / Test 172）、残課題3件、修正/合格358件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでAgent相談結果から `選択クリップのメモ下書きへ` を押し、Clip inspector draftへの追記、保存前の `editor_annotations.json` 不変、timeline/unsaved edit/playback不変、button disabled state、長文切り詰め、既存draft追記は人間確認キューへ集約する。

- M6.5第124スライスでは、Clip Inspectorの編集メモsectionに下書き状態を追加した。ユーザー体験としては、Agent相談結果をメモ下書きへピン留めした後、その内容が保存済みと同じなのか、保存前の変更なのか、AI由来の読み取り専用PREVIEWなのかを、TextEditorの本文だけで判断しなくてよくなる。
- `ProjectEditorAnnotationDraftState` はnote/handoff draftと保存済みannotationを比較し、no-selection、空本文、保存済み一致、変更あり、Agent PREVIEWをCoreで判定する。`canSave` は選択clipがあり、note本文が空でなく、保存済みから変更がある時だけtrueにするため、保存済みと同じ下書きや空本文では `メモを保存` が有効にならない。
- `StudioViewModel.selectedClipNoteDraftState` / `canSaveSelectedClipNoteDraft` と `ClipInspector.NoteDraftState` を追加し、Clip Inspectorは状態labelとsave button gatingを同じ判定から読む。Agent由来PREVIEWではsparkles iconとorange emphasisで、保存前かつtimeline未適用であることを示す。
- この変更はClip Inspectorの状態表示とannotation保存前の判定だけで、`timeline.json`、review patch schema、compiler schema、Studio edit unsaved state、Agent read-only turn、timeline playback pathには触れていない。保存する場合も既存の `saveSelectedClipNote()` から `editor_annotations.json` へ進む。
- `swift test --package-path apps/macos-studio --filter ProjectEditorAnnotationDraftStateTests` は5 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`、tracker inspect、`git diff --check` も成功し、`dist/VideoOSStudio.app` はPID 62171で起動確認済み。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-165/TEST-173を追加し、363件の追跡行（Story 25 / Issue 165 / Test 173）、残課題3件、修正/合格360件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで `ClipInspector.NoteDraftState` のPREVIEW/保存済み一致/変更あり/空本文表示、save button gating、保存前の `editor_annotations.json` / timeline / playback / unsaved Studio edit state不変は人間確認キューへ集約する。

- M6.5第125スライスでは、Source Binの名前付き選別binに状態と用途メモを追加した。ユーザー体験としては、AIが荒編集候補を並べた後、人間編集者が `B-roll確認`、`差し替え候補`、`保留` などのcollectionへ素材を束ねるだけでなく、そのcollectionの判断状態と短い編集メモを残せる。
- `ProjectMediaSourceBinCollectionStatus` は `candidate` / `reviewing` / `selected` / `hold` を持ち、MediaPanelでは `候補` / `確認中` / `採用候補` / `保留` と表示する。`ProjectMediaSourceBinCollectionMetadata` はnoteをtrimし80文字に丸めるため、狭いSource Bin control群でも長文でUIが壊れにくい。
- `ProjectMediaSourceBinCollectionMetadataCatalog` はmetadataの取得、保存、rename、delete、既存collectionへのrename mergeを固定する。rename先に既存metadataがある場合はdestination側の編集意図を優先し、空のstatus/noteだけsourceから補う。default metadataは保存対象から外すのでUserDefaultsは不要に膨らまない。
- `StudioViewModel` は `VideoOSStudio.mediaSourceBinCollectionMetadataByProject` へproject-scoped metadataを保存する。active collectionのstatus/noteはMediaPanelから即時保存され、metadata-only collectionもPicker名一覧とdelete対象に含まれる。rename/delete時にはmembershipだけでなくmetadataも同時に移動または削除する。
- `MediaPanel.SourceBinCollectionStatusPicker` と `MediaPanel.SourceBinCollectionNoteField` を既存のcollection picker/rename/search controlsの間に追加した。この変更はSource Bin UIとローカルUserDefaults状態だけで、timeline.json、review patch schema、compiler schema、source insert/drop/replace/overwrite operation、project artifactには触れていない。
- `swift test --package-path apps/macos-studio --filter ProjectMediaSourceBinCollectionCatalogTests` は12 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 66322）、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-166/TEST-174を追加し、365件の追跡行（Story 25 / Issue 166 / Test 174）、残課題3件、修正/合格362件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで状態picker、用途メモ、rename/delete連動、再起動/プロジェクト切替後の復元、狭幅panel clippingなし、Source Monitor/hover skim/quick insert/drag/favorite/作業bin/used-unused/bulk add-remove退行なしは人間確認キューへ集約する。

- M6.5第126スライスでは、読み取り専用Agent相談の結果から、構造化された `review_patch` JSONをPREVIEW編集候補として検出する導線を追加した。ユーザー体験としては、AIが「短く整える」「代替を探す」などを提案した時、単なる文章メモではなく、アプリが安全に読めるpatch候補の有無と危険な点をAgentパネル上で確認できる。
- `TimelineAgentConsultationPrompt` は、timeline変更を提案する場合だけ、最後に fenced `review_patch` JSON blockを含めるよう指示する。JSONは現在の `timeline_version` と正確なclip/transition IDを使う。説明だけ、または素材検索だけが適切な場合はJSONを含めないため、無理にpatch化しない。
- `TimelineAgentReviewPatchDraft` はassistant本文から fenced `json` / `review_patch` blockとbalanced JSON objectを抽出し、直接の `ReviewPatchDocument`、または wrapper内の `review_patch` / `patch` をdecodeする。decode後はoperation count、compiler-ready count、studio-ready count、operation target、timeline version mismatch、選択範囲外clip参照、compiler保存不可warningを返す。
- `StudioViewModel.selectedAgentReviewPatchDraft` は選択中turnがread-onlyで、assistant本文に構造化patchがある時だけ値を持つ。`AgentPanel.ReviewPatchDraft` は `PREVIEW編集候補` として件数、保存可能件数、operation/target、warning、`まだtimelineには適用していません` copyを表示する。
- この変更はAI相談結果の検出と表示だけで、timeline.json、review patch schema、compiler schema、pending Studio edit state、write approval、既存Agent job実行には触れていない。実際の適用はまだ人間確認後の次スライス候補として残す。
- `swift test --package-path apps/macos-studio --filter 'TimelineAgent(ReviewPatchDraft|ConsultationPrompt)Tests'` は8 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 69005）、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-167/TEST-175を追加し、367件の追跡行（Story 25 / Issue 167 / Test 175）、残課題3件、修正/合格364件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでstructured patch候補表示、warning、JSONなしturnの非表示、既存 `選択クリップのメモ下書きへ` button、read-only turn実行退行なしは人間確認キューへ集約する。

- M6.5第127スライスでは、読み取り専用Agent相談で検出したstructured `review_patch` 候補を、明示buttonで未保存のStudio編集としてTimeline/Viewerへ反映できるようにした。ユーザー体験としては、AIに `短く整える` などを相談した後、文章提案だけでなく、対応済みのtrim/move/split/remove/transition案を保存前に実際の編集状態として確認できる。
- `TimelineAgentReviewPatchApplyPlan` は現在のTimelineに対してdraft patchを評価し、version mismatch、未対応operation、非隣接transition、現在のclip構造に反映できない操作がある場合は部分適用せずblocked reasonを返す。対応済みoperationだけで構成される場合は、一時timeline、changed clip IDs、selection/focus/transition targetを作る。
- `StudioViewModel.applySelectedAgentReviewPatchDraftToTimeline()` はapply planが `canApply` の時だけ `StudioFeedbackSession` へoperationを積み、Timeline/Viewer/playhead/selection/highlightを即更新する。保存は既存のStudio編集保存buttonが担当し、timeline.json、review patch schema、compiler schema、write approval、Agent job実行経路は変更していない。
- `AgentPanel.ReviewPatchDraft` はapply readiness、blocked reason、`Timelineへ表示反映` button、保存前表示を出す。buttonは部分適用なしで反映できる時だけ有効になる。
- `swift test --package-path apps/macos-studio --filter 'TimelineAgentReviewPatch(ApplyPlan|Draft)Tests|TimelineAgentConsultationPromptTests'` は12 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 89592）も成功した。running appでstructured patch turnからの表示反映、未保存Studio編集の保存/破棄、unsupported op混在時のbutton disabled/部分適用なし、既存pin/read-only turn退行なしは人間確認キューへ集約する。

- M6.5第128スライスでは、structured `review_patch` の `replace_segment` も、select候補データが解決できる場合に限って未保存のStudio編集としてTimeline/Viewerへ表示反映できるようにした。ユーザー体験としては、AIが「このclipを別候補へ差し替える」と提案した時、文章だけでなく、実際の置換後の映像状態を保存前に確認できる。
- `TimelineAgentReviewPatchApplyPlan.evaluate` は `CandidateBrowserDataSource` を受け取り、`with_segment_id` と任意の `with_candidate_ref` から `BrowserCandidate` を探す。候補データなし、候補なし、video/audio種別不一致、source range不正、`candidate_ref` がない時のnil `candidate_id` 別候補誤解決はblocked reasonで止め、他operationを含むpatchでも部分適用しない。
- `StudioViewModel.selectedAgentReviewPatchApplyPlan` は現在の候補データをapply planへ渡す。成功時は既存のpending Studio編集として置換clipを選択し、focus/playback対象を更新する。保存するまでは `timeline.json` を変更せず、AI Agentのread-only相談/メモ化/既存trim・move・split・remove・transition表示反映の導線も維持する。
- `swift test --package-path apps/macos-studio --filter 'TimelineAgentReviewPatch(ApplyPlan|Draft)Tests|TimelineAgentConsultationPromptTests'` は15 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 91505）、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-169/TEST-177を追加し、371件の追跡行（Story 25 / Issue 169 / Test 177）、残課題3件、修正/合格368件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでstructured replace_segment turnからの表示反映、source range override、保存/破棄、候補失敗時のbutton disabled/部分適用なし、既存Agent patch操作の退行なしは人間確認キューへ集約する。

- M6.5第129スライスでは、適用済みtransitionを別の編集点へ移動する時も、細い編集点targetへ正確にdropするだけでなく、lane body上の大まかな位置へdropして近いeligible edit pointへ吸着できるようにした。ユーザー体験としては、FCPX/CapCut的に「このtransitionをこのあたりのcutへ動かす」操作が、transition presetを落とす時と同じ磁気的な感覚で成立する。
- `TimelineTransitionPlacementResolver.resolveNearestRelocationOnTrack(...)` は、source transition自身を移動先から除外し、削除保留/却下clip、audio lane、gap境界、relocate planを作れないtargetを避ける。近傍判定、duration clamp、source側をcutに戻すoperationは既存 `TimelineTransitionRelocatePlan` と `set_transition` 契約を使う。
- `TimelineSourceCandidateDropDelegate` は適用済みtransition drag payloadを読み取り、lane hover中に近傍移動先へ `onPreviewTransitionMove` を送る。target側は `近傍 移動` / `近い編集点へ移動` cueを表示し、drop時はexact edit point dropと同じ `onMoveTransition` / pending Studio edit経路へ入る。source candidate drop、transition preset lane drop、duration body drag、click applyは既存挙動を維持する。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は23 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 97901）も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-170/TEST-178を追加し、373件の追跡行（Story 25 / Issue 170 / Test 178）、残課題3件、修正/合格370件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで適用済みtransition中央handleからlane body hover/drop、近傍移動cue、Viewer preview、保存/破棄、source自身/gap/audio/削除保留target拒否、既存transition操作退行なしは人間確認キューへ集約する。

### M6.5第130スライス: Timeline-scoped AI shorten-beat consultation

- M6.5第130スライスでは、Agentパネルのtimeline相談intentに `shortenBeat` を追加し、日本語表示を「このビートを短く」にした。編集者は選択clip/transitionを見ながら、AIへ「この一拍を短くして」と依頼し、timeline変更案をPREVIEWとして受け取れる。
- `TimelineAgentConsultationPrompt` は `shortenBeat` で shorter / rhythmic / continuity / transcript meaning / audio readability を同時に要求する。timeline変更案はPREVIEW operationと任意の `review_patch` JSONに限定し、直接mutationしない。既存の `tightenSelection`、`findStrongerAlternate`、`explainCut` は維持する。
- `swift test --package-path apps/macos-studio --filter TimelineAgentConsultationPromptTests` は4 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 50264）も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-171/TEST-179を追加し、375件の追跡行（Story 25 / Issue 171 / Test 179）、残課題3件、修正/合格372件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでAgentパネルのmenu表示、prompt editor反映、read-only実行、timeline/unsaved Studio edit不変、既存3 intentとstructured review_patch draft/apply退行なしは人間確認キューへ集約する。

### M6.5第131スライス: Timeline keyboard clip selection navigation

- M6.5第131スライスでは、timeline focus時のLeft/Rightで前後のclipへ選択移動し、Shift-Left/Shift-Rightで同一track上の連続範囲へ選択を拡張できるようにした。ユーザー体験としては、AIが並べたrough cutを人間がレビューする時、クリックを繰り返さずにカット単位でViewerを進めながら確認できる。
- `TimelineClipSelectionNavigationPlan` は現在の主clip、選択集合、再生位置から前後のtargetを解決する。選択中は同一track内を進み、未選択ならplayhead近傍から開始する。Shift拡張時は連続clip範囲を返し、同時刻に複数laneがある場合は上位表示trackを優先する。
- `StudioViewModel` は選択移動時にSource Monitor/transition/一時previewを解除し、選択clipの先頭へplayheadとViewerを同期する。Command Paletteとtimeline focus shortcutsには「前のクリップを選択」「次のクリップを選択」「前へ範囲選択」「次へ範囲選択」を追加した。
- この変更はtimeline selection/navigationだけで、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、source insert/drop、transition drag/drop、trim commit pathには触れていない。
- `swift test --package-path apps/macos-studio --filter 'TimelineClipSelectionNavigationPlanTests|StudioCommandPaletteCommandTests'` は9 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 23417）、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-172/TEST-180を追加し、377件の追跡行（Story 25 / Issue 172 / Test 180）、残課題3件、修正/合格374件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtimeline focus後のLeft/Right/Shift-Left/Shift-Right、Viewer/playhead同期、Source MonitorからProgram復帰、Blade/Multi-selectとの状態感、既存Delete/Esc/transport/trim shortcuts退行なしは人間確認キューへ集約する。

### M6.5第132スライス: Timeline edit-point keyboard navigation

- M6.5第132スライスでは、timeline focus時のUp/Downで選択状態を変えず、前後の編集点、マーカー、タイムライン先頭/末尾へplayheadとViewerを移動できるようにした。ユーザー体験としては、AIが並べたrough cutのcut境界をFCPX/CapCut的に次々確認し、Left/Rightのclip選択移動とは別に「再生位置だけを次のseamへ送る」操作ができる。
- `TimelineEditPointNavigationPlan` はclip start/end、visible transition boundary、timeline marker、timeline start/endを同じ候補表へ正規化し、現在playheadより前/後の最寄りtargetを返す。同じframeにtransitionとclip境界がある場合はlabelをまとめ、status messageでどの編集点へ移動したかを示す。
- `StudioViewModel` は編集点ジャンプ時にSource Monitorと一時previewを解除し、clip/transition selectionは変えずにProgram Viewerへ戻して `setPlayheadFrame(..., forceSeek: true)` する。Command Paletteとtimeline focus shortcutsには「前の編集点へ移動」「次の編集点へ移動」を追加し、Up/Downへ接続した。
- この変更はplayhead/navigationだけで、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、source insert/drop、transition drag/drop、trim commit pathには触れていない。
- `swift test --package-path apps/macos-studio --filter 'TimelineEditPointNavigationPlanTests|StudioCommandPaletteCommandTests'` は9 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 90539）、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-173/TEST-181を追加し、379件の追跡行（Story 25 / Issue 173 / Test 181）、残課題3件、修正/合格376件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtimeline focus後のUp/Down、Viewer/playhead同期、Source MonitorからProgram復帰、marker/transition/clip境界/先頭末尾ジャンプ、既存Left/Right/Delete/Esc/transport/trim shortcuts退行なしは人間確認キューへ集約する。

### M6.5第133スライス: Timeline navigation reveal

- M6.5第133スライスでは、timeline focus時のLeft/Right/Shift-Left/Shift-RightやUp/Downでplayheadが大きく移動した時、zoomed detail timelineの表示範囲外または端に出る場合だけ、既存 `Timeline.PlayheadScrollAnchor` へ自動revealするようにした。ユーザー体験としては、Viewerだけが進んでTimeline上の現在位置を見失う状態を減らし、次のdrag/trimへすぐ移れる。
- `TimelineViewportScale.shouldRevealPlayheadAfterNavigation` は、全体表示や中央位置ではfalse、表示外または端近くではtrueを返す。`StudioViewModel.timelinePlayheadRevealRequest` はキーボードclip選択移動とedit-point移動後にだけincrementされ、`TimelinePanel` がそのrequestを受けて必要時だけ `scrollTo(TimelineScrollTarget.playhead)` する。
- この変更はUI scroll/revealだけで、playhead frame、selection、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、source insert/drop、transition drag/drop、trim commit pathには触れていない。再生中follow-playhead、Overview locate、Overview/ruler/empty-lane scrubは既存経路を維持する。
- `swift test --package-path apps/macos-studio --filter TimelineViewportScaleTests` は12 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 37158）、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-174/TEST-182を追加し、381件の追跡行（Story 25 / Issue 174 / Test 182）、残課題3件、修正/合格378件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでzoomed timeline中のLeft/Right/Shift-Left/Shift-Right/Up/Down、必要時だけのdetail reveal、Overview locate、再生中follow、ruler/empty-lane/overview scrub、manual horizontal scroll退行なしは人間確認キューへ集約する。

### M6.5第134スライス: Timeline drag target reveal

- M6.5第134スライスでは、zoomed detail timelineでclip body moveやIN/OUT drag trimを長めに動かした時、target frameが表示範囲外または端に近い場合だけ、専用 `Timeline.DragRevealScrollAnchor` へ自動revealするようにした。ユーザー体験としては、操作中のclip startやtrim boundaryが視界から逃げず、FCPX/CapCut的にそのままdrop/commitできる。
- `TimelineViewportScale.shouldRevealFrameDuringTimelineDrag` は、全体表示や中央位置ではfalse、表示外または端近くではtrueを返す。`TimelinePanel.activeDragRevealFrame` はclip/group move previewのnew timeline-in frame、trim previewのtarget boundary frameを受け取り、`TimelineTrackRow` がpreviewの発生/終了に合わせて更新・clearする。
- この変更はUI scroll/revealだけで、move/trim operation内容、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、source insert/drop、transition drag/drop、keyboard navigation、playhead follow pathには触れていない。Overview locate、ruler/empty-lane scrub、manual horizontal scrollは既存経路を維持する。
- `swift test --package-path apps/macos-studio --filter TimelineViewportScaleTests` は13 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 86151）、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-175/TEST-183を追加し、383件の追跡行（Story 25 / Issue 175 / Test 183）、残課題3件、修正/合格380件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでclip body長距離drag、group move、IN/OUT trim handle drag、必要時だけのdetail reveal、中央位置でのno-scroll、drop後のViewer/playback、keyboard navigation reveal、Overview locate、follow playback、scrub系操作退行なしは人間確認キューへ集約する。

### M6.5第135スライス: Roll edit drag target reveal

- M6.5第135スライスでは、zoomed detail timelineでincoming/outgoing `ROLL` handleを左右へ長めに動かした時、moving edit boundaryが表示範囲外または端に近い場合だけ、既存 `Timeline.DragRevealScrollAnchor` へ自動revealするようにした。ユーザー体験としては、ロール中のcut境界が視界から逃げず、FCPX/CapCut的にそのままmouse-up commitできる。
- `TimelineTrackRow` はROLL preview生成時に `TimelineRollTrimPlan.newBoundaryFrame` を `activeDragRevealFrame` へ入れ、preview終了時にclearする。既存 `TimelineViewportScale.shouldRevealFrameDuringTimelineDrag` を再利用するため、中央位置や全体表示ではfalseのままになり、clip move/drag trim revealと同じscroll contractを使う。
- この変更はUI scroll/revealだけで、ROLL operation内容、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、source insert/drop、transition drag/drop、keyboard navigation、playhead follow pathには触れていない。ROLL Viewer preview、commit path、Overview locate、ruler/empty-lane scrub、manual horizontal scrollは既存経路を維持する。
- `swift test --package-path apps/macos-studio --filter TimelineRollTrimPlanTests` は6 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 5985）、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-176/TEST-184を追加し、385件の追跡行（Story 25 / Issue 176 / Test 184）、残課題3件、修正/合格382件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでincoming/outgoing ROLL handle長距離drag、必要時だけのdetail reveal、中央位置でのno-scroll、mouse-up commit後のViewer/playback、move/trim reveal、keyboard navigation reveal、scrub系操作退行なしは人間確認キューへ集約する。

### M6.5第136スライス: Transition duration drag target reveal

- M6.5第136スライスでは、zoomed detail timelineで既存transitionのduration handleを左右へ長めに動かした時、伸縮しているtransition edgeが表示範囲外または端に近い場合だけ、既存 `Timeline.DragRevealScrollAnchor` へ自動revealするようにした。ユーザー体験としては、transition length調整中のedgeが視界から逃げず、FCPX/CapCut的にそのままmouse-up commitできる。
- `TimelineViewportScale.transitionDurationDragRevealFrame` は、edit boundary、既存duration、drag frame delta、timeline boundsからpreview中のmoving edge frameを返す。`TimelineTransitionDropTarget.durationDragGesture` はframeDeltaがある間だけこのedgeを `activeDragRevealFrame` へ入れ、delta 0またはdrag終了でclearする。既存 `TimelineViewportScale.shouldRevealFrameDuringTimelineDrag` を再利用するため、中央位置や全体表示ではscrollしない。
- この変更はUI scroll/revealだけで、transition duration preview/apply内容、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、source insert/drop、transition preset drop/move、keyboard navigation、playhead follow pathには触れていない。clip move/drag trim/roll reveal、Overview locate、ruler/empty-lane scrub、manual horizontal scrollは既存経路を維持する。
- `swift test --package-path apps/macos-studio --filter TimelineViewportScaleTests` は15 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`、tracker inspect、`git diff --check` も成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-177/TEST-185を追加し、387件の追跡行（Story 25 / Issue 177 / Test 185）、残課題3件、修正/合格384件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで既存transition duration handle長距離drag、必要時だけのdetail reveal、中央位置でのno-scroll、mouse-up commit後のViewer/playback、transition drop/move、move/trim/roll reveal、keyboard navigation reveal、scrub系操作退行なしは人間確認キューへ集約する。

### M6.5第137スライス: Transition duration Viewer resync

- M6.5第137スライスでは、既存transitionのduration handleをドラッグした時、Timeline上のtransition width/badgeだけでなく、Program Viewerのtransition overlayもdrag中のpreview durationへ追従してseekし直すようにした。ユーザー体験としては、FCPX/CapCut的にViewerを見ながらtransitionの長さを調整できる。
- `StudioViewModel.activeViewerTimeline` はtransition duration preview中に `timelineWithTransitionDurationPreview` を使う。`ViewerTransitionPreview` はoverlay media/opacity/labelに加えてoverlay-specific `syncGeneration` を持ち、`ViewerSurface` は通常のplayback syncとoverlay syncを合成してoverlay `MediaVideoPlayer` へ渡す。同じvideo URLのまま `viewerStartSeconds` が変わるdrag previewでもoverlay playerが再seekできる。
- この変更はViewer preview同期だけで、transition duration preview/apply operation、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、source insert/drop、transition preset drop/move、keyboard navigation、playhead follow pathには触れていない。clip move/drag trim/roll Viewer previewは既存経路を維持する。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests`、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`、tracker inspect、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-178/TEST-186を追加し、389件の追跡行（Story 25 / Issue 178 / Test 186）、残課題3件、修正/合格386件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで既存transition duration handleを短く/長くdragし、Program Viewer overlay合成が同じ操作中に更新されること、同じclip/video URL上でもoverlayが古いframeに残らないこと、commit後のViewer/playbackと既存transition/clip previewが退行しないことは人間確認キューへ集約する。

### M6.5第138スライス: Lane-lift overlap avoidance badges

- M6.5第138スライスでは、clip bodyまたはgroup dragが既存clipと重なってmagnetic lane liftされる時、避けられる既存clip自体にも `回避 -> target track` の小型badgeを出すようにした。ユーザー体験としては、重なり位置へdragした時に、別レーンへ逃がされる理由がFCPX/CapCut的にdrop前から分かる。
- `TimelineTrackRow.laneLiftAvoidanceTargetID(for:)` はsingle/group move previewの `laneLift.overlappedClipIDs` から対象clipを解決し、`TimelineLaneLiftAvoidedClipBadge` をtop trailingに表示する。アクセシビリティ値にも「重なり回避対象。移動クリップはtarget trackへ逃がします」を追加した。
- この変更はlane-liftの説明表示だけで、move/lane-lift operation、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、source insert/drop、transition drag/drop、keyboard navigation、playhead follow pathには触れていない。既存clipは押し出されず、moving clipだけが既存 `target_track_id` 契約で別trackへ移る。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`、tracker inspect、`git diff --check` は成功した。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-179/TEST-187を追加し、391件の追跡行（Story 25 / Issue 179 / Test 187）、残課題3件、修正/合格388件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでvideo/audio/overlay clip overlap drag、source/requested target row上のoverlapped clip badge、target ghost/landing cue/move badgeとの整合、commit後Viewer/playback、group move、explicit vertical target、source candidate lane liftの退行なしは人間確認キューへ集約する。

### M6.5第139スライス: Group move target ghosts

- M6.5第139スライスでは、複数選択clipをgroup dragで互換target rowへ移動またはlane-liftするとき、target row上に各moved clipのghostを表示するようにした。ユーザー体験としては、range bandだけでなく、drop後にどのclipがどの位置へ並ぶかをmouse-up前に読める。
- `TimelineTrackRow.groupMoveTargetGhosts` は `TimelineClipGroupMovePlan.newTimelineInFrames` と `targetTrackID` から各clipのtarget ghostを作る。direct group track moveはpurple、lane-liftはtealで描画し、新規track作成時は従来のsource row two-lane preview/range cueを維持する。
- この変更はgroup move/lane-liftのpreview表示だけで、move_segment target_track_id、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、source insert/drop、transition drag/drop、keyboard navigation、playhead follow pathには触れていない。複数clipのdrop resultを読めるようにしつつ、Planner/operation契約は既存のまま保つ。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`、tracker inspect、`git diff --check` は成功した（2026-06-28 23:23 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-180/TEST-188を追加し、393件の追跡行（Story 25 / Issue 180 / Test 188）、残課題3件、修正/合格390件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで複数選択clipのopen compatible row移動、occupied compatible row lane-lift、same-track overlap lift、target rowの各clip ghost、group range cue、landing cue、avoidance badgeの整合、commit後Viewer/playback、single move/source candidate lane lift退行なしは人間確認キューへ集約する。

### M6.5第140スライス: Transition lane drop guides

- M6.5第140スライスでは、transition presetまたは既存transitionをドラッグしている間、compatibleなvideo/overlay row全体に `TimelineTransitionLaneDropGuide` を表示するようにした。ユーザー体験としては、細い編集点だけでなく「このレーン上で離せば近い編集点へ吸着する」ことがdrag開始直後から分かる。
- `TimelineTrackRow.transitionLaneDropGuide` はactive preset drag時にeligible edit point数を数え、preset dropではaccent、transition moveではorangeのrow-wide dashed guideとchipを描く。blocked/rejected clipを含むedit pointは候補数から除外する。
- この変更はtransition drag affordanceの表示だけで、`TimelineTransitionPlacementResolver.resolveNearestOnTrack` / `resolveNearestRelocationOnTrack`、set_transition operation、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。既存の近傍吸着drop挙動を、drop前にrow全体で見えるようにした。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は23 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`、tracker inspect、`git diff --check` は成功した（2026-06-28 23:31 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-181/TEST-189を追加し、395件の追跡行（Story 25 / Issue 181 / Test 189）、残課題3件、修正/合格392件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtransition preset drag開始時のvideo/overlay row drop lane guide、audio/gap-only row非表示、レーン上hoverから近傍edit point cue/Viewer previewへの接続、既存transition move dragのorange guide、drop/click apply/duration drag/clip move退行なしは人間確認キューへ集約する。

### M6.5第141スライス: Clip lane drop guides

- M6.5第141スライスでは、clip bodyまたはgroup drag中に、sourceとは別のcompatible rowへ `TimelineClipLaneDropGuide` を薄く表示するようにした。ユーザー体験としては、FCPX/CapCut的に「どのV/A/Oレーンへ縦移動できるか」がtarget rowへ乗る前から読める。
- `TimelineTrackRow.clipLaneDropGuide` はactive single/group move previewのsource kindを解決し、同種rowだけにguideを出す。現フレーム位置でそのrowの既存clipと重なる場合はtealで「空きレーンへ自動回避」、空いている場合はaccentで「直接移動」を表示する。
- この変更はclip/group move drag affordanceの表示だけで、`TimelineClipMovePlan` / `TimelineClipGroupMovePlan`、move_segment target_track_id、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。既存のtarget ghost/landing cue/lane lift挙動を、target rowへ乗る前からレーン全体で見えるようにした。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify` は初回の可視window検出timing miss後の再実行で成功し、CoreGraphics window check、`pgrep -x VideoOSStudio -fl`、tracker inspect、`git diff --check` も成功した（2026-06-28 23:42 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-182/TEST-190を追加し、397件の追跡行（Story 25 / Issue 182 / Test 190）、残課題3件、修正/合格394件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでsingle/group clip drag中のcompatible row guide、source/種類違いrow非表示、空きrow accent直接移動、重なりrow teal自動回避、target ghost/landing cue/lane lift/Viewer preview、transition/source drag退行なしは人間確認キューへ集約する。

### M6.5第142スライス: Source candidate lane drop guides

- M6.5第142スライスでは、Source Monitor候補カードまたはSource Bin quick dragをタイムラインへ持ち込んだ時、roleに合うrow全体へ `TimelineSourceCandidateLaneDropGuide` を表示するようにした。ユーザー体験としては、素材候補を「どこへ落とせば入るのか」が、細いhover位置やghostだけに依存せず読める。
- `TimelineSourceCandidateDropPreview` は `targetTrackKind` を持ち、`TimelineTrackRow.sourceCandidateLaneDropGuide` が映像候補なら映像row、音声候補なら音声rowだけをorangeで示す。重なり回避が起きるrequested rowとtarget rowはtealで「自動回避」「回避先」と表示し、FCPX的なmagnetic lane感をdrop前に補強する。
- この変更はSource候補drag/drop affordanceの表示だけで、`TimelineSourceInsertPlan`、snap、lane-lift、source marked range、drop commit、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。既存のsource drop ghost/cue/snap indicatorを、compatible row全体の受け皿表示で補強した。
- `swift test --package-path apps/macos-studio --filter TimelineSourceInsertPlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 66661）、tracker inspect、`git diff --check` も成功した（2026-06-28 23:53 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-183/TEST-191を追加し、399件の追跡行（Story 25 / Issue 183 / Test 191）、残課題3件、修正/合格396件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor候補カード/Source Bin quick drag中のcompatible row guide、種類違いrow非表示、snap時magnet表示、重なり時teal自動回避/回避先、hover後ghost/cue/snap/lane-lift、drop後Viewer/playback、clip/transition lane guide退行なしは人間確認キューへ集約する。

### M6.5第143スライス: Source timeline drag chips

- M6.5第143スライスでは、Source Monitor候補カード、Source Binリスト、Source Binタイルに共通の `SourceTimelineDragChip` を追加した。ユーザー体験としては、素材候補を選んだ時点で「Timelineへドラッグできる候補」「想定track」「duration」「confidence」がSource側にも明示される。
- Source Monitor候補カードはsummary直下に `Timelineへドラッグ` chipを表示し、marked rangeのdurationを反映する。Source Binリストは既存quick drag summaryを同じchipへ置き換え、タイルはcompact chipで `TLへ` とdurationを表示する。
- この変更はSource側のdrag affordance表示だけで、既存onDrag payload、quick insert、source marked range、`TimelineSourceInsertPlan`、timeline drop/lane guide、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。Source側の「つかんでTimelineへ持っていく」開始点を、前スライスのTimeline側受け皿表示と揃えた。
- `swift test --package-path apps/macos-studio --filter TimelineSourceInsertPlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 15211）、tracker inspect、`git diff --check` も成功した（2026-06-29 00:02 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-184/TEST-192を追加し、401件の追跡行（Story 25 / Issue 184 / Test 192）、残課題3件、修正/合格398件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor候補カードのdrag chip、marked range変更後のduration反映、Source Binリスト/タイルのdrag chip、カード/row/tile drag payload、quick insert、Source candidate lane guide、drop後Viewer/playback退行なしは人間確認キューへ集約する。

### M6.5第144スライス: Transition preset drag affordance chips

- M6.5第144スライスでは、Transition preset chipへ `TimelineTransitionPresetDragAffordance` を追加した。ユーザー体験としては、クロスフェードなどのpresetを見た時点で、クリック適用だけでなくTimelineへドラッグできる素材で、既定durationが何frameなのかを理解できる。
- `TimelineTransitionPresetDragAffordance` は `hand.draw` iconとdefault frame数のpillをpreset chip内に表示し、active drag中はaccent emphasisへ切り替わる。FCPX/CapCut的な「transition素材をつかんでtimelineへ置く」開始点を、前スライスまでのTimeline側drop lane guideと接続する。
- この変更はTransition palette側のdrag affordance表示だけで、既存click apply、onDrag payload、`beginTransitionPresetDrag`、`TimelineTransitionPlacementResolver`、`set_transition` operation、transition duration/move、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は23 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 48348）、tracker inspect、`git diff --check` も成功した（2026-06-29 00:10 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-185/TEST-193を追加し、403件の追跡行（Story 25 / Issue 185 / Test 193）、残課題3件、修正/合格400件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで各presetのhand+duration chip、drag開始中のactive emphasis、transition lane drop guideへの接続、audio row非表示、click apply/Command-T/duration drag/transition move/source/clip drag退行なしは人間確認キューへ集約する。

### M6.5第145スライス: Transition drop cue duration labels

- M6.5第145スライスでは、Transition presetをdrag中のedit-point candidate cueとmagnet cueにもpreset既定durationを表示するようにした。ユーザー体験としては、paletteでつかんだtransitionが、どのcutへ何frameで吸着しようとしているかをdrop直前にも読める。
- `TimelineTransitionDropTarget` はpreviewed/active preset summaryを `localizedLabel + defaultFrames` で組み、candidate cue、magnet cue、hover preview label、help textへ同じ語彙を使う。FCPX/CapCut的なdrag/dropでは、開始点だけでなくdrop直前のtarget feedbackにも同じ素材情報が出るため、drop confidenceが上がる。
- この変更はTransition target cue表示だけで、既存drop delegate、`TimelineTransitionPlacementResolver`、`set_transition` operation、transition duration/move、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は23 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 86275）、tracker inspect、`git diff --check` も成功した（2026-06-29 00:17 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-186/TEST-194を追加し、405件の追跡行（Story 25 / Issue 186 / Test 194）、残課題3件、修正/合格402件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでedit-point cue/magnet cueの `preset名 既定frame数` 表示、近傍/推奨/hover previewのduration一貫性、長い日本語labelの潰れ、drop/click apply/Command-T/duration drag/transition move退行なしは人間確認キューへ集約する。

### M6.5第146スライス: Existing transition move cue summaries

- M6.5第146スライスでは、適用済みtransitionを中央handleから移動するとき、lane guide、candidate cue、magnet cue、help textに移動元transitionの種別とdurationを表示するようにした。ユーザー体験としては、既存transitionをつかんだ後も「どのtransitionを何frameのまま移動しているか」をdrop先で読める。
- `TimelineTrackRow.activeTransitionMoveSummary` は同じrow内のactive transitionを解決し、`localizedTimelineTransitionType + transitionFrames` へ正規化する。`TimelineTransitionDropTarget` はそのsummaryをmove候補/近傍移動/hover previewの表示に使う。解決できない場合は従来の「移動」表現へfail-openするため、表示補助だけで操作契約を変えない。
- この変更は既存transition移動中のtarget feedback表示だけで、既存drop delegate、`TimelineTransitionPlacementResolver.resolveNearestRelocationOnTrack`、`TimelineTransitionRelocatePlan`、`set_transition` operation、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は23 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 16606）、tracker inspect、`git diff --check` も成功した（2026-06-29 00:23 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-187/TEST-195を追加し、407件の追跡行（Story 25 / Issue 187 / Test 195）、残課題3件、修正/合格404件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで既存transition移動中のsummary cue、解決不能時fail-open、source target自身除外、drop後Viewer/playback/duration drag/preset drop退行なしは人間確認キューへ集約する。

### M6.5第147スライス: Clip move duration labels

- M6.5第147スライスでは、clip bodyまたはgroup drag中の `TimelineMovePreviewBadge` detailに、移動中clipの尺またはgroup span durationを表示するようにした。ユーザー体験としては、clipをつかんでmagnetic move/lane liftしている最中も「何秒の素材をどこへ動かしているか」がdrop前に読める。
- `movePreviewDetail` は移動量に加えて `尺Xs` を受け取る。single clipは `TimelineClipMovePlan.durationFrames`、group moveは移動後の選択clip群の最小startから最大endまでのspanを `groupMoveSpanDurationFrames` で計算する。FCPX/CapCut的なclip dragでは、位置だけでなく素材の長さもdrop confidenceに関わるため、move badgeの情報階層に入れる。
- この変更はclip/group move中のbadge表示だけで、`TimelineClipMovePlan`、`TimelineClipGroupMovePlan`、move/lane-lift/snap/displacement operation、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 47861）、tracker inspect、`git diff --check` も成功した（2026-06-29 00:30 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-188/TEST-196を追加し、409件の追跡行（Story 25 / Issue 188 / Test 196）、残課題3件、修正/合格406件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでsingle/group clip drag中の尺表示、track/lane-lift/snap/displacement detail、長いdetailの潰れ、drop後Viewer/playback、source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第148スライス: Group move range duration labels

- M6.5第148スライスでは、group drag中の `TimelineGroupMoveRangeCue` に選択group span durationを表示するようにした。ユーザー体験としては、複数clipをまとめてmove/lane-liftしている最中も、range band上で「何clipをどれだけの範囲として動かしているか」をdrop前に読める。
- `TimelineGroupMoveRangeCue` は既存の `startFrame` / `endFrame` から `spanDurationText` を計算し、badge内に `尺Xs` を追加する。FCPX/CapCut的なgroup dragでは、個別ghostだけでなくgroup全体のtime spanがdrop confidenceに関わるため、wide range bandにもdurationを置く。
- この変更はgroup move中のrange cue表示だけで、`TimelineClipMovePlan`、`TimelineClipGroupMovePlan`、move/lane-lift/snap/displacement operation、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 78565）、tracker inspect、`git diff --check` も成功した（2026-06-29 00:39 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-189/TEST-197を追加し、411件の追跡行（Story 25 / Issue 189 / Test 197）、残課題3件、修正/合格408件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでgroup drag中のrange cue duration、badge width、move badge/target ghosts/lane-lift/drop後Viewer/playback/source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第149スライス: Group target ghost duration labels

- M6.5第149スライスでは、group dragでdestination rowへ表示される各 `TimelineGroupMoveTargetGhost` chipにclip durationを表示するようにした。ユーザー体験としては、group全体のrange尺だけでなく、drop後に並ぶ個々のclip ghostが何秒の素材かもrow上で読める。
- `TimelineGroupMoveTargetGhostModel` は `durationText` を持ち、`TimelineGroupMoveTargetGhost` はtarget track chipに `尺Xs` を追加する。FCPX/CapCut的なgroup dragでは、range band、move badge、destination ghostの情報が同じ粒度で揃っているとdrop confidenceが上がる。
- この変更はgroup move中のtarget ghost表示だけで、`TimelineClipMovePlan`、`TimelineClipGroupMovePlan`、move/lane-lift/snap/displacement operation、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 22719）、tracker inspect、`git diff --check` も成功した（2026-06-29 00:46 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-190/TEST-198を追加し、413件の追跡行（Story 25 / Issue 190 / Test 198）、残課題3件、修正/合格410件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでgroup target ghost duration、chipの潰れ、range cue/move badge/landing cue/lane-lift/Viewer/playback/source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第150スライス: Single clip target ghost duration labels

- M6.5第150スライスでは、single clip dragでdestination rowへ表示される `TimelineLaneLiftTargetGhost` と `TimelineTrackMoveTargetGhost` のchipにもclip durationを表示するようにした。ユーザー体験としては、group dragだけでなく単体clipのlane-lift/direct track moveでも「どのtrackへ何秒のclipが着地するか」をrow上で読める。
- `TimelineLaneLiftTargetGhostModel` と `TimelineTrackMoveTargetGhostModel` は `durationText` を持ち、各ghost chipに `尺Xs` を追加する。FCPX/CapCut的なmagnetic moveでは、move badge、landing cue、destination ghostの情報粒度が揃うほどdrop confidenceが上がる。
- この変更はsingle clip move中のtarget ghost表示だけで、`TimelineClipMovePlan`、move/lane-lift/snap/displacement operation、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 52980）、tracker inspect、`git diff --check` も成功した（2026-06-29 00:52 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-191/TEST-199を追加し、415件の追跡行（Story 25 / Issue 191 / Test 199）、残課題3件、修正/合格412件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでsingle clip target ghost duration、chipの潰れ、move badge/landing cue/avoidance badge/group/source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第151スライス: Clip move landing cue duration labels

- M6.5第151スライスでは、single/group clip drag中の `TimelineClipMoveLandingCue` chipにもdurationを表示するようにした。ユーザー体験としては、最終drop rail上でtarget track、timecode、clip/group span尺を同時に読める。
- `TimelineClipMoveLandingCueModel` は `durationText` を持ち、single moveでは `TimelineClipMovePlan.durationFrames`、group moveでは `groupMoveSpanDurationFrames` を `尺Xs` として表示する。FCPX/CapCut的なmagnetic moveでは、最後に目が行くdrop railにも素材尺が残ることでmouse-up前の判断がしやすくなる。
- この変更はclip/group move中のlanding cue表示だけで、`TimelineClipMovePlan`、`TimelineClipGroupMovePlan`、move/lane-lift/snap/displacement operation、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 87697）、tracker inspect、`git diff --check` も成功した（2026-06-29 00:58 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-192/TEST-200を追加し、417件の追跡行（Story 25 / Issue 192 / Test 200）、残課題3件、修正/合格414件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでlanding cue duration、badgeの潰れ、move badge/target ghosts/range cue/lane-lift/Viewer/playback/source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第152スライス: Track move blocked cue duration labels

- M6.5第152スライスでは、vertical clip/group dragがincompatible/occupied targetでblockedになる時の `TimelineTrackMoveBlockedCue` にattempted move durationを表示するようにした。ユーザー体験としては、赤いblocked cue上でも「なぜ不可か」だけでなく「何秒のclip/groupを移そうとしていたか」をmouse-up前に読める。
- `TimelineTrackMoveBlockedCueModel` は `durationText` を持ち、`TimelineTrackMoveBlockedCue` chipに `尺Xs` を追加する。help/accessibility labelにも尺を含める。既存 `TimelineTrackMoveBlockedTarget.durationFrames`、`TimelineClipMovePlan` / `TimelineClipGroupMovePlan`、move/lane-lift/snap/displacement operation、timeline.json、schema/compiler契約は変えない。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 27359）、tracker inspect、`git diff --check` も成功した（2026-06-29 01:09 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-193/TEST-201を追加し、419件の追跡行（Story 25 / Issue 193 / Test 201）、残課題3件、修正/合格416件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでsingle clipを種類違いrowまたは占有rowへvertical dragし、group dragでもblocked targetを作り、red blocked cueにreasonと尺が潰れず表示されること、move badge/target ghosts/landing cue/range cue/lane-lift/Viewer/playback/source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第153スライス: Track move blocked cue legibility width

- M6.5第153スライスでは、前スライスでblocked cueへ追加した `reason + 尺Xs` が短尺clipや狭いtimeline zoomで潰れやすい問題に対し、`TimelineTrackMoveBlockedCue` の最小visual widthとchip widthを情報量に合わせて広げた。ユーザー体験としては、赤いblocked target feedbackが短いclip上でも「不可理由」と「対象尺」を同時に読める。
- `trackMoveBlockedCueWidth(for:)` は最小幅を142へ上げ、`TimelineTrackMoveBlockedCue` のcapsule chipは136-172の範囲で収める。長尺clip上でchipが過剰に伸びないよう上限を持たせ、既存 `TimelineTrackMoveBlockedTarget.durationFrames`、move/lane-lift/snap/displacement operation、timeline.json、schema/compiler契約は変えない。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 52177）、tracker inspect、`git diff --check` も成功した（2026-06-29 01:15 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-194/TEST-202を追加し、421件の追跡行（Story 25 / Issue 194 / Test 202）、残課題3件、修正/合格418件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで短尺single clip/groupをincompatible/occupied targetへvertical dragし、red blocked cueのreasonと尺が極端に潰れないこと、長尺clip上でもchipが不必要に伸びすぎないこと、accepted target ghosts/landing cue/range cue/lane-lift/Viewer/playback/source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第154スライス: Clip lane drop guide duration labels

- M6.5第154スライスでは、clip bodyまたはgroup drag中にsourceとは別のcompatible rowへ出る `TimelineClipLaneDropGuide` にmoved clip/group span durationを表示するようにした。ユーザー体験としては、row-wideな受け皿表示の段階で「このrowへ何秒のclip/groupを落とそうとしているか」を読める。
- `TimelineClipLaneDropSource` と `TimelineClipLaneDropGuideModel` は `durationText` を持ち、guideのtitle rowに `尺Xs` を追加する。FCPX/CapCut的なmagnetic moveでは、target ghostやlanding cueに入る前のrow-wide guideでも素材尺が見えていると、直接移動か自動回避かを判断しやすい。
- この変更はclip/group move中のlane drop guide表示だけで、`TimelineClipMovePlan`、`TimelineClipGroupMovePlan`、move/lane-lift/snap/displacement operation、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 92179）、tracker inspect、`git diff --check` も成功した（2026-06-29 01:24 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-195/TEST-203を追加し、423件の追跡行（Story 25 / Issue 195 / Test 203）、残課題3件、修正/合格420件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでsingle/group clip drag開始直後にcompatible rowのlane drop guideへ `尺Xs` が表示されること、空きrow/重なりrowの直接移動/自動回避表現と矛盾しないこと、accepted target ghosts/landing cue/range cue/blocked cue/lane-lift/Viewer/playback/source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第155スライス: Clip lane drop guide target timecodes

- M6.5第155スライスでは、clip bodyまたはgroup drag中にsourceとは別のcompatible rowへ出る `TimelineClipLaneDropGuide` のdetailへlanding timecodeを表示するようにした。ユーザー体験としては、row-wideな受け皿表示の段階で「このrowの何時点へ落ちるか」を読める。
- `TimelineClipLaneDropSource` は `targetTimecode` を持ち、single moveでは `TimelineClipMovePlan.newTimelineInFrame`、group moveでは `newTimelineInFrames` の最小frameをtimecode化する。FCPX/CapCut的なmagnetic moveでは、target ghost/landing cueへ近づく前から着地点の時刻が見えることで、mouse-up前の判断負荷が下がる。
- この変更はclip/group move中のlane drop guide表示だけで、`TimelineClipMovePlan`、`TimelineClipGroupMovePlan`、move/lane-lift/snap/displacement operation、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 22755）、tracker inspect、`git diff --check` も成功した（2026-06-29 01:30 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-196/TEST-204を追加し、425件の追跡行（Story 25 / Issue 196 / Test 204）、残課題3件、修正/合格422件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでsingle/group clip drag開始直後にcompatible rowのlane drop guideへlanding timecodeが出ること、snap中にlanding cue/move badgeと矛盾しないこと、空きrow/重なりrowの直接移動/自動回避表現、accepted target ghosts/landing cue/range cue/blocked cue/lane-lift/Viewer/playback/source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第156スライス: Clip lane drop guide snap labels

- M6.5第156スライスでは、clip bodyまたはgroup drag中にsourceとは別のcompatible rowへ出る `TimelineClipLaneDropGuide` のdetailへsnap labelを表示するようにした。ユーザー体験としては、row-wideな受け皿表示の段階で「この着地点が何に吸着しているか」を読める。
- `TimelineClipLaneDropSource` は `snapLabel` を持ち、single/group move previewの `TimelineClipMoveSnap.label` をdetailの `吸着 label` として表示する。FCPX/CapCut的なmagnetic moveでは、timecodeだけでなくsnap理由がdrop前に見えると、吸い付きが偶然ではなく編集操作として理解しやすい。
- この変更はclip/group move中のlane drop guide表示だけで、`TimelineClipMovePlan`、`TimelineClipGroupMovePlan`、move/lane-lift/snap/displacement operation、timeline.json、review patch schema、compiler schema、StudioFeedbackSession、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 50525）、tracker inspect、`git diff --check` も成功した（2026-06-29 01:35 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-197/TEST-205を追加し、427件の追跡行（Story 25 / Issue 197 / Test 205）、残課題3件、修正/合格424件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでsingle/group clip drag中にmarker/edit/playhead snapを発生させ、compatible rowのlane drop guide detailへ `吸着 label` が出ること、snapなしでは従来文のままになること、move badge/landing cue/range cue/blocked cue/lane-lift/Viewer/playback/source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第157スライス: Transition preset lane guide duration labels

- M6.5第157スライスでは、transition preset drag中にvideo/overlay rowへ出る `TimelineTransitionLaneDropGuide` のtitleへpreset default frame数を表示するようにした。ユーザー体験としては、row-wideなtransition drop laneの段階でも「どのtransitionを何frameで落とすか」を読める。
- preset drag時のlane guide titleは `localizedLabel + defaultFrames` を使い、drop cueやpreset chipと同じduration語彙に揃える。FCPX/CapCut的なtransition dragでは、細いedit point cueへ近づく前からdurationが分かることで、rough placement中の判断がしやすい。
- この変更はtransition preset drag中のlane guide表示だけで、transition move、drop delegate、resolver、`set_transition` operation、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は23 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 85254）、tracker inspect、`git diff --check` も成功した（2026-06-29 01:42 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-198/TEST-206を追加し、429件の追跡行（Story 25 / Issue 198 / Test 206）、残課題3件、修正/合格426件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtransition presetをdrag開始し、video/overlay rowのtransition lane guide titleに `preset名 frame数` が出ること、候補数/detail、candidate cue、magnet cue、click apply、Command-T、transition duration drag、transition move、clip/source drag退行なしは人間確認キューへ集約する。

### M6.5第158スライス: Transition lane guide edit-point range labels

- M6.5第158スライスでは、transition preset/transition move drag中にvideo/overlay rowへ出る `TimelineTransitionLaneDropGuide` のdetailへeligible edit point timecode rangeを表示するようにした。ユーザー体験としては、row-wideなtransition drop laneの段階で「このrowのどの時刻帯に吸着先があるか」を読める。
- `transitionLaneTargetRangeText(for:)` はeligible targetの `boundaryFrame` からfirst-last timecodeを作り、single targetなら単一timecodeを表示する。preset dragでは全eligible targets、transition moveではsource targetを除いたmove targetsを使う。FCPX/CapCut的なtransition dragでは、薄いedit point cueへ近づく前に候補時刻帯が見えることで、magnetic placementの見通しがよくなる。
- この変更はtransition lane guide表示だけで、drop delegate、resolver、`set_transition` operation、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は23 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 20292）、tracker inspect、`git diff --check` も成功した（2026-06-29 01:48 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-199/TEST-207を追加し、431件の追跡行（Story 25 / Issue 199 / Test 207）、残課題3件、修正/合格428件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtransition preset/既存transition moveをdragし、video/overlay rowのtransition lane guide detailにeligible edit point timecode rangeが出ること、single候補では単一timecodeとして読めること、candidate cue/magnet cue/click apply/Command-T/duration drag/clip/source drag退行なしは人間確認キューへ集約する。

### M6.5第159スライス: Transition candidate cue timecode labels

- M6.5第159スライスでは、transition preset/transition move drag中に各edit pointへ出る `TimelineTransitionDropCandidateCue` のlabelへboundary timecodeを表示するようにした。ユーザー体験としては、row-wide rangeから個別候補cueへ視線を移した時に「どの編集点へ吸着するか」を時刻で確認できる。
- `TimelineTransitionDropTarget.dropCandidateCue` はpreset候補、recommended候補、lane-nearest候補、transition move候補すべてで `sequence.framesToTimecode(target.boundaryFrame)` を `@ timecode` として付ける。FCPX/CapCut的なmagnetic transition placementでは、吸い付き先の名前だけでなく位置が読めることで、drag中の修正判断がしやすい。
- この変更はtransition candidate cue表示だけで、drop delegate、resolver、`set_transition` operation、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は23 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 50551）、tracker inspect、`git diff --check` も成功した（2026-06-29 01:54 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-200/TEST-208を追加し、433件の追跡行（Story 25 / Issue 200 / Test 208）、残課題3件、修正/合格430件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtransition preset/既存transition moveをdragし、各edit-point candidate cueにboundary timecodeが出ること、長い日本語preset名でも極端に潰れないこと、lane guide range、magnet cue、click apply、Command-T、duration drag、clip/source drag退行なしは人間確認キューへ集約する。

### M6.5第160スライス: Transition magnet cue timecode details

- M6.5第160スライスでは、transition preset/transition move drag中に実際のhover/drop先へ出る `TimelineTransitionDropMagnetCue` のdetailへboundary timecodeを表示するようにした。ユーザー体験としては、candidate cueからmagnet cueへ進んだ時も吸着先時刻が消えず、drop直前の確認がしやすい。
- `TimelineTransitionDropTarget.magnetCueDetail` は `sequence.framesToTimecode(target.boundaryFrame)` と `fromClipID → toClipID` をまとめ、preset preview、recommended/nearest lane target、transition move targetの全magnet cueで共有する。FCPX/CapCut的なmagnetic transition placementでは、hover中の強い吸着表示でも時間文脈が残ることで、誤dropへの不安が減る。
- この変更はtransition magnet cue表示だけで、drop delegate、resolver、`set_transition` operation、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は23 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 79191）、tracker inspect、`git diff --check` も成功した（2026-06-29 02:00 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-201/TEST-209を追加し、435件の追跡行（Story 25 / Issue 201 / Test 209）、残課題3件、修正/合格432件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtransition preset/既存transition moveをedit pointへhover/dropし、magnet cue detailにboundary timecodeが残ること、candidate cue timecode/lane guide rangeと矛盾しないこと、click apply、Command-T、duration drag、clip/source drag退行なしは人間確認キューへ集約する。

### M6.5第161スライス: Source candidate lane guide landing time and duration

- M6.5第161スライスでは、Source Monitor候補カードやSource Bin quick dragをtimelineへdragしている時に出る `TimelineSourceCandidateLaneDropGuide` のdetailへlanding timecodeとdurationを表示するようにした。ユーザー体験としては、row-wideな受け皿表示の段階で「この素材がどこへ、何秒で置かれるか」を読める。
- `sourceCandidateLandingSummary(_:)` は `TimelineSourceCandidateDropPreview.timelineInFrame` と `durationFrames` から `timecode / 尺Xs` を作り、直接追加、snap、lane-lift自動回避、回避先guideの全detailへ入れる。FCPX/CapCut的な素材drag/dropでは、drop cueへ近づく前から着地時刻と尺が見えることで、素材追加の不安が減る。
- この変更はsource candidate lane guide表示だけで、source insert planner、drop delegate、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineSourceInsertPlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 10929）、tracker inspect、`git diff --check` も成功した（2026-06-29 02:06 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-202/TEST-210を追加し、437件の追跡行（Story 25 / Issue 202 / Test 210）、残課題3件、修正/合格434件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor候補カード/Source Bin quick dragをtimelineへdragし、source candidate lane guide detailにlanding timecodeと尺が出ること、snap/lane-lift/回避先表現とdrop cue/ghostが矛盾しないこと、drop後Viewer/playback、clip/transition drag退行なしは人間確認キューへ集約する。

### M6.5第162スライス: Source candidate drop cue duration labels

- M6.5第162スライスでは、Source Monitor候補カードやSource Bin quick dragをtimelineへdragしている時に出る `TimelineSourceCandidateDropCue` にdurationを表示するようにした。ユーザー体験としては、最終drop cueの段階でも「どのtrackの何時点へ、何秒の素材を落とすか」をmouse-up前に読める。
- `TimelineSourceCandidateDropCue` は `durationText` を受け取り、timecodeの隣に `尺Xs` を表示する。FCPX/CapCut的な素材drag/dropでは、row-wide lane guideから最終drop cueへ視線を移しても、着地時刻と素材尺が消えないことでdrop直前の確信が上がる。
- この変更はsource candidate drop cue表示だけで、source insert planner、drop delegate、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineSourceInsertPlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 35888）、tracker readback、`git diff --check` も成功した（2026-06-29 02:15 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-203/TEST-211を追加し、439件の追跡行（Story 25 / Issue 203 / Test 211）、残課題3件、修正/合格436件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor候補カード/Source Bin quick dragをtimelineへdragし、source drop cueにtrack/timecode/尺/SNAPが潰れず表示されること、lane guide/ghostと表示が矛盾しないこと、drop後Viewer/playback、clip/transition drag退行なしは人間確認キューへ集約する。

### M6.5第163スライス: Source candidate drop cue concrete snap labels

- M6.5第163スライスでは、Source Monitor候補カードやSource Bin quick dragをtimelineへdragしている時に出る `TimelineSourceCandidateDropCue` のsnap表示を、汎用の `SNAP` から具体的な `吸着 <snap.label>` に変えた。ユーザー体験としては、最終drop cueの段階で「どこに吸い付いているのか」をmouse-up前に読める。
- `TimelineSourceCandidateDropCue.snapLabel` は既存 `TimelineSourceInsertSnap.label` を表示し、edit point、playhead、marker、timeline startの既存snap意味をそのままUIへ出す。FCPX/CapCut的な素材drag/dropでは、吸い付きが偶然ではなく編集操作として理解しやすくなる。
- この変更はsource candidate drop cue表示だけで、source insert planner、drop delegate、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineSourceInsertPlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 63118）、tracker readback、`git diff --check` も成功した（2026-06-29 02:21 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-204/TEST-212を追加し、441件の追跡行（Story 25 / Issue 204 / Test 212）、残課題3件、修正/合格438件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor候補カード/Source Bin quick dragをtimelineへdragし、source drop cueに `吸着 CLP_0002 末尾`、marker名、playhead等の具体snap labelが潰れず表示されること、lane guide/ghostと表示が矛盾しないこと、drop後Viewer/playback、clip/transition drag退行なしは人間確認キューへ集約する。

### M6.5第164スライス: Source candidate drop ghost concrete snap labels

- M6.5第164スライスでは、Source Monitor候補カードやSource Bin quick dragをtimelineへdragしている時に出る `TimelineSourceCandidateDropGhost` のsnap badgeを、汎用の `SNAP` から `吸着 <snap.label>` へ変えた。ユーザー体験としては、大きいdrag ghostでも「どこに吸い付いているのか」をdrop cueへ近づく前から読める。
- `TimelineSourceCandidateDropGhost.snapBadgeText` は既存 `TimelineSourceInsertSnap.label` を表示し、ghost幅が150pt以上なら具体label、96pt以上なら短い `吸着` にfallbackする。FCPX/CapCut的な素材drag/dropでは、大きいghostと最終drop cueの磁気説明が揃うことで、吸い付きが偶然ではなく編集操作として理解しやすくなる。
- この変更はsource candidate drop ghost表示だけで、source insert planner、drop delegate、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineSourceInsertPlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 83763）、tracker readback、`git diff --check` も成功した（2026-06-29 02:26 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-205/TEST-213を追加し、443件の追跡行（Story 25 / Issue 205 / Test 213）、残課題3件、修正/合格440件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor候補カード/Source Bin quick dragをtimelineへdragし、source drop ghostに `吸着 CLP_0002 末尾`、marker名、playhead等の具体snap labelが潰れず表示されること、短いclipでは `吸着` にfallbackして崩れないこと、final drop cue/lane guideと表示が矛盾しないこと、drop後Viewer/playback、clip/transition drag退行なしは人間確認キューへ集約する。

### M6.5第165スライス: Source candidate lane guide concrete snap labels

- M6.5第165スライスでは、Source Monitor候補カードやSource Bin quick dragをtimelineへdragしている時に出る `TimelineSourceCandidateLaneDropGuide` のdetailを、汎用の `近い編集点へ吸着` から具体的な `吸着 <snap.label>` に変えた。ユーザー体験としては、row-wideな受け皿表示の段階でも「どこに吸い付いているのか」を読める。
- `TimelineTrackRow.sourceCandidateSnapSummary(_:)` は既存 `TimelineSourceInsertSnap.label` を表示し、snapなしでは `その位置へ追加` を維持する。FCPX/CapCut的な素材drag/dropでは、lane guide、drag ghost、final drop cueの磁気説明が揃うことで、吸い付きが偶然ではなく編集操作として理解しやすくなる。
- この変更はsource candidate lane guide表示だけで、source insert planner、drop delegate、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineSourceInsertPlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 4181）、tracker readback、`git diff --check` も成功した（2026-06-29 02:30 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-206/TEST-214を追加し、445件の追跡行（Story 25 / Issue 206 / Test 214）、残課題3件、修正/合格442件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor候補カード/Source Bin quick dragをtimelineへdragし、source candidate lane guideに `吸着 CLP_0002 末尾`、marker名、playhead等の具体snap labelが表示されること、ghost/final drop cueと表示が矛盾しないこと、drop後Viewer/playback、clip/transition drag退行なしは人間確認キューへ集約する。

### M6.5第166スライス: Overview scrub concrete snap labels

- M6.5第166スライスでは、Timeline overview stripで再生位置をドラッグしている時に出る `TimelineOverviewScrubBadge` のsnap表示を、汎用の `SNAP` から `吸着 <snap.label>` に変えた。ユーザー体験としては、全体俯瞰から大きくplayheadを動かす時も「どこに吸い付いているのか」を画面上で読める。
- `TimelineOverviewScrubBadge` は既存 `TimelinePlayheadScrubSnap.label` を表示し、snap中のbadge幅と `TimelineOverviewStrip.scrubBadgeOffset(for:hasSnap:)` のclamp幅を172ptに広げる。FCPX/CapCut的なoverview navigationでは、rail/helpだけでなくbadge自体に吸着先が出ることで、playhead移動の確信が上がる。
- この変更はoverview scrub badge表示だけで、scrub resolver、timeline operation、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineViewportScaleTests` は15 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 29533）、tracker readback、`git diff --check` も成功した（2026-06-29 02:37 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-207/TEST-215を追加し、447件の追跡行（Story 25 / Issue 207 / Test 215）、残課題3件、修正/合格444件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでOverview stripをedit point、marker、timeline先頭/末尾付近へdragし、overview scrub badgeに具体snap labelが潰れず表示されること、overview端でbadgeがclampされること、ruler/lane scrub、clip/source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第167スライス: Ruler scrub concrete snap labels

- M6.5第167スライスでは、Timeline ruler上で再生位置をドラッグしている時に出るscrub badgeを、timecodeだけの表示から `吸着 <snap.label>` も読める `TimelineRulerScrubBadge` に変えた。ユーザー体験としては、詳細timeline上でplayheadを動かす時も「どこに吸い付いているのか」を画面上で読める。
- `TimelineRulerScrubBadge` は既存 `TimelinePlayheadScrubSnap.label` を表示し、snap中のbadge幅と `TimelineRuler.scrubBadgeOffset(for:hasSnap:width:)` のclamp幅を172ptに広げる。FCPX/CapCut的なruler navigationでは、hover helpだけでなくbadge自体に吸着先が出ることで、細いruler上でもplayhead移動の確信が上がる。
- この変更はruler scrub badge表示だけで、scrub resolver、timeline operation、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineViewportScaleTests` は15 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 60722）、tracker readback、`git diff --check` も成功した（2026-06-29 02:44 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-208/TEST-216を追加し、449件の追跡行（Story 25 / Issue 208 / Test 216）、残課題3件、修正/合格446件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでRulerをedit point、marker、timeline先頭/末尾付近へdragし、ruler scrub badgeに具体snap labelが潰れず表示されること、ruler端でbadgeがclampされること、overview/lane scrub、clip/source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第168スライス: Lane scrub concrete snap labels

- M6.5第168スライスでは、timeline lane上で再生位置をドラッグしている時に出る `TimelineLaneScrubBadge` を、timecodeだけの表示から `吸着 <snap.label>` も読める表示に変えた。ユーザー体験としては、clip lane上で直接playheadを動かす時も「どこに吸い付いているのか」を画面上で読める。
- `TimelineLaneScrubBadge` は既存 `TimelinePlayheadScrubSnap.label` を受け取り、snap中のbadge幅と `TimelineTrackRow.laneScrubBadgeOffset(for:hasSnap:)` のclamp幅を172ptに広げる。FCPX/CapCut的なlane navigationでは、rail/helpだけでなくbadge自体に吸着先が出ることで、細いclip lane上でもplayhead移動の確信が上がる。
- この変更はlane scrub badge表示だけで、scrub resolver、timeline operation、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineViewportScaleTests` は15 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 90543）、tracker readback、`git diff --check` も成功した（2026-06-29 02:49 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-209/TEST-217を追加し、451件の追跡行（Story 25 / Issue 209 / Test 217）、残課題3件、修正/合格448件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtimeline laneをedit point、marker、timeline先頭/末尾付近へdragし、lane scrub badgeに具体snap labelが潰れず表示されること、lane端でbadgeがclampされること、overview/ruler scrub、clip/source/transition drag退行なしは人間確認キューへ集約する。

### M6.5第169スライス: Transition magnet cue title timecodes

- M6.5第169スライスでは、transition preset drag、recommended edit point hover、transition moveのdrop直前に出る `TimelineTransitionDropMagnetCue` のtitleへ `@ <timecode>` を追加した。ユーザー体験としては、候補cueやdetailまで目を移さなくても、最も目立つmagnet cue上段で「どの編集点時刻へ吸着するか」を読める。
- `TimelineTransitionDropTarget.dropMagnetCue` は `targetTimecode` を使い、lane-nearest preset drop、recommended preset drop、hover preview/apply、existing transition moveのtitleへtarget timecodeを入れる。FCPX/CapCut的なtransition drag/dropでは、drop直前の強いmagnet表示自体がedit point時刻を持つことで、細い編集点へ落とす不安が減る。
- この変更はtransition magnet cue title表示、cue幅、title/detailのminimumScaleFactorだけで、drop resolver、`TimelineTransitionDropPlan`、drop delegate、timeline operation、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は23 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 17588）、tracker readback、`git diff --check` も成功した（2026-06-29 02:54 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-210/TEST-218を追加し、453件の追跡行（Story 25 / Issue 210 / Test 218）、残課題3件、修正/合格450件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtransition preset dragと既存transition moveを試し、magnet cue titleに具体 `@ timecode` が出ること、長い日本語preset名でも読めること、candidate cue、lane guide、click apply、Command-T、duration drag、clip/source drag退行なしは人間確認キューへ集約する。

### M6.5第170スライス: Transition lane guide primary target labels

- M6.5第170スライスでは、transition preset/既存transition moveをtimeline laneへdragした時に出る `TimelineTransitionLaneDropGuide` のdetailへ `最寄り @ <timecode> <from>→<to>` を追加した。ユーザー体験としては、magnet cueに近づく前のrow-wideな受け皿表示でも、現在向かっているedit pointと時刻を読める。
- `TimelineTrackRow.transitionLaneDropGuide` は `transitionLanePrimaryTargetText(for:targetID:)` を使い、hover位置で解決された `activeLaneTransitionPresetTargetID` / `activeLaneTransitionMoveTargetID` があればそのtarget、なければ先頭候補を表示する。FCPX/CapCut的なtransition drag/dropでは、row-wide guide、candidate cue、magnet cueが同じedit point時刻の文脈でつながることで、細い編集点へ落とす不安が減る。
- この変更はtransition lane guide detail表示だけで、drop resolver、`TimelineTransitionDropPlan`、drop delegate、timeline operation、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は23 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 43062）、tracker readback、`git diff --check` も成功した（2026-06-29 03:00 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-211/TEST-219を追加し、455件の追跡行（Story 25 / Issue 211 / Test 219）、残課題3件、修正/合格452件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtransition preset dragと既存transition moveをtimeline laneへ入れ、row-wide lane guideに最寄りedit point/timecodeが出ること、hoverに合わせて更新されること、candidate cue、magnet cue、click apply、Command-T、duration drag、clip/source drag退行なしは人間確認キューへ集約する。

### M6.5第171スライス: Transition lane snap indicator rails

- M6.5第171スライスでは、transition preset/既存transition moveをtimeline laneへdragしている時、解決済みの最寄りedit pointへ `TimelineTransitionDropSnapIndicator` を表示するようにした。ユーザー体験としては、row-wide lane guideの説明だけでなく、レーン全体を貫く縦railとtimecode badgeで「ここへ吸い付く」が見える。
- `TimelineTrackRow.activeTransitionLaneSnapTarget` は既存の `activeLaneTransitionPresetTargetID` / `activeLaneTransitionMoveTargetID` を使い、preset dropはaccentのmagnet rail、transition moveはorangeのmove railとして表示する。FCPX/CapCut的なtransition drag/dropでは、細いedit point targetだけに頼らず、row-wide guide、vertical rail、candidate cue、magnet cueが同じ吸着先を指すことでmouse-up前の確信が上がる。
- この変更はtransition lane snap indicator表示だけで、drop resolver、`TimelineTransitionDropPlan`、drop delegate、timeline operation、timeline.json、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests` は23 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 89287）、tracker readback、`git diff --check` も成功した（2026-06-29 03:11 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-212/TEST-220を追加し、457件の追跡行（Story 25 / Issue 212 / Test 220）、残課題3件、修正/合格454件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtransition preset dragと既存transition moveをtimeline laneへ入れ、nearest edit pointに縦magnet rail/timecode badgeが出ること、row内移動に追従すること、candidate cue、magnet cue、click apply、Command-T、duration drag、clip/source drag退行なしは人間確認キューへ集約する。

### M6.5第172スライス: Visible Source Monitor append action

- M6.5第172スライスでは、Source Monitorの主要action rowに `末尾` ボタンを追加した。ユーザー体験としては、FCPXのE append相当の「素材をタイムライン末尾へ送る」操作を、ショートカットやCommand Paletteを覚える前でも画面上から発見できる。
- `MediaPanel` のSource Monitor action rowは既存の `appendSourceMonitorToTimelineEnd()`、`canAppendSourceMonitorToTimelineEnd`、`sourceMonitorAppendHelp` をそのまま使う。FCPX/CapCut的なsource workflowでは、`追加`、`末尾`、`上書き`、`置換` が同じ場所に並ぶことで、素材選定後にどの編集方式でtimelineへ入れるかを直感的に選べる。
- この変更はSource Monitor action rowの表示だけで、既存のappend plan、marked source range override、即時in-memory timeline update、選択、playhead seek、未保存Studio修正ライフサイクル、source insert planner、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineSourceInsertPlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 17731）、tracker readback、`git diff --check` も成功した（2026-06-29 03:18 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-213/TEST-221を追加し、459件の追跡行（Story 25 / Issue 213 / Test 221）、残課題3件、修正/合格456件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitorに `追加 / 末尾 / 上書き / 置換` がクリップせず並ぶこと、`末尾` でmarked rangeがsequence endへ追加されること、既存のW/D/R/E shortcuts、source drag/drop、clip/transition drag退行なしは人間確認キューへ集約する。

### M6.5第173スライス: Adaptive Source Monitor action row

- M6.5第173スライスでは、Source Monitorの主要action rowを `SourceMonitorActionRow` に分離し、`ViewThatFits` で1段表示と2段fallbackを切り替えるようにした。ユーザー体験としては、右側inspectorが狭い時でも `追加 / 末尾 / 上書き / 置換 / 戻る` の操作がクリップせず、素材確認からtimeline投入へ迷わず進める。
- `SourceMonitorActionRow` は既存の `insertSourceMonitorAtPlayhead()`、`appendSourceMonitorToTimelineEnd()`、`overwriteSourceMonitorAtPlayhead()`、`replaceSelectedClipWithSourceMonitorCandidate()`、`clearSourceMonitorAsset()` と各enabled state/help/accessibility identifierをそのまま使う。FCPX/CapCut的なsource workflowでは、編集方式の選択肢が狭いpanelでも欠けないことが、ショートカット未習熟ユーザーとNLE経験者の両方に効く。
- この変更はSource Monitor action rowのレイアウトだけで、既存のsource insert/append/overwrite/replace plan、marked source range override、即時in-memory timeline update、未保存Studio修正ライフサイクル、source insert planner、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineSourceInsertPlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 58810）、tracker readback、`git diff --check` も成功した（2026-06-29 03:27 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-214/TEST-222を追加し、461件の追跡行（Story 25 / Issue 214 / Test 222）、残課題3件、修正/合格458件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitorの右panel幅を狭めても `追加 / 末尾 / 上書き / 置換 / 戻る` が1段または2段で読めること、各ボタンがクリック可能でhelp/accessibilityが維持されること、`末尾` append、W/D/R/E shortcuts、source drag/drop、clip/transition drag退行なしは人間確認キューへ集約する。

### M6.5第174スライス: Source Monitor shortcut hint badges

- M6.5第174スライスでは、Source Monitorの主要編集ボタンに `W` / `E` / `D` / `R` の小さなshortcut badgeを追加した。ユーザー体験としては、FCPXのinsert/append/overwriteに近いsource-to-timeline操作を、Command Paletteやtooltipを開く前にpanel内で見つけられる。
- `SourceMonitorActionRow.sourceActionLabel` は `追加 W`、`末尾 E`、`上書き D`、`置換 R` をbutton label内に表示する。既存の hidden `SourceMonitorShortcutButtons`、Command Palette、focus-gated keyboard shortcuts、button action、enabled state、help、accessibility identifierはそのまま使う。
- この変更はSource Monitor action rowの表示だけで、source insert/append/overwrite/replace plan、marked source range override、即時in-memory timeline update、未保存Studio修正ライフサイクル、source insert planner、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineSourceInsertPlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 83390）、tracker readback、`git diff --check` も成功した（2026-06-29 03:33 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-215/TEST-223を追加し、463件の追跡行（Story 25 / Issue 215 / Test 223）、残課題3件、修正/合格460件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitorの `追加 / 末尾 / 上書き / 置換` にW/E/D/R badgeが読みやすく出ること、2段fallbackでもbadgeが潰れないこと、実際のW/E/D/R shortcuts、button click、source drag/drop、clip/transition drag退行なしは人間確認キューへ集約する。

### M6.5第175スライス: Adaptive Source marked-range controls

- M6.5第175スライスでは、Source Monitorのmarked-range control rowを `SourceMarkedRangeControls` に分離し、`ViewThatFits` で1段表示と2段fallbackを切り替えるようにした。ユーザー体験としては、狭い右panelでも `候補範囲/マーク範囲`、現在source時刻、`I`/`O` mark、IN/OUT nudge、resetが欠けずに読める。
- `SourceMarkedRangeControls` は既存の `markSourceMonitorInAtPlaybackTime()`、`markSourceMonitorOutAtPlaybackTime()`、`nudgeSourceMonitorMarkIn/Out`、`resetSourceMonitorMarkedRange()` と各disabled state/help/accessibility identifierをそのまま使う。FCPX/CapCut的なsource workflowでは、source rangeを決める操作がclip insert/append/overwrite/replaceの手前で崩れないことが、荒編集後の手動微調整に効く。
- この変更はSource Monitor marked-range controlsのレイアウトだけで、source range plan、marked source range override、source insert/drop/replace/overwrite operation、review patch schema、compiler schema、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter TimelineSourceInsertPlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 22277）、tracker readback、`git diff --check` も成功した（2026-06-29 03:40 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-216/TEST-224を追加し、465件の追跡行（Story 25 / Issue 216 / Test 224）、残課題3件、修正/合格462件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitorの右panel幅を狭めても marked-range summary と I/O/IN-/IN+/OUT-/OUT+/reset controls が1段または2段で読めること、各ボタンがクリック可能でhelp/accessibilityが維持されること、I/O shortcuts、source marked insert/append/overwrite/replace、source drag/drop、clip/transition drag退行なしは人間確認キューへ集約する。

### M6.5第176スライス: Source candidate navigation shortcuts

- M6.5第176スライスでは、Source Monitorのselect候補ヘッダーに `[` / `]` hintを追加し、Source Monitor focus中の `[` / `]` で前後候補へ移動できるようにした。ユーザー体験としては、小さいchevronを狙わなくても、候補素材を見比べながらsource-to-timeline操作へ移れる。
- `SourceMonitorShortcutButtons` は既存の `selectPreviousSourceMonitorCandidate()` / `selectNextSourceMonitorCandidate()` と `canSelectPreviousSourceMonitorCandidate` / `canSelectNextSourceMonitorCandidate` を使う。`MediaPanel.SourceCandidatePreviousButton` / `MediaPanel.SourceCandidateNextButton` は既存action、disabled state、accessibility identifierを維持し、button labelとhelpだけに shortcut hint を足した。FCPX/CapCut的なsource workflowでは、素材候補の確認からinsert/append/overwrite/replaceへ進む反復操作を、mouse travelなしで続けられることが効く。
- この変更はSource Monitor candidate navigation affordanceだけで、source insert/drop planner、marked source range、review patch schema、compiler schema、timeline operation、Viewer preview pathには触れていない。timeline focus中の `[` / `]` clip nudge shortcutとは既存のfocus gateで分離する。
- `swift test --package-path apps/macos-studio --filter TimelineSourceInsertPlanTests` は24 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 60878）、tracker readback、`git diff --check` も成功した（2026-06-29 03:48 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-217/TEST-225を追加し、467件の追跡行（Story 25 / Issue 217 / Test 225）、残課題3件、修正/合格464件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor focus中の `[` / `]` がselect候補を前後移動すること、候補ヘッダーの `[` / `]` hintが読みやすいこと、timeline focus中の `[` / `]` は従来どおり選択clip nudgeになること、W/E/D/R、source drag/drop、clip/transition drag退行なしは人間確認キューへ集約する。

### M6.5第177スライス: Source candidate navigation command palette

- M6.5第177スライスでは、Source Monitorのselect候補前後移動をCommand Paletteにも追加した。ユーザー体験としては、`[` / `]` shortcutを覚えていない初回ユーザーでも、`source candidate previous/next` や `ソース 候補 前/次` で同じ候補レビュー操作へ辿り着ける。
- `StudioCommandPaletteCommand` は `selectPreviousSourceMonitorCandidate` / `selectNextSourceMonitorCandidate` をstable catalogへ追加し、localized title、SF Symbol、search keywords、unique accessibility identifierを持つ。`ContentView` の `StudioCommandPaletteItem` は既存 `model.canSelectPreviousSourceMonitorCandidate` / `model.canSelectNextSourceMonitorCandidate` と `selectPreviousSourceMonitorCandidate()` / `selectNextSourceMonitorCandidate()` を使い、Source Monitor未表示と候補端のdisabled copyを分ける。FCPX/CapCut的なsource workflowでは、visible button、focus shortcut、Command Paletteが同じ操作に収束することで学習コストが下がる。
- この変更はCommand Palette exposureだけで、source insert/drop planner、marked source range、review patch schema、compiler schema、timeline operation、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests` は5 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 93389）、tracker readback、`git diff --check` も成功した（2026-06-29 03:55 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-218/TEST-226を追加し、469件の追跡行（Story 25 / Issue 218 / Test 226）、残課題3件、修正/合格466件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでCommand Paletteから `source candidate previous/next`、`ソース 候補 前/次` を検索できること、候補端やSource Monitor未表示時のdisabled copyが分かること、visible [ / ] buttonsとfocus shortcutsと同じ候補移動になることは人間確認キューへ集約する。

### M6.5第178スライス: Source marked-range command palette

- M6.5第178スライスでは、Source Monitorのmarked range微調整をCommand Paletteにも追加した。ユーザー体験としては、panel上の小さい `IN-` / `IN+` / `OUT-` / `OUT+` / reset ボタンを探さなくても、`source in nudge earlier`、`source out nudge later`、`ソース 範囲 リセット` などで候補投入前のsource rangeを調整できる。
- `StudioCommandPaletteCommand` は `nudgeSourceMonitorMarkInEarlier` / `nudgeSourceMonitorMarkInLater` / `nudgeSourceMonitorMarkOutEarlier` / `nudgeSourceMonitorMarkOutLater` / `resetSourceMonitorMarkedRange` をstable catalogへ追加し、localized title、SF Symbol、search keywords、unique accessibility identifierを持つ。`ContentView` の `StudioCommandPaletteItem` は既存 `nudgeSourceMonitorMarkIn(by:)` / `nudgeSourceMonitorMarkOut(by:)` / `resetSourceMonitorMarkedRange()` を使い、Source Monitor未表示、select候補なし、境界到達のdisabled copyを分ける。FCPX/CapCut的なsource workflowでは、visible marked-range controls、focus shortcuts、Command Paletteが同じrange操作に収束することで、素材をtimelineへ入れる直前の微調整が発見しやすくなる。
- `StudioViewModel` には Palette disabled state用の `canNudgeSourceMonitorMarkInEarlier/Later`、`canNudgeSourceMonitorMarkOutEarlier/Later`、`canResetSourceMonitorMarkedRange` を追加した。これは既存 `sourceMonitorInsertCandidateSummary` の状態を読むだけで、source insert/drop planner、marked source range calculation、review patch schema、compiler schema、timeline operation、Viewer preview pathには触れていない。
- `swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests` は5 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 22537）、tracker readback、`git diff --check` も成功した（2026-06-29 04:03 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-219/TEST-227を追加し、471件の追跡行（Story 25 / Issue 219 / Test 227）、残課題3件、修正/合格468件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでCommand Paletteから source IN/OUT nudge と source range reset を検索できること、Source Monitor未表示/select候補なし/範囲境界到達時のdisabled copyが分かること、visible marked-range controls、source drag/drop、source insert/append/overwrite/replaceが同じmarked rangeを使うことは人間確認キューへ集約する。

### M6.5第179スライス: Source marked-range keyboard shortcuts

- M6.5第179スライスでは、Source Monitor focus中のmarked range微調整に keyboard shortcut を追加した。ユーザー体験としては、Source Monitorで素材を見ながら `⌥[` / `⌥]` でINを0.5秒単位で戻す/送る、`⇧⌥[` / `⇧⌥]` でOUTを詰める/伸ばす、`⇧R` で候補範囲へ戻す、という反復操作がbuttonやPaletteへ手を伸ばさず続けられる。
- `SourceMonitorShortcutButtons` は既存のfocus gateを使い、Source Monitorに素材がある時だけ nudge/reset shortcut を受ける。`MediaPanel.SourceMarkedRangeControls` は `IN- ⌥[`、`IN+ ⌥]`、`OUT- ⇧⌥[`、`OUT+ ⇧⌥]`、reset `⇧R` のhintをbutton label/helpへ追加した。`StudioCommandPaletteCommand` のkeywordsと `ContentView.commandItems` subtitleにも同じshortcut表記を追加し、Palette検索とpanel学習を揃えた。FCPX/CapCut的なsource workflowでは、source range確認、I/O mark、0.5秒単位の微調整、insert/append/overwrite/replaceがkeyboard loopに入ることで、AIが選んだ素材を人間が詰める速度が上がる。
- この変更はSource Monitor focus shortcut routing、panel hint、Command Palette copy/search語だけで、source insert/drop planner、marked source range calculation、review patch schema、compiler schema、timeline operation、Viewer preview pathには触れていない。timeline focus中の `[` / `]` clip nudge、Source Monitor focus中の `[` / `]` candidate navigation、W/E/D/R source edit shortcutsとはmodifierで分ける。
- `swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests` は5 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 57825）、tracker readback、`git diff --check` も成功した（2026-06-29 04:11 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-220/TEST-228を追加し、473件の追跡行（Story 25 / Issue 220 / Test 228）、残課題3件、修正/合格470件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor focus中の `⌥[` / `⌥]` / `⇧⌥[` / `⇧⌥]` / `⇧R` がIN/OUT nudge/resetになること、panel hintが狭幅/広幅で読めること、Command Paletteでshortcut検索できること、timeline focus中の `[` / `]` clip nudgeやSource Monitor focus中の `[` / `]` candidate navigation、W/E/D/R source edit退行なしは人間確認キューへ集約する。

### M6.5第180スライス: Source Monitor transport keyboard loop

- M6.5第180スライスでは、Source Monitor focus中にも `Space` / `J` / `K` / `L` のtransport shortcutを追加した。ユーザー体験としては、素材候補をSource Monitorで見ている間に、Timelineへfocusを戻したりmouseでTransport buttonを押したりせず、逆再生、停止、順再生、再生/一時停止を続けられる。
- `SourceMonitorShortcutButtons` は既存のfocus gateを使い、Source Monitorに素材がある時だけ `togglePlayback()`、`playReverseShuttle()`、`pausePlayback()`、`playForwardShuttle()` を受ける。`StudioCommandPaletteCommand` は既存transport commandのkeywordsへ `source monitor` / `source` / `monitor` を追加し、`ContentView.commandItems` subtitleもTimelineまたはSource Monitor focusで使える説明へ変えた。FCPX/CapCut的なsource workflowでは、素材確認、I/O mark、range nudge、candidate切替、W/E/D/R投入までの反復が同じkeyboard loopに入り、AIが選んだ素材を人間が詰める速度が上がる。
- この変更はSource Monitor focus transport shortcut routingとCommand Palette copy/search語だけで、source insert/drop planner、marked source range calculation、review patch schema、compiler schema、timeline operation、Viewer preview pathには触れていない。Source Monitor内のI/O mark、range nudge/reset、`[` / `]` candidate navigation、W/E/D/R source edit shortcutsは既存経路を維持する。`,` / `.` のsource frame stepはsource-time seekを伴う別スライスとして残す。
- `swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests` は5 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 87997）、tracker readback、`git diff --check` も成功した（2026-06-29 04:18 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-221/TEST-229を追加し、475件の追跡行（Story 25 / Issue 221 / Test 229）、残課題3件、修正/合格472件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor focus中の `J` / `K` / `L` / `Space` がsource playbackを操作すること、playback rate badgeと現在source時刻がI/O markに使えること、timeline focus transport、Source Monitor I/O/range shortcuts、`[` / `]` candidate navigation、W/E/D/R source edit退行なしは人間確認キューへ集約する。

### M6.5第181スライス: Source Monitor source-time frame step

- M6.5第181スライスでは、Source Monitor focus中にも `,` / `.` の1フレームstepを追加した。ユーザー体験としては、素材候補のIN/OUTを詰める時にTimelineへ戻らず、source時刻を1フレームずつ確認して、その位置をI/Oマークに使える。
- `StudioViewModel.stepBackward()` / `stepForward()` は `sourceMonitorAssetID != nil` の時だけ `stepSourceMonitor(byFrames:)` へ分岐する。`sourceMonitorStepTarget(byFrames:)` は選択中source candidateの `src_in_us` / `src_out_us` へclampし、timeline fpsが取れる場合はそのfpsの1 frame幅、取れない場合は30fps相当でfail-openする。`sourceMonitorMediaReference` は `sourceMonitorPreviewTimeUS` を `ProjectMediaResolver.resolvePreviewStatus` へ渡すので、step後の `sourceMonitorPlaybackSourceUS` がViewer seekにも反映される。FCPX/CapCut的なsource workflowでは、transport、frame-step、I/O mark、marked range、source-to-timeline editが同じSource Monitor keyboard loopに揃うことが効く。
- `SourceMonitorShortcutButtons` は既存focus gateを使い、Source Monitorに素材がありcandidate範囲内でstepできる時だけ `,` / `.` を受ける。`StudioCommandPaletteCommand` と `ContentView.commandItems` は既存のtimeline frame-step commandをSource Monitorでも見つかるcopy/keywordsへ更新した。この変更はSource Monitor source-time step routing、Viewer preview-time wiring、Command Palette copy/search語だけで、source insert/drop planner、marked source range calculation、review patch schema、compiler schema、timeline operation patch contractには触れていない。
- `swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests` は5 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 38388）、tracker readback、`git diff --check` も成功した（2026-06-29 04:28 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-222/TEST-230を追加し、477件の追跡行（Story 25 / Issue 222 / Test 230）、残課題3件、修正/合格474件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor focus中の `,` / `.` がselected candidate範囲内でViewerを1フレームseekすること、stepped source timeでI/O markできること、候補先頭/末尾のclamp statusが分かること、timeline focus中の `,` / `.`、Source Monitorの `J` / `K` / `L` / `Space`、I/O/range shortcuts、`[` / `]` candidate navigation、W/E/D/R source edit退行なしは人間確認キューへ集約する。

### M6.5第182スライス: Agent consultation direct commands

- M6.5第182スライスでは、Timeline選択から4つのAgent相談intentへ直接入るCommand Palette commandを追加した。ユーザー体験としては、clipやtransitionを選んだまま `agent tighten`、`ビート 短く`、`代替 素材`、`カット 説明` で、Agent panelのpickerを探さずに読み取り専用相談を準備/実行できる。
- `StudioCommandPaletteCommand` は `runAgentTightenSelection` / `runAgentShortenBeat` / `runAgentFindStrongerAlternate` / `runAgentExplainCut` をstable catalogへ追加した。`ContentView.commandItems` は `canPrepareTimelineAgentPrompt` と `appServerStatus` を使ってdisabled stateを分け、実行時は `prepareAndRunTimelineSelectionAgentPrompt(intent:)` を呼ぶ。`StudioViewModel` の新helperは指定intentを `selectedTimelineAgentIntent` に入れて既存のprompt prepare/run pathを再利用する。AI Agent統合編集ソフトとしては、手動timeline操作の文脈から、編集判断の相談だけを即座に投げられ、timeline mutationはstructured patchのpreview/applyまで分離されることが効く。
- この変更はCommand Palette exposureと `selectedTimelineAgentIntent` routingだけで、Agent prompt schema、structured `review_patch` detection/apply、timeline operation patch contract、compiler schema、timeline artifactsには触れていない。Agent sessionがなければ既存挙動どおりprompt/status準備で止まり、sessionがあれば読み取り専用turnを実行する。
- `swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests` は5 tests / 0 failuresで成功した。`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 78146）、tracker readback、`git diff --check` も成功した（2026-06-29 04:36 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-223/TEST-231を追加し、479件の追跡行（Story 25 / Issue 223 / Test 231）、残課題3件、修正/合格476件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでCommand Paletteから4つのAI相談commandを検索できること、clip/transition選択contextがpromptへ反映されること、Agent sessionあり/なしのstatus copyが分かること、structured patch適用前にtimeline/unsaved editが増えないこと、既存Agent panel picker/run/pin/review-patch draft導線退行なしは人間確認キューへ集約する。

### M6.5第183スライス: Clip body drag begins selection

- M6.5第183スライスでは、Timeline上の未選択clipを本体dragした瞬間に、そのclipをprimary selectionへ切り替える経路を追加した。ユーザー体験としては、clipを先にクリックしてから移動するのではなく、掴んだclipがそのまま操作対象としてtoolbar/Viewer文脈に入る。
- `TimelineViews.clipMoveDragGesture` はbody領域で最初にdragが始まった時だけ `onBeginClipBodyDrag` を呼ぶ。`ContentView` はこのcallbackを `StudioViewModel.beginTimelineClipBodyDrag(_:)` へ配線し、`timelineFocused` も立てる。ViewModel側はsource monitor、selected transition、transition/trim/roll/slip/skim previewsをクリアし、未選択clipなら単独選択へ切り替え、既存multi-selection内のclipならgroup selectionは維持したままprimaryだけ更新する。
- FCPX/CapCut的なdirect manipulationでは、drag前に明示的な選択クリックを要求しないこと、掴んだ瞬間に操作対象と表示文脈が揃うこと、かつplayhead/snap contextが不用意に変わらないことが重要。この変更はdrag開始時にplayheadを動かさず、`TimelineClipMovePlan`、timeline operation patch contract、compiler schema、review patch schemaには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter TimelineClipMovePlanTests`（24 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 18668）、tracker readback、`git diff --check` は成功した（2026-06-29 04:45 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-224/TEST-232を追加し、481件の追跡行（Story 25 / Issue 224 / Test 232）、残課題3件、修正/合格478件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで未選択clip本体をdragすると即座にそのclipが選択されtoolbar/Viewer文脈が切り替わること、選択済みmulti-clip group内のclipをdragするとgroup moveが維持されること、drag開始でplayheadがjumpしないこと、trim handle/roll/slip gestureがbody drag selectionに奪われないこと、source/transition transient previewがclip drag開始で消えることは人間確認キューへ集約する。

### M6.5第184スライス: Transition duration drag begins selection

- M6.5第184スライスでは、適用済みtransitionの左右duration領域をdragし始めた瞬間に、そのtransitionを選択文脈へ同期する経路を追加した。ユーザー体験としては、transitionを先にclickしてから調整するのではなく、掴んだtransitionがそのまま選択対象になり、clip/sourceではなくtransitionの長さ調整として読める。
- `TimelineTransitionDropTarget.durationDragGesture` は既存transitionの有効なduration drag開始時に `hasBegunDurationDrag` を立て、最初のdrag eventで `selectTransitionIfPresent()` を呼ぶ。これにより、frame deltaが0の初期dragでもtransition selectionが先に切り替わり、deltaが出た時だけ既存のduration preview / Viewer overlay pathへ進む。
- `StudioViewModel.selectTimelineTransition(...)` はSource Monitor contextを `clearSourceMonitorAsset(updateStatus: false)` で外すようにした。FCPX/CapCut的なdirect manipulationでは、transitionの本体調整を始めた瞬間にselection、toolbar summary、Viewer overlayの文脈が同じ対象へ揃うことが重要。この変更はSwiftUI duration drag begin stateとselection cleanupだけで、`TimelineTransitionDropPlan`、timeline operation patch contract、compiler schema、review patch schemaには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests`（23 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 45859）、tracker readback、`git diff --check` は成功した（2026-06-29 04:52 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-225/TEST-233を追加し、483件の追跡行（Story 25 / Issue 225 / Test 233）、残課題3件、修正/合格480件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで既存transitionのduration領域をdragし始めると即座にtransitionが選択されること、clip/source contextが消えること、drag開始でplayheadがjumpしないこと、非ゼロdragではduration preview badgeとViewer overlayが従来通り出ること、transition move-handle dragとedit-point click-to-applyが退行しないことは人間確認キューへ集約する。

### M6.5第185スライス: Transition move-handle drag begins selection

- M6.5第185スライスでは、適用済みtransitionの中央move handleをdragし始めた瞬間に、そのtransitionを選択文脈へ同期する経路を追加した。ユーザー体験としては、transitionを先にclickしてから移動するのではなく、掴んだtransitionがそのまま移動対象になり、relocation guideやtoolbar feedbackも同じtransition文脈で読める。
- `TimelineTransitionDropTarget` の `TimelineTransitionMoveHandle.onDrag` は、`onBeginTransitionMoveDrag(existingTransition.id)` の前に `selectTransitionIfPresent()` を呼ぶようにした。これにより、既存のtransition selection pathを再利用し、Source Monitor context cleanupも含めた状態同期をrelocation drag stateより先に済ませる。
- FCPX/CapCut的なdirect manipulationでは、transitionの長さ調整だけでなく、transition自体を別の編集点へ移す操作でも、掴んだ対象が即座に選択対象へ変わることが重要。この変更はSwiftUI move-handle drag begin selection callだけで、`TimelineTransitionDropPlan`、timeline operation patch contract、compiler schema、review patch schemaには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter TimelineTransitionDropPlanTests`（23 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 68856）、tracker readback、`git diff --check` は成功した（2026-06-29 04:58 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-226/TEST-234を追加し、485件の追跡行（Story 25 / Issue 226 / Test 234）、残課題3件、修正/合格482件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで既存transitionの中央move handleをdragし始めると即座にtransitionが選択されること、clip/source contextが消えること、relocation guideとmagnetic target cueが出ること、drag開始でplayheadがjumpしないこと、duration dragとedit-point click-to-applyが退行しないことは人間確認キューへ集約する。

### M6.5第186スライス: Timeline Agent consultation preview context

- M6.5第186スライスでは、Timeline選択からAIへ相談する前に、Agent Panel内で相談対象と安全境界が読めるpreview summaryを追加した。ユーザー体験としては、clipやtransitionを選んだ状態で、AIに何が渡るか、どの相談intentか、タイムラインが勝手に変更されないかをプロンプト生成前に確認できる。
- `StudioViewModel.timelineAgentConsultationPreviewLabel` は選択clip数、timecode range、選択transitionのtype/duration/from-to、選択中の `TimelineAgentConsultationIntent.localizedTitle`、読み取り専用状態を1行でまとめる。`timelineAgentConsultationContractLabel` は、ファイルを変更せず、提案はPREVIEWで、反映は `review_patch` 確認後に行うことを明示する。`AgentPanel` はこのsummaryとcontractを `相談プレビュー` として `TextEditor` より前に表示する。
- AI Agent統合編集ソフトとしては、手動timeline操作の文脈からAI相談へ入れるだけでなく、AIが即座に編集を確定しないこと、提案が人間レビュー可能なpreview/apply loopに分離されていることがUI上で分かる必要がある。この変更は表示summaryとlocalized title共有だけで、Agent prompt schema、structured `review_patch` detection/apply、timeline operation patch contract、compiler schema、timeline artifactsには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter TimelineAgentConsultationPromptTests`（5 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 8907）、tracker readback、`git diff --check` は成功した（2026-06-29 05:05 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-227/TEST-235を追加し、487件の追跡行（Story 25 / Issue 227 / Test 235）、残課題3件、修正/合格484件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでclip/transition選択に応じてAgentPanelの相談プレビューが更新されること、intent picker変更でpreview intent textが変わること、read-only/PREVIEW contractが狭幅でも読めること、prompt生成が既存のreview_patch契約を維持すること、相談準備だけではtimeline/manual edit stateが増えないことは人間確認キューへ集約する。

### M6.5第187スライス: Timeline Agent prompt-only Command Palette

- M6.5第187スライスでは、Timeline選択からAI相談へ入るCommand Palette導線に、Agent実行を開始しないprompt-only commandを追加した。ユーザー体験としては、clipやtransitionを選んだまま `prompt preview review_patch` や `AI プロンプト 準備` で、まず読み取り専用相談プロンプトだけを作り、内容を見てから実行できる。
- `StudioCommandPaletteCommand.prepareTimelineAgentPrompt` は stable ID `prepare-timeline-agent-prompt` を持ち、title、icon、検索keywordsを追加した。`ContentView.commandItems` はこのcommandを4つのdirect run consultation commandの前に出し、`model.prepareTimelineSelectionAgentPrompt()` だけを呼ぶ。Agent sessionの有無や接続確認状態には依存せず、timeline clip/transition selectionだけを有効条件にする。
- AI Agent統合編集ソフトとしては、AIに任せる前に、何を依頼するかをkeyboard loop内でpreviewできることが重要。既存の4つのdirect run commandは維持し、prompt-only commandはmanual editing loopを中断せずにread-only promptを作るだけに留める。この変更はCommand Palette catalog、ContentView command item、localized title copyだけで、Agent prompt schema、structured `review_patch` detection/apply、timeline operation patch contract、compiler schema、timeline artifactsには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter StudioCommandPaletteCommandTests`（5 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 39492）、tracker readback、`git diff --check` は成功した（2026-06-29 05:12 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-228/TEST-236を追加し、489件の追跡行（Story 25 / Issue 228 / Test 236）、残課題3件、修正/合格486件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでCommand Palette検索から `AI相談プロンプトを準備` / `prompt preview review_patch` が見つかること、実行してもAgent turnが始まらずpromptだけ更新されること、未選択時のdisabled copyが分かること、既存4つのdirect run consultation commandが退行しないことは人間確認キューへ集約する。

### M6.5第188スライス: Agent review_patch impact labels

- M6.5第188スライスでは、AIが返した `review_patch` を `Timelineへ表示反映` する前に、各operationの具体的な影響をAgent Panel上で読めるimpact行を追加した。ユーザー体験としては、raw JSONを読まずに、trimのsource range、moveのtarget frame、replace/insertのsegment、transition type/duration、marker/noteの内容を確認してからpreview applyへ進める。
- `TimelineAgentReviewPatchOperationSummary` は `impactLabel` を持ち、`ReviewPatchOperation` のpayloadから表示用に生成する。`trim_segment` は `source 1.000s-2.400s`、`move_segment` は `frame 120 / duration 48f / track V2`、`set_transition` は `V1 crossfade / 12f` のような短い差分行になる。`AgentPanel` はoperation name、target、その下のimpact lineを並べ、長いIDはmiddle truncationで収める。
- AI Agent統合編集ソフトとしては、AIが操作候補を出しても、タイムラインへの反映は人間が確認してから行う必要がある。この変更はpreview-only summary表示だけで、`review_patch` schema、compiler schema、Timeline表示反映のapply plan、timeline operation patch contract、timeline artifactsには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`swift test --package-path apps/macos-studio --filter TimelineAgentReviewPatchDraftTests`（5 tests / 0 failures）、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 84283）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 05:21 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-229/TEST-237を追加し、491件の追跡行（Story 25 / Issue 229 / Test 237）、残課題3件、修正/合格488件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで `review_patch` を含むAgent結果が、`Timelineへ表示反映` 前にoperation targetとimpact lineを表示すること、長いclip/segment IDが破綻せずtruncateされること、compiler非対応やstudio-only operationのwarning色が残ること、Timeline反映には明示的な `Timelineへ表示反映` が必要なことは人間確認キューへ集約する。

### M6.5第189スライス: Transition lane guide recommended target fallback

- M6.5第189スライスでは、transition presetを掴んだ直後のrow-wide lane guideが、hover前にrow先頭edit pointへfallbackするのではなく、既存のrecommended transition targetを優先して表示するようにした。ユーザー体験としては、FCPXのdefault transitionに近く、選択clip/transitionやplayheadから推奨されたedit pointと、lane guideの「最寄り」表示が掴み始めから揃う。
- `TimelineTrackRow.transitionLaneDropGuide` はpreset drag時のprimary targetに、active lane hover target、recommended transition drop target、row先頭eligible edit pointの順でfallbackする。hover後は従来どおりpointer位置から解決されたnearest targetが優先される。
- この変更はview-only fallback priorityだけで、`TimelineTransitionPlacementResolver`、`TimelineTransitionDropPlan`、drop delegate、`set_transition` operation、compiler schema、review patch schema、timeline artifacts、Viewer preview pathには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 13869）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 05:27 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-230/TEST-238を追加し、493件の追跡行（Story 25 / Issue 230 / Test 238）、残課題3件、修正/合格490件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtransition presetをdragし、lane hover前のlane guideがViewer/default previewと同じrecommended edit pointを表示すること、row内移動後はpointer近傍のedit pointへ更新されること、click apply、Command-T、既存transition move、duration drag、clip/source dragが退行しないことは人間確認キューへ集約する。

### M6.5第190スライス: Selected transition duration label

- M6.5第190スライスでは、適用済みtransitionを選択またはhoverした時点で、body上に `12f` のようなcompact duration labelを表示するようにした。ユーザー体験としては、長さ調整を始める前に現在のtransition尺をTimeline上で確認でき、FCPX/CapCut的な「掴む前に状態が読める」直接操作へ近づく。
- `TimelineTransitionDropTarget.existingTransitionDurationLabel` は、選択中、hover中、drag/drop interaction中、またはduration preview中だけ表示される。通常時は密度を保ち、極端に短いtransitionでは `displayWidth >= 28` を満たさない限りラベルを出さない。duration drag中はpreview後のframe数を表示し、既存のdelta/seconds preview badgeは維持する。
- この変更はview-only labelだけで、`TimelineTransitionPlacementResolver`、`TimelineTransitionDropPlan`、drop delegate、`set_transition` operation、compiler schema、review patch schema、timeline artifacts、Viewer preview pathには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 42318）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 05:33 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-231/TEST-239を追加し、495件の追跡行（Story 25 / Issue 231 / Test 239）、残課題3件、修正/合格492件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで適用済みtransitionを選択またはhoverするとframe duration labelが出ること、duration drag中にlabelがpreview値へ更新されること、短すぎるtransitionでは文字が潰れて出ないこと、move/drop/click apply/Command-T/clip/source dragが退行しないことは人間確認キューへ集約する。

### M6.5第191スライス: Selected clip timing metadata label

- M6.5第191スライスでは、Timeline clip本体を選択またはhoverした時点で、clip body上に `3.2s`、十分な幅がある場合は `3.2s · src 1.2s-4.4s` のようなcompact timing metadataを表示するようにした。ユーザー体験としては、移動・trim・slipを始める前に、clipの尺と使用source rangeをTimeline上で直接読める。
- `TimelineTrackRow.clipTimingMetadataLabel(for:)` はclip幅に応じてdurationのみ、またはduration + source rangeを返す。`TimelineClipBlock.shouldShowTimingMetadata` はstandard/expanded densityで、選択、hover、body drag、trim preview、skim preview、Viewer参照中だけ表示し、compact density、blade mode、pending remove、move preview中は出さない。Accessibility valueにもclip duration/source rangeを追加した。
- この変更はview-only metadata labelとaccessibility copyだけで、clip move/trim/slip/roll plan、timeline operation patch contract、compiler schema、review patch schema、timeline artifacts、Viewer preview pathには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 84786）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 05:41 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-232/TEST-240を追加し、497件の追跡行（Story 25 / Issue 232 / Test 240）、残課題3件、修正/合格494件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでclipを選択またはhoverするとduration/source range labelが読めること、短いclipやcompact densityでは密度を崩さないこと、trim/skim/body drag中に表示状態が破綻しないこと、move/drop/transition/source dragが退行しないことは人間確認キューへ集約する。

### M6.5第192スライス: Transition preset active drag status

- M6.5第192スライスでは、Transition presetをdragしている間のtoolbar statusを、単なる「ドラッグ中」から、preset名、default duration、編集点destination cueを含む `TimelineTransitionPresetDragStatus` に置き換えた。ユーザー体験としては、Timeline上のdrop guideを探している間も「何を持っていて、編集点へ落とす状態なのか」をtoolbar側で見失わない。
- `TimelineTransitionPresetPalette.activePresetDragSummary` はactive presetを `TimelineTransitionPreset` として返し、status viewが `hand.draw.fill`、duration badge、`arrow.down.to.line.compact`、`編集点` cueを表示する。help/accessibility labelもpreset名、frame数、編集点へdrag中であることを読む。preset chip、recommended target resolver、drop delegate、Viewer transition previewは既存経路のまま。
- この変更はview-only active drag statusだけで、`TimelineTransitionPlacementResolver`、`TimelineTransitionDropPlan`、drop operation、`set_transition` operation、compiler schema、review patch schema、timeline artifacts、Viewer preview pathには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 17641）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 05:48 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-233/TEST-241を追加し、499件の追跡行（Story 25 / Issue 233 / Test 241）、残課題3件、修正/合格496件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtransition presetをdragした時にtoolbar statusがpreset名、duration、編集点cueを出すこと、Timeline上のlane/drop guideと同時に読めること、click apply、Command-T、drop apply、existing transition move/duration drag、clip/source dragが退行しないことは人間確認キューへ集約する。

### M6.5第193スライス: Transition preset edit-point body cues

- M6.5第193スライスでは、Transition presetを掴んだ直後、eligible edit-point well本体にも `Drop 12f`、recommended targetには `推奨 12f`、lane-nearest targetには `近傍 12f` のような短いbody cueを表示するようにした。ユーザー体験としては、上部/レーンのguideだけでなく、実際にdropできるwell自体にも意味が出るため、「クロスフェードをどこへドロップするのか」がより直接読める。
- `TimelineTransitionDropTarget.transitionPresetBodyCueLabel` は、既存transitionがなく、hover/drop previewがまだ発生していないpreset carry中だけ表示される。hover後は既存の `previewedPresetSummary` が優先され、drop candidate cue、magnet cue、lane guide、recommended target fallbackは既存経路を維持する。
- この変更はview-only edit-point body cueだけで、`TimelineTransitionPlacementResolver`、`TimelineTransitionDropPlan`、drop delegate、`set_transition` operation、compiler schema、review patch schema、timeline artifacts、Viewer preview pathには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 45980）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 05:53 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-234/TEST-242を追加し、501件の追跡行（Story 25 / Issue 234 / Test 242）、残課題3件、修正/合格498件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtransition preset drag直後にeligible edit-point wellsが `Drop/推奨/近傍` cueを出すこと、hover後は既存preset summary/magnet cueへ自然に切り替わること、click apply、Command-T、drop apply、existing transition move/duration drag、clip/source dragが退行しないことは人間確認キューへ集約する。

### M6.5第194スライス: Source candidate drop ghost marked range

- M6.5第194スライスでは、Source Monitor / Source Binからsource candidateをTimelineへdragしている間、drop ghost上にdurationだけでなく、幅が十分な場合は `1.2s-4.4s` のようなmarked source rangeも表示するようにした。ユーザー体験としては、IN/OUTで詰めたソース範囲を落としている最中もTimeline上で確認でき、AIが選んだ素材を人間が手で詰めるsource workflowに近づく。
- `TimelineSourceCandidateDropGhost.shouldShowMarkedRangeLabel` はghost幅が `138` 以上の時だけ `preview.markedRangeLabel` を表示する。短いghostでは従来通りsegment/duration/snapを優先し、既存help/accessibility labelはmarked rangeを読み続ける。
- 変更はview-only ghost labelだけで、`TimelineSourceInsertPlan`、`TimelineSourceCandidateDropDelegate`、`StudioDragPayload`、source insert/drop operation、compiler schema、review patch schema、timeline artifacts、Viewer preview pathには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 82421）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 06:02 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-235/TEST-243を追加し、503件の追跡行（Story 25 / Issue 235 / Test 243）、残課題3件、修正/合格500件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでsource candidateをTimelineへdragした時にwide ghostでmarked source rangeが出ること、short ghostでは崩れず隠れること、snap badge/lane lift/blocked target表示が退行しないこと、drop/insert/append/overwrite/replace/transition/clip dragが退行しないことは人間確認キューへ集約する。

### M6.5第195スライス: Source drag chip source range labels

- M6.5第195スライスでは、Source Monitor / Source BinからTimelineへsource candidateをdragする前のdrag chip自体に、運ばれるsource rangeを表示またはhelp/accessibilityで読めるようにした。ユーザー体験としては、Timeline laneへhoverしてghostが出る前から、AIが選んだ素材範囲や人間がIN/OUTで詰めた範囲を確認して掴める。
- `SourceTimelineDragChip.sourceRangeLabel` は、Source Monitorでは `candidate.markedRangeLabel`、Source Bin quick dragでは `SourceBinQuickDragSummary.sourceRangeLabel` を受ける。非compact chipではsegment/role/trackに加えてsource rangeを表示し、compact tile chipでは幅を守るためduration表示のままhelp/accessibilityにsource rangeを含める。
- 変更はview-only chip labelとsummary fieldだけで、`StudioDragPayload`、`TimelineSourceInsertPlan`、`TimelineSourceCandidateDropDelegate`、source insert/drop operation、compiler schema、review patch schema、timeline artifacts、Viewer preview pathには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 15674）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 06:08 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-236/TEST-244を追加し、505件の追跡行（Story 25 / Issue 236 / Test 244）、残課題3件、修正/合格502件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Monitor drag chipがmarked IN/OUT rangeを表示すること、Source Bin list chipがcandidate source rangeを表示すること、compact tile chipは崩れずhelp/accessibilityでrangeを読めること、source drop/insert/append/overwrite/replaceとTimeline ghost cuesが退行しないことは人間確認キューへ集約する。

### M6.5第196スライス: Timeline source drop cue source range

- M6.5第196スライスでは、source candidateをTimeline lane上へhoverしている間のfloating drop cueにも、落とすsource rangeを表示するようにした。ユーザー体験としては、Source Monitor / Source Binのdrag chipからTimeline ghostまで、AIが選んだ素材範囲や人間がIN/OUTで詰めた範囲の表示が途切れない。
- `TimelineSourceCandidateDropCue` はtrack、timecode、source range、duration、snap cueを1行で表示する。snapありの場合だけ幅を少し広げ、lane lift / incompatible targetの色とiconは既存のまま維持する。Accessibility labelにも `preview.markedRangeLabel` を含めた。
- 変更はview-only drop cue labelとaccessibility copyだけで、`StudioDragPayload`、`TimelineSourceInsertPlan`、`TimelineSourceCandidateDropDelegate`、source insert/drop operation、compiler schema、review patch schema、timeline artifacts、Viewer preview pathには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 39168）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 06:13 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-237/TEST-245を追加し、507件の追跡行（Story 25 / Issue 237 / Test 245）、残課題3件、修正/合格504件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでsource candidateをTimeline laneへhoverした時にfloating drop cueへsource rangeが出ること、snap/lane-lift/incompatible target cueが崩れないこと、source drop/insert/append/overwrite/replaceとsource/transition/clip dragが退行しないことは人間確認キューへ集約する。

### M6.5第197スライス: Clip move landing cue detail

- M6.5第197スライスでは、clip本体や複数選択groupをdragしている間のlanding cueへ、着地点だけでなく移動量、clip数、track変更、lane lift、新規lane、押し出し数、snap先を短く表示するようにした。ユーザー体験としては、離す直前に「どこへ落ちるか」だけでなく「どれだけ動き、何に吸着し、重なり回避が起きるか」をtarget line上で確認できる。
- `TimelineClipMoveLandingCueModel.detailText` は `clipMoveLandingDetail(...)` から生成する。single moveでは秒単位のdelta、track/lane lift、push count、snapを出し、group moveではclip数も含める。既存の `TimelineMovePreviewBadge` と `TimelineGroupMoveRangeCue` は維持し、landing cueのhelp/accessibilityにも同じdetailを含める。
- 変更はview-only landing cue labelとaccessibility copyだけで、`TimelineClipMovePlan`、`TimelineClipGroupMovePlan`、move operation commit、compiler schema、review patch schema、timeline artifacts、Viewer preview pathには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 72034）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 06:18 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-238/TEST-246を追加し、509件の追跡行（Story 25 / Issue 238 / Test 246）、残課題3件、修正/合格506件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでsingle clip move landing cueにdelta/snap/lane-lift/push detailが出ること、group moveではclip数とdeltaが読めること、新規lane/既存lane回避の表示が崩れないこと、clip move commit、source drag、transition drag/dropが退行しないことは人間確認キューへ集約する。

### M6.5第198スライス: Clip move target ghost timecodes

- M6.5第198スライスでは、clip本体や複数選択groupを別track/laneへdragしている間のtarget ghost自体に、落下先trackだけでなくtarget timecodeも表示するようにした。ユーザー体験としては、landing cueやpreview badgeへ視線を移さなくても、ghost上で「このclipがどのtrackの何秒位置に移るか」を確認してmouse-upできる。
- `TimelineLaneLiftTargetGhostModel`、`TimelineTrackMoveTargetGhostModel`、`TimelineGroupMoveTargetGhostModel` に `timecode` を追加し、single lane-lift、direct track move、group moveの各ghost label/help/accessibilityへ反映した。既存のtarget track、duration、lane-lift color、group/lane-lift icon、ghost width計算は維持する。
- 変更はview-only target ghost labelとaccessibility copyだけで、`TimelineClipMovePlan`、`TimelineClipGroupMovePlan`、move operation commit、compiler schema、review patch schema、timeline artifacts、Viewer preview pathには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 15833）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 06:25 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-239/TEST-247を追加し、511件の追跡行（Story 25 / Issue 239 / Test 247）、残課題3件、修正/合格508件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでdirect cross-track move ghost、existing-lane lane-lift ghost、group move ghostにtarget timecodeが出ること、短いclipでもbadgeが崩れないこと、landing cue detail、clip move commit、source drag、transition drag/dropが退行しないことは人間確認キューへ集約する。

### M6.5第199スライス: Transition duration drag Viewer preview frame

- M6.5第199スライスでは、既存transitionの左右duration drag中にProgram Viewerが現在のplayhead位置だけでなく、変更後durationのtransition内部frameへ一時的に追従するようにした。ユーザー体験としては、duration badgeの数値だけでなく、Viewer上の主映像/overlay/`TRANS` timecodeでも「長さを変えた結果」がmouse-up前に分かる。
- `TimelineTransitionDurationPreview` に `previewFrame` を追加し、`activeViewerFrame` と `activeViewerPlayheadLabel` がduration preview中はそのframeを使うようにした。duration dragでは `TimelineViewportScale.transitionDurationDragViewerPreviewFrame(...)` でboundaryから変更後transition内部へ寄せたframeを算出し、preset hover / transition move previewは従来通りboundary frameを使う。
- 変更はViewModelの一時preview stateとCoreのframe計算helperだけで、`TimelineTransitionDropPlan`、`adjustTimelineTransitionDuration(...)` のcommit処理、timeline operation、review patch schema、compiler schema、timeline artifactsには触れない。
- `swift test --package-path apps/macos-studio --filter TimelineViewportScaleTests`（17 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 49760）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 06:32 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-240/TEST-248を追加し、513件の追跡行（Story 25 / Issue 240 / Test 248）、残課題3件、修正/合格510件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appで既存transitionの左右duration grip/body edgeをdragし、Viewer labelが `TRANS` timecodeへ切り替わること、長く/短くした時にViewer overlayが変化すること、mouse-up commit後の再生、transition move、preset drop、clip/source dragが退行しないことは人間確認キューへ集約する。

### M6.5第200スライス: Created lane lift cue

- M6.5第200スライスでは、clip本体または複数選択groupをdragして重なり回避が新規track/lane作成になる時、source row上に `新規 V2/A2`、target timecode、尺、clip数、回避件数を示すcueを表示するようにした。ユーザー体験としては、FCPX的に「重なったので別レイヤーへ逃がされる」挙動が、単なる小アイコンではなく明示的な新規lane作成として読める。
- `TimelineLaneLiftCreateCueModel` と `TimelineLaneLiftCreateCue` を追加し、`activeMovePreview` / `activeGroupMovePreview` の `laneLift.createsTrack` 時だけ表示する。既存laneへ逃がす場合のtarget ghost、landing cue detail、group range cue、source/transition drag表示は維持する。
- 変更はview-only created-lane cueとaccessibility copyだけで、`TimelineClipMovePlan`、`TimelineClipGroupMovePlan`、move operation commit、review patch schema、compiler schema、timeline artifacts、Viewer preview pathには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 87488）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 06:40 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-241/TEST-249を追加し、515件の追跡行（Story 25 / Issue 241 / Test 249）、残課題3件、修正/合格512件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでsingle clip/group moveを重なる位置へdragして新規lane作成になる時、created-lane cueに `新規 <track>`、timecode、尺、clip数、回避件数が出ること、短いlane幅で崩れないこと、既存lane-lift target ghost、landing cue、clip move commit、source/transition dragが退行しないことは人間確認キューへ集約する。

### M6.5第201スライス: Transition preset lane drop action labels

- M6.5第201スライスでは、Transition presetをTimeline laneへdragしている間のrow-wide guide、nearest edit-point cue、drop snap badge、magnet detailを「レーン上で離すと最寄り編集点へ磁気適用」と読める文言へ強めた。ユーザー体験としては、クロスフェードを編集点へピンポイントで落とす必要があるのか、レーン上で離せば吸着するのかがdrag中に判断できる。
- `TimelineTrackRow.transitionLaneDropGuide` のpreset pathは `レーンで離す` / `離すと最寄り ... へ磁気適用` を表示する。`TimelineTransitionDropSnapIndicator` のbadgeは `Drop <timecode>` になり、nearest edit-point cueは `離す <preset> @ <timecode>`、preset drop magnet detailは `離すと適用 / <timecode> / from → to` を表示する。Transition move pathは既存文言のまま。
- 変更はview-only drag/drop affordance copyだけで、`TimelineTransitionPlacementResolver`、`TimelineTransitionDropPlan`、drop delegate、`set_transition` operation、compiler schema、review patch schema、timeline artifacts、Viewer preview pathには触れない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 21624）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 06:48 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-242/TEST-250を追加し、517件の追跡行（Story 25 / Issue 242 / Test 250）、残課題3件、修正/合格514件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでクロスフェードなどのtransition presetをdragし、lane上で離すだけでnearest edit pointへ適用できること、row-wide guideが「レーンで離す」「磁気適用」を示すこと、snap badge/magnet cueがdrop先timecodeとfrom/to clipを読めること、click apply、Command-T、existing transition move/duration drag、clip/source dragが退行しないことは人間確認キューへ集約する。

### M6.5第202スライス: Transition blocked lane guides

- M6.5第202スライスでは、Transition presetまたは既存transitionをdragしている間、Audio/Caption/Markerなどvideo/overlay以外のrowにも赤い対象外guideを表示するようにした。ユーザー体験としては、dropできるV/Oレーンとできないレーンの違いがdrag中に読め、audio laneへ持っていった時に無反応に見えない。
- `TimelineTrackRow.transitionLaneBlockedGuide` は、`track.kind` が `.video` / `.overlay` 以外で、`activeTransitionPresetDragID` または `activeTransitionMoveID` がある時だけ `TimelineTransitionLaneDropGuide` を赤色・`nosign` iconで再利用する。preset dragでは `<preset> 対象外 / <kind>レーンには適用不可 / V・O編集点へ移動`、existing transition moveでは `トランジション移動不可 / <kind>レーンは対象外 / V・O編集点へ移動` を表示する。
- 変更はview-only blocked-lane guideだけで、`TimelineTransitionPlacementResolver`、`TimelineTransitionDropPlan`、drop delegate、`set_transition` operation、compiler schema、review patch schema、timeline artifacts、Viewer preview pathには触れない。Audio transition自体の対応は別設計が必要なので今回は広げない。
- `swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 51820）、tracker finalize/readback、`git diff --check` は成功した（2026-06-29 06:55 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-243/TEST-251を追加し、519件の追跡行（Story 25 / Issue 243 / Test 251）、残課題3件、修正/合格516件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでtransition preset/既存transitionをAudio/Caption/Markerなど非visual rowへdragした時に赤い対象外guideが出ること、video/overlay rowでは従来のdrop guide/snap cueが出ること、source/clip drag guideと干渉しないこと、click apply、Command-T、duration drag、transition move/dropが退行しないことは人間確認キューへ集約する。

### M6.5第203スライス: Source Bin collection order controls

- M6.5第203スライスでは、Project Loop HarnessのF-0019として、Source Binのactive named selection collectionを上下アイコンで前後へ移動できるようにし、その表示順をproject-scoped UserDefaultsへ保存するようにした。ユーザー体験としては、用途別に作った選択binを編集の優先順へ並べ替え、作成・改名・削除後も順序が崩れない。
- `ProjectMediaSourceBinCollectionCatalog` はstored names、active name、preferred orderから重複なしの表示順を作り、move/rename/delete時のorder変換をCore helperとして固定する。`StudioViewModel` はproject別orderを永続化し、createは末尾追加、renameは位置維持またはmerge、deleteはorder上の近いcollectionへ選択を戻す。`MediaPanelViews` はcollection picker横へicon-onlyの上下buttonを追加した。
- 変更はSource Bin collection order stateと小さな操作UIだけで、membership、metadata/status/notes、filters、source monitor、quick insert、drag、favorites、work bin、timeline.json、review patch schema、compiler contractsには触れない。PCLではTC-0005 unitをpassingにし、TC-0003 integrationとTC-0004 manualはplannedのまま残す。
- `swift test --package-path apps/macos-studio --filter ProjectMediaSourceBinCollectionCatalogTests`（16 tests / 0 failures）、`swift build --package-path apps/macos-studio --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 86908）、`pcl test pass TC-0005`、`pcl validate`、tracker readback、`git diff --check` は成功した（2026-07-01 15:48 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-244/TEST-252を追加し、521件の追跡行（Story 25 / Issue 244 / Test 252）、残課題3件、修正/合格518件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでSource Bin collection picker横の上下buttonがactive collectionを前後へ動かすこと、再起動/再読み込み後もproject内順序が維持されること、rename merge/delete後に自然な隣接collectionが選ばれること、collection membership、bulk add/remove、source monitor、quick insert、drag/drop、favorites、work binが退行しないことは人間確認キューへ集約する。

### M7第1スライス: Timeline AI consultation rich evidence context

- M7第1スライスでは、Project Loop HarnessのF-0020として、Timeline選択からAIへ相談するpromptに、既に読み込み済みのlocal evidenceをより多く渡すようにした。ユーザー体験としては、編集者が「このcutを説明」「短く整える」「代替を探す」を頼んだ時、AIがtimeline位置だけでなく、選択clipの興味点、peak、Marlin検索hit、audio story、BGM section cuesまで踏まえて返答できる。
- `TimelineAgentConsultationPrompt.appendEvidence` は、既存のasset、segment summary、transcript、Marlin temporal cue、audio event、QA issueに加えて、segment interest points、peak analysis、Marlin find results、audio story nodes、BGM sectionsを短い行として出す。秒数とconfidenceは固定小数で揃え、長いraw/textは既存のlimit helperで切り詰める。
- 変更はprompt text生成とfocused unit testだけで、Agent実行、review_patch schema、compiler schema、timeline operation patch、source media、rendered output、timeline.jsonには触れない。AI相談は引き続きread-only/PREVIEWで、timeline反映は明示的なreview_patch preview/apply経路へ分離される。
- `swift test --filter TimelineAgentConsultationPromptTests`（7 tests / 0 failures）、`swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 72471）、`pcl test pass TC-0006`、`pcl validate`、tracker readback、`git diff --check` は成功した（2026-07-01 16:05 JST）。`docs/ux/video-os-studio-ux-tracker.xlsx` はUX-245/TEST-253を追加し、523件の追跡行（Story 25 / Issue 245 / Test 253）、残課題3件、修正/合格520件、未解決P0/P1 3件、重複ID0件、formula error0件として更新した。running appでAgent panel / Command Paletteから選択clipのpromptを準備した時にrich evidenceが読みやすく出ること、read-only/PREVIEW contractが維持されること、明示的なreview_patch applyなしにtimeline/manual edit stateが増えないことは人間確認キューへ集約する。

### M7第2スライス: Agent review_patch before-after preview diffs

- M7第2スライスでは、Project Loop HarnessのF-0021として、AIがread-only相談で返した `review_patch` をTimelineへ表示反映する前に、現在のtimelineから計算したbefore/after差分行をAgentパネルに表示するようにした。ユーザー体験としては、raw JSONやoperation名だけでなく「このclipのsource range/位置/transitionが何から何へ変わるか」を見てから `Timelineへ表示反映` を押せる。
- `TimelineAgentReviewPatchApplyPlan` に `TimelineAgentReviewPatchPreviewDiff` を追加し、trim、split、set_transition、move、remove、replace のsupported operationsだけに、current timeline / candidate dataから before/after label を作る。途中にunsupported/unresolved operationがある場合は従来通りpartial applyを禁止し、`previewDiffs` も空にしてblocked reasonだけを出す。
- `AgentInspectorViews` はapply planが持つ `previewDiffs` を `反映前後` として最大3件表示し、4件以上は残数だけを表示する。表示はPREVIEW/保存前の枠内に留まり、Agent実行、review_patch schema、compiler schema、timeline artifact、source media、rendered outputには触れない。
- `swift test --filter TimelineAgentReviewPatchApplyPlanTests`（8 tests / 0 failures）、`swift build --target VideoOSStudio`、`npx tsc --noEmit`、`./script/build_and_run.sh --verify`、`pgrep -x VideoOSStudio -fl`（PID 44543）、`pcl test pass TC-0011`、`pcl test pass TC-0009`、`pcl validate`、tracker readback、`git diff --check` は成功した（2026-07-01 16:15 JST）。running appでread-only Agent turnの `review_patch` draftが、apply前にbefore/after差分を読みやすく表示すること、表示だけではtimeline/manual edit stateが変わらないこと、blocked patchが誤って差分表示されないことは人間確認キューへ集約する。
