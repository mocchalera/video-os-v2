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

function SliderField({
  label,
  value,
  min,
  max,
  step = 0.5,
  onChange,
}: SliderFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono text-xs text-slate-400">{value.toFixed(1)} dB</span>
      </div>
      <input
        className="range-input w-full"
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
    <label className="space-y-2">
      <span className="text-sm text-slate-300">{label}</span>
      <input
        className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 font-mono text-sm text-slate-50 outline-none transition focus:border-[#57a4ff]"
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
      <aside className="h-full rounded-2xl border border-white/10 bg-[color:var(--panel-bg)] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.25)]">
        <div className="font-mono text-xs uppercase tracking-[0.24em] text-slate-500">
          Properties
        </div>
        <h2 className="mt-3 text-lg font-semibold text-slate-50">No clip selected</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Click a clip on the timeline to inspect metadata, adjust gain, and edit fade
          parameters.
        </p>
      </aside>
    );
  }

  const audioPolicy = clip.audio_policy ?? {};

  return (
    <aside className="h-full rounded-2xl border border-white/10 bg-[color:var(--panel-bg)] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.25)]">
      <div className="font-mono text-xs uppercase tracking-[0.24em] text-slate-500">
        Properties
      </div>

      <div className="mt-4 rounded-2xl border border-white/8 bg-slate-950/45 p-4">
        <div className="font-mono text-xs uppercase tracking-[0.18em] text-slate-500">
          {clip.clip_id}
        </div>
        <div className="mt-2 text-lg font-semibold text-slate-50">{clip.motivation}</div>
        <div className="mt-3 grid gap-2 text-sm text-slate-400">
          <div className="flex justify-between gap-3">
            <span>Asset</span>
            <span className="font-mono text-slate-300">{clip.asset_id}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span>Role</span>
            <span className="font-mono text-slate-300">{clip.role}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span>Beat</span>
            <span className="font-mono text-slate-300">{clip.beat_id ?? '—'}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span>Source In</span>
            <span className="font-mono text-slate-300">
              {formatMicroseconds(clip.src_in_us, fps)}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span>Source Out</span>
            <span className="font-mono text-slate-300">
              {formatMicroseconds(clip.src_out_us, fps)}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span>Timeline</span>
            <span className="font-mono text-slate-300">
              {clip.timeline_in_frame}f / {clip.timeline_duration_frames}f
            </span>
          </div>
        </div>
      </div>

      <section className="mt-6 space-y-4">
        <div className="font-mono text-xs uppercase tracking-[0.2em] text-slate-500">
          Audio Policy
        </div>

        <SliderField
          label="Nat Gain"
          value={audioPolicy.nat_gain ?? 0}
          min={-96}
          max={12}
          onChange={(value) => onUpdateAudioNumber('nat_gain', value)}
        />

        <SliderField
          label="Nat Sound Gain"
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
          label="Duck Music"
          value={audioPolicy.duck_music_db ?? 0}
          min={-96}
          max={0}
          onChange={(value) => onUpdateAudioNumber('duck_music_db', value)}
        />
      </section>

      <section className="mt-6 grid gap-4">
        <div className="font-mono text-xs uppercase tracking-[0.2em] text-slate-500">
          Fade
        </div>

        <NumberField
          label="Fade In Frames"
          value={audioPolicy.fade_in_frames ?? 0}
          min={0}
          onChange={(value) => onUpdateAudioNumber('fade_in_frames', Math.max(0, value))}
        />

        <NumberField
          label="Fade Out Frames"
          value={audioPolicy.fade_out_frames ?? 0}
          min={0}
          onChange={(value) => onUpdateAudioNumber('fade_out_frames', Math.max(0, value))}
        />

        <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-slate-950/50 px-3 py-3 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={audioPolicy.preserve_nat_sound ?? false}
            onChange={(event) =>
              onUpdateAudioBoolean('preserve_nat_sound', event.target.checked)
            }
          />
          Preserve natural sound
        </label>
      </section>
    </aside>
  );
}
