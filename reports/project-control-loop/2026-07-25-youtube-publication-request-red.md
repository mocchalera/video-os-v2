# YouTube Publication Request Contract — Red Evidence

## Scope

- Goal: G-0012
- Task: T-0052
- Feature: F-0085
- User story: US-0055
- Test case: TC-0151

## Reproduced gap

The existing publication path binds the local video hash, visibility, metadata
hash, authenticated remote channel, and destination label across preflight and
upload. However:

- publication approval does not require the exact YouTube channel ID;
- publication approval does not bind the exact metadata hash;
- the mutating CLI may omit `--expected-channel`;
- the final upload receipt does not cite the publication approval artifact hash.

A valid OAuth token can therefore authenticate a different channel than the
human-readable approval label without a mandatory approval-derived channel
check.

## Red test

Command:

```sh
PATH=/Users/operator/.nvm/versions/node/v22.23.1/bin:$PATH \
  npx vitest run tests/youtube-publication-request.test.ts
```

Result: 3 failed. The metadata hash helper and strict publication-request
resolver do not exist, and the schema has no `publication-approval/v2`
destination contract.

The fixture is local-only and performs no HTTP or external publication.
