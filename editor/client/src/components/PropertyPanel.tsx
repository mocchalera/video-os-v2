import type { ReactNode } from 'react';
import type { AudioPolicy, Clip } from '../types';
import { formatMicroseconds } from '../utils/time';

interface PropertyPanelProps {
  clip: Clip | null;
  fps: number;
  onUpdateAudioNumber: (field: keyof AudioPolicy, value: number) => void;
  onUpdateAudioBoolean: (field: keyof AudioPolicy, value: boolean) => void;
}

interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}

function PanelSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-white/[0.06] px-5 py-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
        {title}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step = 0.5,
  onChange,
}: SliderFieldProps) {
  return (
    <div>
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-[color:var(--text-muted)]">{label}</span>
        <span className="font-mono text-[11px] text-neutral-300">{value.toFixed(1)} dB</span>
      </div>
      <input
        className="range-input mt-2 w-full"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-[color:var(--text-muted)]">{label}</span>
      <input
        className="w-20 border border-white/[0.06] bg-transparent px-2 py-1 text-right font-mono text-[11px] text-neutral-100 outline-none transition focus:border-[var(--accent)]"
        type="number"
        min={min}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export default function PropertyPanel({
  clip,
  fps,
  onUpdateAudioNumber,
  onUpdateAudioBoolean,
}: PropertyPanelProps) {
  if (!clip) {
    return (
      <aside className="flex h-full min-h-0 flex-col bg-transparent">
        <div className="border-b border-white/[0.06] px-5 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-[color:var(--text-subtle)]">
            Inspector
          </div>
        </div>

        <div className="flex min-h-0 flex-1 items-center px-5 py-5">
          <div className="w-full">
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--text-subtle)]">
              No clip selected
            </div>
            <div className="mt-3 text-[18px] font-semibold tracking-tight text-neutral-300">
              Select a clip to inspect.
            </div>
            <p className="mt-2 text-[13px] leading-6 text-[color:var(--text-muted)]">
              Source bounds, audio mix, fade settings, and quality flags.
            </p>
          </div>
        </div>
      </aside>
    );
  }

  const audioPolicy = clip.audio_policy ?? {};

  return (
    <aside className="flex h-full min-h-0 flex-col bg-transparent">
      <div className="border-b border-white/[0.06] px-5 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-[color:var(--text-subtle)]">
          Inspector
        </div>
      </div>

      <div className="editor-scrollbar min-h-0 flex-1 overflow-y-auto">
        <PanelSection title="Clip Info">
          <div className="text-[17px] font-semibold leading-tight text-white">
            {clip.beat_id ? `${clip.beat_id} / ` : ''}
            {clip.motivation}
          </div>
          <div className="mt-2 font-mono text-[11px] text-[color:var(--text-subtle)]">
            {clip.clip_id}
          </div>

          <div className="mt-4 space-y-2 text-[12px]">
            <div className="flex justify-between gap-3">
              <span className="text-[color:var(--text-muted)]">Asset</span>
              <span className="font-mono text-neutral-100">{clip.asset_id}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-[color:var(--text-muted)]">Role</span>
              <span className="font-mono uppercase text-neutral-100">{clip.role}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-[color:var(--text-muted)]">Beat</span>
              <span className="font-mono text-neutral-100">{clip.beat_id ?? '\u2014'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-[color:var(--text-muted)]">Source In</span>
              <span className="font-mono text-neutral-100">
                {formatMicroseconds(clip.src_in_us, fps)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-[color:var(--text-muted)]">Source Out</span>
              <span className="font-mono text-neutral-100">
                {formatMicroseconds(clip.src_out_us, fps)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-[color:var(--text-muted)]">Timeline</span>
              <span className="font-mono text-neutral-100">
                {clip.timeline_in_frame}f / {clip.timeline_duration_frames}f
              </span>
            </div>
          </div>
        </PanelSection>

        <PanelSection title="Audio">
          <div className="space-y-4">
            <SliderField
              label="Nat Gain"
              value={audioPolicy.nat_gain ?? 0}
              min={-96}
              max={12}
              onChange={(value) => onUpdateAudioNumber('nat_gain', value)}
            />

            <SliderField
              label="Nat Sound"
              value={audioPolicy.nat_sound_gain ?? 0}
              min={-96}
              max={12}
              onChange={(value) => onUpdateAudioNumber('nat_sound_gain', value)}
            />

            <SliderField
              label="BGM Gain"
              value={audioPolicy.bgm_gain ?? 0}
              min={-96}
              max={12}
              onChange={(value) => onUpdateAudioNumber('bgm_gain', value)}
            />

            <SliderField
              label="Duck"
              value={audioPolicy.duck_music_db ?? 0}
              min={-96}
              max={0}
              onChange={(value) => onUpdateAudioNumber('duck_music_db', value)}
            />
          </div>
        </PanelSection>

        <PanelSection title="Fade">
          <div className="space-y-4">
            <NumberField
              label="Fade In"
              value={audioPolicy.fade_in_frames ?? 0}
              min={0}
              onChange={(value) =>
                onUpdateAudioNumber('fade_in_frames', Math.max(0, value))
              }
            />

            <NumberField
              label="Fade Out"
              value={audioPolicy.fade_out_frames ?? 0}
              min={0}
              onChange={(value) =>
                onUpdateAudioNumber('fade_out_frames', Math.max(0, value))
              }
            />

            <label className="flex items-center gap-3 py-1 text-[12px] text-neutral-200">
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={audioPolicy.preserve_nat_sound ?? false}
                onChange={(event) =>
                  onUpdateAudioBoolean('preserve_nat_sound', event.target.checked)
                }
              />
              Preserve nat sound
            </label>
          </div>
        </PanelSection>

        {(clip.confidence != null ||
          (clip.quality_flags && clip.quality_flags.length > 0)) && (
          <PanelSection title="Metadata">
            <div className="space-y-2 text-[12px]">
              {clip.confidence != null && (
                <div className="flex justify-between gap-3">
                  <span className="text-[color:var(--text-muted)]">Confidence</span>
                  <span className="font-mono text-neutral-100">
                    {(clip.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              )}
              {clip.quality_flags && clip.quality_flags.length > 0 && (
                <div className="flex justify-between gap-3">
                  <span className="text-[color:var(--text-muted)]">Flags</span>
                  <span className="font-mono text-neutral-100">
                    {clip.quality_flags.join(', ')}
                  </span>
                </div>
              )}
            </div>
          </PanelSection>
        )}
      </div>
    </aside>
  );
}
