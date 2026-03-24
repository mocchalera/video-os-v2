import type { ClipRole, EditorLane, Marker } from '../types';
import { formatFrameLabel } from './time';

const ROLE_COLORS: Record<ClipRole, string> = {
  hero: '#4a90d9',
  support: '#5bc0de',
  transition: '#f0ad4e',
  texture: '#8e7cc3',
  dialogue: '#5cb85c',
  music: '#2ecc71',
  nat_sound: '#e67e22',
  ambient: '#95a5a6',
  bgm: '#2ecc71',
  title: '#e74c3c',
};

const LANE_FILLS = ['rgba(15, 52, 96, 0.22)', 'rgba(13, 41, 75, 0.5)'];

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
  return ROLE_COLORS[role] ?? '#95a5a6';
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
  context.fillStyle = '#111827';
  context.fillRect(0, 0, width, height);

  context.fillStyle = 'rgba(14, 24, 45, 0.98)';
  context.fillRect(0, 0, width, rulerHeight);

  lanes.forEach((_, index) => {
    context.fillStyle = LANE_FILLS[index % LANE_FILLS.length];
    context.fillRect(0, rulerHeight + index * laneHeight, width, laneHeight);
  });

  const majorStep = getMajorTickStep(fps, pxPerFrame);
  const minorStep = Math.max(1, Math.round(majorStep / 2));

  context.font = '11px "Geist Mono", monospace';
  context.textBaseline = 'middle';

  for (let frame = 0; frame <= totalFrames + majorStep; frame += minorStep) {
    const x = Math.round(frame * pxPerFrame) + 0.5;
    const isMajor = frame % majorStep === 0;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.strokeStyle = isMajor
      ? 'rgba(130, 149, 196, 0.18)'
      : 'rgba(130, 149, 196, 0.08)';
    context.lineWidth = 1;
    context.stroke();

    if (isMajor) {
      context.fillStyle = 'rgba(208, 218, 240, 0.74)';
      context.fillText(formatFrameLabel(frame, fps), x + 6, rulerHeight / 2);
    }
  }

  markers.forEach((marker) => {
    const x = Math.round(marker.frame * pxPerFrame) + 0.5;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.strokeStyle =
      marker.kind === 'beat'
        ? 'rgba(255, 180, 86, 0.5)'
        : 'rgba(255, 92, 92, 0.34)';
    context.setLineDash([6, 6]);
    context.stroke();
    context.setLineDash([]);

    context.fillStyle = 'rgba(255, 218, 162, 0.9)';
    context.fillText(marker.label, x + 6, 12);
  });

  for (let index = 0; index <= lanes.length; index += 1) {
    const y = rulerHeight + index * laneHeight + 0.5;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.strokeStyle = 'rgba(120, 146, 194, 0.16)';
    context.lineWidth = 1;
    context.stroke();
  }

  context.beginPath();
  context.moveTo(0, rulerHeight + 0.5);
  context.lineTo(width, rulerHeight + 0.5);
  context.strokeStyle = 'rgba(120, 146, 194, 0.3)';
  context.stroke();
}
