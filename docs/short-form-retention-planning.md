# Short-form retention planning

短尺SNSの構成品質を、ジャンル推測ではなくcreative briefの明示フィールドから改善するためのplanning contractです。

## 適用条件

次を両方満たす場合だけ有効になります。

- `editorial.distribution_channel` または `project.format` がsocial deliveryを示す
- `project.runtime_target_sec <= 90`

`hook_priority: aggressive`、または`must_have`にコールドオープンが明示される場合だけ、強いpayoff先出しを要求します。`credibility_first`や`credibility_bias: high`では、断片的なspoilerを強制せず、完全な主張と根拠を優先します。長尺、イベント、通常の16:9案件には適用しません。

## 構成contract

- aggressive shortでは、実在するpayoff/reactionから1〜2秒のcold openを作る
- setupへ戻った後、完全なpayoffをおおむね全尺65%以前に開始する
- 固定画・低motion素材では、6〜12秒ごとの意味的転換に実在reaction、登録済みreframe/punch-in、または登録済みemphasis overlayを計画する
- 無意味なzoom、flash、decorative transitionで変化を偽装しない
- 素材にない結果、反応、発言、能力を作らない

## 内部構造と画面文言の分離

`beat.id`と`beat.label`はcompilerや評価が使う構造語です。視聴者へ見せる章題は`beat.viewer_label`へ記録します。

```yaml
- id: b03_payoff
  label: payoff
  viewer_label: ついに本気
```

HyperFrames/Remotionのsection labelは`viewer_label`を使用し、`HOOK`、`LEVEL 1`、`PAYOFF`、`ENDING`などの内部語をbrief指定なしに画面へ出しません。

## 実装点

- 判定・prompt・監査: `runtime/editorial/short-form-retention.ts`
- split planning: `runtime/agents/llm-triage-agent.ts`, `runtime/agents/llm-blueprint-agent.ts`
- unified planning / retry: `runtime/agents/unified-editorial-agent.ts`
- artifact contract: `schemas/edit-blueprint.schema.json`
- social finishing: `runtime/caption/social-finishing.ts`
- render-level QA: `runtime/packaging/social-retention-qa.ts`

監査違反はLLMの再生成理由へ渡されます。非対象briefではprompt指示も監査も空になり、既存の構成経路を維持します。

## Social talking-head finishing profile v1

`social_talking_head`と判定された短尺会話動画に限り、次の仕上げを追加します。

- aggressive cold openには、冒頭2秒以内の登録済み`hook-title`を要求する
- hook-titleは白フラッシュ、短いscale/rotation収束、accent wipeを使う
- 質問字幕は軽い立ち上がり、`punchline / surprise / reaction / payoff`の保護済み字幕だけ強めにpopする
- 字幕animationはcanonical speech frameから開始し、発話前へ前倒ししない
- 20秒以上の動画では、実カットまたは登録済み強調overlayの間隔を14秒以内にする
- BGMは明示的なmix profileがない場合に`dialogue_first`を適用し、baseを最大-10dB、duckを最大-18dBへ制限する

字幕・HyperFrames overlayだけを直した場合、Remotion base assemblyのfingerprintは変わりません。既存assemblyを再利用し、その後段だけを再生成します。画、音声、Remotion所有overlay、transition、source mediaが変わった場合はcache missとなり、base assemblyから再レンダーします。

長尺、event、cinematic、通常16:9、および`credibility_first`のcold-open強制には適用しません。未登録字幕styleのfail-fastも`social_talking_head`だけに限定します。
