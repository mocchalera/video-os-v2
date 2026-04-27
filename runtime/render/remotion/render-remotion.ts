export interface RenderRemotionOptions {
  timelinePath: string;
  sourceMap: Record<string, string>;
  outputPath: string;
}

export async function renderRemotionAssembly(
  _opts: RenderRemotionOptions,
): Promise<{ assemblyPath: string }> {
  throw new Error("renderRemotionAssembly: not yet implemented (Phase C3)");
}

