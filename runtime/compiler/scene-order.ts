import type { AssembledTimeline, NormalizedBeat, TimelineClip, Track } from "./types.js";
import type { CompileVisualCache } from "./visual-cache.js";
import { cosineSimilarity } from "./visual-cache.js";

export interface SceneContinuityOrderResult {
  reorderedBeats: number;
  reorderedClips: number;
  averageVisualCoherenceBefore: number;
  averageVisualCoherenceAfter: number;
}

interface ClipWithIndex {
  clip: TimelineClip;
  index: number;
}

interface SceneCluster {
  key: string;
  firstIndex: number;
  clips: TimelineClip[];
}

const SCENE_CLUSTER_WINDOW_US = 30 * 60 * 1_000_000;

export function reorderAssembledSceneContinuity(
  assembled: AssembledTimeline,
  beats: NormalizedBeat[],
  cache: CompileVisualCache | null | undefined,
): SceneContinuityOrderResult {
  const beatOrder = beats.map((beat) => beat.beat_id);
  const totals: SceneContinuityOrderResult = {
    reorderedBeats: 0,
    reorderedClips: 0,
    averageVisualCoherenceBefore: 0.5,
    averageVisualCoherenceAfter: 0.5,
  };
  let scoredTracks = 0;

  for (const track of assembled.tracks.video) {
    const result = reorderTrackSceneContinuity(track, cache, beatOrder);
    totals.reorderedBeats += result.reorderedBeats;
    totals.reorderedClips += result.reorderedClips;
    if (track.clips.length > 1) {
      totals.averageVisualCoherenceBefore += result.averageVisualCoherenceBefore;
      totals.averageVisualCoherenceAfter += result.averageVisualCoherenceAfter;
      scoredTracks += 1;
    }
  }
  syncOriginalAudioMirrors(assembled);

  if (scoredTracks > 0) {
    totals.averageVisualCoherenceBefore = totals.averageVisualCoherenceBefore / scoredTracks;
    totals.averageVisualCoherenceAfter = totals.averageVisualCoherenceAfter / scoredTracks;
  }
  return totals;
}

