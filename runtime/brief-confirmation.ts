import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Readable, Writable } from "node:stream";
import type { BriefAudioPolicy, BriefCaptionPolicy, CreativeBrief, EditBlueprint } from "./compiler/types.js";
import { resolveCaptionPolicy } from "./captions/timeline-captions.js";
import { loadProfiles } from "./editorial/policy-resolver.js";

export interface BriefConfirmationOptions {
  skipConfirmations?: boolean;
  force?: boolean;
  input?: Readable;
  output?: Writable;
  now?: string;
  repoRoot?: string;
}

export interface BriefConfirmationResult {
  skipped: boolean;
  wrote: boolean;
  captionPolicy?: BriefCaptionPolicy;
  audioPolicy?: BriefAudioPolicy;
  source?: "interactive_prompt" | "non_interactive_default";
}

export async function confirmBriefDefaults(
  projectDir: string,
  options: BriefConfirmationOptions = {},
): Promise<BriefConfirmationResult> {
  const briefPath = path.join(projectDir, "01_intent/creative_brief.yaml");
  const blueprintPath = path.join(projectDir, "04_plan/edit_blueprint.yaml");
  if (!fs.existsSync(briefPath) || !fs.existsSync(blueprintPath)) {
    return { skipped: true, wrote: false };
  }

  const brief = parseYaml(fs.readFileSync(briefPath, "utf-8")) as CreativeBrief & {
    autonomy?: { skip_confirmations?: boolean };
    confirmation_provenance?: unknown;
  };
  if (options.skipConfirmations || brief.autonomy?.skip_confirmations === true) {
    return { skipped: true, wrote: false };
  }

  const blueprint = parseYaml(fs.readFileSync(blueprintPath, "utf-8")) as EditBlueprint;
  const repoRoot = options.repoRoot ?? findRepoRoot(projectDir);
  const defaultCaptionPolicy = resolveCaptionPolicy(brief, blueprint, repoRoot).mode;
  const defaultAudioPolicy = resolveAudioPolicyDefault(brief, blueprint, repoRoot);
  const needsWrite = options.force ||
    !brief.caption_policy ||
    !brief.audio_policy ||
    !brief.confirmation_provenance;
  if (!needsWrite) {
    return {
      skipped: true,
      wrote: false,
      captionPolicy: brief.caption_policy,
      audioPolicy: brief.audio_policy,
    };
  }

  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const interactive = Boolean(options.force) ||
    Boolean((input as typeof defaultInput).isTTY) ||
    Boolean(options.input);

  let captionPolicy = defaultCaptionPolicy;
  let audioPolicy = defaultAudioPolicy;
  let source: BriefConfirmationResult["source"] = "non_interactive_default";

  if (interactive) {
    source = "interactive_prompt";
    const captionQuestion = `テロップを付けますか? [auto/manual/off] (default: ${defaultCaptionPolicy}) `;
    const audioQuestion = `原音を活用しますか? [yes=ducking/no=bgm only] (default: ${defaultAudioPolicy === "bgm_only" ? "no" : "yes"}) `;
    if (!(input as typeof defaultInput).isTTY) {
      const answers = await readAllLines(input);
      output.write(captionQuestion);
      captionPolicy = parseCaptionAnswer(answers[0] ?? "", defaultCaptionPolicy);
      output.write(audioQuestion);
      audioPolicy = parseAudioAnswer(answers[1] ?? "", defaultAudioPolicy);
    } else {
      const rl = readline.createInterface({ input, output });
      try {
        captionPolicy = parseCaptionAnswer(
          await rl.question(captionQuestion),
          defaultCaptionPolicy,
        );
        audioPolicy = parseAudioAnswer(
          await rl.question(audioQuestion),
          defaultAudioPolicy,
        );
      } finally {
        rl.close();
      }
    }
  }

  const nextBrief = {
    ...brief,
    caption_policy: captionPolicy,
    audio_policy: audioPolicy,
    confirmation_provenance: {
      confirmed_at: options.now ?? new Date().toISOString(),
      source,
      caption_policy: captionPolicy,
      audio_policy: audioPolicy,
      questions: [
        "テロップを付けますか?",
        "原音を活用しますか?",
      ],
    },
  };
  fs.writeFileSync(briefPath, stringifyYaml(nextBrief), "utf-8");
  return { skipped: false, wrote: true, captionPolicy, audioPolicy, source };
}

async function readAllLines(input: Readable): Promise<string[]> {
  if (input === defaultInput && !(defaultInput as typeof defaultInput).isTTY) {
    return fs.readFileSync(0, "utf-8").split(/\r?\n/);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8").split(/\r?\n/);
}

function parseCaptionAnswer(answer: string, fallback: BriefCaptionPolicy): BriefCaptionPolicy {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "auto" || normalized === "a") return "auto";
  if (normalized === "manual" || normalized === "m") return "manual";
  if (normalized === "off" || normalized === "o" || normalized === "none" || normalized === "no") return "off";
  return fallback;
}

function parseAudioAnswer(answer: string, fallback: BriefAudioPolicy): BriefAudioPolicy {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "yes" || normalized === "y" || normalized === "ducking" || normalized === "duck") return "ducking";
  if (normalized === "no" || normalized === "n" || normalized === "bgm" || normalized === "bgm_only") return "bgm_only";
  if (normalized === "original_only" || normalized === "original") return "original_only";
  return fallback;
}

function resolveAudioPolicyDefault(
  brief: CreativeBrief,
  blueprint: EditBlueprint,
  repoRoot: string,
): BriefAudioPolicy {
  if (brief.audio_policy) return brief.audio_policy;
  const profileId = blueprint.resolved_profile?.id ?? brief.editorial?.profile_hint;
  if (profileId) {
    const profile = loadProfiles(path.join(repoRoot, "runtime/editorial/profiles")).get(profileId);
    if (profile?.defaults.audio_policy) return profile.defaults.audio_policy;
  }
  return "ducking";
}

function findRepoRoot(from: string): string {
  let dir = path.resolve(from);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "schemas"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
