## 結論

Marlin-2Bは、このプロジェクトでは **既存Gemini VLMの単純置換ではなく、動画の「意味イベント」と「時間範囲」を作る専用レイヤー**として統合するのが一番効きます。

RoughCut Agentはすでに `intent -> analysis -> triage -> blueprint -> compile -> review` のパイプライン、VLM peak detection、`peak_analysis`、deterministic compilerを持っています。つまり、Marlinを入れるべき場所は「LLMに説明文を作らせる場所」ではなく、**`03_analysis/segments.json` と `04_plan/selects_candidates.yaml` の質を上げ、最終的に `timeline.json` のカット位置へ反映される場所**です。([GitHub][1])

Marlin-2Bの強みは、モデルカード上でも「何が起きているか」と「いつ起きているか」を、`scene` と timestamp付き `events`、または自然言語クエリから `(start, end)` で返す点です。`caption()` と `find()` の2メソッドが直接この目的に合っています。([Hugging Face][2])

---

## 前提：Marlinを「効かせる」とは何か

ここでの「効く」は、単に `summary` が少し良くなることではありません。
**カット候補、in/out、trim center、peak score、beat配置が変わること**です。

具体的には、Marlinの出力を次の4箇所へ流し込みます。

1. `03_analysis/marlin_events.json`
   動画全体の scene / events / find spans を保存する。

2. `03_analysis/segments.json`
   各segmentに Marlin由来の `summary`, `tags`, `interest_points`, `peak_analysis` を追加する。

3. `04_plan/selects_candidates.yaml`
   `trim_hint.source_center_us`, `recommended_in_us`, `recommended_out_us`, `editorial_signals.peak_strength_score` に反映する。

4. `05_timeline/timeline.json`
   compilerのtrim結果が、midpointではなく「Marlinが見つけた瞬間」を中心に切られる。

このプロジェクトの既存設計も、VLMの役割を「summary/tags」から「秒単位のピーク検出、selects、compiler trim/scoreへ反映」に引き上げる方向で書かれており、Marlinの思想とかなり噛み合っています。

---

## 重要な判断：既存 `VlmFn` にMarlinを差し替えない

現状のVLMコネクタは、`framePaths + prompt + options -> rawJson` という形で、静止フレーム束をGeminiへ投げる設計です。`scripts/analyze.ts` も `GEMINI_API_KEY` がある場合に `createGeminiVlmFn()` を作って `runPipeline()` に渡しています。

一方、Marlinは `video_path` を受けて `caption(video_path)` / `find(video_path, event=...)` を実行するモデルです。モデルカードでも、`caption()` はsceneとevents、`find()` は自然言語イベントに対する時間spanを返すと説明されています。([Hugging Face][2])

だから、最初にやるべきことはこれです。

| 方針                             | 評価 | 理由                                                          |
| ------------------------------ | -: | ----------------------------------------------------------- |
| Gemini VLM connectorをMarlinで置換 |  × | 既存VLMは静止画束＋任意JSON prompt。Marlinは動画パス＋caption/find特化。噛み合わない。 |
| Marlinを別ステージとして追加              |  ◎ | Marlinのtimestamp付きeventをそのままanalysis / triage / trimへ渡せる。   |
| Gemini + Marlinのhybrid         |  ◎ | Geminiは画像・品質・汎用prompt、Marlinは動画意味・瞬間検出に使い分けられる。             |
| Marlinだけで全VLMを置換               |  △ | 画像、品質フラグ、自由なJSON抽出では既存Geminiのほうが扱いやすい。                      |

率直に言うと、Marlinを「ローカルGemini代替」として扱うと失敗します。
**Marlinは“動画の時間意味センサー”として扱うべきです。**

---

## 推奨アーキテクチャ

```text
source video
  -> ffprobe / segmentation / derivatives / STT
  -> Marlin caption
       scene
       events[start_sec, end_sec, description]
  -> Marlin find
       query -> span[start_sec, end_sec]
  -> marlin_events.json
  -> segment mapping
  -> segments.json
       summary
       tags
       interest_points
       peak_analysis
  -> /triage
       trim_hint
       editorial_signals
       peak_signals
  -> compiler
       score bonus
       peak-centered trim
  -> timeline.json
```

既存E2Eフローは `scripts/analyze.ts -> 03_analysis/assets.json / segments.json / transcripts / contact sheets / filmstrips / peak_analysis -> /triage -> selects_candidates.yaml -> /blueprint -> compile` なので、Marlinは **analysisの中に入れ、triageでさらに使う** のが自然です。([GitHub][1])

