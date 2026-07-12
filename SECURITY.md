# Security Policy

## Supported versions

This repository is pre-1.0. Security fixes are handled on the default development branch until a release policy exists.

## Reporting a vulnerability

Please open a private security advisory on GitHub if available. If that is not available, contact the maintainer privately before publishing exploit details.

Include:

- Affected command, service, or artifact.
- Steps to reproduce.
- Whether private media, credentials, local file paths, or rendered outputs can be exposed.
- Suggested remediation if known.

## Secret and media handling

- Never commit `.env.local`, API keys, provider tokens, private footage, rendered videos, or generated contact sheets.
- Use `.env.example` for documented environment variables.
- Treat `projects/*` as local working data unless the path is explicitly allowlisted.
- Review generated logs and JSON artifacts before sharing them, because they may include local file paths or source media names.

## Local media and source maps

- Treat `source_map.json` as a capability file: any path in it can grant local media access to preview, thumbnail, waveform, and media routes.
- Server media routes must resolve candidate paths through `realpath` and allow only project-local media roots, project cache roots, or explicit `VIDEO_OS_ALLOWED_MEDIA_ROOTS` / `VOS_ALLOWED_MEDIA_ROOTS` entries.
- Do not expose `local_source_path`, `source_locator`, or `link_path` from source-map API responses. Client playback should use asset IDs and server-issued media URLs.
- Thumbnail endpoints must bound requested dimensions and reject invalid resource requests instead of passing them through to ffmpeg.
