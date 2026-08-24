import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { AuthPrompt } from "@/components/AuthPrompt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { timelineDecisionEvidence } from "@/lib/timelineDecisionEvidence";
import { CheckCheck, ChevronLeft, ChevronRight, CircleCheckBig, GitCommitHorizontal, ImageIcon, Images, Minus, Pause, Play, Plus, RefreshCw, ShieldAlert, Timer, TriangleAlert, Volume2, ZoomIn } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type ProjectSummary = { id: number; name: string; audioDurationMs: number | null; sourceImageCount: number; sourcesAttached: boolean; analysisBlocker: string | null; narrationOriginalName?: string | null; imageSourcePath?: string | null; outputPath?: string | null };
type ReplaceTarget = { id: number; imageFilename: string | null; startMs: number; endMs: number };
type EditorSegment = { id: number; startMs: number; endMs: number; thumbnailUrl: string | null; imageFilename: string | null; narrationText: string; selectionReason: string; decisionType: "KEEP" | "CHANGE" | "SKIP" | "FALLBACK" };
type VisualSettings = { enabled: boolean; amountPercent: number; direction: "IN" | "OUT" | "AUTO"; crossfadeDurationMs: number };

export default function Timeline() {
  const { isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const projects = trpc.project.list.useQuery(undefined, { enabled: isAuthenticated });
  const [projectId, setProjectId] = useState(() => new URLSearchParams(window.location.search).get("project") ?? "");
  const [replaceTarget, setReplaceTarget] = useState<ReplaceTarget | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<number | null>(null);

  useEffect(() => {
    if (!projectId && projects.data?.length) {
      const selected = projects.data.find(project => project.sourcesAttached);
      if (selected) setProjectId(String(selected.id));
    }
  }, [projectId, projects.data]);
  useEffect(() => setReplaceTarget(null), [projectId]);

  const numericProjectId = Number(projectId);
  const hasValidProjectId = Number.isInteger(numericProjectId) && numericProjectId > 0;
  const input = useMemo(() => ({ projectId: numericProjectId }), [numericProjectId]);
  const review = trpc.timeline.review.useQuery(input, { enabled: hasValidProjectId, retry: false });
  const candidates = trpc.timeline.candidates.useQuery(input, { enabled: hasValidProjectId && Boolean(replaceTarget), retry: false });
  const approve = trpc.timeline.approve.useMutation({
    onSuccess: async () => {
      await utils.timeline.review.invalidate(input);
      toast.success("Timeline approved. Native FFmpeg handoff is now unlocked.");
    },
    onError: error => toast.error(error.message),
  });
  const replace = trpc.timeline.substituteImage.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.timeline.review.invalidate(input), utils.timeline.candidates.invalidate(input), utils.worker.renderHandoff.invalidate(input)]);
      setReplaceTarget(null);
      setSelectedCandidateId(null);
      toast.success("Image replaced. Timeline approval was revoked; review and approve again before rendering.");
    },
    onError: error => toast.error(error.message),
  });

  const selectedProject = projects.data?.find(project => project.id === Number(projectId)) as ProjectSummary | undefined;
  const approved = review.data?.approval.status === "approved";
  const selectedCandidate = candidates.data?.find(candidate => candidate.id === selectedCandidateId) ?? null;
  const openReplaceDialog = (segment: ReplaceTarget) => { setSelectedCandidateId(null); setReplaceTarget(segment); };
  const confirmReplacement = () => { if (replaceTarget && selectedCandidate) replace.mutate({ projectId: input.projectId, segmentId: replaceTarget.id, newImageAssetId: selectedCandidate.id }); };

  if (!isAuthenticated) return <div className="mx-auto max-w-6xl"><PageHeading /><AuthPrompt noun="timeline inspector" /></div>;
  return <div className="mx-auto max-w-[1480px] space-y-6">
    <PageHeading metadata={review.data?.metadata} />
    <section className="vs-surface flex flex-col gap-4 rounded-[1.5rem] p-5 md:flex-row md:items-center">
      <div className="flex-1"><p className="text-sm font-semibold text-slate-100">Choose a project to review</p><p className="mt-1 text-xs leading-5 text-slate-500">{review.data?.metadata ? `${review.data.metadata.selectedImageCount} of ${review.data.metadata.analyzedImageCount} analyzed images are in this sequence. ${review.data.metadata.candidateImageCount ? `${review.data.metadata.candidateImageCount} alternatives remain available if you want to replace a shot.` : "Every analyzed image is represented."}` : "Select a project to inspect its visuals, timing, and approval state."}</p></div>
      <select value={projectId} onChange={event => setProjectId(event.target.value)} className="vs-field w-full px-3 text-sm md:w-[280px]">
        <option value="" disabled>Select project</option>{projects.data?.map(project => <option key={project.id} value={String(project.id)} className="bg-[#152032]">{project.name}</option>)}
      </select>
    </section>
    {selectedProject ? <SourceStatus project={selectedProject} /> : null}
    {review.error ? <ReviewError message={review.error.message} /> : review.data?.segments.length ? <>
      <section className="flex flex-col gap-4 rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-5 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3"><span className={`grid h-10 w-10 place-items-center rounded-xl ${approved ? "bg-emerald-300/10 text-emerald-200" : "bg-amber-300/10 text-amber-100"}`}><CircleCheckBig className="h-5 w-5" /></span><div><p className="font-semibold text-white">{approved ? "Timeline approved for native rendering" : "Review and approve this visual edit"}</p><p className="mt-1 text-sm leading-6 text-slate-500">{approved ? `Approved ${review.data.approval.approvedAt ? new Date(review.data.approval.approvedAt).toLocaleString() : ""}. Replacing an image will revoke this approval before a new review.` : "Inspect every selected image, timing, rationale, and alternative. Approval is required before any MP4 handoff can be prepared."}</p></div></div>
        {approved ? <Badge className="w-fit border-0 bg-emerald-300/10 px-3 py-1.5 text-emerald-100 hover:bg-emerald-300/10">APPROVED</Badge> : <Button disabled={approve.isPending} onClick={() => approve.mutate(input)} className="bg-cyan-200 text-slate-950 hover:bg-cyan-100">{approve.isPending ? "Approving…" : "Approve timeline for render"}</Button>}
      </section>
      <EditorTimeline
        narrationUrl={review.data.narrationUrl}
        segments={review.data.segments}
        visualSettings={{ enabled: review.data.project.zoomEnabled, amountPercent: review.data.project.zoomAmountPercent, direction: review.data.project.zoomDirection, crossfadeDurationMs: review.data.project.crossfadeDurationMs }}
        onReplace={openReplaceDialog}
      />
    </> : review.isLoading ? <div className="h-72 animate-pulse rounded-[1.5rem] border border-white/[0.07] bg-white/[0.025]" /> : <EmptyReview project={selectedProject} onOpenProjects={() => setLocation("/projects")} onOpenProviders={() => setLocation("/gemini")} />}
    <CandidateDialog target={replaceTarget} candidates={candidates.data ?? []} loading={candidates.isLoading} selectedCandidateId={selectedCandidateId} pending={replace.isPending} onClose={() => { if (!replace.isPending) setReplaceTarget(null); }} onSelect={setSelectedCandidateId} onConfirm={confirmReplacement} />
  </div>;
}