---

## 実装プラン

### P0：Marlin実行環境を分離する

TypeScript/NodeプロジェクトにPyTorchモデルを直結すると依存が重くなります。
まずは Python worker を別プロセスとして立て、Node側からJSON-RPC風に呼ぶのが安全です。

追加するファイル案：

```text
python/marlin_worker.py
python/requirements-marlin.txt
runtime/connectors/marlin-local.ts
runtime/connectors/marlin-types.ts
tests/marlin-normalize.test.ts
```

`requirements-marlin.txt` はモデルカードの要件に合わせます。

```txt
transformers>=5.7.0
torch>=2.11.0
torchcodec
qwen-vl-utils>=0.0.14
av
pillow
accelerate
```

Marlinのモデルカードは `transformers >= 5.7.0`, `torch >= 2.11.0`, `torchcodec`, `qwen-vl-utils`, `av`, `pillow` を要求しており、推論例では `trust_remote_code=True`, `dtype=torch.bfloat16`, `device_map={"": "cuda"}` を使っています。([Hugging Face][2])

`.env.local` / `analysis_policy.yaml` には以下を追加します。

```env
VOS_MARLIN_ENABLED=1
VOS_MARLIN_MODEL=NemoStation/Marlin-2B
VOS_MARLIN_DEVICE=cuda
VOS_MARLIN_MODE=hybrid
HF_TOKEN=...
```

注意点として、Hugging Face上のモデルカードにはアクセス条件確認の表示があるため、CIや初回セットアップでは `HF_TOKEN` とモデルアクセスの確認をpreflightに入れるべきです。([Hugging Face][2])

---

### P1：Marlin connectorを作る

Node側にこういう抽象を作ります。

```ts
export interface MarlinEvent {
  start_sec: number;
  end_sec: number;
  description: string;
  confidence?: number;
}

export interface MarlinCaptionResult {
  asset_id: string;
  source_path: string;
  scene: string;
  caption?: string;
  events: MarlinEvent[];
  model_alias: string;
  model_snapshot: string;
}

export interface MarlinFindResult {
  asset_id: string;
  query: string;
  span: [number, number] | null;
  raw?: string;
  format_ok: boolean;
  model_alias: string;
  model_snapshot: string;
}

export interface MarlinFn {
  caption(videoPath: string, opts?: MarlinOptions): Promise<MarlinCaptionResult>;
  find(videoPath: string, event: string, opts?: MarlinOptions): Promise<MarlinFindResult>;
}
```

Python worker側は、起動時にモデルを一度だけロードします。
毎クリップごとにPythonプロセスを起動してモデルをロードする設計は、実運用では遅すぎます。

```python
# python/marlin_worker.py のイメージ
import json
import torch
from transformers import AutoModelForCausalLM

model = AutoModelForCausalLM.from_pretrained(
    "NemoStation/Marlin-2B",
    trust_remote_code=True,
    dtype=torch.bfloat16,
    device_map={"": "cuda"},
)

while True:
    req = json.loads(input())
    if req["method"] == "caption":
        result = model.caption(req["video_path"])
    elif req["method"] == "find":
        result = model.find(req["video_path"], event=req["event"])
    print(json.dumps(result, ensure_ascii=False), flush=True)
```

Marlinは `model.compile()` も使えるようですが、最初の呼び出しが重くなるので、MVPではオプション扱いで十分です。モデルカードでも `compile()` はoptionalとされています。([Hugging Face][2])

---

### P2：`03_analysis/marlin_events.json` を作る

Marlinの生出力をいきなり `segments.json` に混ぜるとデバッグしづらくなります。
まずは独立artifactに保存します。

```json
{
  "version": "1",
  "project_id": "my-project",
  "model": {
    "provider": "marlin",
    "model_alias": "NemoStation/Marlin-2B",
    "model_snapshot": "hf-revision-or-local-sha"
  },
  "items": [
    {
      "asset_id": "AST_001",
      "source_path": "02_media/source/a001.mp4",
      "scene": "A child practices riding a bicycle in an outdoor area...",
      "events": [
        {
          "event_id": "MEV_AST_001_0001",
          "start_us": 1200000,
          "end_us": 4200000,
          "description": "The child gets ready on the bicycle while an adult watches."
        },
        {
          "event_id": "MEV_AST_001_0002",
          "start_us": 4300000,
          "end_us": 6800000,
          "description": "The child starts pedaling and keeps balance for several seconds."
        }
      ],
      "find_results": [
        {
          "query": "child successfully rides the bicycle",
          "span_start_us": 5100000,
          "span_end_us": 6900000,
          "format_ok": true
        }
      ]
    }
  ]
}
```

