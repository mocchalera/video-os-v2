# Source Map Allowed Roots Evidence

Date: 2026-07-09

## Scope

Implemented the next governance/security slice from the third-party review:
server-side source_map path authorization for local media-serving paths.

This slice covers:

- `editor/server/routes/media.ts`
- `editor/server/routes/thumbnails.ts`
- `editor/server/routes/waveforms.ts`
- `editor/server/routes/preview.ts`
- shared resolver logic in `editor/server/utils.ts`

## Behavior

The editor server no longer accepts arbitrary absolute paths from
`source_map.json` as sufficient authority to read local files.

Allowed source paths must now resolve through:

- the project directory;
- `02_media` under the project;
- `.cache` under the project;
- optional operator-provided roots in `VIDEO_OS_ALLOWED_MEDIA_ROOTS` or
  `VOS_ALLOWED_MEDIA_ROOTS`;
- the exact real target of an existing `link_path` inside project `02_media`.

That last rule preserves the existing project pattern where external source
footage is intentionally materialized as a symlink under `02_media`, while
blocking a source_map-only absolute path to an unrelated local file.

## Verification

Commands run locally with Node v22.23.1 / npm 10.9.8 by pinning PATH to
`$HOME/.nvm/versions/node/v22.23.1/bin`:

```text
npx vitest run tests/editor-server-media-roots.test.ts
=> 4 tests passed

npm run typecheck
=> passed

npm --prefix editor run typecheck
=> passed

npm run validate
=> valid=true, artifacts_checked=15, error_count=0, warning_count=0

git diff --check
=> passed
```

## Notes

- This does not redact absolute paths from `/api/projects/:id/source-map`; it
  prevents the server-side media/preview/thumbnail/waveform resolvers from
  using unauthorized local paths.
- Route-level HTTP tests can be added later if editor-server test harnessing is
  expanded. The current focused coverage tests the shared authorization helper
  without pulling Express into the root test dependency surface.
