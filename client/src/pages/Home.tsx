import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { ArrowRight, Bot, CheckCircle2, FolderPlus, ShieldCheck, TimerReset } from "lucide-react";
import { useLocation } from "wouter";

const principles = [
  { icon: TimerReset, title: "Audio owns the cut", copy: "Every visual boundary comes from narration analysis and validated story timing, never a preset interval." },
  { icon: Bot, title: "Interactions API reasoning", copy: "The current Gemini Flash release handles narration, image semantics, candidate review, and quality control through one server-side client." },
  { icon: ShieldCheck, title: "Private by design", copy: "Keys are validated server-side, encrypted at rest, and only their masked identifiers reach the workspace." },
];

export default function Home() {
  const [, setLocation] = useLocation();
  const { isAuthenticated } = useAuth();
  const projects = trpc.project.list.useQuery(undefined, { enabled: isAuthenticated });
  const model = trpc.gemini.model.useQuery();
  const recentProject = projects.data?.[0];

  return <div className="mx-auto max-w-7xl space-y-6">
    <section className="relative overflow-hidden rounded-[1.75rem] border border-white/[0.08] bg-[#0e1624] px-6 py-10 shadow-[0_26px_80px_rgba(0,0,0,0.28)] md:px-10 md:py-14">
      <div className="pointer-events-none absolute -right-20 -top-24 h-80 w-80 rounded-full bg-cyan-300/[0.12] blur-3xl" />
      <div className="pointer-events-none absolute bottom-0 left-1/3 h-40 w-96 rounded-full bg-indigo-500/[0.12] blur-3xl" />
      <div className="relative max-w-3xl"><div className="mb-5 inline-flex items-center gap-2 rounded-full border border-cyan-200/15 bg-cyan-200/[0.075] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.13em] text-cyan-100"><span className="h-1.5 w-1.5 rounded-full bg-cyan-200" />Visual timeline editor</div><h1 className="max-w-2xl text-4xl font-semibold leading-[1.02] tracking-[-0.045em] text-white md:text-6xl">Every cut begins with <span className="text-cyan-200">what is said.</span></h1><p className="mt-5 max-w-xl text-base leading-7 text-slate-400 md:text-lg">Turn an existing image sequence and a narration track into a semantically matched, fully synchronized video—without forcing the story into a slideshow rhythm.</p><div className="mt-8 flex flex-col gap-3 sm:flex-row"><Button onClick={() => setLocation("/projects")} size="lg" className="h-12 bg-cyan-200 px-5 text-slate-950 hover:bg-cyan-100"><FolderPlus className="mr-2 h-4 w-4" />Create a project</Button><Button onClick={() => setLocation("/gemini")} size="lg" variant="outline" className="h-12 border-white/10 bg-white/[0.035] px-5 text-slate-100 hover:bg-white/[0.08] hover:text-white">Configure Gemini <ArrowRight className="ml-2 h-4 w-4" /></Button></div></div>
      <div className="relative mt-11 grid gap-3 sm:grid-cols-3"><Metric label="Output" value="1920 × 1080 · 16:9" /><Metric label="Timeline rule" value="No fixed duration" /><Metric label="Analysis model" value={model.data ?? "gemini-flash-latest"} /></div>
    </section>
    <section className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]"><div className="rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-6 md:p-7"><div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Workspace</p><h2 className="mt-2 text-xl font-semibold tracking-tight text-white">{recentProject ? "Continue your story" : "Start with real source material"}</h2></div><span className="rounded-lg bg-cyan-200/10 px-2.5 py-1 text-[11px] font-semibold text-cyan-100">Private</span></div>{recentProject ? <button onClick={() => setLocation("/projects")} className="mt-6 flex w-full items-center justify-between rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4 text-left transition hover:bg-white/[0.055]"><div><p className="font-medium text-white">{recentProject.name}</p><p className="mt-1 text-sm text-slate-500">{recentProject.status.replaceAll("_", " ")} · 1920 × 1080</p></div><ArrowRight className="h-4 w-4 text-cyan-200" /></button> : <div className="mt-6 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-5"><p className="font-medium text-slate-200">No projects yet</p><p className="mt-1.5 max-w-md text-sm leading-6 text-slate-500">Create a project to register the narration, image source, and output location that your local processor will use.</p><Button onClick={() => setLocation("/projects")} variant="link" className="mt-2 h-auto px-0 text-cyan-200 hover:text-cyan-100">Create the first project <ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Button></div>}</div><div className="rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-6 md:p-7"><div className="flex items-center gap-2 text-cyan-200"><CheckCircle2 className="h-4 w-4" /><span className="text-xs font-semibold uppercase tracking-[0.14em]">Integrity first</span></div><p className="mt-4 text-lg font-medium leading-7 text-white">The video is only rendered after the timeline covers the narration with no gaps or overlaps.</p><p className="mt-3 text-sm leading-6 text-slate-500">When no relevant image exists, the valid action is to keep the previous relevant image—not force an unrelated cut.</p></div></section>
    <section className="grid gap-4 md:grid-cols-3">{principles.map(item => <article key={item.title} className="rounded-[1.25rem] border border-white/[0.065] bg-white/[0.018] p-5 transition hover:-translate-y-0.5 hover:bg-white/[0.035]"><item.icon className="h-5 w-5 text-cyan-200" /><h3 className="mt-4 font-semibold text-slate-100">{item.title}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{item.copy}</p></article>)}</section>
  </div>;
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border border-white/[0.07] bg-black/15 p-4 backdrop-blur-sm"><p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500">{label}</p><p className="mt-1.5 text-sm font-medium text-white">{value}</p></div>; }
