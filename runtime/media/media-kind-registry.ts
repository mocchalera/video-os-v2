import * as path from "node:path";

export type MediaKind = "video" | "audio" | "image" | "sequence" | "unknown";
export type ConsumerImpact =
  | "none"
  | "status_only"
  | "triage_warn"
  | "planning_warn"
  | "planning_block"
  | "compile_block"
  | "package_block";

export interface MediaKindCapabilities {
  discovery: true;
  ingest: boolean;
  segment: boolean;
  analyze: boolean;
  plan: boolean;
  compile: boolean;
  render: boolean;
}

export interface MediaKindRegistration {
  kind: MediaKind;
  extensions: readonly string[];
  capabilities: Readonly<MediaKindCapabilities>;
  unsupportedReason: string | null;
  consumerImpact: ConsumerImpact;
}

const VIDEO_EXTENSIONS = [
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".mts", ".m2ts", ".ts",
  ".mxf", ".flv", ".wmv", ".mpg", ".mpeg", ".m4v", ".3gp",
] as const;
const AUDIO_EXTENSIONS = [".wav", ".mp3", ".m4a", ".aac"] as const;
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".heic"] as const;

const SUPPORTED_VIDEO_CAPABILITIES: MediaKindCapabilities = {
  discovery: true,
  ingest: true,
  segment: true,
  analyze: true,
  plan: true,
  compile: true,
  render: true,
};
const SUPPORTED_AUDIO_CAPABILITIES: MediaKindCapabilities = {
  discovery: true,
  ingest: true,
  segment: true,
  analyze: true,
  plan: true,
  compile: true,
  render: true,
};
const SUPPORTED_STILL_IMAGE_CAPABILITIES: MediaKindCapabilities = {
  discovery: true,
  ingest: true,
  segment: true,
  analyze: true,
  plan: true,
  compile: true,
  render: true,
};
const SUPPORTED_SEQUENCE_CAPABILITIES: MediaKindCapabilities = {
  discovery: true,
  ingest: true,
  segment: true,
  analyze: true,
  plan: true,
  compile: true,
  render: true,
};
const DISCOVERY_ONLY_CAPABILITIES: MediaKindCapabilities = {
  discovery: true,
  ingest: false,
  segment: false,
  analyze: false,
  plan: false,
  compile: false,
  render: false,
};

export const MEDIA_KIND_REGISTRY: Readonly<Record<MediaKind, MediaKindRegistration>> = Object.freeze({
  video: Object.freeze({
    kind: "video",
    extensions: VIDEO_EXTENSIONS,
    capabilities: Object.freeze(SUPPORTED_VIDEO_CAPABILITIES),
    unsupportedReason: null,
    consumerImpact: "none",
  }),
  audio: Object.freeze({
    kind: "audio",
    extensions: AUDIO_EXTENSIONS,
    capabilities: Object.freeze(SUPPORTED_AUDIO_CAPABILITIES),
    unsupportedReason: null,
    consumerImpact: "none",
  }),
  image: Object.freeze({
    kind: "image",
    extensions: IMAGE_EXTENSIONS,
    capabilities: Object.freeze(SUPPORTED_STILL_IMAGE_CAPABILITIES),
    unsupportedReason: null,
    consumerImpact: "none",
  }),
  sequence: Object.freeze({
    kind: "sequence",
    extensions: Object.freeze([]),
    capabilities: Object.freeze(SUPPORTED_SEQUENCE_CAPABILITIES),
    unsupportedReason: null,
    consumerImpact: "none",
  }),
  unknown: Object.freeze({
    kind: "unknown",
    extensions: Object.freeze([]),
    capabilities: Object.freeze(DISCOVERY_ONLY_CAPABILITIES),
    unsupportedReason: "unrecognized media extension",
    consumerImpact: "planning_block",
  }),
});

const EXTENSION_OWNER = new Map<string, MediaKind>();
for (const registration of Object.values(MEDIA_KIND_REGISTRY)) {
  for (const extension of registration.extensions) {
    const normalized = normalizeMediaExtension(extension);
    if (EXTENSION_OWNER.has(normalized)) {
      throw new Error(`Duplicate media extension owner: ${normalized}`);
    }
    EXTENSION_OWNER.set(normalized, registration.kind);
  }
}

export function normalizeMediaExtension(locator: string): string {
  const extension = locator.startsWith(".") && !locator.includes(path.sep)
    ? locator
    : path.extname(locator);
  return extension.normalize("NFC").toLowerCase();
}

export function classifyMediaKind(locator: string): MediaKindRegistration {
  const kind = EXTENSION_OWNER.get(normalizeMediaExtension(locator)) ?? "unknown";
  return MEDIA_KIND_REGISTRY[kind];
}

export function mediaKindForExtension(locator: string): MediaKind {
  return classifyMediaKind(locator).kind;
}

export function allRegisteredExtensions(): readonly string[] {
  return Object.freeze([...EXTENSION_OWNER.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
}
