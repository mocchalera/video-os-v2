# Video OS v2 記事アウトラインと核

作成日: 2026-06-05

## この記事の位置づけ

AGIラボのAI Agent Hackathonでファイナリストに残った Video OS v2 / RoughCut Agent を題材に、単なる実装解説ではなく、「なぜこの形にしたのか」「どこに作り手の思想があるのか」「AIに編集を任せるとは何を意味するのか」まで掘る。

参考記事「撮れば撮るほど苦しい」を終わらせたい。自律型映像編集エージェント「Video OS v2」を作った話は、背景や問題意識の参照元として扱う。ただし本稿はその続編や焼き直しではなく、Video OS v2 というプロジェクトを中心にした新しい一本として再構成する。

## 想定読者

- AIエージェント開発者
- 動画編集やクリエイティブ制作にAIを使いたいクリエイター
- 生成AIを「全自動化」ではなく「制作プロセスのOS」として見たい人

技術者向けには、VLM、STT、話者分離、音声解析、タイムラインIR、スキル、ゲート、アプリ化の設計を具体的に見せる。一般クリエイター向けには、「AIが映像を見る」「意図を説明できる編集にする」「最後の感性は人間が握る」という可能性を伝える。

## 核となる一文

Video OS v2 は、AIに編集を明け渡すためのプロジェクトではない。人間が感覚でやっている編集の手つきを、プロンプト、ルール、スキル、タイムラインに分解し、説明できる形でAIに預け直すための実験だった。

## 主要テーマ

### 1. 「自動編集アプリ」ではなく「編集OS」

伝えたいこと:

- Video OS v2 は「素材を入れたら勝手に完成動画が出る」だけを目指していない。
- リポジトリ上でも `Editorial Intent Compiler + Media Intelligence OS` として構想されている。
- 人間の依頼、素材分析、候補抽出、構成、タイムライン、レビュー、Premiere連携までを一つの編集プロセスとして扱う。
- 真実の置き場はチャットの返答ではなく、プロジェクト内の成果物と中間アーティファクト。

根拠にする場所:

- `README.md`
- `ARCHITECTURE.md`
- `docs/roadmap.md`
- `.agents/skills/full-pipeline/SKILL.md`

### 2. 出発点は「AIの目はどこまで使えるのか」

取材メモ:

- 動画生成やRemotion的なプログラマブル動画は増えている。
- 一方で、実素材を読み、どこを切るか、何を残すか、どんな順番で見せるかを扱うAIはまだ少ない。
- 作り手は、人間が感覚でやっている編集判断を言語化し、プロンプト、ルール、スキルに落としたとき、どこまでクリエイターの手つきが再現できるかに興味があった。

記事内での言い換え:

- 「AIに絵を作らせる」のではなく、「AIに撮ってしまった現実を見る訓練をさせる」プロジェクト。
- 生成AIブームの逆方向にある実験。

### 3. コンタクトシートという、AIのための目

伝えたいこと:

- 動画の全フレームを等倍で見るとトークンも時間も破綻する。
- そこで全体を縮小したコンタクトシートで俯瞰し、必要なところだけfilmstripやdense framesで深掘りする。
- 動きのあるカットはキーフレーム抽出を密にし、静的なカットや会話は粗く見る。
- これは「AIに全部見せる」のではなく、「人間の編集者が素材をざっと見る行為」を機械向けに設計し直したもの。

根拠にする場所:

- `runtime/connectors/ffmpeg-derivatives.ts`
- `runtime/connectors/vlm-peak-detector.ts`
- `runtime/connectors/gemini-vlm.ts`
- `runtime/pipeline/stages/vlm.ts`
- `runtime/analysis-defaults.yaml`

### 4. インタビュー、セミナー、PV、MVは同じ問題ではない

取材メモ:

- インタビューやセミナーのように文字起こしが構成に使える素材はかなり得意。
- 話している内容を軸に切り取り方と編集構成を組み立てられる。
- 時系列の記録も比較的扱いやすい。
- ただし絵だけで判断するPV系は難しい。
- MVは未検証。ルールがないぶん、音楽のビートと展開を軸にどこまで絵を選べるかが次の実験になる。

記事内での言い換え:

- AI編集の難しさは「動画」一般ではなく、「意味がどのモダリティに宿っているか」で変わる。
- 言葉に意味がある映像、時系列に意味がある映像、絵と音だけに意味がある映像では、必要なエージェントが違う。

根拠にする場所:

- `runtime/editorial/profiles/*.yaml`
- `runtime/editorial/policy-resolver.ts`
- `projects/*/04_plan/*`
- `projects/*/09_output/*`

### 5. 編集のこだわりをスキルに分解する

伝えたいこと:

- `.agents/skills` は工程のスキル。
- `runtime/editorial/skills` や `runtime/editorial/transition-skills` は編集判断そのもののスキル。
- `build_to_peak`、`silence_beat`、`match_cut_bridge`、`b_roll_bridge` などは、映像編集者が感覚で選ぶ「つなぎ方」「残し方」「盛り上げ方」を名前付きルールにしたもの。
- 「説明できない編集意図で作業させない」という思想がここに出ている。

根拠にする場所:

