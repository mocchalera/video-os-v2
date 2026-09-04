export const SHORT_SOUND_DESIGN_PLAN_CLI_FLAGS = [
  "--project",
  "--repo-sfx-root",
  "--timeline",
  "--request",
  "--decision-output",
  "--cues-output",
  "--dry-run",
  "--help",
] as const;

export const SFX_PROMOTION_CLI_FLAGS = [
  "--asset-id", "--scope", "--source", "--manifest", "--destination",
  "--output-manifest", "--project", "--repo-root", "--repo-sfx-root",
  "--rights-status", "--rights-evidence", "--provenance-ref",
  "--provenance-origin", "--usage-scope", "--review-status", "--verified-at",
  "--permitted-derivatives", "--validate-only", "--dry-run", "--json", "--help",
] as const;

/** Backward-compatible alias for the plan entrypoint's public flags. */
export const SHORT_SOUND_DESIGN_CLI_FLAGS = SHORT_SOUND_DESIGN_PLAN_CLI_FLAGS;

export const SHORT_SOUND_DESIGN_AGENT_SKILL_CONTRACT = {
  skillName: "short-sound-design",
  skillPath: ".agents/skills/short-sound-design/SKILL.md",
  commands: [
    {
      invocation:
        "npm run sound-design:plan -- --project <project> --timeline <timeline.json> --request <sound-design-request.json> --decision-output <new-decision.json> --cues-output <new-sfx-cues.json> --repo-sfx-root <repo-sfx-root> --dry-run",
      packageScript: "sound-design:plan",
      entrypoint: "scripts/plan-sound-design.ts",
    },
    {
      invocation:
        "npm run sfx:project -- --project <project> --timeline <timeline.json> --cues <sfx-cues.json> --repo-sfx-root <repo-sfx-root> --output <new-timeline.json>",
      packageScript: "sfx:project",
      entrypoint: "scripts/project-sfx-cues.ts",
    },
    {
      invocation:
        "npm run sfx:promote -- --asset-id <asset-id> --scope <repo_common|project_local> --manifest <sfx-library.json> --repo-sfx-root <repo-sfx-root> --validate-only --json",
      packageScript: "sfx:promote",
      entrypoint: "scripts/promote-sfx-asset.ts",
    },
    {
      invocation:
        "npm run render-audio-plan -- --project <project> --timeline <timeline.json> --music-cues <music-cues.json> --sfx-cues <sfx-cues.json> --repo-sfx-root <repo-sfx-root> --route social-review --output <new-social-dir>",
      packageScript: "render-audio-plan",
      entrypoint: "scripts/render-audio-plan.ts",
    },
    {
      invocation:
        "npm run render-audio-plan -- --project <project> --timeline <timeline.json> --music-cues <music-cues.json> --sfx-cues <sfx-cues.json> --repo-sfx-root <repo-sfx-root> --route final --output <new-final-dir>",
      packageScript: "render-audio-plan",
      entrypoint: "scripts/render-audio-plan.ts",
    },
    {
      invocation:
        "npm run social-review -- --project <project> --timeline <timeline.json> --captions <caption-plan.json> --music-cues <music-cues.json> --sfx-cues <sfx-cues.json> --repo-sfx-root <repo-sfx-root> --output <internal-review.mp4> --work-dir <new-work-dir>",
      packageScript: "social-review",
      entrypoint: "scripts/render-social-review.ts",
    },
  ],
  flags: SHORT_SOUND_DESIGN_CLI_FLAGS,
  commandFlagContracts: {
    "scripts/plan-sound-design.ts": SHORT_SOUND_DESIGN_PLAN_CLI_FLAGS,
    "scripts/promote-sfx-asset.ts": SFX_PROMOTION_CLI_FLAGS,
  },
  prerequisiteReferences: ["references/workflow.md"],
  producedArtifacts: [
    "sound-design-decision/v1",
    "sfx-cues/v1",
    "sfx-library/v1",
    "sfx-promotion-result/v1",
    "audio-render-plan/v1",
    "audio-mix-report/v2",
    "internal-review MP4",
  ],
} as const;
