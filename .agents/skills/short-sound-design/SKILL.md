---
name: short-sound-design
description: Design and verify audio finishing for Japanese or English short-form social video. Use for 短尺SNS, BGM/効果音, テンポ調整, 意味ベース配置, dialogue-first mixing, or existing rough cut audio finishing with pinned local assets and internal-review QA.
---

# Short Sound Design

意味と会話の可読性を先に決め、信頼できるbeat evidenceがある場合だけ小さくtempoへ寄せる。
判断、formal cue、共有音声render、QAを別artifactとして残す。

## 必ず読む参照

判断前に[`references/workflow.md`](references/workflow.md)を読む。

## Workflow

1. project、timeline、creative brief、blueprint、source mapのidentityとhashを確認する。
   canonical artifactは読み取り専用にし、作業用copyを使う。
2. SFX libraryとBGM Packのrights、provenance、manifest、asset hash、sizeを確認する。
   未pin、unknown、missing、hash driftは止める。
3. picture edit、発言、視覚イベントからsemantic candidateを作る。各候補へpurpose、
   evidence、semantic window、asset pinを付ける。
4. dialogue、caption、overlay、lower-third、section、music entryをcongestion evidenceにする。
   固定間隔の候補生成やpicture timing変更はしない。
5. solverをdry-runし、人が読めるadopt/reject、score、conflict、snap理由を確認する。

   ```sh
   npm run sound-design:plan -- --project <project> --timeline <timeline.json> --request <sound-design-request.json> --decision-output <new-decision.json> --cues-output <new-sfx-cues.json> --dry-run
   ```

6. decisionを承認候補として確認してから、同じcommandを`--dry-run`なしで実行する。
   solver decisionからformal `sfx-cues/v1`だけを生成し、手で別判断へ差し替えない。
7. cueをA3へ投影する。

   ```sh
   npm run sfx:project -- --project <project> --timeline <timeline.json> --cues <sfx-cues.json> --output <new-timeline.json>
   ```

8. Phase 3/4の共有AudioRenderPlan/Executorを使い、social/final audioを同じplanで検証する。
   solver内にFFmpeg、mixer、filtergraphを再実装しない。

   ```sh
   npm run render-audio-plan -- --project <project> --timeline <timeline.json> --music-cues <music-cues.json> --sfx-cues <sfx-cues.json> --route social-review --output <new-social-dir>
   npm run render-audio-plan -- --project <project> --timeline <timeline.json> --music-cues <music-cues.json> --sfx-cues <sfx-cues.json> --route final --output <new-final-dir>
   ```

9. 必要なら既存picture、caption、overlayを変えずinternal reviewを作る。

   ```sh
   npm run social-review -- --project <project> --timeline <timeline.json> --captions <caption-plan.json> --music-cues <music-cues.json> --sfx-cues <sfx-cues.json> --output <internal-review.mp4> --work-dir <new-work-dir>
   ```

10. full decode、rational FPS、尺、A/V、plan/report/final-mix parity、LUFS/true peak、
    decision/cue/library pin、canonical hash不変を機械検証する。
11. 音色・配置・BGM最終選定をhuman audition gate、外部公開をpublication gateとして残す。

## 禁止

- semantic evidenceなしのhit、固定間隔SFX、BPMだけからの無根拠beat生成
- dialogueを邪魔するhit、未pin素材、低信頼beatへのsnap
- picture timingや発言境界の移動、mixed audioのdialogue finishing再投入
- masteringの重複、内部試写をfinal/public approvalとして扱うこと
- 明示承認なしの公開、upload、外部素材取得