`segments.schema.json` は `additionalProperties: false` なので、いきなり未定義fieldを足すとvalidationが壊れます。現状の `segments.json` には `interest_points` と `peak_analysis` の拡張枠があるため、Marlinのイベントはそこに正規化して入れるのが安全です。

---

### P3：Marlin eventsをsegmentsへマッピングする

イベント秒数をmicrosecondへ変換し、既存segmentとoverlapで対応させます。

```ts
function overlapRatio(eventStartUs, eventEndUs, segStartUs, segEndUs) {
  const overlap = Math.max(0, Math.min(eventEndUs, segEndUs) - Math.max(eventStartUs, segStartUs));
  return overlap / Math.max(1, segEndUs - segStartUs);
}
```

ルール案：

```text
overlap_ratio >= 0.30:
  segment.summary に Marlin event description を反映
  segment.tags にイベント由来タグを追加
  segment.interest_points に event midpoint を追加

find span が segment に重なる:
  peak_analysis.peak_moments に追加
  recommended_in_out に span or safety window を追加
```

この段階で `segments.json` に入れる形：

```json
{
  "interest_points": [
    {
      "frame_us": 5950000,
      "label": "marlin_find: child successfully rides the bicycle",
      "confidence": 0.78
    }
  ],
  "peak_analysis": {
    "peak_moments": [
      {
        "peak_ref": "MARLIN_AST_001@5950000",
        "timestamp_us": 5950000,
        "type": "action_peak",
        "confidence": 0.78,
        "description": "The child successfully keeps balance while pedaling.",
        "source_pass": "marlin_find_span"
      }
    ],
    "recommended_in_out": {
      "best_in_us": 5100000,
      "best_out_us": 6900000,
      "rationale": "Marlin find matched the successful riding moment.",
      "source_pass": "marlin_find_span"
    },
    "visual_energy_curve": [],
    "support_signals": {
      "motion_support_score": 0.5,
      "audio_support_score": 0.5,
      "fused_peak_score": 0.78
    },
    "provenance": {
      "coarse_prompt_template_id": "marlin-caption-v1",
      "refine_prompt_template_id": "marlin-find-v1",
      "precision_mode": "marlin_native_span",
      "fusion_version": "marlin-peak-fusion-v1",
      "support_signal_version": "marlin-span-v1"
    }
  }
}
```

ここで型定義上は `source_pass` や `trim_hint.center_source` のenum拡張が必要です。`selects-candidates.schema.json` 側では `trim_hint.center_source` が `refine_filmstrip`, `precision_dense_frames`, `precision_proxy_clip`, `interest_point_fallback`, `midpoint_fallback` に限定されています。Marlin由来を正しく残すなら、`marlin_caption_event` と `marlin_find_span` を追加すべきです。

---

### P4：`scripts/analyze.ts` にMarlinモードを追加する

既存CLIは `--skip-vlm`, `--skip-peak`, `--content-hint`, `--concurrency` などを持っています。ここにMarlin用オプションを追加します。

追加案：

```bash
npx tsx scripts/analyze.ts \
  projects/my-project/02_media/source/* \
  --project projects/my-project \
  --content-hint "子どもの自転車練習" \
  --vlm-provider hybrid \
  --marlin-mode caption-find
```

新CLI案：

```text
--vlm-provider gemini|marlin|hybrid
--skip-marlin
--marlin-mode caption|find|caption-find
--marlin-query "自然言語クエリ"
--marlin-query-file queries.yaml
--marlin-max-chunk-sec 120
```

実装上は `PipelineOptions` に以下を足します。

```ts
marlinFn?: MarlinFn;
skipMarlin?: boolean;
marlinMode?: "caption" | "find" | "caption-find";
marlinQueries?: string[];
```

`ingest.ts` では、STT後・既存VLM前にMarlin stageを入れるのが良いです。

```text
Stage 7-8: STT
Stage 8.5: Marlin temporal semantics
Stage 9-10: existing VLM enrichment
Stage 11-12: peak detection / fusion
```

現在の `ingest.ts` はSTT、VLM、peak detectionを順番に実行し、VLMがない場合はdegraded peak detectionへ落ちる構造です。Marlinはここに「第三の信号」として入れるのが自然です。

---

### P5：Marlin `find()` は2回使う

