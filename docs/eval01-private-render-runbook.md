# EVAL-01 v2-native private render runbook

## Scope

`scripts/eval01-private-render.ts` is the sole bounded entrypoint for the
EVAL-01 private social-review render and targeted QA route. It is not a Gate 10
package or publication command. Do not use it until a successor execution
overlay and a fresh exact-one human decision bind the accepted code hashes,
seven fixed inputs, dependency identity, exact environment, and persistent
allowlist.

## Invocation contract

Run the entrypoint from the repository root with an external, hash-bound TSX
loader so repository `node_modules` can be absent before the process starts:

```sh
node /absolute/canonical/node_modules/tsx/dist/cli.mjs \
  scripts/eval01-private-render.ts \
  --overlay /absolute/execution-overlay.json \
  --overlay-sha256 <64-hex> \
  --human-decision /absolute/exact1-decision.json \
  --human-decision-sha256 <64-hex> \
  --project /absolute/artifact-root/project \
  --node-modules-target /Users/operator/Dev/video-os-v2-spec/node_modules
```

The decision must be `eval01-private-render-decision/v1`, `APPROVED`, bind
`invocation_count: 1`, retry/workaround zero, the full persistent allowlist,
all ten fixed input/code hashes, the four-key render environment, and hashes
for the canonical dependency target's `package.json`, `package-lock.json`, and
`tsx/dist/cli.mjs`.

## Fail-closed behavior

- v1 `captions[]` remains supported by `render-social-review.ts`; v2 maps only
  `cues[].text` and `timeline_in_frame`/`timeline_out_frame` into display cues.
  Raw ASR word bounds are provenance-only.
- The runner invokes the social-review renderer once. A mock, skip, timeout,
  signal, nonnumeric/nonzero exit, hash drift, pre-existing or extra output,
  display overlap, missing audio/font/caption proof, decode failure, metric
  miss, or symlink residue cannot become PASS.
- Targeted QA reuses the repository media measurement/full-decode path and
  adds exact dimensions, rational FPS, 2700-frame/90000-ms checks, A/V start
  and end parity, loudness/true peak, v2 caption overlap, ASS/font proof,
  assembly timing, and frames 0/1350/2699.
- QA and receipt validate against their closed schemas. Their body hashes are
  domain-separated; the receipt intentionally contains no hash of its final
  serialized file.
- The temporary repository `node_modules` symlink is removed before receipt
  publication. PASS also requires no persistent change outside the exact
  allowlist. NONPASS_STOP never authorizes a retry.

No render is authorized by this runbook. Rendered media still requires its
separate independent artifact audit and later human private-viewing decision;
network access, external sharing, Git/PCL mutation, dashboard use, package.ts,
and publication remain forbidden.
