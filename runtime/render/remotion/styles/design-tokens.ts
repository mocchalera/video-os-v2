export const remotionDesignTokens = {
  colors: {
    caption: {
      text: "#ffffff",
      shadow: "rgba(0, 0, 0, 0.65)",
      background: "rgba(0, 0, 0, 0.32)",
    },
    overlay: {
      text: "#ffffff",
      accent: "#00d4ff",
      panel: "rgba(10, 12, 16, 0.72)",
    },
  },
  fontSizes: {
    caption: 54,
    title: 72,
    lowerThird: 42,
    label: 30,
  },
  safeAreas: {
    "16:9": { top: 72, right: 96, bottom: 72, left: 96 },
    "9:16": { top: 96, right: 54, bottom: 96, left: 54 },
    "1:1": { top: 72, right: 72, bottom: 72, left: 72 },
    "4:5": { top: 84, right: 64, bottom: 84, left: 64 },
  },
  easings: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    emphasized: "cubic-bezier(0.2, 0, 0, 1.2)",
  },
  durations: {
    fastFrames: 8,
    standardFrames: 16,
    slowFrames: 28,
  },
} as const;

