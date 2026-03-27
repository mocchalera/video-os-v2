import type { ClipRole, EditorLane, Marker } from '../types';
import { formatFrameLabel } from './time';

const ROLE_COLORS: Record<ClipRole, string> = {
  hero: '#3B82F6',
  support: '#60A5FA',
  transition: '#F59E0B',
  texture: '#818CF8',
  dialogue: '#22C55E',
  music: '#8B5CF6',
  nat_sound: '#34D399',
  ambient: '#6B7280',
  bgm: '#8B5CF6',
  title: '#F472B6',
};

const TRACK_COLORS: Record<string, string> = {
  V1: '#2563eb',  // blue-600
  V2: '#3b82f6',
  V3: '#60a5fa',
  A1: '#f59e0b',  // amber-500
  A2: '#d97706',
  A3: '#b45309',
  A4: '#92400e',
};

/** Track-kind base colors per design spec Phase 5 */
const TRACK_KIND_COLORS: Record<string, string> = {
  video: '#2563eb',    // blue-600
  audio: '#f59e0b',    // amber-500
  title: '#a855f7',    // purple-400
  caption: '#2dd4bf',  // teal-400
};

const LANE_FILLS = ['rgba(16, 23, 34, 0.96)', 'rgba(12, 18, 28, 0.96)'];

export interface DrawTimelineOptions {
  width: number;
  height: number;
  fps: number;
  pxPerFrame: number;
  totalFrames: number;
  rulerHeight: number;
  laneHeight: number;
  lanes: EditorLane[];
  markers: Marker[];
}

export function getRoleColor(role: ClipRole): string {
  return ROLE_COLORS[role] ?? '#6B7280';
}

export function getTrackColor(laneId: string, trackKind: 'video' | 'audio'): string {
  return TRACK_COLORS[laneId] ?? TRACK_KIND_COLORS[trackKind] ?? (trackKind === 'video' ? '#2563eb' : '#f59e0b');
}

export function hexToRgba(hex: string, alpha: number): string {
  const sanitized = hex.replace('#', '');
  const value =
    sanitized.length === 3
      ? sanitized
          .split('')
          .map((character) => `${character}${character}`)
          .join('')
      : sanitized;
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export function resizeCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  const devicePixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * devicePixelRatio);
  canvas.height = Math.floor(height * devicePixelRatio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  return context;
}

function getMajorTickStep(fps: number, pxPerFrame: number): number {
  const candidates = [
    1,
    Math.round(fps / 2),
    Math.round(fps),
    Math.round(fps * 2),
    Math.round(fps * 5),
    Math.round(fps * 10),
    Math.round(fps * 30),
    Math.round(fps * 60),
  ].filter((value, index, values) => value > 0 && values.indexOf(value) === index);

  return candidates.find((step) => step * pxPerFrame >= 96) ?? Math.round(fps * 120);
}

export function drawTimelineBackdrop(
  context: CanvasRenderingContext2D,
  options: DrawTimelineOptions,
): void {
  const {
    width,
    height,
    fps,
    pxPerFrame,
    totalFrames,
    rulerHeight,
    laneHeight,
    lanes,
    markers,
  } = options;

  context.clearRect(0, 0, width, height);
  context.fillStyle = '#0b1017';
  context.fillRect(0, 0, width, height);

  context.fillStyle = '#101722';
  context.fillRect(0, 0, width, rulerHeight);

  lanes.forEach((_, index) => {
    context.fillStyle = LANE_FILLS[index % LANE_FILLS.length];
    context.fillRect(0, rulerHeight + index * laneHeight, width, laneHeight);
  });

  const majorStep = getMajorTickStep(fps, pxPerFrame);
  const minorStep = Math.max(1, Math.round(majorStep / 2));

  context.font = '10px "Geist Mono", monospace';
  context.textBaseline = 'middle';

  for (let frame = 0; frame <= totalFrames + majorStep; frame += minorStep) {
    const x = Math.round(frame * pxPerFrame) + 0.5;
    const isMajor = frame % majorStep === 0;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.strokeStyle = isMajor
      ? 'rgba(148, 163, 184, 0.12)'
      : 'rgba(148, 163, 184, 0.04)';
    context.lineWidth = 1;
    context.stroke();

    if (isMajor) {
      context.beginPath();
      context.moveTo(x, rulerHeight - 6);
      context.lineTo(x, rulerHeight);
      context.strokeStyle = 'rgba(148, 163, 184, 0.28)';
      context.stroke();

      context.fillStyle = 'rgba(203, 213, 225, 0.58)';
      context.fillText(formatFrameLabel(frame, fps), x + 4, rulerHeight / 2);
    }
  }

  markers.forEach((marker) => {
    const x = Math.round(marker.frame * pxPerFrame) + 0.5;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.strokeStyle =
      marker.kind === 'beat'
        ? 'rgba(245, 158, 11, 0.42)'
        : 'rgba(248, 113, 113, 0.26)';
    context.setLineDash([4, 4]);
    context.stroke();
    context.setLineDash([]);

    context.fillStyle = 'rgba(251, 191, 36, 0.78)';
    context.font = '9px "Geist Mono", monospace';
    context.fillText(marker.label, x + 4, 10);
    context.font = '10px "Geist Mono", monospace';
  });

  for (let index = 0; index <= lanes.length; index += 1) {
    const y = rulerHeight + index * laneHeight + 0.5;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.strokeStyle = 'rgba(148, 163, 184, 0.07)';
    context.lineWidth = 1;
    context.stroke();
  }

  context.beginPath();
  context.moveTo(0, rulerHeight + 0.5);
  context.lineTo(width, rulerHeight + 0.5);
  context.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  context.stroke();
}
