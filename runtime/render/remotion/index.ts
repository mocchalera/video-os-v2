// @ts-ignore TSX files are type-checked by tsconfig.remotion.json.
export { CompositionRoot } from "./CompositionRoot.js";
// @ts-ignore TSX files are type-checked by tsconfig.remotion.json.
export { VideoTimeline } from "./VideoTimeline.js";
// @ts-ignore TSX files are type-checked by tsconfig.remotion.json.
export { OverlayTimeline } from "./OverlayTimeline.js";
// @ts-ignore TSX files are type-checked by tsconfig.remotion.json.
export { TextOverlayLayer } from "./components/TextOverlayLayer.js";
// @ts-ignore TSX files are type-checked by tsconfig.remotion.json.
export { TransitionLayer } from "./components/TransitionLayer.js";
export {
  REMOTION_COMPOSITION_ID,
  REMOTION_OVERLAY_COMPOSITION_ID,
  timelineToCompositionProps,
} from "./timeline-to-props.js";
export type { RemotionCompositionProps } from "./timeline-to-props.js";
export {
  renderRemotionContentLayer,
  renderRemotionAssembly,
} from "./render-remotion.js";
export type {
  RenderRemotionLayerOptions,
  RenderRemotionLayerResult,
  RenderRemotionOptions,
  RenderRemotionResult,
} from "./render-remotion.js";
export { remotionDesignTokens } from "./styles/design-tokens.js";
export {
  getOverlayText,
  overlayPresets,
  resolveOverlayPreset,
} from "./styles/overlay-presets.js";
export type {
  OverlayPreset,
  OverlayPresetProps,
} from "./styles/overlay-presets.js";
export {
  transitionPresets,
  resolveTransitionPreset,
} from "./styles/transition-presets.js";
export type {
  TransitionPreset,
  TransitionPresetProps,
} from "./styles/transition-presets.js";
export { preflightTransition } from "./preflight-transitions.js";
export type {
  PreflightClipInput,
  PreflightTransitionInput,
  TransitionPreflightResult,
} from "./preflight-transitions.js";