ここはかなり重要です。

このプロジェクトのE2Eは、まず `analyze` を走らせ、その後 `/intent` でcreative briefを作る流れです。つまり、最初のanalysis時点では「何を探すべきか」がまだ完全には分かりません。([GitHub][1])

だから `find()` は2段階にします。

#### 1回目：analysis時の汎用find

`--content-hint` から最低限のqueryを作る。

例：

```yaml
generic_queries:
  - "the strongest action moment"
  - "the strongest emotional reaction"
  - "a clear visual reveal"
  - "a person enters or exits"
  - "a child succeeds at the task"
```

#### 2回目：triage時のbrief-aware find

`creative_brief.yaml` の `must_have`, `emotion_curve`, `message.primary` からqueryを生成する。

例：

```yaml
brief_queries:
  - "child starts riding the bicycle without help"
  - "parent reacts happily"
  - "moment of success"
  - "quiet emotional aftermath after success"
```

この2回目が本命です。
Marlinの `find()` は「自然言語クエリから時間範囲を返す」機能なので、briefのmust-haveと直結させると候補抽出の質が上がります。([Hugging Face][2])

---

### P6：`/triage` にMarlin由来のtrim_hintを materialize する

既存のselect-clipsスキルは、`peak_analysis.recommended_in_out` があり、`fused_peak_score >= 0.70` の場合に `best_in_us / best_out_us` を候補windowの第一候補にすると明記しています。

Marlin由来のspanも同じ規則に乗せます。

```yaml
trim_hint:
  source_center_us: 5950000
  preferred_duration_us: 2200000
  min_duration_us: 1200000
  max_duration_us: 3600000
  window_start_us: 5100000
  window_end_us: 6900000
  interest_point_label: "marlin_find: child successfully rides the bicycle"
  interest_point_confidence: 0.78
  peak_ref: MARLIN_AST_001@5950000
  peak_type: action_peak
  center_source: marlin_find_span
  rationale: "Marlin matched the brief query: child successfully rides the bicycle"
  recommended_in_us: 5100000
  recommended_out_us: 6900000

editorial_signals:
  peak_strength_score: 0.78
  peak_type: action_peak
  visual_tags:
    - bicycle
    - child
    - success
```

これでcompilerが `selects_candidates.yaml` だけを見ても、Marlinの判断が効きます。
このプロジェクトはcanonical artifactsを出力し、compilerはdeterministicに `timeline.json` を再現する設計なので、Marlinの結果もartifact化してから渡すのが正しいです。([GitHub][1])

---

## 長尺動画への対応

Marlinのモデルカードでは、動画プリプロセスのデフォルトが `FPS=2.0`, `FPS_MAX_FRAMES=240` で、約2分をカバーすると説明されています。また、multichunk reasoningは限定的とされています。([Hugging Face][2])

したがって、2分を超える素材はプロジェクト側でchunkingします。

```text
source.mp4
  -> chunk_000: 0-120s
  -> chunk_001: 115-235s
  -> chunk_002: 230-350s
```

ルール：

```text
chunk_sec = 120
overlap_sec = 5
Marlin event seconds + chunk_offset = source absolute seconds
overlap部分の重複eventは description類似度 + 時間overlap でdedupe
```

この処理を `python/marlin_worker.py` 側ではなく、TypeScript側の `runtime/pipeline/stages/marlin.ts` に置くべきです。理由は、artifactの時刻管理とcache hashをNode側で一元管理したいからです。

---

## 画像への扱い

ここは誤解しないほうがいいです。

Marlinは「動画特化VLM」です。静止画像1枚の意味理解を主目的にしていません。
このプロジェクトにはcontact sheet / filmstrip / frame bundleを使う既存VLM設計があるので、**画像・品質判定・任意JSON抽出は既存Gemini系、動画の意味イベントと時間spanはMarlin** と分担するのが堅いです。

つまり：

```text
Gemini / existing VLM:
  - contact sheet理解
  - filmstrip比較
  - quality_flags
  - still image / arbitrary prompt

Marlin:
  - video-level scene
  - temporal events
  - natural-language moment search
  - brief-aware must-have span detection
```

これを分けないと、Marlinに苦手なことをやらせて統合価値がぼやけます。

---

## ファイル別変更計画

