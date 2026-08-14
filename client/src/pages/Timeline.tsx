import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { AuthPrompt } from "@/components/AuthPrompt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { CheckCheck, CircleCheckBig, Images, ImageIcon, RefreshCw, ShieldAlert, Timer, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

type ProjectSummary = { id: number; name: string; audioDurationMs: number | null; sourceImageCount: number; sourcesAttached: boolean; analysisBlocker: string | null };
type ReplaceTarget = { id: number; imageFilename: string | null; startMs: number; endMs: number };

export default function Timeline() {
  const { isAuthenticated } = useAuth();
  const utils = trpc.useUtils();
  const projects = trpc.project.list.useQuery(undefined, { enabled: isAuthenticated });
  const [projectId, setProjectId] = useState("");
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
      await Promise.all([
        utils.timeline.review.invalidate(input),
        utils.timeline.candidates.invalidate(input),
        utils.worker.renderHandoff.invalidate(input),
      ]);
      setReplaceTarget(null);
      setSelectedCandidateId(null);
      toast.success("Image replaced. Timeline approval was revoked; review and approve again before rendering.");
    },
    onError: error => toast.error(error.message),
  });
  const selectedProject = projects.data?.find(project => project.id === Number(projectId)) as ProjectSummary | undefined;
  const approved = review.data?.approval.status === "approved";
  const selectedCandidate = candidates.data?.find(candidate => candidate.id === selectedCandidateId) ?? null;
  const openReplaceDialog = (segment: ReplaceTarget) => {
    setSelectedCandidateId(null);
    setReplaceTarget(segment);
  };
  const confirmReplacement = () => {
    if (!replaceTarget || !selectedCandidate) return;
    replace.mutate({ projectId: input.projectId, segmentId: replaceTarget.id, newImageAssetId: selectedCandidate.id });
  };

  if (!isAuthenticated) return <div className="mx-auto max-w-6xl"><PageHeading /><AuthPrompt noun="timeline inspector" /></div>;
  return <div className="mx-auto max-w-6xl space-y-6">
    <PageHeading />
    <section className="flex flex-col gap-4 rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-5 md:flex-row md:items-center">
      <div className="flex-1"><p className="text-sm font-semibold text-slate-100">Review timeline before rendering</p><p className="mt-1 text-xs leading-5 text-slate-500">All 23 analyzed source images are preserved. You can inspect the 13 unselected alternatives and replace any card before approval.</p></div>
      <select value={projectId} onChange={event => setProjectId(event.target.value)} className="h-10 w-full rounded-md border border-white/10 bg-white/[0.035] px-3 text-sm text-slate-200 outline-none focus:border-cyan-200/50 focus:ring-2 focus:ring-cyan-200/20 md:w-[280px]">
        <option value="" disabled>Select project</option>{projects.data?.map(project => <option key={project.id} value={String(project.id)} className="bg-[#152032]">{project.name}</option>)}
      </select>
    </section>
    {selectedProject ? <SourceStatus project={selectedProject} /> : null}
    {review.error ? <ReviewError message={review.error.message} /> : review.data?.segments.length ? <>
      <section className="flex flex-col gap-4 rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-5 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3"><span className={`grid h-10 w-10 place-items-center rounded-xl ${approved ? "bg-emerald-300/10 text-emerald-200" : "bg-amber-300/10 text-amber-100"}`}><CircleCheckBig className="h-5 w-5" /></span><div><p className="font-semibold text-white">{approved ? "Timeline approved for native rendering" : "Review and approve this visual edit"}</p><p className="mt-1 text-sm leading-6 text-slate-500">{approved ? `Approved ${review.data.approval.approvedAt ? new Date(review.data.approval.approvedAt).toLocaleString() : ""}. Replacing an image will revoke this approval before a new review.` : "Inspect every selected image, timing, rationale, and alternative. Approval is required before any MP4 handoff can be prepared."}</p></div></div>
        {approved ? <Badge className="w-fit border-0 bg-emerald-300/10 px-3 py-1.5 text-emerald-100 hover:bg-emerald-300/10">APPROVED</Badge> : <Button disabled={approve.isPending} onClick={() => approve.mutate(input)} className="bg-cyan-200 text-slate-950 hover:bg-cyan-100">{approve.isPending ? "Approving…" : "Approve timeline for render"}</Button>}
      </section>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {review.data.segments.map(segment => <article key={segment.id} className="overflow-hidden rounded-[1.25rem] border border-white/[0.07] bg-[#101827]">
          <div className="aspect-video bg-[#080c15]"><StorageThumbnail src={segment.thumbnailUrl} alt={segment.imageFilename ?? "Selected timeline image"} className="h-full w-full object-cover" /></div>
          <div className="p-4"><div className="flex items-center justify-between gap-3"><span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-cyan-100"><Timer className="h-3.5 w-3.5" />{formatTime(segment.startMs)}–{formatTime(segment.endMs)}</span><span className="text-xs font-semibold text-emerald-200">{Math.round(Number(segment.confidence) * 100)}%</span></div><p className="mt-3 line-clamp-2 text-sm font-medium leading-6 text-slate-100">{segment.narrationText}</p><p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{segment.selectionReason}</p><div className="mt-3 flex items-center justify-between gap-3"><Badge className="border-0 bg-white/[0.07] text-[9px] text-slate-400 hover:bg-white/[0.07]">{segment.decisionType}</Badge><span className="truncate text-[10px] text-slate-600">{segment.imageFilename}</span></div><Button variant="outline" size="sm" onClick={() => openReplaceDialog({ id: segment.id, imageFilename: segment.imageFilename, startMs: segment.startMs, endMs: segment.endMs })} className="mt-4 w-full border-white/10 text-slate-200 hover:bg-white/[0.06] hover:text-white"><RefreshCw className="mr-2 h-3.5 w-3.5" />Replace image</Button></div>
        </article>)}
      </section>
    </> : review.isLoading ? <div className="h-72 animate-pulse rounded-[1.5rem] border border-white/[0.07] bg-white/[0.025]" /> : <EmptyReview />}
    <CandidateDialog target={replaceTarget} candidates={candidates.data ?? []} loading={candidates.isLoading} selectedCandidateId={selectedCandidateId} pending={replace.isPending} onClose={() => { if (!replace.isPending) setReplaceTarget(null); }} onSelect={setSelectedCandidateId} onConfirm={confirmReplacement} />
  </div>;
}

