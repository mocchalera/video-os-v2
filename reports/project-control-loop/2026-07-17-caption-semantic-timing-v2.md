# Caption semantic timing feedback implementation v2

Date: 2026-07-17
Features: F-0067, F-0068
Stories: US-0039, US-0040

This supplement records the user's correction that the failure is general speech
caption lead, not only punchline reveal timing.

- F-0068 owns the universal `speech_sync` layer for transcript-backed captions.
- F-0067 owns the optional `protect_reveals` layer on top of `speech_sync`.
- The read-only IMG_3921 audit checked 17 captions and found 9 excessive leads,
  with a maximum of 99 frames (4.125 seconds).
- The implementation and verification details remain in
  `2026-07-17-caption-semantic-timing.md`.
- `npm run verify` passed all gates.
- `npm run eval -- --suite golden` exited 0.