| ファイル                                     | 変更内容                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `python/marlin_worker.py`                | Marlinモデルを常駐ロードし、`caption` / `find` をJSON stdin/stdoutで提供                 |
| `python/requirements-marlin.txt`         | Marlin用Python依存を分離                                                        |
| `runtime/connectors/marlin-types.ts`     | `MarlinCaptionResult`, `MarlinFindResult`, `MarlinEvent`, `MarlinFn`      |
| `runtime/connectors/marlin-local.ts`     | Python workerをspawnし、caption/findを呼ぶ                                      |
| `runtime/pipeline/stages/marlin.ts`      | asset単位でcaption/find実行、chunking、event→segment mapping                     |
| `runtime/pipeline/ingest.ts`             | STT後にMarlin stageを追加                                                      |
| `scripts/analyze.ts`                     | `--vlm-provider`, `--skip-marlin`, `--marlin-mode`, `--marlin-query` 追加   |
| `runtime/analysis-defaults.yaml`         | `marlin:` policy追加                                                        |
| `schemas/marlin-events.schema.json`      | `03_analysis/marlin_events.json` のschema                                  |
| `schemas/segments.schema.json`           | 必要なら `source_pass` のMarlin由来値を許容                                          |
| `schemas/selects-candidates.schema.json` | `trim_hint.center_source` に `marlin_caption_event`, `marlin_find_span` 追加 |
| `.agents/skills/select-clips/SKILL.md`   | Marlin由来spanの使い方を明記                                                       |
| `tests/marlin-normalize.test.ts`         | caption/find出力の正規化テスト                                                     |
| `tests/pipeline-ingest.test.ts`          | Marlin mock stageのE2Eテスト                                                  |

---

## rollout順序

### Phase 1：安全なsidecar導入

Marlinを走らせて `03_analysis/marlin_events.json` だけ出す。
`segments.json` やcompilerにはまだ影響させない。

成功条件：

```text
- Marlin workerが安定起動する
- caption/find結果がJSON artifactとして保存される
- cacheが効く
- GPUなし環境ではfail-openでskipされる
```

---

### Phase 2：segmentsへ反映

Marlin eventsを `segments.json.interest_points[]` と `peak_analysis` に入れる。

成功条件：

```text
- validateが通る
- interest_pointsがevent midpoint由来になる
- peak_analysis.recommended_in_outが入る
- 既存Gemini VLMなしでも最低限のpeakが残る
```

---

### Phase 3：triageへ反映

`/triage` がMarlin由来の `peak_analysis` を読み、`selects_candidates.yaml` の `trim_hint` に反映する。

成功条件：

```text
- candidateのsrc_in_us/src_out_usがMarlin span周辺になる
- trim_hint.source_center_us が midpoint ではなく Marlin由来になる
- must_haveに対応するspanが evidence に残る
```

---

### Phase 4：compilerへ効かせる

compilerのscore/trimで、Marlin由来の `trim_hint` と `editorial_signals.peak_strength_score` を使う。

成功条件：

```text
- timeline.jsonのclip範囲がMarlin span中心になる
- guide duration modeでもMarlin peakが守られる
- peakがない素材では従来のmidpoint fallbackに戻る
```

既存READMEでも、`guide` modeはVLM peak保護を優先すると説明されています。Marlinの導入はこの設計を強くする方向です。([GitHub][1])

---

### Phase 5：hybrid最適化

MarlinとGeminiをこう使い分けます。

```yaml
vlm_provider: hybrid

marlin:
  use_for:
    - video_scene
    - temporal_events
    - natural_language_find
    - brief_aware_must_have
    - peak_candidate_spans

gemini:
  use_for:
    - contact_sheet_general_review
    - quality_flags
    - still_image_understanding
    - arbitrary_json_prompts
```

この段階で、Gemini APIコストを下げたいなら：

```text
Marlin成功 && confidence >= 0.75:
  Gemini segment summaryをskip

Marlin失敗 or low confidence:
  Gemini VLM fallback

quality_flags必要:
  Gemini or ffmpeg heuristics
```

---

## 評価指標

Marlin統合の良し悪しは、主観ではなく以下で見るべきです。

| 指標                                      | 期待する変化 |
| --------------------------------------- | ------ |
| `trim_hint.source_center_us` のMarlin由来率 | 上がる    |
| midpoint fallback率                      | 下がる    |
| `must_have` のspan検出率                    | 上がる    |
| candidateの重複率                           | 下がる    |
| rejected candidateの精度                   | 上がる    |
| Gemini API呼び出し数                         | 下がる    |
| `timeline.json` の手戻り                    | 下がる    |
| Premiere roundtrip後のtrim修正量             | 下がる    |

