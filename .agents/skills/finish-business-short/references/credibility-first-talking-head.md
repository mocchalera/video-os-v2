# Credibility-first talking-head short

## 適用

経営者、人事、研修、DX、採用、組織文化など、話者の信頼と発言の文脈が
成果に直結する25〜45秒の縦型ショートへ適用する。

`aggressive`なSNS広告とは分ける。強いspoiler、白flash、過剰なkinetic type、
絵文字、毎文のzoomで視聴を奪わない。完全な主張と根拠を優先する。

## 30〜32秒の既定構造

| 区間 | 役割 | 編集 |
| --- | --- | --- |
| 0.0–1.2秒 | thesis hook | 発言を始めながら、12〜24文字程度の主張を上部safe areaに表示 |
| 0–13秒 | setup / struggle | 人物・状況・失敗・再挑戦を意味単位でhard cut |
| 13–19秒 | thesis | 最重要の主張へscale changeと短いemphasis |
| 19–30秒 | human payoff | 人が惹かれる理由から行動・希望へ着地 |
| 最後2.0–2.5秒 | CTA | 濃色full-frame card。音声を言い切った後を基本とする |

秒数は発話境界を優先して前後させる。尺を守るために語尾を切らない。

## 削除基準

削ってよい:

- 直前の主張を言い換えるだけの一文
- thesisとpayoffの間にある個人的な好みの補足
- なくても因果がつながる説明的な迂回
- filler、dead air、重複した接続

残す:

- 誰が何をしたかを定めるsetup
- 失敗から再挑戦へ移るsemantic bridge
- 中心命題を話者自身の言葉で言い切る箇所
- 視聴者が「なぜそうなるか」を理解する因果
- CTAへ接続する完全な最終発話

削除前後を音声だけでも聞き、代名詞、接続詞、主語が孤立しないことを確認する。

## Jump cutと画面変化

- 30秒前後で5〜8個のsemantic beatを目安にする
- 実カット、scale change、登録済みemphasisを合わせて7〜9回程度の画面変化にする
- 30秒尺ではtitle、lower-third、section label、emphasis、CTAを意味の転換点へ
  配し、情報レイヤー間隔を8秒以内にする
- talking-headのzoomは原則`1.10–1.18`
- 隣接clipでwide / punch-inを交互にし、同一scaleを機械的に続けない
- 顔、頭、手、マイク、look roomを代表frameで確認する
- 画面変化は接続詞ではなく、setup、retry、thesis、payoffの境界へ置く

## Copy

- hookは中心命題を短く言い換える。存在しない引用符を付けない
- 日本語hookは1〜2行、1行12〜16文字を目安にする
- 「絶対」「必ず」「成功する」など素材にない効果保証を足さない
- AI対人間の敵対構図に単純化しない

## Captions

- 全発話をcaption対象にし、1 cueは1意味、1〜2行にする
- 発話onsetから始め、speechが終わるまでに消す
- 固有名詞、誤認識、数字はsource audioとbriefで校正する
- key phraseは同じcue内で短くするか、登録済みemphasis elementを一度だけ使う
- bottom UIを避け、1080x1920では字幕下端を概ね画面下300pxより上に保つ
- 投影背景では半透明の濃紺panelか強いoutlineを使う
- 全文字幕はlibassの検証済み静的faceを使う。通常は
  `VideoOS Noto Sans JP Bold`、SNSでさらに太さが必要なら
  `VideoOS Noto Sans JP Black`を選び、generic family fallbackを許さない
- HyperFramesは全文字幕ではなく、登録済みlower-third／section-labelの
  motion layerに使う。renderer receiptがない場合は「使用済み」と報告しない

## CTA

- `vos:content.cta-card/v1`を使う
- 終盤35%内に置き、24fpsなら48frame以上、30fpsなら60frame以上保持する
- headlineは視聴後の変化、actionは商品／相談先、brandは主体を示す
- source映像の投影スライドと重ねず、full-frameで分離する
- external link、価格、効果保証はbriefにない限り追加しない

## Audio

- dialogue-first。BGMなしでも成立させる
- BGMを使う場合はレビュー済みlibraryとprovenanceを要求する
- loudness targetは案件宣言を優先し、未指定なら`-16 LUFS`付近
- AAC encode後もtrue peakとA/V end差を再測定する

## Review

最低限、次を記録する。

- 総尺、解像度、rational FPS、frame count
- video/audio start、duration差、full decode
- integrated LUFS、true peak
- semantic beat数と最大visual refresh間隔
- hook onset、CTA onset／hold
- caption overflow、UI safe area、背景分離
- source-map identity、rights/privacy残課題
