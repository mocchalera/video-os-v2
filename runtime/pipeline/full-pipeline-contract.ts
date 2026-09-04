import { FULL_PIPELINE_RESUME_STAGE_ORDER } from "./plan.js";

export interface FullPipelineCliOptionContract {
  flag: `--${string}`;
  aliases?: readonly `-${string}`[];
  value?: string;
  exampleValue?: string;
  description: string;
}

export const FULL_PIPELINE_CLI_OPTIONS = [
  {
    flag: "--project",
    value: "<project-id|project-dir>",
    exampleValue: "projects/demo",
    description: "Project identifier or directory (required).",
  },
  {
    flag: "--source-dir",
    value: "<path>",
    exampleValue: "footage",
    description: "Source footage directory. Required when creating a new project.",
  },
  {
    flag: "--content-hint",
    value: "<text>",
    exampleValue: "interview",
    description: "Context hint for VLM analysis.",
  },
  {
    flag: "--lyrics",
    value: "<path>",
    exampleValue: "lyrics.txt",
    description: "Authored lyric body; requires --timing-plan and explicit caption approval.",
  },
  {
    flag: "--timing-plan",
    value: "<path>",
    exampleValue: "timing-plan.json",
    description: "Authored caption timing evidence/plan; body text remains authoritative from --lyrics.",
  },
  {
    flag: "--from",
    value: "<stage>",
    exampleValue: "QA",
    description: `Resume hint: ${FULL_PIPELINE_RESUME_STAGE_ORDER.join("|")}.`,
  },
  { flag: "--skip-analyze", description: "Start from existing 03_analysis artifacts." },
  { flag: "--skip-footage-db", description: "Skip 03_analysis/search/footage.db rebuild." },
  { flag: "--skip-render", description: "Run planning/compile but do not render rough-cut.mp4." },
  { flag: "--skip-qa", description: "Skip QA improvement loop." },
  { flag: "--no-qwen3vl", description: "Disable Qwen3-VL embeddings." },
  { flag: "--no-clap-audio", description: "Disable CLAP audio embeddings." },
  { flag: "--help", aliases: ["-h"], description: "Show this help." },
] as const satisfies readonly FullPipelineCliOptionContract[];

export const FULL_PIPELINE_CANONICAL_OUTPUTS = [
  "09_output/rough-cut.mp4",
] as const;

export const FULL_PIPELINE_AGENT_SKILL_CONTRACT = {
  skillName: "full-pipeline",
  skillPath: ".agents/skills/full-pipeline/SKILL.md",
  manifestPath: ".agents/skills/agent-skill-contracts.json",
  commands: [
    {
      invocation: "npm run full-pipeline -- --project <project-id> --source-dir <source-dir>",
      packageScript: "full-pipeline",
      entrypoint: "scripts/full-pipeline.ts",
    },
    {
      invocation: "npx tsx scripts/analyze.ts",
      entrypoint: "scripts/analyze.ts",
    },
    {
      invocation: "npx tsx scripts/editorial-agent-task.ts",
      entrypoint: "scripts/editorial-agent-task.ts",
    },
    {
      invocation: "npx tsx scripts/compile-timeline.ts",
      entrypoint: "scripts/compile-timeline.ts",
    },
    {
      invocation: "npm run render-route",
      packageScript: "render-route",
      entrypoint: "scripts/render-route.ts",
    },
    {
      invocation: "npm run package",
      packageScript: "package",
      entrypoint: "scripts/package.ts",
    },
  ],
  flags: FULL_PIPELINE_CLI_OPTIONS.map((option) => option.flag),
  resumeStages: [...FULL_PIPELINE_RESUME_STAGE_ORDER],
  prerequisiteReferences: [
    "references/gate-conditions.md",
    "references/recovery-playbook.md",
  ],
  producedArtifacts: [
    "01_intent/*",
    "03_analysis/*",
    "04_plan/*",
    "05_timeline/*",
    "06_review/*",
    "07_package/*",
    ...FULL_PIPELINE_CANONICAL_OUTPUTS,
  ],
} as const;
