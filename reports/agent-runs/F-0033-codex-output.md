## Findings — CLI設計、assembly自動生成の鮮度判定、skills更新内容

`packageCommand()` 本体は変更せず、新規 [scripts/package.ts](/Users/operator/Dev/video-os-v2-spec/scripts/package.ts) を薄い CLI として追加しました。`npm run package -- <project>` と `npx tsx scripts/package.ts <project>` の両方で起動でき、`--source-of-truth` / `--autonomy-mode` は Gate 入力の assertion、`--skip-render` / `--no-assembly` / `--assembly-path` / `--supplied-final` を公開しています。

assembly は CLI 側で `05_timeline/assembly.mp4` を標準ターゲットにし、`05_timeline/render-report.json` または `render-meta.json` の `timeline_hash` / `video_hash` を見て freshness 判定します。metadata が無い場合は mtime fallback です。missing/stale なら `assembleTimelineToMp4()` で生成し、F-0023 と同じ `writeRenderFreshnessMetadata()` で鮮度メタデータを書きます。`--no-assembly` 時は自動生成を止め、明示 path を渡して既存の missing-only auto assemble を迂回します。

skills は inline `npx tsx -e` を削除し、新 CLI 手順に更新しました。`.claude/skills/render-video/SKILL.md` と `.agents/skills/render-video/SKILL.md` は byte 一致確認済みです。`.claude/commands/render.md` も preflight と auto-assembly 前提に合わせました。

## Evidence — 変更ファイル一覧、テストコマンドと結果件数

変更ファイル:
- [scripts/package.ts](/Users/operator/Dev/video-os-v2-spec/scripts/package.ts)
- [tests/package-cli.test.ts](/Users/operator/Dev/video-os-v2-spec/tests/package-cli.test.ts)
- [package.json](/Users/operator/Dev/video-os-v2-spec/package.json)
- [.agents/skills/render-video/SKILL.md](/Users/operator/Dev/video-os-v2-spec/.agents/skills/render-video/SKILL.md)
- [.claude/skills/render-video/SKILL.md](/Users/operator/Dev/video-os-v2-spec/.claude/skills/render-video/SKILL.md) byte-identical hard link
- [.claude/commands/render.md](/Users/operator/Dev/video-os-v2-spec/.claude/commands/render.md)

検証:
- `npx tsc --noEmit`: pass
- `npm test`: 145 files passed, 4 skipped; 2531 tests passed, 39 skipped
- `npx vitest run tests/package-cli.test.ts tests/package-assembler.test.ts`: 2 files passed; 5 tests passed
- `npm run package -- --help` と `npx tsx scripts/package.ts --help`: both exit 0
- `cmp -s .claude/skills/render-video/SKILL.md .agents/skills/render-video/SKILL.md`: match
- `rg "npx tsx -e"` on updated render skill/command files: no matches

No commit made. `.project-loop/`, `.env*`, `projects/*/02_media`, `projects/*/09_output` were not modified.

<oai-mem-citation>
<citation_entries>
MEMORY.md:1351-1353|note=[project-loop boundary and validation context]
MEMORY.md:1856-1858|note=[render QA loop scope]
MEMORY.md:1864-1864|note=[qa loop rollout id source]
MEMORY.md:1868-1868|note=[render-report metadata cue]
</citation_entries>
<rollout_ids>
019f1bb5-512f-75e2-998b-6471acd1bc2b
019ee53a-9b03-7033-a577-16983fc4c78a
</rollout_ids>
</oai-mem-citation>
