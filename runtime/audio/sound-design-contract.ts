export const SHORT_SOUND_DESIGN_CLI_FLAGS = [
  "--project",
  "--timeline",
  "--request",
  "--decision-output",
  "--cues-output",
  "--dry-run",
  "--help",
] as const;

export const SHORT_SOUND_DESIGN_AGENT_SKILL_CONTRACT = {
  skillName: "short-sound-design",
  skillPath: ".agents/skills/short-sound-design/SKILL.md",
  commands: [
    {
      invocation:
        "npm run sound-design:plan -- --project <project> --timeline <timeline.json> --request <sound-design-request.json> --decision-output <new-decision.json> --cues-output <new-sfx-cues.json> --dry-run",
      packageScript: "sound-design:plan",
      entrypoint: "scripts/plan-sound-design.ts",
    },
    {
      invocation:
        "npm run sfx:project -- --project <project> --timeline <timeline.json> --cues <sfx-cues.json> --output <new-timeline.json>",
      packageScript: "sfx:project",
      entrypoint: "scripts/project-sfx-cues.ts",
    },
    {
      invocation:
        "npm run render-audio-plan -- --project <project> --timeline <timeline.json> --music-cues <music-cues.json> --sfx-cues <sfx-cues.json> --route social-review --output <new-social-dir>",
      packageScript: "render-audio-plan",
      entrypoint: "scripts/render-audio-plan.ts",
    },
    {
      invocation:
        "npm run render-audio-plan -- --project <project> --timeline <timeline.json> --music-cues <music-cues.json> --sfx-cues <sfx-cues.json> --route final --output <new-final-dir>",
      packageScript: "render-audio-plan",
      entrypoint: "scripts/render-audio-plan.ts",
    },
    {
      invocation:
        "npm run social-review -- --project <project> --timeline <timeline.json> --captions <caption-plan.json> --music-cues <music-cues.json> --sfx-cues <sfx-cues.json> --output <internal-review.mp4> --work-dir <new-work-dir>",
      packageScript: "social-review",
      entrypoint: "scripts/render-social-review.ts",
    },
  ],
  flags: SHORT_SOUND_DESIGN_CLI_FLAGS,
  prerequisiteReferences: ["references/workflow.md"],
  producedArtifacts: [
    "sound-design-decision/v1",
    "sfx-cues/v1",
    "audio-render-plan/v1",
    "audio-mix-report/v2",
    "internal-review MP4",
  ],
} as const;
