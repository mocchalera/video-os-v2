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
