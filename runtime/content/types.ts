export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue };

export type ContentElementKind =
  | "text"
  | "image"
  | "shape"
  | "svg"
  | "template"
  | "group";

export type ContentAnchor =
  | "top_left"
  | "top_center"
  | "top_right"
  | "center_left"
  | "center"
  | "center_right"
  | "bottom_left"
  | "bottom_center"
  | "bottom_right";

export type ContentRendererId = "ffmpeg" | "remotion" | "hyperframes";
export type ContentRendererHint = "auto" | ContentRendererId;

export interface ContentAnimationRef {
  preset: string;
  duration_frames?: number;
  delay_frames?: number;
}

export interface ContentElementLayout {
  anchor: ContentAnchor;
  x: number;
  y: number;
  width?: number;
  height?: number;
  scale: number;
  rotation_deg: number;
  opacity: number;
  safe_area: boolean;
  z_index: number;
}

export interface ContentElementV1 {
  version: "content-element/v1";
  element_id: string;
  kind: ContentElementKind;
  template_ref?: string;
  template_version?: string;
  props: Record<string, JSONValue>;
  layout: ContentElementLayout;
  animation?: {
    in?: ContentAnimationRef;
    loop?: ContentAnimationRef;
    out?: ContentAnimationRef;
  };
  renderer_hint?: ContentRendererHint;
}

export interface TimedContentElement {
  element: ContentElementV1;
  start_frame: number;
  duration_frames: number;
  track_index?: number;
}
