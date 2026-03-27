import { useState, type ReactNode } from 'react';
import type { AudioPolicy, Clip, ReviewReportResponse } from '../types';
import { CONFIDENCE_HIGH, CONFIDENCE_MEDIUM } from '../types';
import type { BlueprintResponse } from '../hooks/useReview';
import { formatMicroseconds } from '../utils/time';
import AiDecisionPanel from './AiDecisionPanel';

type PanelTab = 'properties' | 'ai-context' | 'review';

interface PropertyPanelProps {
  clip: Clip | null;
  fps: number;
  reviewReport: ReviewReportResponse | null;
  blueprint: BlueprintResponse | null;
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

function confidenceBadge(confidence: number | undefined) {
  if (confidence == null) return null;
  const pct = (confidence * 100).toFixed(0);
  let bg: string;
  let textColor: string;
  if (confidence >= CONFIDENCE_HIGH) {
    bg = '#16a34a';
    textColor = '#fff';
  } else if (confidence >= CONFIDENCE_MEDIUM) {
    bg = '#ca8a04';
    textColor = '#fff';
  } else {
    bg = '#dc2626';
    textColor = '#fff';
  }
  return (
    <span
      className="inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-bold"
      style={{ background: bg, color: textColor }}
    >
      {pct}%
    </span>
  );
}

function PropertiesTab({
  clip,
  fps,
  onUpdateAudioNumber,
  onUpdateAudioBoolean,
}: {
  clip: Clip;
  fps: number;
  onUpdateAudioNumber: (field: keyof AudioPolicy, value: number) => void;
  onUpdateAudioBoolean: (field: keyof AudioPolicy, value: boolean) => void;
}) {
  const audioPolicy = clip.audio_policy ?? {};

  return (
    <>
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
    </>
  );
}

function AiContextTab({
  clip,
  reviewReport,
  blueprint,
}: {
  clip: Clip;
  reviewReport: ReviewReportResponse | null;
  blueprint: BlueprintResponse | null;
}) {
  const clipWeaknesses =
    reviewReport?.data?.weaknesses?.filter((w) => w.clip_id === clip.clip_id) ?? [];
  const clipWarnings =
    reviewReport?.data?.warnings?.filter((w) => w.clip_id === clip.clip_id) ?? [];
  const beatInfo = clip.beat_id
    ? blueprint?.data?.beats?.find((b) => b.beat_id === clip.beat_id)
    : null;

  return (
    <>
      <PanelSection title="AI Context">
        <div className="space-y-3 text-[12px]">
          <div>
            <div className="text-[color:var(--text-muted)]">Motivation</div>
            <div className="mt-1 text-[13px] leading-relaxed text-neutral-100">
              {clip.motivation}
            </div>
          </div>

          <div className="flex justify-between gap-3">
            <span className="text-[color:var(--text-muted)]">Confidence</span>
            <span>{confidenceBadge(clip.confidence) ?? <span className="font-mono text-neutral-400">{'\u2014'}</span>}</span>
          </div>

          <div className="flex justify-between gap-3">
            <span className="text-[color:var(--text-muted)]">Role</span>
            <span className="font-mono uppercase text-neutral-100">{clip.role}</span>
          </div>

          <div className="flex justify-between gap-3">
            <span className="text-[color:var(--text-muted)]">Beat ID</span>
            <span className="font-mono text-neutral-100">{clip.beat_id ?? '\u2014'}</span>
          </div>

          {beatInfo?.purpose ? (
            <div>
              <div className="text-[color:var(--text-muted)]">Beat Purpose</div>
              <div className="mt-1 text-[13px] leading-relaxed text-neutral-100">
                {beatInfo.purpose}
              </div>
            </div>
          ) : null}
        </div>
      </PanelSection>

      {clip.quality_flags && clip.quality_flags.length > 0 ? (
        <PanelSection title="Quality Flags">
          <div className="flex flex-wrap gap-1.5">
            {clip.quality_flags.map((flag) => (
              <span
                key={flag}
                className="rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-300"
              >
                {flag}
              </span>
            ))}
          </div>
        </PanelSection>
      ) : null}

      {clipWeaknesses.length > 0 ? (
        <PanelSection title="Review Weaknesses">
          <div className="space-y-2">
            {clipWeaknesses.map((w, i) => (
              <div
                key={i}
                className="rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px]"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="rounded-sm px-1 py-px text-[9px] font-bold uppercase"
                    style={{
                      background:
                        w.severity === 'critical'
                          ? '#dc2626'
                          : w.severity === 'major'
                            ? '#ea580c'
                            : '#ca8a04',
                      color: '#fff',
                    }}
                  >
                    {w.severity}
                  </span>
                </div>
                <div className="mt-1 text-neutral-200">{w.description}</div>
                {w.suggestion ? (
                  <div className="mt-1 text-[color:var(--text-muted)]">
                    Suggestion: {w.suggestion}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </PanelSection>
      ) : null}

      {clipWarnings.length > 0 ? (
        <PanelSection title="Review Warnings">
          <div className="space-y-2">
            {clipWarnings.map((w, i) => (
              <div
                key={i}
                className="rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px]"
              >
                <span className="font-mono text-[9px] uppercase text-amber-400">
                  {w.category}
                </span>
                <div className="mt-1 text-neutral-200">{w.description}</div>
              </div>
            ))}
          </div>
        </PanelSection>
      ) : null}
    </>
  );
}

function ReviewTab({
  reviewReport,
}: {
  reviewReport: ReviewReportResponse | null;
}) {
  const report = reviewReport?.data;

  if (!reviewReport?.exists || !report) {
    return (
      <PanelSection title="Review">
        <div className="text-[12px] text-[color:var(--text-muted)]">
          No review report available.
        </div>
      </PanelSection>
    );
  }

  const judgment = report.summary_judgment;
  const judgmentColor =
    judgment?.status === 'approved'
      ? '#16a34a'
      : judgment?.status === 'blocked'
        ? '#dc2626'
        : '#ca8a04';

  return (
    <>
      {judgment ? (
        <PanelSection title="Summary Judgment">
          <div className="flex items-center gap-2">
            <span
              className="rounded-sm px-1.5 py-0.5 text-[10px] font-bold uppercase"
              style={{ background: judgmentColor, color: '#fff' }}
            >
              {judgment.status}
            </span>
            {confidenceBadge(judgment.confidence)}
          </div>
          <div className="mt-2 text-[12px] leading-relaxed text-neutral-200">
            {judgment.rationale}
          </div>
        </PanelSection>
      ) : null}

      {report.strengths && report.strengths.length > 0 ? (
        <PanelSection title="Strengths">
          <ul className="space-y-1.5">
            {report.strengths.map((s, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[11px] leading-relaxed text-green-300"
              >
                <span className="mt-0.5 shrink-0 text-green-500">+</span>
                {s}
              </li>
            ))}
          </ul>
        </PanelSection>
      ) : null}

      {report.fatal_issues && report.fatal_issues.length > 0 ? (
        <PanelSection title="Fatal Issues">
          <div className="space-y-2">
            {report.fatal_issues.map((issue, i) => (
              <div
                key={i}
                className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300"
              >
                {issue}
              </div>
            ))}
          </div>
        </PanelSection>
      ) : null}

      {report.weaknesses && report.weaknesses.length > 0 ? (
        <PanelSection title="Weaknesses">
          <div className="space-y-2">
            {report.weaknesses.map((w, i) => (
              <div
                key={i}
                className="rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px]"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="rounded-sm px-1 py-px text-[9px] font-bold uppercase"
                    style={{
                      background:
                        w.severity === 'critical'
                          ? '#dc2626'
                          : w.severity === 'major'
                            ? '#ea580c'
                            : '#ca8a04',
                      color: '#fff',
                    }}
                  >
                    {w.severity}
                  </span>
                  {w.clip_id ? (
                    <span className="font-mono text-[9px] text-[color:var(--text-subtle)]">
                      {w.clip_id}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-neutral-200">{w.description}</div>
                {w.suggestion ? (
                  <div className="mt-1 text-[color:var(--text-muted)]">
                    Suggestion: {w.suggestion}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </PanelSection>
      ) : null}

      {report.warnings && report.warnings.length > 0 ? (
        <PanelSection title="Warnings">
          <div className="space-y-2">
            {report.warnings.map((w, i) => (
              <div
                key={i}
                className="rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px]"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded-sm bg-amber-600 px-1 py-px text-[9px] font-bold uppercase text-white">
                    {w.category}
                  </span>
                  {w.clip_id ? (
                    <span className="font-mono text-[9px] text-[color:var(--text-subtle)]">
                      {w.clip_id}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-neutral-200">{w.description}</div>
              </div>
            ))}
          </div>
        </PanelSection>
      ) : null}

      {report.recommended_next_pass ? (
        <PanelSection title="Recommended Next Pass">
          <div className="text-[12px] leading-relaxed text-neutral-200">
            {report.recommended_next_pass}
          </div>
        </PanelSection>
      ) : null}
    </>
  );
}

export default function PropertyPanel({
  clip,
  fps,
  reviewReport,
  blueprint,
  onUpdateAudioNumber,
  onUpdateAudioBoolean,
}: PropertyPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('properties');

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

  return (
    <aside className="flex h-full min-h-0 flex-col bg-transparent">
      <div className="border-b border-white/[0.06]">
        <div className="flex">
          <button
            type="button"
            className={`flex-1 px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-[0.22em] transition ${
              activeTab === 'properties'
                ? 'border-b-2 border-[var(--accent)] text-white'
                : 'text-[color:var(--text-subtle)] hover:text-neutral-300'
            }`}
            onClick={() => setActiveTab('properties')}
          >
            Properties
          </button>
          <button
            type="button"
            className={`flex-1 px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-[0.22em] transition ${
              activeTab === 'ai-context'
                ? 'border-b-2 border-[var(--accent)] text-white'
                : 'text-[color:var(--text-subtle)] hover:text-neutral-300'
            }`}
            onClick={() => setActiveTab('ai-context')}
          >
            AI Context
          </button>
          <button
            type="button"
            className={`flex-1 px-4 py-2.5 text-center font-mono text-[10px] uppercase tracking-[0.22em] transition ${
              activeTab === 'review'
                ? 'border-b-2 border-[var(--accent)] text-white'
                : 'text-[color:var(--text-subtle)] hover:text-neutral-300'
            }`}
            onClick={() => setActiveTab('review')}
          >
            Review
          </button>
        </div>
      </div>

      <div className="editor-scrollbar min-h-0 flex-1 overflow-y-auto">
        {activeTab === 'properties' ? (
          <>
            <PropertiesTab
              clip={clip}
              fps={fps}
              onUpdateAudioNumber={onUpdateAudioNumber}
              onUpdateAudioBoolean={onUpdateAudioBoolean}
            />
            {/* AI Decision collapsible section in NLE Inspector */}
            <AiDecisionPanel
              clip={clip}
              reviewReport={reviewReport}
              blueprint={blueprint}
              collapsible
            />
          </>
        ) : activeTab === 'ai-context' ? (
          <AiContextTab clip={clip} reviewReport={reviewReport} blueprint={blueprint} />
        ) : (
          <ReviewTab reviewReport={reviewReport} />
        )}
      </div>
    </aside>
  );
}
