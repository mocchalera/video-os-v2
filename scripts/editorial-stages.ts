import { runCompileTimeline } from "./compile-timeline.js";
import { renderRoughCut } from "./render-rough-cut.js";

export async function runEditorialCompile(projectDir: string): Promise<void> {
  await runCompileTimeline({
    projectPath: projectDir,
    skipPreview: true,
    skipConfirmations: true,
  });
}

export async function runEditorialRender(projectDir: string): Promise<void> {
  await renderRoughCut({
    projectPath: projectDir,
    noAudio: false,
  });
}