最低限の自動テストは、既存の `npm run validate`, `npm test`, `npm run build` にMarlin mockを加える形で十分です。READMEでもこの3つが検証コマンドとして示されています。([GitHub][1])

---

## リスクと対策

| リスク                      | 対策                                                                 |
| ------------------------ | ------------------------------------------------------------------ |
| Python/PyTorch依存が重い      | `requirements-marlin.txt` を分離し、Marlin disabledでもNode buildが通るようにする |
| モデルロードが遅い                | Python worker常駐。1assetごとに起動しない                                     |
| HF access / token問題      | preflightで `HF_TOKEN` とモデルアクセス確認                                   |
| 長尺動画で精度低下                | 120秒chunk + 5秒overlap + timestamp offset                           |
| Marlinのconfidenceが明示されない | event source別に固定初期confidenceを置き、ffmpeg/STT信号で補正                    |
| schema破壊                 | `marlin_events.json` を別artifactにし、segments/selectsは既存拡張枠だけ使う       |
| Marlinが画像に弱い             | 画像・品質・contact sheetは既存VLMを残す                                       |
| find queryが雑になる          | analysis時はgeneric、triage時はbrief-awareの2段階に分ける                      |
| 生成結果がcompilerへ効かない       | `trim_hint` と `editorial_signals` へ必ずmaterializeする                 |

---

## 最初のMVP仕様

最初のPRはこれだけでいいです。

```text
1. python/marlin_worker.py
2. runtime/connectors/marlin-local.ts
3. runtime/pipeline/stages/marlin.ts
4. scripts/analyze.ts に --skip-marlin / --marlin-mode
5. 03_analysis/marlin_events.json 出力
6. tests/marlin-normalize.test.ts
```

この時点ではcompilerに影響させない。
次のPRで `segments.json.interest_points` と `peak_analysis` へ反映。
さらに次で `/triage` の `trim_hint` へ反映。

焦って最初からtimelineを変えると、Marlinの効果なのか既存peak detectorの効果なのか分からなくなります。
**まず観測、次にsegments反映、最後にtimeline反映** の順が堅いです。

---

## 具体例：子どもの自転車練習

Marlin caption:

```json
{
  "scene": "A child practices riding a bicycle while an adult watches.",
  "events": [
    {
      "start": 1.2,
      "end": 4.2,
      "description": "The child prepares on the bicycle."
    },
    {
      "start": 4.3,
      "end": 6.8,
      "description": "The child starts pedaling and keeps balance."
    },
    {
      "start": 6.9,
      "end": 9.4,
      "description": "The adult reacts positively after the child succeeds."
    }
  ]
}
```

Marlin find:

```json
{
  "query": "child successfully rides the bicycle",
  "span": [5.1, 6.9],
  "format_ok": true
}
```

`selects_candidates.yaml` にはこう落とす。

```yaml
segment_id: SEG_0012
asset_id: AST_001
src_in_us: 5100000
src_out_us: 6900000
role: hero
why_it_matches: 子どもが自転車に乗れた成功瞬間で、briefのmust_haveに一致する
risks: []
confidence: 0.82
evidence:
  - marlin.find: child successfully rides the bicycle
  - peak_analysis.peak_moments[0]
eligible_beats:
  - hook
  - payoff
editorial_signals:
  peak_strength_score: 0.82
  peak_type: action_peak
  visual_tags:
    - child
    - bicycle
    - success
trim_hint:
  source_center_us: 5950000
  preferred_duration_us: 2200000
  min_duration_us: 1200000
  max_duration_us: 3600000
  window_start_us: 5100000
  window_end_us: 6900000
  interest_point_label: "marlin_find: child successfully rides the bicycle"
  interest_point_confidence: 0.82
  peak_type: action_peak
  center_source: marlin_find_span
  recommended_in_us: 5100000
  recommended_out_us: 6900000
```

この形まで行けば、Marlinは「説明生成」ではなく、編集判断に効いています。
あなたの直感どおり、動画編集エージェントに必要なのは「映像の意味」と「その瞬間がいつか」です。Marlinはそこにかなり向いています。ただし、雑に置換するのではなく、**時間意味グラフを作るレイヤーとして統合する**のが勝ち筋です。

[1]: https://github.com/mocchalera/video-os-v2 "GitHub - mocchalera/video-os-v2: RoughCut Agent — Autonomous video editing agent that runs intent → analysis → triage → blueprint → compile → review in one shot · GitHub"
[2]: https://huggingface.co/NemoStation/Marlin-2B "NemoStation/Marlin-2B · Hugging Face"
