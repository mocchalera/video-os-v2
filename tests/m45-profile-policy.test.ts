import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveProfileAndPolicy,
  clearRegistryCache,
  type ResolutionInput,
} from "../runtime/editorial/policy-resolver.js";
import * as path from "node:path";

const PROFILES_DIR = path.resolve("runtime/editorial/profiles");
const POLICIES_DIR = path.resolve("runtime/editorial/policies");

describe("Profile / Policy Resolution", () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  it("uses explicit profile_hint", () => {
    const input: ResolutionInput = {
      briefEditorial: { profile_hint: "lp-testimonial" },
    };
    const result = resolveProfileAndPolicy(input, PROFILES_DIR, POLICIES_DIR);
    expect(result.resolvedProfile.id).toBe("lp-testimonial");
    expect(result.resolvedProfile.source).toBe("explicit_hint");
  });

  it("uses explicit policy_hint", () => {
    const input: ResolutionInput = {
      briefEditorial: {
        profile_hint: "interview-highlight",
        policy_hint: "documentary",
      },
    };
    const result = resolveProfileAndPolicy(input, PROFILES_DIR, POLICIES_DIR);
    expect(result.resolvedPolicy.id).toBe("documentary");
    expect(result.resolvedPolicy.source).toBe("explicit_hint");
  });

  it("infers product-demo from screen_demo visual mode", () => {
    const input: ResolutionInput = {
      briefEditorial: { allow_inference: true },
      editorialSummary: { dominant_visual_mode: "screen_demo" },
    };
    const result = resolveProfileAndPolicy(input, PROFILES_DIR, POLICIES_DIR);
    expect(result.resolvedProfile.id).toBe("product-demo");
    expect(result.resolvedProfile.source).toBe("inferred");
    expect(result.resolvedPolicy.id).toBe("tutorial");
  });

  it("infers interview-highlight from solo_primary + 16:9 + 60s", () => {
    const input: ResolutionInput = {
      briefEditorial: {
        aspect_ratio: "16:9",
        allow_inference: true,
      },
      editorialSummary: { speaker_topology: "solo_primary" },
      runtimeTargetSec: 60,
    };
    const result = resolveProfileAndPolicy(input, PROFILES_DIR, POLICIES_DIR);
    expect(result.resolvedProfile.id).toBe("interview-highlight");
    expect(result.resolvedPolicy.id).toBe("interview");
  });

  it("infers lp-testimonial from aggressive + lp_embed + solo + short", () => {
    const input: ResolutionInput = {
      briefEditorial: {
        embed_context: "lp_embed",
        hook_priority: "aggressive",
        allow_inference: true,
      },
      editorialSummary: { speaker_topology: "solo_primary" },
      runtimeTargetSec: 45,
    };
    const result = resolveProfileAndPolicy(input, PROFILES_DIR, POLICIES_DIR);
    expect(result.resolvedProfile.id).toBe("lp-testimonial");
  });

  it("infers lecture-highlight from dense + long + credibility", () => {
    const input: ResolutionInput = {
      briefEditorial: {
        credibility_bias: "high",
        allow_inference: true,
      },
      editorialSummary: { transcript_density: "dense" },
      runtimeTargetSec: 120,
    };
    const result = resolveProfileAndPolicy(input, PROFILES_DIR, POLICIES_DIR);
    expect(result.resolvedProfile.id).toBe("lecture-highlight");
    expect(result.resolvedPolicy.id).toBe("tutorial");
  });

  it("infers event-recap from event_broll + high motion + 9:16", () => {
    const input: ResolutionInput = {
      briefEditorial: {
        aspect_ratio: "9:16",
        allow_inference: true,
      },
      editorialSummary: {
        dominant_visual_mode: "event_broll",
        motion_profile: "high",
      },
    };
    const result = resolveProfileAndPolicy(input, PROFILES_DIR, POLICIES_DIR);
    expect(result.resolvedProfile.id).toBe("event-recap");
    expect(result.resolvedPolicy.id).toBe("highlight");
  });

  it("infers vertical-short from 9:16 + aggressive + short", () => {
    const input: ResolutionInput = {
      briefEditorial: {
        aspect_ratio: "9:16",
        hook_priority: "aggressive",
        allow_inference: true,
      },
      runtimeTargetSec: 30,
    };
    const result = resolveProfileAndPolicy(input, PROFILES_DIR, POLICIES_DIR);
    expect(result.resolvedProfile.id).toBe("vertical-short");
  });

  it("falls back to default when inference fails", () => {
    const input: ResolutionInput = {
      briefEditorial: { allow_inference: true },
      editorialSummary: { dominant_visual_mode: "mixed" },
    };
    const result = resolveProfileAndPolicy(input, PROFILES_DIR, POLICIES_DIR);
    expect(result.resolvedProfile.source).toBe("default");
    expect(result.insufficientSignal).toBe(true);
  });

  it("returns insufficient signal when inference disabled and no hint", () => {
    const input: ResolutionInput = {
      briefEditorial: { allow_inference: false },
    };
    const result = resolveProfileAndPolicy(input, PROFILES_DIR, POLICIES_DIR);
    expect(result.insufficientSignal).toBe(true);
    expect(result.resolvedProfile.source).toBe("default");
  });

  it("provides profile defaults", () => {
    const input: ResolutionInput = {
      briefEditorial: { profile_hint: "interview-highlight" },
    };
    const result = resolveProfileAndPolicy(input, PROFILES_DIR, POLICIES_DIR);
    expect(result.profileDefaults).toBeDefined();
    expect(result.profileDefaults?.target_duration_sec).toBe(60);
    expect(result.profileDefaults?.active_editing_skills).toContain("build_to_peak");
  });

  it("provides policy definition", () => {
    const input: ResolutionInput = {
      briefEditorial: { profile_hint: "interview-highlight" },
    };
    const result = resolveProfileAndPolicy(input, PROFILES_DIR, POLICIES_DIR);
    expect(result.policyDefinition).toBeDefined();
    expect(result.policyDefinition?.id).toBe("interview");
    expect(result.policyDefinition?.preserve_natural_breath).toBe(true);
  });
});
