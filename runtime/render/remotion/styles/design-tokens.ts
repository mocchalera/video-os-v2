export const remotionDesignTokens = {
  colors: {
    neutral: {
      white: "#ffffff",
      black: "#000000",
      transparent: "rgba(0, 0, 0, 0)",
      ink: "#f7f7f2",
      muted: "rgba(247, 247, 242, 0.74)",
      shadow: "rgba(0, 0, 0, 0.72)",
      scrim: "rgba(0, 0, 0, 0.34)",
    },
    caption: {
      text: "#ffffff",
      shadow: "rgba(0, 0, 0, 0.65)",
      background: "rgba(0, 0, 0, 0.32)",
    },
    overlay: {
      text: "#ffffff",
      mutedText: "rgba(255, 255, 255, 0.78)",
      shadow: "rgba(0, 0, 0, 0.78)",
      background: "rgba(0, 0, 0, 0.42)",
      accent: "#00d4ff",
      panel: "rgba(10, 12, 16, 0.72)",
      panelSoft: "rgba(10, 12, 16, 0.48)",
    },
  },
  fontFamilies: {
    heading:
      '"Helvetica Neue", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif',
    body:
      '"Helvetica Neue", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif',
    mono:
      '"SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
  },
  fontSizes: {
    caption: 54,
    title: 72,
    lowerThird: 42,
    kicker: 34,
    tag: 24,
    credit: 36,
    label: 30,
  },
  safeAreas: {
    "16:9": { top: 72, right: 96, bottom: 72, left: 96 },
    "9:16": { top: 96, right: 54, bottom: 96, left: 54 },
    "1:1": { top: 72, right: 72, bottom: 72, left: 72 },
    "4:5": { top: 84, right: 64, bottom: 84, left: 64 },
  },
  easings: {
    ease_in_out: "cubic-bezier(0.4, 0, 0.2, 1)",
    ease_out: "cubic-bezier(0, 0, 0.2, 1)",
    linear: "linear",
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    emphasized: "cubic-bezier(0.2, 0, 0, 1.2)",
  },
  durations: {
    fade_short: 10,
    fade_medium: 18,
    fade_long: 30,
    fastFrames: 8,
    standardFrames: 16,
    slowFrames: 28,
  },
} as const;
