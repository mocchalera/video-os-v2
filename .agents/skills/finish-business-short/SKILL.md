---
name: finish-business-short
description: Finish an existing Japanese business talking-head, lecture, interview, or testimonial rough cut as a credibility-first vertical social video. Use when the user wants an SNS short that preserves the speaker's meaning while tightening repeated ideas, adding a first-second thesis, readable full captions, restrained punch-ins, speaker identification, a registered CTA card, dialogue-first audio, and retention QA.
---

# Finish Business Short

講演・インタビューの信頼感を残したまま、既存rough cutをSNS向けの完成プレビューへ仕上げる。
派手さではなく、主張の早さ、意味の密度、字幕の読みやすさ、明確な着地でテンポを作る。

## 必ず読む参照

編集判断の前に
[`references/credibility-first-talking-head.md`](references/credibility-first-talking-head.md)
を読む。尺配分、削除基準、画面変化、字幕、CTA、QAの既定値はそこから選ぶ。

## Workflow

1. `creative_brief.yaml`、`timeline.json`、最新preview、transcript、
   `review_report.yaml`を読む。source mapのSHA・size・durationと、
   字幕焼き込みのないクリーン元素材を確認する。
2. `credibility_first`と`aggressive`を分ける。経営者・人事・DX担当者向けの
   講演／インタビューは、briefに別指定がなければ`credibility_first`を選ぶ。
3. 冒頭の完全な発言順を維持し、最初の1.2秒以内に視聴者向けの短い主張を
   登録済みtitle templateで重ねる。発言の並べ替えや架空の引用でhookを作らない。
4. 同じ意味を繰り返す発言だけを`remove_segment`で削る。映像と対応する
   dialogue clipを同時に削り、patch apply後にA/V配置を再検証する。
5. 意味の転換点でhard cutまたは`zoom: 1.10–1.18`のpunch-inを使う。
   固定間隔のズーム、flash、speed ramp、無関係なB-rollは使わない。
6. 次をcanonical timelineへ記録する。
   - 冒頭の登録済みtitle／hook element
   - 一度だけの講師・話者表記
   - transcriptに同期した日本語フル字幕
   - briefが要求する場合、終盤35%内に2秒以上の登録済みfull-frame
     `vos:content.cta-card/v1`
   - 演出密度を上げる場合、`vos:content.lower-third/v1` または
     `vos:content.section-label/v1` を少なくとも1つHyperFramesへ割り当てる
7. 字幕は発話より先行させない。1 cue 1意味、原則2行以内とし、
   プラットフォームUIを避けたsafe areaへ置く。投影資料がある場合は
   半透明の暗色panelまたは十分なoutlineで背景から分離する。
   全文字幕はHyperFramesではなくlibassを使い、可変`Noto Sans JP`を
   直接指定しない。検証済み静的700/900 faceをfail-closedで選ぶ。
8. 会話音声を主役にする。既存の検証済みMAを維持し、BGMはbriefとprovenanceが
    揃う場合だけ使う。BGM、効果音、テンポ調整、意味ベース配置を含む音仕上げが
    必要なら`$short-sound-design`へrouteする。通常は`-16 LUFS`付近、
    true peakは宣言値以下を確認する。
9. rough review outputはfinal packageと区別して書き出す。正式packageは
   `render-video`のGate 10、字幕承認、rights/privacy、publication gateを省略しない。
10. full decode、rational FPS、総尺、A/V start/end、loudness、代表frame、
    CTA hold、subtitle safe area、発言意味の連続性を確認する。

## Canonical edit path

- 局所削除・trim・punch-in: `re-edit`
- 会話MA・人物reframe: `finish-interview`
- registered overlayとcaptionを含むreview出力:
  `npx tsx scripts/render-social-review.ts --project <project> --captions <plan.json>`
- 編集後の判断: `review-roughcut`
- skill／policy変更後の回帰: `evaluate-edit`
- 承認済みfinal package: `render-video`

## 完了条件

- 主張が冒頭1.2秒以内に読める
- setup、thesis、human payoff、CTAが一続きで理解できる
- 発言の時系列と意味を壊していない
- 20秒以上では画面変化の最大間隔が8秒以内
- CTA要求時は登録済みfull-frame cardが2秒以上ある
- 字幕、話者表記、CTAが互いに競合しない
- レンダー報告にHyperFrames/Remotionの実レイヤーreceiptと字幕font hashが残る
- 音声を含む動画がfull decodeとA/V QAを通る
