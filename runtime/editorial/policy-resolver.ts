// Profile / Policy Resolution
// Resolves editorial profile and policy from creative brief + editorial summary.
// Deterministic. No LLM calls.

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  EditorialSummary,
  ProfileDefinition,
  PolicyDefinition,
  ResolvedRef,
  ProfileDefaults,
} from "../compiler/types.js";

// ── Registry Loading ──────────────────────────────────────────────

const PROFILES_DIR = path.resolve(
  import.meta.url ? path.dirname(new URL(import.meta.url).pathname) : __dirname,
  "profiles",
);
const POLICIES_DIR = path.resolve(
  import.meta.url ? path.dirname(new URL(import.meta.url).pathname) : __dirname,
  "policies",
);

let profileCache: Map<string, ProfileDefinition> | null = null;
let policyCache: Map<string, PolicyDefinition> | null = null;

export function loadProfiles(dir?: string): Map<string, ProfileDefinition> {
  if (profileCache && !dir) return profileCache;
  const profileDir = dir ?? PROFILES_DIR;
  const map = new Map<string, ProfileDefinition>();
  if (!fs.existsSync(profileDir)) return map;
  for (const file of fs.readdirSync(profileDir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const raw = fs.readFileSync(path.join(profileDir, file), "utf-8");
    const def = parseYaml(raw) as ProfileDefinition;
    if (def.id) map.set(def.id, def);
  }
  if (!dir) profileCache = map;
  return map;
}

export function loadPolicies(dir?: string): Map<string, PolicyDefinition> {
  if (policyCache && !dir) return policyCache;
  const policyDir = dir ?? POLICIES_DIR;
  const map = new Map<string, PolicyDefinition>();
  if (!fs.existsSync(policyDir)) return map;
  for (const file of fs.readdirSync(policyDir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const raw = fs.readFileSync(path.join(policyDir, file), "utf-8");
    const def = parseYaml(raw) as PolicyDefinition;
    if (def.id) map.set(def.id, def);
  }
  if (!dir) policyCache = map;
  return map;
}

/** Clear cached registries (for testing) */
export function clearRegistryCache(): void {
  profileCache = null;
  policyCache = null;
}

// ── Editorial Brief Fields ────────────────────────────────────────

export interface EditorialBriefFields {
  distribution_channel?: string;
  aspect_ratio?: string;
  embed_context?: string;
  hook_priority?: string;
  credibility_bias?: string;
  profile_hint?: string;
  policy_hint?: string;
  allow_inference?: boolean;
}

export interface ResolutionInput {
  briefEditorial?: EditorialBriefFields;
  editorialSummary?: EditorialSummary;
  runtimeTargetSec?: number;
}

export interface ResolutionResult {
  resolvedProfile: ResolvedRef;
  resolvedPolicy: ResolvedRef;
  profileDefaults?: ProfileDefaults;
  policyDefinition?: PolicyDefinition;
  /** Set when inference couldn't determine profile */
  insufficientSignal?: boolean;
}

// ── Inference Table (Design Doc §3) ───────────────────────────────

interface InferenceRule {
  conditions: (input: ResolutionInput) => boolean;
  profileId: string;
}

const INFERENCE_RULES: InferenceRule[] = [
  {
    profileId: "product-demo",
    conditions: (i) =>
      i.editorialSummary?.dominant_visual_mode === "screen_demo",
  },
  {
    profileId: "interview-highlight",
    conditions: (i) =>
      i.editorialSummary?.speaker_topology === "solo_primary" &&
      i.briefEditorial?.aspect_ratio === "16:9" &&
      (i.runtimeTargetSec ?? 0) >= 40 &&
      (i.runtimeTargetSec ?? 0) <= 90 &&
      i.briefEditorial?.hook_priority !== "aggressive",
  },
  {
    profileId: "lp-testimonial",
    conditions: (i) =>
      i.editorialSummary?.speaker_topology === "solo_primary" &&
      i.briefEditorial?.embed_context === "lp_embed" &&
      i.briefEditorial?.hook_priority === "aggressive" &&
      (i.runtimeTargetSec ?? 999) <= 60,
  },
  {
    profileId: "lecture-highlight",
    conditions: (i) =>
      i.editorialSummary?.transcript_density === "dense" &&
      (i.runtimeTargetSec ?? 0) >= 90 &&
      i.briefEditorial?.credibility_bias === "high",
  },
  {
    profileId: "event-recap",
    conditions: (i) =>
      i.editorialSummary?.dominant_visual_mode === "event_broll" &&
      i.editorialSummary?.motion_profile === "high" &&
      i.briefEditorial?.aspect_ratio === "9:16",
  },
  {
    profileId: "vertical-short",
    conditions: (i) =>
      i.briefEditorial?.aspect_ratio === "9:16" &&
      (i.runtimeTargetSec ?? 999) <= 45 &&
      i.briefEditorial?.hook_priority === "aggressive",
  },
];

// ── Default Policy Mapping ────────────────────────────────────────

const PROFILE_TO_POLICY: Record<string, string> = {
  "interview-highlight": "interview",
  "interview-pro-highlight": "interview",
  "lp-testimonial": "interview",
  "lecture-highlight": "tutorial",
  "product-demo": "tutorial",
  "event-recap": "highlight",
  "vertical-short": "highlight",
};

// ── Resolution Logic ──────────────────────────────────────────────

export function resolveProfileAndPolicy(
  input: ResolutionInput,
  profilesDir?: string,
  policiesDir?: string,
): ResolutionResult {
  const profiles = loadProfiles(profilesDir);
  const policies = loadPolicies(policiesDir);

  // Step 1: Resolve profile
  let resolvedProfile: ResolvedRef;
  let profileDef: ProfileDefinition | undefined;

  // 1a. Explicit hint takes priority
  if (input.briefEditorial?.profile_hint) {
    const hintId = input.briefEditorial.profile_hint;
    profileDef = profiles.get(hintId);
    resolvedProfile = {
      id: hintId,
      source: "explicit_hint",
      rationale: `profile_hint="${hintId}" from creative brief`,
    };
  }
  // 1b. Inference from structured fields
  else if (input.briefEditorial?.allow_inference !== false) {
    const matchedRule = INFERENCE_RULES.find((r) => r.conditions(input));
    if (matchedRule) {
      profileDef = profiles.get(matchedRule.profileId);
      resolvedProfile = {
        id: matchedRule.profileId,
        source: "inferred",
        rationale: `Inferred from editorial summary and brief fields`,
      };
    } else {
      // No rule matched — insufficient signal
      resolvedProfile = {
        id: "interview-highlight",
        source: "default",
        rationale: "No matching inference rule; using default profile",
      };
      profileDef = profiles.get("interview-highlight");
      return {
        resolvedProfile,
        resolvedPolicy: {
          id: PROFILE_TO_POLICY["interview-highlight"] ?? "interview",
          source: "default",
          rationale: "Default policy for default profile",
        },
        profileDefaults: profileDef?.defaults,
        policyDefinition: policies.get("interview"),
        insufficientSignal: true,
      };
    }
  } else {
    // Inference not allowed and no hint
    resolvedProfile = {
      id: "interview-highlight",
      source: "default",
      rationale: "No profile_hint and allow_inference=false; using default",
    };
    profileDef = profiles.get("interview-highlight");
    return {
      resolvedProfile,
      resolvedPolicy: {
        id: "interview",
        source: "default",
        rationale: "Default policy for default profile",
      },
      profileDefaults: profileDef?.defaults,
      policyDefinition: policies.get("interview"),
      insufficientSignal: true,
    };
  }

  // Step 2: Resolve policy
  let resolvedPolicy: ResolvedRef;
  let policyDef: PolicyDefinition | undefined;

  if (input.briefEditorial?.policy_hint) {
    const policyHintId = input.briefEditorial.policy_hint;
    policyDef = policies.get(policyHintId);
    resolvedPolicy = {
      id: policyHintId,
      source: "explicit_hint",
      rationale: `policy_hint="${policyHintId}" from creative brief`,
    };
  } else {
    // Default from profile mapping
    const defaultPolicyId = profileDef?.default_policy
      ?? PROFILE_TO_POLICY[resolvedProfile.id ?? ""]
      ?? "interview";
    policyDef = policies.get(defaultPolicyId);
    resolvedPolicy = {
      id: defaultPolicyId,
      source: resolvedProfile.source === "explicit_hint" ? "inferred" : "default",
      rationale: `Default policy for profile "${resolvedProfile.id}"`,
    };
  }

  return {
    resolvedProfile,
    resolvedPolicy,
    profileDefaults: profileDef?.defaults,
    policyDefinition: policyDef,
  };
}