- `.agents/skills/design-intent/SKILL.md`
- `.agents/skills/select-clips/SKILL.md`
- `.agents/skills/review-roughcut/SKILL.md`
- `runtime/editorial/skills/*.yaml`
- `runtime/editorial/transition-skills/*.json`

### 6. 音に合わせる編集

取材メモ:

- 作り手は「音に合わせる編集」にかなりこだわった。
- BGMが盛り上がるところで映像も盛り上がりたい。
- 重要な発話のときはBGMを下げる。
- BGMと素材音のバランス、ラウドネス調整まで入っている。

記事内での言い換え:

- Video OS v2 にとって音はBGMの添え物ではなく、編集構造を決める軸の一つ。
- 「ビートに合わせる」だけではなく、「展開に合わせる」「声を殺さない」「最終音量を整える」までが編集。

根拠にする場所:

- `runtime/media/bgm-analyzer.ts`
- `runtime/connectors/bgm-beat-detector.ts`
- `runtime/compiler/adjacency.ts`
- `runtime/compiler/score.ts`
- `runtime/audio/ducking.ts`
- `runtime/audio/mixer.ts`
- `runtime/audio/mastering.ts`
- `runtime/audio/music-cues.ts`

### 7. モデル選定は「万能モデル探し」ではなく「感覚器官の分担」

取材メモ:

- VLM選定をかなり試した。
- APIではGemini、ローカルではQwen系やMarlin連携を試した。
- STT、話者分離も試した。
- OpenAI STT、Groq Whisper、pyannote のように、音声理解も複数経路で組んだ。

記事内での言い換え:

- 一つのモデルに編集者をやらせるのではなく、素材を見る目、発話を聞く耳、時間方向の意味を掴む感覚器官を分ける。
- Geminiはフレーム束やコンタクトシートを見る目。
- STTは発話を構造化する耳。
- pyannoteは誰が話しているかを分ける耳。
- Marlin/Qwen系はローカルで時間方向の映像意味を掴む実験。

根拠にする場所:

- `runtime/connectors/gemini-vlm.ts`
- `runtime/connectors/openai-stt.ts`
- `runtime/connectors/groq-stt.ts`
- `runtime/connectors/pyannote-diarizer.ts`
- `runtime/pipeline/stages/stt.ts`
- `docs/marlin-2B統合プラン.md`
- `python/marlin_worker.py`
- `python/requirements-marlin.txt`

### 8. 詰まったところ: 全部やろうとしたこと、検証が重いこと

伝えたいこと:

- インタビュー、セミナー、PV、家族記録、MV的なものまで一気に視野に入れたことで、実装が分岐した。
- 動画は検証が重い。変更してすぐ結果がわかるWeb UIとは違い、解析、構成、コンパイル、レンダー、視聴レビューのループが長い。
- ハッカソンでは、APIキー、zsh glob、直列VLM、フルパイプラインの再開性など、プロダクト以前の現実的な詰まりも出た。

根拠にする場所:

- `docs/roadmap-v2.1.md`
- `.claude/state/breezing-timeline.jsonl`
- `.claude/state/session.events.jsonl`
- `projects/*/06_review/*`
- `projects/*/09_output/*`

### 9. アプリ化: チャットではなくオペレーターサーフェスへ

伝えたいこと:

- Video OS Studio は、別の編集エンジンではなく、エージェントと中間成果物を扱う操作面。
- 最終的に必要なのは「AIに頼んだら動画が返る箱」ではなく、人間が意図、候補、タイムライン、レビュー、差分を見ながら判断できる画面。
- ここに「AIに感性を明け渡さない」という思想が戻ってくる。

根拠にする場所:

- `docs/macos-studio-architecture.md`
- `docs/editor-*.md`
- `docs/p*-implementation-notes.md`

### 10. 結論: AI編集の価値は、人間の感性を消すことではない

締めの方向:

- Video OS v2 は、AIが編集者になる話ではない。
- 退屈な素材確認、発話整理、候補抽出、音合わせ、粗い構成案をAIに渡すことで、人間が「何を残したいか」に戻れるようにする試み。
- AIの可能性は、作り手の意思を薄めることではなく、意思を反映させる面積を広げることにある。

## タイトル候補

1. AIに感性を明け渡さない。Video OS v2が試した「編集エージェント」の作り方
2. 動画生成ではなく、編集OSを作る。Video OS v2の実装と思考
3. AIの目は、クリエイターの手つきをどこまで再現できるのか
4. 「エモいカット」を逃さないAIは作れるか。Video OS v2の実験

## 初稿で必ず入れる言葉

- AIの目はどこまで使えるのか
- 感性は人間側が握りたい
- 説明できない編集意図で作業させない
- エモい絵やカットを逃したくない
- 実素材を扱うAI
- コンタクトシート
- 音に合わせる編集
- BGMが盛り上がるところで盛り上がる
- 文字起こしが構成に使える映像は強い
- MVは次の実験

## 追加取材したい問い

1. ハッカソン提出時、審査員や周囲に一番伝わったポイントは何だったか。
2. 「Video OS v2」という名前の v1 との違い、または v2 と呼びたかった理由は何か。
3. 実際に一番うまくいった素材、一番うまくいかなかった素材はどれか。
4. クリエイターが触るアプリとして、最初に見せたい画面はどこか。
5. MV実験で最初に試すなら、どんな曲、どんな素材がよいか。