export function reorderTrackSceneContinuity(
  track: Track,
  cache: CompileVisualCache | null | undefined,
  beatOrder: string[] = [],
): SceneContinuityOrderResult {
  const beforeScore = averageAdjacentVisualCoherence(track.clips, cache?.embeddings);
  const result: SceneContinuityOrderResult = {
    reorderedBeats: 0,
    reorderedClips: 0,
    averageVisualCoherenceBefore: beforeScore,
    averageVisualCoherenceAfter: beforeScore,
  };
  if (!cache || !hasSceneOrderingEvidence(cache) || track.clips.length <= 1) return result;

  const beatIndex = new Map(beatOrder.map((beatId, index) => [beatId, index]));
  const byBeat = new Map<string, TimelineClip[]>();
  for (const clip of track.clips) {
    const clips = byBeat.get(clip.beat_id) ?? [];
    clips.push(clip);
    byBeat.set(clip.beat_id, clips);
  }

  const orderedBeatIds = [...byBeat.keys()].sort((a, b) => {
    const beatDiff = (beatIndex.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (beatIndex.get(b) ?? Number.MAX_SAFE_INTEGER);
    if (beatDiff !== 0) return beatDiff;
    return firstTimelineFrame(byBeat.get(a) ?? []) - firstTimelineFrame(byBeat.get(b) ?? []);
  });

  const nextClips: TimelineClip[] = [];
  for (const beatId of orderedBeatIds) {
    const beatClips = byBeat.get(beatId) ?? [];
    const ordered = orderClipsBySceneContinuity(beatClips, cache);
    if (!sameClipOrder(beatClips, ordered)) {
      result.reorderedBeats += 1;
      result.reorderedClips += ordered.length;
    }
    retimeBeatClips(ordered);
    nextClips.push(...ordered);
  }

  track.clips.splice(0, track.clips.length, ...nextClips);
  result.averageVisualCoherenceAfter = averageAdjacentVisualCoherence(track.clips, cache.embeddings);
  return result;
}

export function orderClipsBySceneContinuity(
  clips: TimelineClip[],
  cache: CompileVisualCache | null | undefined,
): TimelineClip[] {
  if (!cache || !hasSceneOrderingEvidence(cache) || clips.length <= 1) return [...clips];

  const clusters = buildSceneClusters(clips, cache);
  if (clusters.length === 0) return [...clips];
  if (clusters.length === 1) return [...clusters[0].clips];

  const orderedClusters = greedyVisualClusterChain(clusters, cache);
  return orderedClusters.flatMap((cluster) => cluster.clips);
}

export function averageAdjacentVisualCoherence(
  clips: TimelineClip[],
  embeddings: Map<string, Float32Array> | undefined,
): number {
  if (clips.length <= 1 || !embeddings || embeddings.size === 0) return 0.5;
  let total = 0;
  let count = 0;
  for (let index = 0; index < clips.length - 1; index += 1) {
    total += clipVisualSimilarity(clips[index], clips[index + 1], embeddings);
    count += 1;
  }
  return count > 0 ? total / count : 0.5;
}

function buildSceneClusters(
  clips: TimelineClip[],
  cache: CompileVisualCache,
): SceneCluster[] {
  const withIndex = clips.map((clip, index) => ({ clip, index }));
  const timestamped = withIndex.filter((item) => cache.timestamps.has(item.clip.segment_id));
  const untimestamped = withIndex.filter((item) => !cache.timestamps.has(item.clip.segment_id));
  const clusters: SceneCluster[] = [];

  const byCamera = new Map<string, ClipWithIndex[]>();
  for (const item of timestamped) {
    const camera = cache.cameras.get(item.clip.segment_id) ?? "unknown";
    const items = byCamera.get(camera) ?? [];
    items.push(item);
    byCamera.set(camera, items);
  }

  for (const [camera, items] of byCamera) {
    const sorted = [...items].sort((a, b) =>
      timestampFor(a.clip, cache) - timestampFor(b.clip, cache) ||
      sourceOrder(a.clip, cache) - sourceOrder(b.clip, cache) ||
      a.index - b.index
    );
    let current: ClipWithIndex[] = [];
    let previousTimestamp: number | undefined;
    for (const item of sorted) {
      const timestamp = timestampFor(item.clip, cache);
      if (
        current.length > 0 &&
        previousTimestamp != null &&
        timestamp - previousTimestamp > SCENE_CLUSTER_WINDOW_US
      ) {
        clusters.push(makeCluster(`time:${camera}:${timestampFor(current[0].clip, cache)}`, current, cache));
        current = [];
      }
      current.push(item);
      previousTimestamp = timestamp;
    }
    if (current.length > 0) {
      clusters.push(makeCluster(`time:${camera}:${timestampFor(current[0].clip, cache)}`, current, cache));
    }
  }

  const byAsset = new Map<string, ClipWithIndex[]>();
  for (const item of untimestamped) {
    const assetId = cache.assetIds.get(item.clip.segment_id) ?? item.clip.asset_id;
    const items = byAsset.get(assetId) ?? [];
    items.push(item);
    byAsset.set(assetId, items);
  }

  for (const [assetId, items] of byAsset) {
    clusters.push(makeCluster(`asset:${assetId}`, items, cache));
  }

  return clusters.sort((a, b) => a.firstIndex - b.firstIndex || a.key.localeCompare(b.key));
}

function hasSceneOrderingEvidence(cache: CompileVisualCache): boolean {
  return cache.embeddings.size > 0 ||
    cache.timestamps.size > 0 ||
    cache.assetIds.size > 0 ||
    cache.sourceInUs.size > 0 ||
    cache.cameras.size > 0;
}

function makeCluster(
  key: string,
  items: ClipWithIndex[],
  cache: CompileVisualCache,
): SceneCluster {
  const sorted = [...items].sort((a, b) =>
    timestampForNullable(a.clip, cache) - timestampForNullable(b.clip, cache) ||
    a.clip.asset_id.localeCompare(b.clip.asset_id) ||
    sourceOrder(a.clip, cache) - sourceOrder(b.clip, cache) ||
    a.index - b.index
  );

  return {
    key,
    firstIndex: Math.min(...items.map((item) => item.index)),
    clips: sorted.map((item) => item.clip),
  };
}

function greedyVisualClusterChain(
  clusters: SceneCluster[],
  cache: CompileVisualCache,
): SceneCluster[] {
  const remaining = [...clusters].sort((a, b) => a.firstIndex - b.firstIndex || a.key.localeCompare(b.key));
  const ordered: SceneCluster[] = [];
  ordered.push(remaining.shift()!);

  while (remaining.length > 0) {
    const current = ordered[ordered.length - 1];
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const score = clusterVisualSimilarity(current, remaining[index], cache.embeddings);
      if (
        score > bestScore ||
        (score === bestScore && remaining[index].firstIndex < remaining[bestIndex].firstIndex)
      ) {
        bestScore = score;
        bestIndex = index;
      }
    }
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }

  return ordered;
}

