import { useMemo, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { AuthPrompt } from "@/components/AuthPrompt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Braces, CheckCheck, CircleDashed, ShieldAlert } from "lucide-react";

export default function Timeline() {
  const { isAuthenticated } = useAuth();
  const projects = trpc.project.list.useQuery(undefined, { enabled: isAuthenticated });
  const [projectId, setProjectId] = useState("");
  const timelineInput = useMemo(() => ({ projectId: Number(projectId) }), [projectId]);
  const hasSelection = projectId.length > 0;
  const timeline = trpc.timeline.list.useQuery(timelineInput, { enabled: hasSelection });

  if (!isAuthenticated) return <div className="mx-auto max-w-5xl"><PageHeading /><AuthPrompt noun="timeline inspector" /></div>;

  return <div className="mx-auto max-w-5xl space-y-6">
    <PageHeading />
    <section className="flex flex-col gap-4 rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-5 md:flex-row md:items-center">
      <div className="flex-1"><p className="text-sm font-semibold text-slate-100">Choose a project timeline</p><p className="mt-1 text-xs leading-5 text-slate-500">Only a validated timeline created by the connected processor can appear here.</p></div>
      <label className="sr-only" htmlFor="timeline-project">Project timeline</label>
      <select id="timeline-project" value={projectId} onChange={event => setProjectId(event.target.value)} className="h-10 w-full rounded-md border border-white/10 bg-white/[0.035] px-3 text-sm text-slate-200 outline-none transition focus:border-cyan-200/50 focus:ring-2 focus:ring-cyan-200/20 md:w-[280px]">
        <option value="" disabled className="bg-[#152032]">Select project</option>
        {projects.data?.map(project => <option key={project.id} value={String(project.id)} className="bg-[#152032]">{project.name}</option>)}
      </select>
    </section>
    {hasSelection && timeline.isLoading ? <div className="h-48 animate-pulse rounded-[1.5rem] border border-white/[0.07] bg-white/[0.025]" /> : hasSelection && timeline.data?.length ? <TimelineSegments segments={timeline.data} /> : <EmptyTimeline hasProjects={Boolean(projects.data?.length)} />}
  </div>;
}

function PageHeading() {
  return <section className="rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-6 md:p-8"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200/70">Timeline inspector</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-white">A sequence of decisions, not durations.</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">VisualSync persists the image choice, exact start and end, narration context, confidence, candidates, and decision type for every story beat before an MP4 can render.</p><div className="mt-5 flex flex-wrap gap-2"><Badge className="border border-emerald-300/10 bg-emerald-300/[0.07] text-emerald-100 hover:bg-emerald-300/[0.07]"><CheckCheck className="mr-1.5 h-3.5 w-3.5" />No gaps</Badge><Badge className="border border-emerald-300/10 bg-emerald-300/[0.07] text-emerald-100 hover:bg-emerald-300/[0.07]"><CheckCheck className="mr-1.5 h-3.5 w-3.5" />No overlaps</Badge><Badge className="border border-emerald-300/10 bg-emerald-300/[0.07] text-emerald-100 hover:bg-emerald-300/[0.07]"><CheckCheck className="mr-1.5 h-3.5 w-3.5" />Full audio coverage</Badge></div></section>;
}

function TimelineSegments({ segments }: { segments: Array<{ id: number; startMs: number; endMs: number; narrationText: string; decisionType: string; selectionReason: string; confidence: string | number }> }) {
  return <section className="overflow-hidden rounded-[1.5rem] border border-white/[0.07] bg-[#101827]"><div className="grid grid-cols-[110px_1fr_90px] gap-4 border-b border-white/[0.055] px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500"><span>Timing</span><span>Selection decision</span><span className="text-right">Confidence</span></div>{segments.map(segment => <article key={segment.id} className="grid grid-cols-[110px_1fr_90px] gap-4 border-b border-white/[0.055] px-5 py-4 last:border-0"><span className="font-mono text-xs leading-5 text-cyan-100">{formatTime(segment.startMs)}<br />{formatTime(segment.endMs)}</span><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium text-slate-100">{segment.narrationText}</p><Badge className="border-0 bg-white/[0.07] text-[9px] text-slate-400 hover:bg-white/[0.07]">{segment.decisionType}</Badge></div><p className="mt-1 text-xs leading-5 text-slate-500">{segment.selectionReason}</p></div><span className="text-right text-xs font-semibold text-emerald-200">{Math.round(Number(segment.confidence) * 100)}%</span></article>)}</section>;
}

function EmptyTimeline({ hasProjects }: { hasProjects: boolean }) { return <section className="rounded-[1.5rem] border border-dashed border-white/10 bg-white/[0.018] px-6 py-14 text-center">{hasProjects ? <CircleDashed className="mx-auto h-7 w-7 text-cyan-200" /> : <Braces className="mx-auto h-7 w-7 text-cyan-200" />}<h2 className="mt-4 text-lg font-semibold text-white">{hasProjects ? "No validated timeline available" : "Create a project before inspecting a timeline"}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">{hasProjects ? "The local worker must first analyze the actual audio and image collection with Gemini, then submit a continuous, variable-duration timeline for validation." : "Project-level timeline records are created only from a real narration-and-image analysis run."}</p><Button disabled className="mt-5 bg-white/[0.07] text-slate-500"><ShieldAlert className="mr-2 h-4 w-4" />Awaiting real analysis</Button></section>; }
function formatTime(milliseconds: number) { const totalSeconds = milliseconds / 1000; const minutes = Math.floor(totalSeconds / 60); const seconds = (totalSeconds % 60).toFixed(2).padStart(5, "0"); return `${String(minutes).padStart(2, "0")}:${seconds}`; }