function EditorTimeline({ narrationUrl, segments, visualSettings, onReplace }: { narrationUrl: string | null; segments: EditorSegment[]; visualSettings: VisualSettings; onReplace: (segment: ReplaceTarget) => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [viewScale, setViewScale] = useState(3);
  const [selectedId, setSelectedId] = useState<number>(segments[0]?.id ?? 0);
  const durationMs = Math.max(1, segments.at(-1)?.endMs ?? 1);
  const durationSeconds = durationMs / 1000;
  const innerWidth = Math.max(760, durationSeconds * viewScale);
  const matchingIndex = segments.findIndex(segment => time * 1000 >= segment.startMs && time * 1000 < segment.endMs);
  const currentIndex = matchingIndex >= 0 ? matchingIndex : Math.max(0, segments.length - 1);
  const current = segments[currentIndex] ?? segments[0];
  const selected = segments.find(segment => segment.id === selectedId) ?? current;
  const rulerTicks = useMemo(() => buildRulerTicks(durationMs), [durationMs]);
  const playheadLeft = Math.min(innerWidth, Math.max(0, time * viewScale));

  useEffect(() => { setSelectedId(segments[0]?.id ?? 0); setTime(0); }, [segments]);
  useEffect(() => {
    if (playing && viewport.current) {
      const view = viewport.current;
      const nextLeft = Math.max(0, playheadLeft - view.clientWidth * 0.45);
      if (playheadLeft < view.scrollLeft + 48 || playheadLeft > view.scrollLeft + view.clientWidth - 64) view.scrollTo({ left: nextLeft, behavior: "smooth" });
    }
  }, [playheadLeft, playing]);

  const seek = (seconds: number) => {
    const bounded = Math.max(0, Math.min(durationSeconds, seconds));
    if (audio.current) audio.current.currentTime = bounded;
    setTime(bounded);
  };
  const selectClip = (segment: EditorSegment) => { setSelectedId(segment.id); seek(segment.startMs / 1000); };
  const toggle = async () => {
    if (!audio.current) return;
    try { if (audio.current.paused) await audio.current.play(); else audio.current.pause(); }
    catch { toast.error("Audio preview could not start. Your saved Timeline is unchanged."); }
  };
  const moveSelection = (offset: number) => {
    const index = Math.max(0, Math.min(segments.length - 1, segments.findIndex(segment => segment.id === selected?.id) + offset));
    selectClip(segments[index]);
  };

  return <section className="overflow-hidden rounded-[1.5rem] border border-white/[0.08] bg-[#090f1b] shadow-[0_24px_80px_rgba(0,0,0,.26)]">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] bg-[#0d1523] px-4 py-3">
      <div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg border border-cyan-200/15 bg-cyan-200/[0.08] text-cyan-100"><GitCommitHorizontal className="h-4 w-4" /></span><div><p className="text-xs font-semibold text-slate-100">Visual sequence editor</p><p className="text-[10px] uppercase tracking-[.14em] text-slate-500">View only · original timing locked</p></div></div>
      <div className="flex items-center gap-2 text-[11px] text-slate-400"><span className="rounded-md border border-white/[0.08] bg-black/20 px-2 py-1 font-mono text-cyan-100">{formatTime(time * 1000)}</span><span className="text-slate-600">/</span><span className="font-mono">{formatTime(durationMs)}</span><span className="ml-2 hidden rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 sm:inline">{segments.length} visual clips</span></div>
    </div>

    <div className="grid min-h-[330px] lg:grid-cols-[minmax(0,1fr)_270px]">
      <div className="border-b border-white/[0.07] p-4 lg:border-b-0 lg:border-r">
        <div className="relative aspect-video overflow-hidden rounded-xl border border-white/[0.08] bg-black">
          {current ? <StorageThumbnail src={current.thumbnailUrl} alt={current.imageFilename ?? "Current timeline image"} className="h-full w-full object-contain" /> : null}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/55 to-transparent px-4 pb-3 pt-14">
            <div className="flex items-end justify-between gap-3"><div className="min-w-0"><p className="truncate text-xs font-semibold text-white">{current?.imageFilename ?? "Current visual"}</p><p className="mt-1 line-clamp-1 text-[11px] text-slate-300">{current?.narrationText ?? "Timeline narration"}</p></div><div className="flex gap-1.5">{visualSettings.enabled ? <Badge className="border border-cyan-100/20 bg-cyan-100/10 text-[9px] text-cyan-50 hover:bg-cyan-100/10"><ZoomIn className="mr-1 h-3 w-3" />{resolvedZoomDirection(visualSettings, currentIndex)}</Badge> : null}{visualSettings.crossfadeDurationMs > 0 ? <Badge className="border border-violet-100/20 bg-violet-100/10 text-[9px] text-violet-50 hover:bg-violet-100/10">FADE {formatSeconds(visualSettings.crossfadeDurationMs)}</Badge> : null}</div></div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-white/[0.07] bg-[#0d1523] px-3 py-2.5"><Button size="icon" onClick={toggle} disabled={!narrationUrl} className="h-8 w-8 bg-cyan-200 text-slate-950 hover:bg-cyan-100 disabled:opacity-50">{playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</Button><div className="min-w-0 flex-1"><input aria-label="Timeline preview position" type="range" min="0" max={durationSeconds} step="0.01" value={time} onChange={event => seek(Number(event.target.value))} className="h-1.5 w-full cursor-pointer accent-cyan-300" /><div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500"><span>{formatTime(time * 1000)}</span><span>{formatTime(durationMs)}</span></div></div><span className="hidden items-center gap-1.5 text-[10px] text-slate-500 sm:flex"><Volume2 className="h-3.5 w-3.5 text-cyan-200" />Narration preview</span></div>
        <audio ref={audio} src={narrationUrl ?? undefined} onTimeUpdate={event => setTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      </div>

      <aside className="flex min-w-0 flex-col bg-[#0c1320] p-4"><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-slate-500">Selected clip</p>{selected ? <><div className="mt-3 overflow-hidden rounded-lg border border-white/[0.08] bg-black/20"><div className="aspect-video"><StorageThumbnail src={selected.thumbnailUrl} alt={selected.imageFilename ?? "Selected timeline image"} className="h-full w-full object-cover" /></div><div className="p-3"><p className="truncate text-xs font-semibold text-slate-100">{selected.imageFilename ?? "Selected visual"}</p><p className="mt-1 font-mono text-[10px] text-cyan-100">{formatTime(selected.startMs)} — {formatTime(selected.endMs)} <span className="text-slate-500">·</span> {formatSeconds(selected.endMs - selected.startMs)}</p><p className="mt-2 line-clamp-3 text-[11px] leading-5 text-slate-400">{selected.narrationText}</p></div></div><div className="mt-3 flex items-center justify-between text-[10px] text-slate-500"><span>{timelineDecisionEvidence(selected.selectionReason)}</span><Badge className="border border-white/[0.07] bg-white/[0.04] text-[9px] text-slate-400 hover:bg-white/[0.04]">{selected.decisionType}</Badge></div><Button variant="outline" size="sm" onClick={() => onReplace({ id: selected.id, imageFilename: selected.imageFilename, startMs: selected.startMs, endMs: selected.endMs })} className="mt-3 border-white/10 text-slate-200 hover:bg-white/[0.06] hover:text-white"><RefreshCw className="mr-2 h-3.5 w-3.5" />Replace image</Button><div className="mt-auto flex gap-2 pt-4"><Button variant="outline" size="sm" onClick={() => moveSelection(-1)} disabled={segments[0]?.id === selected.id} className="flex-1 border-white/10 text-slate-300 hover:bg-white/[0.06]"><ChevronLeft className="mr-1 h-3.5 w-3.5" />Previous</Button><Button variant="outline" size="sm" onClick={() => moveSelection(1)} disabled={segments.at(-1)?.id === selected.id} className="flex-1 border-white/10 text-slate-300 hover:bg-white/[0.06]">Next<ChevronRight className="ml-1 h-3.5 w-3.5" /></Button></div></> : null}</aside>
    </div>

    <div className="border-t border-white/[0.08] bg-[#060b14] p-3 sm:p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.14em] text-slate-500"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-cyan-300" />Visual track</span><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-emerald-300" />Narration timing</span>{visualSettings.crossfadeDurationMs > 0 ? <span className="flex items-center gap-1.5"><GitCommitHorizontal className="h-3 w-3 text-violet-200" />Crossfade markers</span> : null}</div><div className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-1"><span className="text-[10px] text-slate-500">Timeline view</span><Button variant="ghost" size="icon" aria-label="Zoom out timeline view" onClick={() => setViewScale(value => Math.max(0.5, value - 1))} className="h-6 w-6 text-slate-400 hover:bg-white/[0.08] hover:text-white"><Minus className="h-3.5 w-3.5" /></Button><span className="w-8 text-center font-mono text-[10px] text-cyan-100">{viewScale}px</span><Button variant="ghost" size="icon" aria-label="Zoom in timeline view" onClick={() => setViewScale(value => Math.min(12, value + 1))} className="h-6 w-6 text-slate-400 hover:bg-white/[0.08] hover:text-white"><Plus className="h-3.5 w-3.5" /></Button></div></div>
      <div ref={viewport} className="relative overflow-x-auto overscroll-x-contain rounded-lg border border-white/[0.08] bg-[#090f1b] pb-3" aria-label="Visual sequence timeline">
        <div className="relative" style={{ width: innerWidth }}>
      <div className="relative h-8 border-b border-white/[0.08] bg-[#0d1523]">{rulerTicks.map(tick => <div key={tick} className="absolute top-0 h-full border-l border-white/[0.12]" style={{ left: (tick / 1000) * viewScale }}><span className="absolute left-1 top-2 font-mono text-[9px] text-slate-500">{formatTime(tick)}</span></div>)}</div>
          <div className="relative h-[112px] border-b border-white/[0.07] bg-[linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] bg-[size:28px_100%]">
            <div className="absolute left-2 top-2 z-20 rounded bg-black/50 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[.14em] text-slate-400">V</div>
            {segments.map((segment, index) => <button type="button" key={segment.id} onClick={() => selectClip(segment)} onFocus={() => setSelectedId(segment.id)} title={`Clip ${index + 1}: ${formatTime(segment.startMs)}–${formatTime(segment.endMs)} · ${formatSeconds(segment.endMs - segment.startMs)} · ${timelineDecisionEvidence(segment.selectionReason)}`} className={`group absolute top-6 h-[78px] overflow-visible rounded-md border text-left shadow-lg transition-[transform,border-color,box-shadow] duration-150 focus:outline-none ${selected?.id === segment.id ? "z-10 border-cyan-200 ring-2 ring-cyan-200/40" : "border-white/15 hover:z-10 hover:-translate-y-0.5 hover:border-cyan-100/70 hover:shadow-cyan-500/15"}`} style={{ left: (segment.startMs / 1000) * viewScale, width: Math.max(42, ((segment.endMs - segment.startMs) / 1000) * viewScale) }}>
              <StorageThumbnail src={segment.thumbnailUrl} alt={segment.imageFilename ?? `Timeline clip ${index + 1}`} className="h-full w-full rounded-[5px] object-cover opacity-90 transition-opacity group-hover:opacity-100" />
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/50 to-transparent px-1.5 pb-1 pt-6"><span className="block truncate font-mono text-[9px] text-white">{formatSeconds(segment.endMs - segment.startMs)}</span></span>
              {visualSettings.enabled ? <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded bg-cyan-300 text-slate-950 shadow"><ZoomIn className="h-2.5 w-2.5" /></span> : null}
              {visualSettings.crossfadeDurationMs > 0 && index > 0 ? <span title={`Crossfade · ${formatSeconds(visualSettings.crossfadeDurationMs)}`} className="absolute -left-2 top-[31px] z-20 grid h-4 w-4 place-items-center rotate-45 rounded-[3px] border border-violet-100/70 bg-violet-300 shadow-[0_0_0_2px_rgba(6,11,20,.85)]"><GitCommitHorizontal className="h-2.5 w-2.5 -rotate-45 text-slate-950" /></span> : null}
            </button>)}
          </div>
          <div className="relative h-11 bg-[#07130f]">
            <div className="absolute left-2 top-3 z-20 rounded bg-black/45 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[.14em] text-emerald-100">A</div>
            {segments.map(segment => <button type="button" key={`audio-${segment.id}`} aria-label={`Seek narration to ${formatTime(segment.startMs)}`} onClick={() => selectClip(segment)} className="absolute top-3 h-5 rounded-sm border border-emerald-100/15 bg-emerald-300/30 transition hover:bg-emerald-200/55 focus:outline-none focus:ring-2 focus:ring-emerald-200/70" style={{ left: (segment.startMs / 1000) * viewScale, width: Math.max(4, ((segment.endMs - segment.startMs) / 1000) * viewScale - 1) }} />)}
          </div>
          <div aria-hidden="true" className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-amber-300 shadow-[0_0_0_1px_rgba(251,191,36,.18),0_0_12px_rgba(251,191,36,.75)]" style={{ left: playheadLeft }}><span className="absolute -left-[4px] -top-1 h-2 w-2 rotate-45 bg-amber-300" /></div>
        </div>
      </div>
      <p className="mt-2 px-1 text-[10px] leading-4 text-slate-500">The editor view uses the saved clip boundaries and narration coverage exactly as generated. Timeline view zoom, clip selection, and seeking affect only this review interface.</p>
    </div>
  </section>;
}

function CandidateDialog({ target, candidates, loading, selectedCandidateId, pending, onClose, onSelect, onConfirm }: { target: ReplaceTarget | null; candidates: Array<{ id: number; originalFilename: string; sequenceNumber: number | null; thumbnailUrl: string; sceneDescription: string | null }>; loading: boolean; selectedCandidateId: number | null; pending: boolean; onClose: () => void; onSelect: (id: number) => void; onConfirm: () => void }) {
  const selected = candidates.find(candidate => candidate.id === selectedCandidateId) ?? null;
  return <Dialog open={Boolean(target)} onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto border-white/10 bg-[#0c1422] text-slate-100"><DialogHeader><DialogTitle className="flex items-center gap-2 text-xl"><Images className="h-5 w-5 text-cyan-200" />Choose from every source image</DialogTitle><DialogDescription className="max-w-3xl text-slate-400">The complete analyzed folder library is available, including images already used elsewhere in the timeline. Replace <span className="font-medium text-slate-200">{target?.imageFilename ?? "this selected image"}</span> for {target ? `${formatTime(target.startMs)}–${formatTime(target.endMs)}` : "this segment"}. The timing boundaries do not change. Selecting a new image revokes any existing approval and requires a fresh review before rendering.</DialogDescription></DialogHeader>
    {loading ? <div className="grid min-h-64 place-items-center text-sm text-slate-500">Loading analyzed alternatives…</div> : candidates.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{candidates.map(candidate => <button type="button" key={candidate.id} onClick={() => onSelect(candidate.id)} className={`overflow-hidden rounded-xl border text-left transition ${candidate.id === selectedCandidateId ? "border-cyan-200 bg-cyan-200/[0.08] ring-2 ring-cyan-200/25" : "border-white/[0.08] bg-white/[0.025] hover:border-white/20 hover:bg-white/[0.05]"}`}><div className="aspect-video bg-[#080c15]"><StorageThumbnail src={candidate.thumbnailUrl} alt={candidate.originalFilename} className="h-full w-full object-cover" /></div><div className="p-3"><div className="flex items-center justify-between gap-2"><span className="truncate font-mono text-[10px] text-cyan-100">#{candidate.sequenceNumber ?? "—"}</span>{candidate.id === selectedCandidateId ? <CheckCheck className="h-3.5 w-3.5 text-cyan-200" /> : null}</div><p className="mt-1 truncate text-xs font-medium text-slate-100">{candidate.originalFilename}</p><p className="mt-1 line-clamp-3 text-[11px] leading-4 text-slate-500">{candidate.sceneDescription ?? "Genuine provider analysis is available; no scene description was returned."}</p></div></button>)}</div> : <div className="rounded-xl border border-dashed border-white/10 px-6 py-14 text-center text-sm text-slate-500">No unselected analyzed images are available for this timeline.</div>}
    <DialogFooter className="border-t border-white/[0.07] pt-4 sm:justify-between"><p className="hidden max-w-xl text-xs leading-5 text-amber-100/70 sm:block">This is a manual visual substitution. It preserves the validated duration and narration boundaries, but your approval must be renewed.</p><div className="flex gap-2"><Button variant="outline" disabled={pending} onClick={onClose} className="border-white/10 text-slate-300 hover:bg-white/[0.06] hover:text-white">Cancel</Button><Button disabled={!selected || pending} onClick={onConfirm} className="bg-cyan-200 text-slate-950 hover:bg-cyan-100">{pending ? "Replacing…" : "Use selected image"}</Button></div></DialogFooter>
  </DialogContent></Dialog>;
}

function PageHeading({ metadata }: { metadata?: { provider: string | null; model: string | null; analyzedImageCount: number; selectedImageCount: number; candidateImageCount: number } }) { const providerName = metadata?.provider === "groq" ? "Groq" : metadata?.provider === "gemini" ? "Gemini" : "AI provider"; return <section className="vs-surface rounded-[1.5rem] p-6 md:p-8"><p className="vs-kicker">Timeline review</p><h1 className="vs-page-title mt-2">Review the timing before you render.</h1><p className="vs-page-copy mt-3 max-w-3xl">Confirm the selected images, narration boundaries, and timing for every shot. {metadata ? `${metadata.selectedImageCount} of ${metadata.analyzedImageCount} source images are selected by ${providerName}.${metadata.candidateImageCount ? ` ${metadata.candidateImageCount} alternatives are still available for manual review.` : ""}` : "Choose a project to load its review details."} Approval unlocks the local render handoff; it never starts a render automatically.</p><div className="mt-5 flex flex-wrap gap-2"><Badge className="border border-emerald-300/10 bg-emerald-300/[0.07] text-emerald-100 hover:bg-emerald-300/[0.07]"><CheckCheck className="mr-1.5 h-3.5 w-3.5" />No gaps</Badge><Badge className="border border-emerald-300/10 bg-emerald-300/[0.07] text-emerald-100 hover:bg-emerald-300/[0.07]"><CheckCheck className="mr-1.5 h-3.5 w-3.5" />No overlaps</Badge><Badge className="border border-emerald-300/10 bg-emerald-300/[0.07] text-emerald-100 hover:bg-emerald-300/[0.07]"><CheckCheck className="mr-1.5 h-3.5 w-3.5" />Full audio coverage</Badge></div></section>; }
function SourceStatus({ project }: { project: ProjectSummary }) { return <section className="rounded-[1.25rem] border border-white/[0.07] bg-[#101827] p-5"><div className="flex items-center justify-between gap-4"><div><p className="text-sm font-semibold text-slate-100">{project.name} source readiness</p><p className="mt-1 text-xs leading-5 text-slate-500">{project.audioDurationMs ? `${formatTime(project.audioDurationMs)} narration · ${project.sourceImageCount} real source images` : "Media duration is pending."}</p></div>{project.analysisBlocker ? <div className="flex max-w-lg items-start gap-2 rounded-xl border border-amber-200/10 bg-amber-200/[0.045] p-3 text-xs leading-5 text-amber-100/75"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{project.analysisBlocker}</div> : null}</div></section>; }
function EmptyReview({ project, onOpenProjects, onOpenProviders }: { project?: ProjectSummary; onOpenProjects: () => void; onOpenProviders: () => void }) { const sourceDetailsMissing = project && !project.sourcesAttached; const analysisBlocked = Boolean(project?.sourcesAttached && project.analysisBlocker); return <section className="rounded-[1.5rem] border border-dashed border-white/10 bg-white/[0.018] px-6 py-14 text-center"><ShieldAlert className="mx-auto h-7 w-7 text-cyan-200" /><h2 className="mt-4 text-lg font-semibold text-white">{sourceDetailsMissing ? "Add project source details first" : analysisBlocked ? "Analysis is waiting for Groq capacity" : "No validated timeline available"}</h2><p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">{sourceDetailsMissing ? `“${project?.name}” is still a draft: it has no narration asset, image collection, duration, or analysis results. A timeline cannot be generated until you register its narration file, image-folder path, and output folder, then attach and analyze the real media.` : analysisBlocked ? project?.analysisBlocker : "A native handoff remains locked until real source media has been analyzed and a continuous timeline has been generated and reviewed."}</p>{sourceDetailsMissing ? <Button onClick={onOpenProjects} className="mt-5 bg-cyan-200 text-slate-950 hover:bg-cyan-100">Set up project sources</Button> : analysisBlocked ? <Button onClick={onOpenProviders} className="mt-5 bg-violet-300 text-slate-950 hover:bg-violet-200">Open AI Providers</Button> : null}</section>; }
function ReviewError({ message }: { message: string }) { return <section className="rounded-[1.5rem] border border-rose-200/15 bg-rose-200/[0.045] px-6 py-10 text-center"><ShieldAlert className="mx-auto h-7 w-7 text-rose-100" /><h2 className="mt-4 text-lg font-semibold text-white">Timeline review could not be loaded</h2><p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-rose-100/70">{message}</p><p className="mx-auto mt-2 max-w-2xl text-xs leading-5 text-slate-500">Refresh the page to restore your secure session, then reopen Timeline. The stored images and timing are unchanged.</p></section>; }
function StorageThumbnail({ src, alt, className }: { src: string | null; alt: string; className: string }) { const [failed, setFailed] = useState(false); if (!src || failed) return <div className="grid h-full w-full place-items-center bg-[#080c15] text-slate-500" role="img" aria-label={`${alt} thumbnail unavailable`}><ImageIcon className="h-6 w-6" /></div>; return <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />; }
function buildRulerTicks(durationMs: number) { const step = durationMs <= 90_000 ? 10_000 : durationMs <= 8 * 60_000 ? 30_000 : durationMs <= 30 * 60_000 ? 120_000 : 300_000; const ticks: number[] = []; for (let value = 0; value <= durationMs; value += step) ticks.push(value); if (ticks.at(-1) !== durationMs) ticks.push(durationMs); return ticks; }
function resolvedZoomDirection(settings: VisualSettings, index: number) { if (settings.direction !== "AUTO") return `ZOOM ${settings.direction}`; return `ZOOM ${index % 2 === 0 ? "IN" : "OUT"}`; }
function formatSeconds(milliseconds: number) { return `${(milliseconds / 1000).toFixed(milliseconds % 1000 === 0 ? 0 : 1)}s`; }
function formatTime(milliseconds: number) { const seconds = milliseconds / 1000; return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`; }