function clusterVisualSimilarity(
  left: SceneCluster,
  right: SceneCluster,
  embeddings: Map<string, Float32Array>,
): number {
  const leftClip = [...left.clips].reverse().find((clip) => embeddings.has(clip.segment_id));
  const rightClip = right.clips.find((clip) => embeddings.has(clip.segment_id));
  if (!leftClip || !rightClip) return 0.5;
  return clipVisualSimilarity(leftClip, rightClip, embeddings);
}

function clipVisualSimilarity(
  left: TimelineClip,
  right: TimelineClip,
  embeddings: Map<string, Float32Array>,
): number {
  const leftVector = embeddings.get(left.segment_id);
  const rightVector = embeddings.get(right.segment_id);
  if (!leftVector || !rightVector) return 0.5;
  return cosineSimilarity(leftVector, rightVector);
}

function timestampFor(clip: TimelineClip, cache: CompileVisualCache): number {
  return cache.timestamps.get(clip.segment_id) ?? Number.MAX_SAFE_INTEGER;
}

function timestampForNullable(clip: TimelineClip, cache: CompileVisualCache): number {
  return cache.timestamps.get(clip.segment_id) ?? Number.MAX_SAFE_INTEGER;
}

function sourceOrder(clip: TimelineClip, cache: CompileVisualCache): number {
  return cache.sourceInUs.get(clip.segment_id) ?? clip.src_in_us;
}

function firstTimelineFrame(clips: TimelineClip[]): number {
  return clips.reduce((min, clip) => Math.min(min, clip.timeline_in_frame), Number.MAX_SAFE_INTEGER);
}

function retimeBeatClips(clips: TimelineClip[]): void {
  if (clips.length <= 1) return;
  let frame = Math.min(...clips.map((clip) => clip.timeline_in_frame));
  for (const clip of clips) {
    clip.timeline_in_frame = frame;
    frame += clip.timeline_duration_frames;
  }
}

function sameClipOrder(left: TimelineClip[], right: TimelineClip[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((clip, index) => clip.clip_id === right[index]?.clip_id);
}

function syncOriginalAudioMirrors(assembled: AssembledTimeline): void {
  const videoBySource = new Map<string, TimelineClip[]>();
  for (const track of assembled.tracks.video) {
    for (const clip of track.clips) {
      const clips = videoBySource.get(sourceRangeKey(clip)) ?? [];
      clips.push(clip);
      videoBySource.set(sourceRangeKey(clip), clips);
    }
  }

  for (const track of assembled.tracks.audio) {
    for (const clip of track.clips) {
      if (clip.motivation !== "original clip audio") continue;
      const matches = videoBySource.get(sourceRangeKey(clip));
      const videoClip = matches?.shift();
      if (!videoClip) continue;
      clip.timeline_in_frame = videoClip.timeline_in_frame;
      clip.timeline_duration_frames = videoClip.timeline_duration_frames;
      clip.beat_id = videoClip.beat_id;
    }
  }
}

function sourceRangeKey(clip: TimelineClip): string {
  return [
    clip.segment_id,
    clip.asset_id,
    clip.src_in_us,
    clip.src_out_us,
  ].join(":");
}
