# Error Catalog

`troubleshoot-error` は、まず failure surface を固定し、そのあとこのカタログの該当 section だけを読む。
全部を毎回なめない。

## 1. Schema validation errors

典型症状:

- `npx tsx scripts/validate-schemas.ts projects/<project>` が exit 1
- compile / patch / review 後に schema validation warning or failure

診断:

```bash
npx tsx scripts/validate-schemas.ts projects/<project>
```

見る場所:

- `violations[].artifact`
- `violations[].rule`
- `violations[].message`
- `violations[].details.instancePath`

修正方針:

- missing field: schema 必須 field を追加する
- type mismatch: string / number / array / object を schema に合わせる
- referential integrity: `segment_id` や `asset_id` を `03_analysis` artifact と突き合わせる
- `review_patch.json`: op 名は `replace_segment`, `trim_segment`, `move_segment`, `insert_segment`, `remove_segment`, `change_audio_policy`, `add_marker`, `add_note` だけ

再実行:

- 該当 artifact を直したら validator を再実行
- compile / patch failure だった場合は元 command も再実行

## 2. FFmpeg / FFprobe errors

典型症状:

- `Unknown decoder` / `Invalid data found`
- `Permission denied`
- `No such file or directory`
- `spawn ffmpeg ENOENT` / `spawn ffprobe ENOENT`

診断:

```bash
ffmpeg -version
ffprobe -version
ffprobe -v error -show_streams -show_format <source-file>
```

切り分け:

- codec 不明:
  `ffprobe` で stream / format を見る
- permission denied:
  source file と出力先の権限を確認する
- no such file:
  `02_media/source_map.json` の path 解決と、project 相対 / 絶対 path の混同を確認する
- binary missing:
  `ffmpeg` / `ffprobe` 自体が入っているか確認する

repo 固有の注意:

- analyze は `ffmpeg` / `ffprobe` に依存する
- compile patch 後の preview manifest でも `source_map.json` 解決が必要になる

## 3. API errors

典型症状:

- `GEMINI_API_KEY environment variable is required`
- `GROQ_API_KEY environment variable is required`
- `OPENAI_API_KEY environment variable is required`
- 401 / 403
- 429
- timeout

診断:

- missing key:
  環境変数が未設定
- 401 / 403:
  key はあるが invalid / unauthorized
- 429:
  rate limit
- timeout:
  provider or network latency

repo 固有の注意:

- `scripts/analyze.ts` は `GEMINI_API_KEY` がなければ warning を出して VLM を skip する
- STT provider を使う場合、対応 key がないと connector 側で失敗する

回復方針:

- VLM が必須でないなら `--skip-vlm`
- STT が必須でないなら `--skip-stt`
- 429 / timeout は retry か local-only fallback を使う
- invalid key は repo 修正では治らない。必要 env を明示して止める

## 4. Compile gate failures

典型症状:

- `Compile gate BLOCKED. Unresolved blockers exist.`
- compile 自体は走る前に停止

診断:

```bash
npx tsx scripts/validate-schemas.ts projects/<project>
```

見る場所:

- `compile_gate`
- `violations[]` のうち `rule === "compile_gate"`
- `01_intent/unresolved_blockers.yaml`

切り分け:

- hard blocker:
  unresolved_blockers の未解決項目
- schema invalid:
  compile gate は open でも artifact violation で後段が落ちることがある

注意:

- `validate-schemas.ts` の exit code と `compile_gate` は同義ではない
- blocker は semantic issue なので、勝手に解決済みにしない

## 5. TypeScript errors

典型症状:

- `npx tsc --noEmit` failure
- tsx 実行時の import / type / emit error

診断:

```bash
npx tsc --noEmit
```

切り分け:

- 変更した file に出ている error
- 以前からある unrelated baseline error

修正方針:

- 今回の変更で増やした error を優先して止血する
- unrelated な既存 debt は巻き取らない
- runtime failure に直結している import / schema / type mismatch を先に直す
