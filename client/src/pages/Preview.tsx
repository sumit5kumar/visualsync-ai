import { useMemo } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { AuthPrompt } from "@/components/AuthPrompt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, Clapperboard, Clipboard, Cpu, FileVideo2, LockKeyhole, Send, TerminalSquare } from "lucide-react";
import { toast } from "sonner";

const localRenderCommand = `& ".\\render-approved-handoff.ps1" \
  -HandoffPath "C:\\Users\\sumit\\Downloads\\Nothing\\approved-render-handoff.json" \
  -SourceDirectory "C:\\Users\\sumit\\Downloads\\try" \
  -OutputDirectory "C:\\Users\\sumit\\Downloads\\Nothing" \
  -FFmpegPath "D:\\ffmpeg-8.1-essentials_build\\ffmpeg-8.1-essentials_build\\bin\\ffmpeg.exe"`;

export default function Preview() {
  const { isAuthenticated } = useAuth();
  const projects = trpc.project.list.useQuery(undefined, { enabled: isAuthenticated });
  const project = projects.data?.find(item => item.status === "timeline_ready") ?? projects.data?.find(item => item.status === "completed");
  const input = useMemo(() => ({ projectId: project?.id ?? 0 }), [project?.id]);
  const review = trpc.timeline.review.useQuery(input, { enabled: Boolean(project?.id) });
  const handoff = trpc.worker.renderHandoff.useQuery(input, { enabled: Boolean(project?.id && review.data?.approval.status === "approved"), retry: false });
  const completed = project?.status === "completed";
  const approved = review.data?.approval.status === "approved";

  if (!isAuthenticated) return <div className="mx-auto max-w-5xl"><header className="rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-6"><p className="text-xs font-semibold uppercase tracking-[0.15em] text-cyan-200/70">Preview & render</p><h1 className="mt-2 text-3xl font-semibold text-white">Render only after approval.</h1></header><div className="mt-6"><AuthPrompt noun="render handoff" /></div></div>;

  const downloadHandoff = () => {
    if (!handoff.data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(handoff.data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "approved-render-handoff.json"; link.click(); URL.revokeObjectURL(url);
    toast.success("Approved handoff downloaded. Save it in the Nothing folder before running the local worker.");
  };
  const copyRenderCommand = async () => {
    try { await navigator.clipboard.writeText(localRenderCommand); toast.success("PowerShell render command copied."); } catch { toast.error("Copy is unavailable in this browser. Select the command manually."); }
  };

  return <div className="mx-auto max-w-5xl space-y-6">
    <section className="rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-6 md:p-8"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200/70">Native MP4 handoff</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-white">FFmpeg renders locally from an approved edit.</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">This hosted page safely prepares the exact S3-backed timeline handoff. Rendering is intentionally run on your Windows computer, where FFmpeg and the original files are available; a persistent cloud-worker connection is not required.</p></section>
    {!project ? <section className="rounded-[1.5rem] border border-dashed border-white/10 bg-white/[0.018] p-12 text-center"><Clapperboard className="mx-auto h-8 w-8 text-cyan-200" /><p className="mt-4 font-semibold text-white">No approved or completed project yet</p><p className="mt-2 text-sm text-slate-500">Approve a validated timeline in Timeline to create a local render handoff.</p></section> : <>
      <section className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]"><div className="overflow-hidden rounded-[1.5rem] border border-white/[0.07] bg-[#101827]"><div className="grid aspect-video place-items-center bg-[radial-gradient(circle_at_70%_30%,rgba(34,211,238,0.12),transparent_30%),#080c15]"><div className="text-center"><Clapperboard className="mx-auto h-8 w-8 text-cyan-200" /><p className="mt-4 font-semibold text-slate-100">{project.name} · 1920 × 1080 MP4</p><p className="mt-1 text-sm text-slate-500">{review.data?.segments.length ?? 0} approved visual decisions</p></div></div></div><div className="rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-6"><div className="flex items-center gap-2 text-cyan-200"><Cpu className="h-4 w-4" /><span className="text-xs font-semibold uppercase tracking-[0.14em]">Local render status</span></div><p className="mt-4 text-lg font-semibold text-white">{completed ? "MP4 rendered locally" : approved ? "Ready for local FFmpeg render" : "Timeline approval required"}</p><p className="mt-2 text-sm leading-6 text-slate-500">{completed ? "The last approved Nothing render is available in the local Nothing folder. Download the handoff again only when you want to rerender." : approved ? "No worker connection is needed. Download the approved JSON, then run the local PowerShell worker below." : "Return to Timeline, review each thumbnail, then approve before the render handoff is exposed."}</p><div className="mt-5 flex flex-wrap gap-2"><Badge className={`border-0 ${completed ? "bg-emerald-300/10 text-emerald-100" : approved ? "bg-cyan-200/10 text-cyan-100" : "bg-amber-300/10 text-amber-100"}`}>{completed ? "RENDERED LOCALLY" : approved ? "HANDOFF READY" : "PENDING APPROVAL"}</Badge><Badge className="border-0 bg-white/[0.07] text-slate-400">LOCAL WORKER · WINDOWS</Badge></div><div className="mt-6 space-y-3 border-t border-white/[0.06] pt-5"><State icon={FileVideo2} title="FFmpeg contract" text={handoff.data ? "Approved asset and timing payload prepared." : "Locked until timeline approval."} /><State icon={LockKeyhole} title="Media source" text="Original local narration and images stay on your Windows computer." /></div><Button disabled={!approved || handoff.isLoading || !handoff.data} onClick={downloadHandoff} className="mt-6 w-full bg-cyan-200 text-slate-950 hover:bg-cyan-100 disabled:bg-white/[0.07] disabled:text-slate-500"><Send className="mr-2 h-4 w-4" />{completed ? "Download handoff again" : approved ? "Download approved render handoff" : "Approve timeline to unlock handoff"}</Button></div></section>
      {completed ? <section className="flex items-start gap-3 rounded-[1.25rem] border border-emerald-300/15 bg-emerald-300/[0.045] p-5"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-200" /><div><p className="font-semibold text-emerald-100">Current render output</p><p className="mt-1 font-mono text-xs leading-5 text-emerald-100/75">C:\Users\sumit\Downloads\Nothing\Nothing_approved_1920x1080.mp4</p><p className="mt-2 text-xs leading-5 text-slate-400">Validated output: 1920 × 1080, H.264 video, AAC audio, 70.091 seconds.</p></div></section> : null}
      <section className="rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-6"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><div className="flex items-center gap-2 text-cyan-200"><TerminalSquare className="h-4 w-4" /><span className="text-xs font-semibold uppercase tracking-[0.14em]">How to render locally</span></div><h2 className="mt-2 text-lg font-semibold text-white">Run the worker in Windows PowerShell</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">Download the approved handoff into the Nothing folder, then run this command. The worker validates approval, exact timing, 1920 × 1080 output, and every source file before starting FFmpeg.</p></div><Button variant="outline" size="sm" onClick={copyRenderCommand} className="border-white/10 text-slate-200 hover:bg-white/[0.06] hover:text-white"><Clipboard className="mr-2 h-3.5 w-3.5" />Copy command</Button></div><pre className="mt-5 overflow-x-auto rounded-xl border border-white/[0.07] bg-[#080c15] p-4 text-xs leading-6 text-cyan-100"><code>{localRenderCommand}</code></pre></section>
    </>}
  </div>;
}

function State({ icon: Icon, title, text }: { icon: typeof FileVideo2; title: string; text: string }) { return <div className="flex gap-3"><span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-slate-400"><Icon className="h-3.5 w-3.5" /></span><div><p className="text-sm font-medium text-slate-200">{title}</p><p className="mt-0.5 text-xs text-slate-500">{text}</p></div></div>; }
