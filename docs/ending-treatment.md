# Ending Treatment

尻切れ感を防ぐ終端処理は、尺や編集 profile に依存しない `edit_blueprint.yaml` の共通機能です。コンパイラは最終クリップの利用可能な素材ハンドル内で post-roll を伸ばし、音声と映像のフェード指定を `timeline.json` に記録します。レンダーはその frame 数をそのまま適用します。

```yaml
ending_policy:
  should_feel: resolved
  final_visual_strategy: hold the final frame, then fade to black
  final_audio_strategy: preserve room tone, then fade out
  tail_hold_sec: 3
  audio_fade_out_sec: 2
  video_fade_out_sec: 1.5
  video_fade_color: black
```

- `tail_hold_sec`: 最終カットの source out を後ろへ伸ばす秒数。素材終端を超えない。
- `audio_fade_out_sec`: 最終音声クリップの末尾フェード秒数。
- `video_fade_out_sec`: 最終映像クリップの末尾フェード秒数。
- `video_fade_color`: `none`、`black`、`white`。

既存 blueprint にこれらの指定がなければ尺とレンダーは変わりません。新規の通常 blueprint は短い音声フェードを既定とし、`longform-event` は長めの余韻と黒フェードを既定にします。QA の beat pacing は宣言済み post-roll を編集テンポの逸脱として数えません。
