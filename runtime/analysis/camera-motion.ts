const CAMERA_TERMS = /\bcamera\b/;
const MOTION_TERMS = /\b(adjusts?|adjusting|moves?|moving|motion|settles?|settling|stabili[sz]es?|stabili[sz]ing|shake|shakes|shaky|wobble|wobbles|wobbly|repositions?|repositioning)\b/;

export const MARLIN_CAMERA_MOTION_START_FLAG = "marlin_camera_motion_start";
export const MARLIN_CAMERA_MOTION_CONFIDENCE_PENALTY = 0.18;

export function describesCameraSetupMotion(description: string | undefined): boolean {
  if (!description) return false;
  const value = description.toLowerCase();
  return CAMERA_TERMS.test(value) && MOTION_TERMS.test(value);
}
