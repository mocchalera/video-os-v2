# M3.5 Design Review: Human Handoff Round-Trip

対象:
- [milestone-3.5-design.md](/path/to/project/docs/milestone-3.5-design.md)

レビュー観点:
- Gate 8-11 整合
- stable ID round-trip
- OTIO export/import 変換
- loss-aware detection
- Resolve capability profile
- diff coverage
- M3 recompile 接続
- Python bridge robustness
- fixture-based test strategy
- M3 `/export` との責務分離

## FATAL

### FATAL 1: import 側の stable ID 一意性条件が未定義で、split / duplicate edit で round-trip が壊れる

根拠:
- 設計は `exchange_clip_id` を import の primary key にしているが、1 対 1 対応しか定義していない。[docs/milestone-3.5-design.md:308](/path/to/project/docs/milestone-3.5-design.md#L308) [docs/milestone-3.5-design.md:311](/path/to/project/docs/milestone-3.5-design.md#L311)
- mapping 優先順位は「どの imported clip がどの base clip に対応するか」しか書いておらず、同じ `exchange_clip_id` を持つ imported item が複数ある場合の扱いがない。[docs/milestone-3.5-design.md:475](/path/to/project/docs/milestone-3.5-design.md#L475) [docs/milestone-3.5-design.md:489](/path/to/project/docs/milestone-3.5-design.md#L489)
- unmapped classification に `duplicate_stable_id` / `split_clip` / `inserted_clip` がなく、曖昧な one-to-many を Gate 9 で止める contract が不足している。[docs/milestone-3.5-design.md:685](/path/to/project/docs/milestone-3.5-design.md#L685) [docs/milestone-3.5-design.md:700](/path/to/project/docs/milestone-3.5-design.md#L700)

影響:
- 人間が NLE で blade/split/duplicate を行った場合、stable ID が保持されても importer が一意に追跡できず、差分が collapse する。
- これは「stable ID の埋め込み・追跡・round-trip 維持」の設計欠落であり、user 判定基準の `stable ID 喪失 / round-trip 不可能` に該当する。

推奨修正:
- import 正規化直後に `exchange_clip_id` の重複検査を追加し、重複は `duplicate_stable_id` として hard classify する。
- `split_clip`, `duplicated_clip`, `inserted_clip` を unsupported/unmapped classification に追加する。
- `roundtrip_import_report.yaml` に `duplicate_id_items` と `ambiguous_one_to_many_items` を持たせ、常に `review_required: true` にする。
- `human_revision_diff.yaml` には 1 対 1 で確定した operation だけを載せ、one-to-many は `unmapped_edits[]` に隔離する。

## WARNING

### WARNING 1: `reorder` / `track_move` 検出条件が ripple shift と global track reorder を誤検出する

根拠:
- `reorder` は「same track かつ clip ordinal または `timeline_in_frame` が変化」で検出する設計だが、上流 clip の trim で downstream clip の `timeline_in_frame` は自然に変わる。[docs/milestone-3.5-design.md:565](/path/to/project/docs/milestone-3.5-design.md#L565) [docs/milestone-3.5-design.md:573](/path/to/project/docs/milestone-3.5-design.md#L573)
- `track_move` は `track ordinal` 変化でも検出するが、Blackmagic の Resolve 18.5 guide は「track hierarchy を入れ替えても absolute track number は変わらず、割当先だけが変わる」と説明しており、track order と clip の移動は別概念である。出典: <https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_18.5_New_Features_Guide.pdf>

影響:
- trim だけで reorder が大量発生する。
- track の並べ替えだけで全 clip が `track_move` 扱いになる可能性がある。
- diff が noisy になり、roughcut-critic / blueprint-planner に誤った編集意図を渡す。

推奨修正:
- `reorder` は `timeline_in_frame` 単独ではなく、同一 peer 集合内の相対順変化で定義する。
- `trim` による ripple shift を正規化した後に `reorder` 判定する。
- `track_move` は「clip の所属先 logical track が base と変わったか」で判定し、global track reorder は別 classification に落とす。
- capability profile か diff spec に `track_reorder` と `clip_track_move` の区別を明記する。

### WARNING 2: Gate 10 の source-of-truth 宣言が export 時 manifest に押し込まれており、決定タイミングと artifact がずれている

根拠:
- `handoff_manifest.yaml` は export 時に作る ledger と定義され、その sample でも `source_of_truth_intent` を持つ。[docs/milestone-3.5-design.md:397](/path/to/project/docs/milestone-3.5-design.md#L397) [docs/milestone-3.5-design.md:446](/path/to/project/docs/milestone-3.5-design.md#L446)
- 一方 Gate 10 は「final path に入る前」に `engine_render | nle_finishing` を宣言すると書いており、意思決定は import/diff 後である。[docs/milestone-3.5-design.md:826](/path/to/project/docs/milestone-3.5-design.md#L826) [docs/milestone-3.5-design.md:838](/path/to/project/docs/milestone-3.5-design.md#L838)

影響:
- export 時の intent と post-import の final decision が同じ artifact に混在する。
- M4 が「handoff 開始時の意図」を読むのか「final render 前の確定判断」を読むのか不明確になる。

推奨修正:
- export 時 manifest は immutable に保ち、`source_of_truth_intent` は intent として明示する。
- import/review 後の確定判断は別 artifact で持つ。
  例: `handoff_resolution.yaml`
- `handoff_resolution.yaml` に `source_of_truth_decision`, `decided_by`, `decided_at`, `basis_report_hashes` を追加する。

### WARNING 3: Resolve v1 capability profile が実機エビデンスより先に roundtrip 面を広く宣言している

根拠:
- Resolve v1 profile は `enable_disable`, `track_move`, `simple_transition`, `marker_note` まで `roundtrip` としている。[docs/milestone-3.5-design.md:730](/path/to/project/docs/milestone-3.5-design.md#L730) [docs/milestone-3.5-design.md:750](/path/to/project/docs/milestone-3.5-design.md#L750)
- しかし Blackmagic の公開資料で確認できるのは OTIO timeline import/export の存在と、Resolve 19 で OTIO import に custom import options が追加されたことまでで、metadata retention や transition/marker/disable の round-trip 保証までは文書化されていない。出典: <https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_18.5_New_Features_Guide.pdf> <https://documents.blackmagicdesign.com/jp/SupportNotes/DaVinci_Resolve_19_New_Features_Guide.pdf>
- manual smoke の acceptance も `trim / reorder / disable` にしか触れておらず、profile が roundtrip としている全 surface を受け入れ条件にしていない。[docs/milestone-3.5-design.md:996](/path/to/project/docs/milestone-3.5-design.md#L996) [docs/milestone-3.5-design.md:1000](/path/to/project/docs/milestone-3.5-design.md#L1000)

影響:
- capability profile が product contract ではなく希望的 target になっている。
- 実機 smoke でズレたときに、どこまでが仕様でどこからが provisional か曖昧になる。

推奨修正:
- Resolve v1 profile を `verified_roundtrip` と `provisional_roundtrip` に分ける。
- 初回 acceptance gate は roadmap にある最小 surface から始める。
- profile または `handoff_manifest.yaml` に Resolve version と import/export option snapshot を保存する。
- manual smoke の acceptance を profile 宣言面と 1 対 1 に揃える。

### WARNING 4: Python subprocess bridge の versioning / error contract が不足しており、determinism 要件を支えきれない

根拠:
- 設計は「same OTIO bridge version なら deterministic」としているが、その version をどこに保存するかが shape にない。[docs/milestone-3.5-design.md:68](/path/to/project/docs/milestone-3.5-design.md#L68) [docs/milestone-3.5-design.md:906](/path/to/project/docs/milestone-3.5-design.md#L906)
- bridge の責務境界はあるが、command envelope、exit code、stderr、timeout、version mismatch policy が書かれていない。[docs/milestone-3.5-design.md:235](/path/to/project/docs/milestone-3.5-design.md#L235) [docs/milestone-3.5-design.md:258](/path/to/project/docs/milestone-3.5-design.md#L258) [docs/milestone-3.5-design.md:924](/path/to/project/docs/milestone-3.5-design.md#L924)
- Phase 1 の deliverable に OTIO bridge command contract はあるが、本文に契約 shape がない。[docs/milestone-3.5-design.md:1017](/path/to/project/docs/milestone-3.5-design.md#L1017) [docs/milestone-3.5-design.md:1025](/path/to/project/docs/milestone-3.5-design.md#L1025)

影響:
- export/import の再現性と障害切り分けが artifact だけでは追えない。
- OTIO/Python 更新で diff drift が起きても、manifest/report から原因を逆算できない。

推奨修正:
- `handoff_manifest.yaml` と `roundtrip_import_report.yaml` に `bridge` block を追加する。
  - `python_version`
  - `opentimelineio_version`
  - `bridge_version`
  - `bridge_script_hash`
  - `loaded_adapter_modules`
- bridge command contract を JSON request/response で明文化する。
- TS 側で timeout、non-zero exit、invalid JSON、stderr capture の扱いを規定する。
- export 時と import 時で bridge version が変わった場合の policy を `fail | warn+review_required` で固定する。

### WARNING 5: `marker_note` の再入線が current M3 patch contract と一致していない

根拠:
- M3.5 は `marker_note` で timeline marker 追加、clip-attached marker 追加、note text 追加を first-class に扱う。[docs/milestone-3.5-design.md:606](/path/to/project/docs/milestone-3.5-design.md#L606) [docs/milestone-3.5-design.md:615](/path/to/project/docs/milestone-3.5-design.md#L615)
- しかし M3 への戻し方では `add_marker` / `add_note` proposal に落とすとしか書かれていない。[docs/milestone-3.5-design.md:817](/path/to/project/docs/milestone-3.5-design.md#L817) [docs/milestone-3.5-design.md:820](/path/to/project/docs/milestone-3.5-design.md#L820)
- 実際の M3 patch contract は timeline-level marker 追加しか表現できず、clip anchor や note body の専用 field を持たない。[schemas/review-patch.schema.json](/path/to/project/schemas/review-patch.schema.json) [runtime/compiler/patch.ts:382](/path/to/project/runtime/compiler/patch.ts#L382)

影響:
- clip-attached marker / note を M3 loop に戻すと、anchor 情報を落として timeline marker に平坦化する。
- 「diff は読めるが再表現できない」状態になり、M3 接続の contract が崩れる。

推奨修正:
- M3.5 base scope を「timeline marker のみ」に狭める。
または
- `review_patch.json` と compiler patch apply に `target_clip_id`, `relative_frame`, `note_text` を追加する拡張設計を先に切る。
- scope を狭める場合は capability profile と success criteria から clip-attached marker を外す。

### WARNING 6: recompile ループの state / approval invalidation が設計本文で明示されていない

根拠:
- M3.5 の loop は「diff -> agent proposal -> deterministic compile -> preview update」まで書かれているが、どの command が draft artifact を書き、どの時点で `approval_record` を stale にし、state を `timeline_drafted` / `critique_ready` に戻すかが書かれていない。[docs/milestone-3.5-design.md:790](/path/to/project/docs/milestone-3.5-design.md#L790) [docs/milestone-3.5-design.md:824](/path/to/project/docs/milestone-3.5-design.md#L824)
- M3 既存設計では timeline/review artifact 変更時に approval を stale にし state を戻すのが必須 contract である。[docs/milestone-3-design.md:602](/path/to/project/docs/milestone-3-design.md#L602) [docs/milestone-3-design.md:636](/path/to/project/docs/milestone-3-design.md#L636)

影響:
- 実装者が `approved` state のまま proposal/compile を進める誤実装をしやすい。
- M3 approval semantics と M3.5 round-trip loop の接続点が曖昧になる。

推奨修正:
- `human_revision_diff.yaml` の consumer は既存 `/review` または `/blueprint` command を経由する、と明記する。
- proposal promote 時に `approval_record` を stale にすることを M3.5 側でも明文化する。
- recompile 後の expected state を表で追加する。

## NOTE

### NOTE 1: Gate 8-11 は設計書には入ったが、中心契約の `ARCHITECTURE.md` はまだ 1-7 のまま

根拠:
- roadmap は gates 8-11 を central gate として定義している。[docs/roadmap.md:53](/path/to/project/docs/roadmap.md#L53) [docs/roadmap.md:64](/path/to/project/docs/roadmap.md#L64)
- M3.5 設計も Gate 8-11 を追加している。[docs/milestone-3.5-design.md:183](/path/to/project/docs/milestone-3.5-design.md#L183) [docs/milestone-3.5-design.md:191](/path/to/project/docs/milestone-3.5-design.md#L191)
- しかし `ARCHITECTURE.md` 本文はまだ gates 1-7 のみで止まっている。[ARCHITECTURE.md:223](/path/to/project/ARCHITECTURE.md#L223) [ARCHITECTURE.md:231](/path/to/project/ARCHITECTURE.md#L231)

推奨修正:
- 実装前に `ARCHITECTURE.md` へ gates 8-11 を昇格し、OTIO exchange boundary と合わせて central contract を一本化する。

### NOTE 2: `roundtrip_import_report.yaml` の sample shape が本文 NFR と完全には一致していない

根拠:
- Reliability/Auditability では `base_timeline.hash` を保持して誤った base への import を拒否するとしている。[docs/milestone-3.5-design.md:912](/path/to/project/docs/milestone-3.5-design.md#L912) [docs/milestone-3.5-design.md:917](/path/to/project/docs/milestone-3.5-design.md#L917)
- しかし sample の `roundtrip_import_report.yaml` には `base_timeline` block がない。[docs/milestone-3.5-design.md:497](/path/to/project/docs/milestone-3.5-design.md#L497) [docs/milestone-3.5-design.md:526](/path/to/project/docs/milestone-3.5-design.md#L526)

推奨修正:
- report sample/schema に `base_timeline.version`, `base_timeline.hash`, `bridge_version` を追加する。

### NOTE 3: M3 `/export` と M3.5 handoff export の責務分離自体は明確で、この方針は維持すべき

根拠:
- M3 では `/export` は review bundle に限定されている。[docs/milestone-3-design.md:121](/path/to/project/docs/milestone-3-design.md#L121) [docs/milestone-3-design.md:661](/path/to/project/docs/milestone-3-design.md#L661)
- M3.5 でも `runtime/commands/export.ts` と `runtime/handoff/*` を分ける設計になっている。[docs/milestone-3.5-design.md:120](/path/to/project/docs/milestone-3.5-design.md#L120) [docs/milestone-3.5-design.md:137](/path/to/project/docs/milestone-3.5-design.md#L137)

推奨修正:
- command 名と help 文でもこの境界を固定し、M3 `/export` に OTIO handoff 意味を混ぜない。

## External References

- Blackmagic Design, DaVinci Resolve 18.5 New Features Guide:
  <https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_18.5_New_Features_Guide.pdf>
- Blackmagic Design, DaVinci Resolve 19 New Features Guide:
  <https://documents.blackmagicdesign.com/jp/SupportNotes/DaVinci_Resolve_19_New_Features_Guide.pdf>
- OpenTimelineIO schema API docs:
  <https://opentimelineio.readthedocs.io/en/latest/api/python/opentimelineio.schema.html>
- OpenTimelineIO file format specification:
  <https://opentimelineio.readthedocs.io/en/v0.13/tutorials/otio-file-format-specification.html>
- OpenTimelineIO PyPI:
  <https://pypi.org/project/OpenTimelineIO/>