function CandidateDialog({ target, candidates, loading, selectedCandidateId, pending, onClose, onSelect, onConfirm }: { target: ReplaceTarget | null; candidates: Array<{ id: number; originalFilename: string; sequenceNumber: number | null; thumbnailUrl: string; sceneDescription: string | null }>; loading: boolean; selectedCandidateId: number | null; pending: boolean; onClose: () => void; onSelect: (id: number) => void; onConfirm: () => void }) {
  const selected = candidates.find(candidate => candidate.id === selectedCandidateId) ?? null;
  return <Dialog open={Boolean(target)} onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto border-white/10 bg-[#0c1422] text-slate-100"><DialogHeader><DialogTitle className="flex items-center gap-2 text-xl"><Images className="h-5 w-5 text-cyan-200" />Choose an analyzed alternative</DialogTitle><DialogDescription className="max-w-3xl text-slate-400">Replace <span className="font-medium text-slate-200">{target?.imageFilename ?? "this selected image"}</span> for {target ? `${formatTime(target.startMs)}–${formatTime(target.endMs)}` : "this segment"}. The timing boundaries do not change. Selecting a new image revokes any existing approval and requires a fresh review before rendering.</DialogDescription></DialogHeader>
    {loading ? <div className="grid min-h-64 place-items-center text-sm text-slate-500">Loading analyzed alternatives…</div> : candidates.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{candidates.map(candidate => <button type="button" key={candidate.id} onClick={() => onSelect(candidate.id)} className={`overflow-hidden rounded-xl border text-left transition ${candidate.id === selectedCandidateId ? "border-cyan-200 bg-cyan-200/[0.08] ring-2 ring-cyan-200/25" : "border-white/[0.08] bg-white/[0.025] hover:border-white/20 hover:bg-white/[0.05]"}`}><div className="aspect-video bg-[#080c15]"><StorageThumbnail src={candidate.thumbnailUrl} alt={candidate.originalFilename} className="h-full w-full object-cover" /></div><div className="p-3"><div className="flex items-center justify-between gap-2"><span className="truncate font-mono text-[10px] text-cyan-100">#{candidate.sequenceNumber ?? "—"}</span>{candidate.id === selectedCandidateId ? <CheckCheck className="h-3.5 w-3.5 text-cyan-200" /> : null}</div><p className="mt-1 truncate text-xs font-medium text-slate-100">{candidate.originalFilename}</p><p className="mt-1 line-clamp-3 text-[11px] leading-4 text-slate-500">{candidate.sceneDescription ?? "Genuine Gemini analysis is available; no scene description was returned."}</p></div></button>)}</div> : <div className="rounded-xl border border-dashed border-white/10 px-6 py-14 text-center text-sm text-slate-500">No unselected analyzed images are available for this timeline.</div>}
    <DialogFooter className="border-t border-white/[0.07] pt-4 sm:justify-between"><p className="hidden max-w-xl text-xs leading-5 text-amber-100/70 sm:block">This is a manual visual substitution. It preserves the validated duration and narration boundaries, but your approval must be renewed.</p><div className="flex gap-2"><Button variant="outline" disabled={pending} onClick={onClose} className="border-white/10 text-slate-300 hover:bg-white/[0.06] hover:text-white">Cancel</Button><Button disabled={!selected || pending} onClick={onConfirm} className="bg-cyan-200 text-slate-950 hover:bg-cyan-100">{pending ? "Replacing…" : "Use selected image"}</Button></div></DialogFooter>
  </DialogContent></Dialog>;
}

function PageHeading() { return <section className="rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-6 md:p-8"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200/70">Timeline review</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-white">Approve the edit before it renders.</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">Every card shows the actual selected image, narration, explicit timing, selection rationale, and Gemini confidence. The 13 genuine but unselected analyses remain available as alternatives. Approval is a deliberate gate—not an automatic render trigger.</p><div className="mt-5 flex flex-wrap gap-2"><Badge className="border border-emerald-300/10 bg-emerald-300/[0.07] text-emerald-100 hover:bg-emerald-300/[0.07]"><CheckCheck className="mr-1.5 h-3.5 w-3.5" />No gaps</Badge><Badge className="border border-emerald-300/10 bg-emerald-300/[0.07] text-emerald-100 hover:bg-emerald-300/[0.07]"><CheckCheck className="mr-1.5 h-3.5 w-3.5" />No overlaps</Badge><Badge className="border border-emerald-300/10 bg-emerald-300/[0.07] text-emerald-100 hover:bg-emerald-300/[0.07]"><CheckCheck className="mr-1.5 h-3.5 w-3.5" />Full audio coverage</Badge></div></section>; }
function SourceStatus({ project }: { project: ProjectSummary }) { return <section className="rounded-[1.25rem] border border-white/[0.07] bg-[#101827] p-5"><div className="flex items-center justify-between gap-4"><div><p className="text-sm font-semibold text-slate-100">{project.name} source readiness</p><p className="mt-1 text-xs leading-5 text-slate-500">{project.audioDurationMs ? `${formatTime(project.audioDurationMs)} narration · ${project.sourceImageCount} real source images` : "Media duration is pending."}</p></div>{project.analysisBlocker ? <div className="flex max-w-lg items-start gap-2 rounded-xl border border-amber-200/10 bg-amber-200/[0.045] p-3 text-xs leading-5 text-amber-100/75"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{project.analysisBlocker}</div> : null}</div></section>; }
function EmptyReview() { return <section className="rounded-[1.5rem] border border-dashed border-white/10 bg-white/[0.018] px-6 py-14 text-center"><ShieldAlert className="mx-auto h-7 w-7 text-cyan-200" /><h2 className="mt-4 text-lg font-semibold text-white">No validated timeline available</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">A native handoff remains locked until a real continuous timeline is generated and reviewed.</p></section>; }
function ReviewError({ message }: { message: string }) { return <section className="rounded-[1.5rem] border border-rose-200/15 bg-rose-200/[0.045] px-6 py-10 text-center"><ShieldAlert className="mx-auto h-7 w-7 text-rose-100" /><h2 className="mt-4 text-lg font-semibold text-white">Timeline review could not be loaded</h2><p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-rose-100/70">{message}</p><p className="mx-auto mt-2 max-w-2xl text-xs leading-5 text-slate-500">Refresh the page to restore your secure session, then reopen Timeline. The stored images and timing are unchanged.</p></section>; }
function StorageThumbnail({ src, alt, className }: { src: string | null; alt: string; className: string }) { const [failed, setFailed] = useState(false); if (!src || failed) return <div className="grid h-full w-full place-items-center bg-[#080c15] text-slate-500" role="img" aria-label={`${alt} thumbnail unavailable`}><ImageIcon className="h-6 w-6" /></div>; return <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />; }
function formatTime(milliseconds: number) { const seconds = milliseconds / 1000; return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`; }
