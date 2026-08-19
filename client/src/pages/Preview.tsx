import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { AuthPrompt } from "@/components/AuthPrompt";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { buildNativeRenderCommand } from "@/lib/nativeRenderCommand";
import { estimateNativeRender, formatRenderDuration } from "@/lib/renderEstimate";
import { Clapperboard, Clipboard, Download, Pause, Play, Zap } from "lucide-react";
import { toast } from "sonner";

const handoffName = (name: string) => `${name.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "project"}-approved-render-handoff.json`;
const isWindowsDirectory = (value: string | null | undefined) => Boolean(value && /^(?:[A-Za-z]:\\|\\\\)/.test(value.trim()));

type ZoomSettings = { enabled: boolean; amountPercent: 3 | 5 | 8 | 12; direction: "IN" | "OUT" | "AUTO"; crossfadeDurationMs: 0 | 300 | 500 | 800 | 1000 | 1200 };

export default function Preview() {
  const { isAuthenticated } = useAuth();
  const utils = trpc.useUtils();
  const projects = trpc.project.list.useQuery(undefined, { enabled: isAuthenticated });
  const [projectId, setProjectId] = useState<number | null>(null);

  useEffect(() => {
    if (projectId === null && projects.data?.length) setProjectId(projects.data.find(project => project.status === "timeline_ready")?.id ?? projects.data[0].id);
  }, [projectId, projects.data]);

  const project = useMemo(() => projects.data?.find(item => item.id === projectId) ?? null, [projects.data, projectId]);
  const input = useMemo(() => ({ projectId: project?.id ?? 0 }), [project?.id]);
  const review = trpc.timeline.review.useQuery(input, { enabled: Boolean(project) });
  const approved = review.data?.approval.status === "approved";
  const handoff = trpc.worker.renderHandoff.useQuery(input, { enabled: Boolean(project && approved), retry: false });
  const [nativeSourceDirectory, setNativeSourceDirectory] = useState("");
  const [nativeOutputDirectory, setNativeOutputDirectory] = useState("");
  const updateZoom = trpc.project.updateZoom.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.project.list.invalidate(), utils.timeline.review.invalidate(input), utils.worker.renderHandoff.invalidate(input)]);
      toast.success("Zoom settings saved for the next native render.");
    },
    onError: error => toast.error(error.message || "Zoom settings could not be saved."),
  });
  const updateNativePaths = trpc.project.updateSetup.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.project.list.invalidate(), utils.worker.renderHandoff.invalidate(input)]);
      toast.success("Exact Windows render paths saved for this project.");
    },
    onError: error => toast.error(error.message || "Windows render paths could not be saved."),
  });
  useEffect(() => {
    setNativeSourceDirectory(isWindowsDirectory(project?.imageSourcePath) ? project!.imageSourcePath! : "");
    setNativeOutputDirectory(isWindowsDirectory(project?.outputPath) ? project!.outputPath! : "");
  }, [project?.id, project?.imageSourcePath, project?.outputPath]);
  const command = buildNativeRenderCommand(project?.name ?? "project", project?.imageSourcePath, project?.outputPath);

  if (!isAuthenticated) return <div className="mx-auto max-w-6xl"><Hero /><AuthPrompt noun="video preview" /></div>;

  const selectedZoom: ZoomSettings = {
    enabled: project?.zoomEnabled ?? true,
    amountPercent: (project?.zoomAmountPercent === 3 || project?.zoomAmountPercent === 5 || project?.zoomAmountPercent === 12 ? project.zoomAmountPercent : 8) as 3 | 5 | 8 | 12,
    direction: project?.zoomDirection === "OUT" || project?.zoomDirection === "AUTO" ? project.zoomDirection : "IN",
    crossfadeDurationMs: (project?.crossfadeDurationMs === 0 || project?.crossfadeDurationMs === 300 || project?.crossfadeDurationMs === 500 || project?.crossfadeDurationMs === 1000 || project?.crossfadeDurationMs === 1200 ? project.crossfadeDurationMs : 800) as 0 | 300 | 500 | 800 | 1000 | 1200,
  };
  const saveZoom = (next: ZoomSettings) => {
    if (!project) return;
    updateZoom.mutate({ projectId: project.id, ...next });
  };
  const saveNativePaths = () => {
    if (!project) return;
    if (!isWindowsDirectory(nativeSourceDirectory) || !isWindowsDirectory(nativeOutputDirectory)) {
      toast.error("Enter full Windows paths, for example D:\\Test, for both source and output folders.");
      return;
    }
    updateNativePaths.mutate({ projectId: project.id, imageSourcePath: nativeSourceDirectory.trim(), outputPath: nativeOutputDirectory.trim() });
  };
  const download = () => {
    if (!handoff.data || !project) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(handoff.data, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = handoffName(project.name);
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return <div className="vs-page-enter mx-auto max-w-6xl space-y-6">
    <Hero />
    <select value={project?.id ?? ""} onChange={event => setProjectId(Number(event.target.value))} className="vs-field w-full px-3 text-sm">
      <option value="" disabled>Select project</option>
      {projects.data?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status.replaceAll("_", " ")}</option>)}
    </select>
    {project ? <>
      <section className="grid gap-5 lg:grid-cols-[1.35fr_.65fr]">
        <div className="overflow-hidden rounded-[1.5rem] border border-white/[.07] bg-[#101827]">
          <div className="aspect-video bg-black">
            <TimelinePlayer narrationUrl={review.data?.narrationUrl ?? null} segments={review.data?.segments ?? []} zoom={selectedZoom} />
          </div>
        </div>
        <aside className="vs-surface rounded-[1.5rem] p-6">
          <p className="vs-kicker">Timeline preview</p>
          <h2 className="mt-3 text-lg font-semibold text-white">Check the story with narration</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">Preview the approved image boundaries with the original audio before creating the final local MP4.</p>
          <Button onClick={download} disabled={!approved || !handoff.data} className="mt-5 w-full bg-cyan-200 text-slate-950 hover:bg-cyan-100"><Download className="mr-2 h-4 w-4" />Download handoff</Button>
          <div className="mt-5 rounded-xl border border-cyan-200/[.12] bg-cyan-200/[.04] p-3 text-xs leading-5 text-slate-400"><span className="font-semibold text-cyan-100">Local workflow.</span> Download the approved handoff, run the saved command in Windows PowerShell, and find the completed MP4 in the project output folder.</div>
        </aside>
      </section>
      <ZoomControls zoom={selectedZoom} saving={updateZoom.isPending} onChange={saveZoom} />
      <RenderEstimate durationMs={project.audioDurationMs ?? review.data?.segments.at(-1)?.endMs ?? 0} imageCount={review.data?.segments.length ?? 0} zoom={selectedZoom} />
      <section className="rounded-[1.5rem] border border-cyan-200/[.14] bg-[#101827] p-6">
        <p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-200">Saved Windows render folders</p>
        <h2 className="mt-2 text-lg font-semibold text-white">Use the exact local drive paths</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">Browsers intentionally do not reveal a selected folder’s full Windows path. Paste it once here—for example <code className="text-cyan-100">D:\\Test</code>—and future handoff commands will use that exact path instead of guessing a Downloads folder.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2"><label className="grid gap-1.5 text-xs font-medium text-slate-400">Source folder<input aria-label="Windows source folder path" value={nativeSourceDirectory} onChange={event => setNativeSourceDirectory(event.target.value)} placeholder="D:\\Test" className="vs-field w-full px-3 text-sm placeholder:text-slate-600" /></label><label className="grid gap-1.5 text-xs font-medium text-slate-400">Output folder<input aria-label="Windows output folder path" value={nativeOutputDirectory} onChange={event => setNativeOutputDirectory(event.target.value)} placeholder="D:\\Test" className="vs-field w-full px-3 text-sm placeholder:text-slate-600" /></label></div>
        <Button type="button" disabled={updateNativePaths.isPending} onClick={saveNativePaths} className="mt-4 bg-cyan-200 text-slate-950 hover:bg-cyan-100">Save exact Windows paths</Button>
      </section>
      <section className="rounded-[1.5rem] border border-white/[.07] bg-[#101827] p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-200">Native render</p><h2 className="mt-2 font-semibold text-white">Three clear steps</h2><p className="mt-1 text-sm leading-6 text-slate-500">The command uses your saved folders and applies the approved timeline with the motion mode selected above.</p></div><Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(command).then(() => toast.success("Command copied."))} className="border-white/10 text-slate-200"><Clipboard className="mr-2 h-3.5 w-3.5" />Copy command</Button></div>
        <div className="mt-5 grid gap-3 md:grid-cols-3"><WorkflowStep number="1" title="Download worker" text="Use the current approved worker only." /><WorkflowStep number="2" title="Download handoff" text="Keep its project-specific file name." /><WorkflowStep number="3" title="Paste and render" text="Run the copied command in the saved output folder." /></div>
        <pre className="mt-4 overflow-x-auto rounded-xl bg-black/40 p-4 text-xs leading-6 text-cyan-100"><code>{command}</code></pre>
        <div className="mt-4 rounded-xl border border-violet-200/[.14] bg-violet-200/[.04] p-4 text-xs leading-5 text-slate-400"><span className="font-semibold text-violet-100">Local GPU usage.</span> The worker uses the first compatible GPU encoder—NVIDIA NVENC, then AMD AMF, then Intel Quick Sync—for the final H.264 MP4 encode. It writes <code className="text-violet-100">ENCODER=NVIDIA NVENC H.264</code> in PowerShell when the RTX 3050 is selected. The continuous zoom-frame preparation and direct-opacity crossfade compositor remain CPU-based to preserve the accepted motion and timing.</div>
      </section>
    </> : null}
  </div>;
}

function ZoomControls({ zoom, saving, onChange }: { zoom: ZoomSettings; saving: boolean; onChange: (zoom: ZoomSettings) => void }) {
  const controlClass = "h-10 rounded-lg border border-white/10 bg-black/25 px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-200/60 disabled:cursor-not-allowed disabled:opacity-50";
  const fastRender = !zoom.enabled && zoom.crossfadeDurationMs === 0;
  return <section className="rounded-[1.5rem] border border-cyan-200/[.14] bg-[radial-gradient(circle_at_100%_0%,rgba(34,211,238,.1),transparent_35%),#101827] p-6">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div><p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-200">Render settings</p><h2 className="mt-2 text-lg font-semibold text-white">Quality motion or fast static render</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">Fast Render removes both zoom and transitions for a much quicker local export. It never changes image selection, timeline timing, or narration sync.</p></div>
      <div className="flex flex-wrap gap-2"><Button type="button" disabled={saving || fastRender} onClick={() => onChange({ ...zoom, enabled: false, crossfadeDurationMs: 0 })} className="bg-amber-200 text-slate-950 hover:bg-amber-100"><Zap className="mr-2 h-4 w-4" />Fast Render</Button>{fastRender ? <Button type="button" variant="outline" disabled={saving} onClick={() => onChange({ ...zoom, enabled: true, crossfadeDurationMs: 800 })} className="border-cyan-200/25 text-cyan-100">Restore motion</Button> : <Button type="button" variant="outline" disabled={saving} onClick={() => onChange({ ...zoom, enabled: !zoom.enabled })} className="border-cyan-200/25 text-cyan-100">Zoom {zoom.enabled ? "ON" : "OFF"}</Button>}</div>
    </div>
    <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="grid gap-1.5 text-xs font-medium text-slate-400">Zoom amount<select aria-label="Zoom amount" disabled={!zoom.enabled || saving} className={controlClass} value={zoom.amountPercent} onChange={event => onChange({ ...zoom, amountPercent: Number(event.target.value) as 3 | 5 | 8 | 12 })}><option value={3}>3% subtle</option><option value={5}>5% gentle</option><option value={8}>8% default</option><option value={12}>12% strong</option></select></label>
      <label className="grid gap-1.5 text-xs font-medium text-slate-400">Direction<select aria-label="Zoom direction" disabled={!zoom.enabled || saving} className={controlClass} value={zoom.direction} onChange={event => onChange({ ...zoom, direction: event.target.value as ZoomSettings["direction"] })}><option value="AUTO">Auto (alternating)</option><option value="IN">Zoom in</option><option value="OUT">Zoom out</option></select></label>
      <label className="grid gap-1.5 text-xs font-medium text-slate-400">Transition<select aria-label="Crossfade duration" disabled={saving || fastRender} className={controlClass} value={zoom.crossfadeDurationMs} onChange={event => onChange({ ...zoom, crossfadeDurationMs: Number(event.target.value) as ZoomSettings["crossfadeDurationMs"] })}><option value={0}>No transition · Fast Render</option><option value={300}>0.3 seconds · quick</option><option value={500}>0.5 seconds · short</option><option value={800}>0.8 seconds · default</option><option value={1000}>1.0 second · slow</option><option value={1200}>1.2 seconds · very slow</option></select></label>
      <div className="rounded-lg border border-white/[.07] bg-black/20 px-3 py-2.5 text-xs leading-5 text-slate-400">{fastRender ? <><span className="font-medium text-amber-100">Saved: Fast Render</span><br />Static images · direct cuts · no motion processing</> : <>{zoom.enabled ? <><span className="font-medium text-slate-200">Saved:</span> {zoom.amountPercent}% · {zoom.direction}</> : <><span className="font-medium text-slate-200">Saved:</span> static images</>} · {(zoom.crossfadeDurationMs / 1000).toFixed(1)}s fade</>}</div>
    </div>
  </section>;
}

function RenderEstimate({ durationMs, imageCount, zoom }: { durationMs: number; imageCount: number; zoom: ZoomSettings }) {
  const estimate = estimateNativeRender({ durationMs, imageCount, zoomEnabled: zoom.enabled, crossfadeDurationMs: zoom.crossfadeDurationMs });
  if (!estimate) return null;
  const fastRender = !zoom.enabled && zoom.crossfadeDurationMs === 0;
  return <section className="rounded-[1.5rem] border border-amber-200/[.12] bg-[radial-gradient(circle_at_100%_0%,rgba(251,191,36,.08),transparent_38%),#101827] p-6"><div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-amber-200">Approximate local render time</p><h2 className="mt-2 text-xl font-semibold text-white">{formatRenderDuration(estimate.lowerSeconds)}–{formatRenderDuration(estimate.upperSeconds)}</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Based on this approved timeline: {imageCount} images, {formatRenderDuration(durationMs / 1000)} of narration, {estimate.outputFrames.toLocaleString()} output frames, and {fastRender ? "Fast Render with static direct cuts." : zoom.enabled ? `${zoom.amountPercent}% ${zoom.direction} zoom with a ${(zoom.crossfadeDurationMs / 1000).toFixed(1)}s crossfade.` : `static images with a ${(zoom.crossfadeDurationMs / 1000).toFixed(1)}s crossfade.`}</p></div><div className="rounded-xl border border-white/[.07] bg-black/20 px-4 py-3 text-xs leading-5 text-slate-400"><span className="font-semibold text-slate-200">Why it varies:</span> Fast Render skips the costly per-frame zoom and alpha-composition stages.</div></div></section>;
}

function TimelinePlayer({ narrationUrl, segments, zoom }: { narrationUrl: string | null; segments: Array<{ startMs: number; endMs: number; thumbnailUrl: string | null; imageFilename: string | null }>; zoom: ZoomSettings }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [displayedImage, setDisplayedImage] = useState<string | null>(null);
  const [previousImage, setPreviousImage] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const currentIndex = Math.max(0, segments.findIndex(segment => time * 1000 >= segment.startMs && time * 1000 < segment.endMs));
  const current = segments[currentIndex] ?? segments[0];
  const currentImage = current?.thumbnailUrl ?? null;

  useEffect(() => {
    if (currentImage && currentImage !== displayedImage) {
      if (zoom.crossfadeDurationMs === 0) { setPreviousImage(null); setDisplayedImage(currentImage); setTransitioning(false); return; }
      const hasOutgoing = Boolean(displayedImage);
      setPreviousImage(displayedImage);
      setDisplayedImage(currentImage);
      setTransitioning(hasOutgoing);
      const timeout = window.setTimeout(() => { setPreviousImage(null); setTransitioning(false); }, zoom.crossfadeDurationMs);
      return () => window.clearTimeout(timeout);
    }
  }, [currentImage, displayedImage, zoom.crossfadeDurationMs]);

  if (!narrationUrl || !current) return <div className="grid h-full place-items-center p-8 text-center text-sm text-slate-500"><Clapperboard className="mx-auto mb-3 h-8 w-8 text-cyan-200" />Timeline preview becomes available after narration and image analysis finish.</div>;

  const shotDurationSeconds = (current.endMs - current.startMs) / 1000;
  const resolvedDirection = zoom.direction === "AUTO" ? (currentIndex % 2 === 0 ? "IN" : "OUT") : zoom.direction;
  const zoomMagnitude = 1 + (zoom.amountPercent / 100);
  const zoomStart = !zoom.enabled ? 1 : resolvedDirection === "OUT" ? zoomMagnitude : 1;
  const zoomEnd = !zoom.enabled ? 1 : resolvedDirection === "OUT" ? 1 : zoomMagnitude;
  const format = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
  const seek = (value: number) => { if (audio.current) audio.current.currentTime = value; setTime(value); };
  const toggle = async () => { if (!audio.current) return; if (audio.current.paused) await audio.current.play(); else audio.current.pause(); };
  const motionStyle = {
    ["--preview-zoom-start" as string]: String(zoomStart),
    ["--preview-zoom-end" as string]: String(zoomEnd),
    ["--preview-zoom-duration" as string]: `${Math.max(1.8, shotDurationSeconds)}s`,
    ["--preview-crossfade-duration" as string]: `${zoom.crossfadeDurationMs}ms`,
  };
  const activeClassName = `vs-preview-active ${transitioning ? "vs-preview-transition" : ""} absolute inset-0 h-full w-full object-cover`;

  return <div className="relative h-full overflow-hidden bg-black">
    <div className="absolute inset-0" style={motionStyle}>
      {previousImage ? <img src={previousImage} className="vs-preview-previous absolute inset-0 h-full w-full object-cover" alt="" /> : null}
      {displayedImage ? (<img key={displayedImage} src={displayedImage} style={motionStyle} className={activeClassName} alt={current.imageFilename ?? "Timeline image"} />) : null}
    </div>
    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-4 pb-4 pt-16">
      <input type="range" min="0" max={duration || Math.ceil(segments.at(-1)?.endMs ?? 0) / 1000} step="0.01" value={time} onChange={event => seek(Number(event.target.value))} className="mb-3 h-1.5 w-full accent-cyan-300" aria-label="Timeline position" />
      <div className="flex items-center gap-3"><Button size="icon" onClick={toggle} className="bg-cyan-200 text-slate-950 hover:bg-cyan-100">{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</Button><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-white">{current.imageFilename ?? "Current image"}</p><p className="text-[11px] text-slate-300">{format(time)} / {format(duration || Math.ceil(segments.at(-1)?.endMs ?? 0) / 1000)}</p></div></div>
    </div>
    <audio ref={audio} src={narrationUrl} onLoadedMetadata={event => setDuration(event.currentTarget.duration)} onTimeUpdate={event => setTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
  </div>;
}

function WorkflowStep({ number, title, text }: { number: string; title: string; text: string }) {
  return <div className="rounded-xl border border-white/[.07] bg-black/20 p-3"><p className="text-[10px] font-semibold tracking-[.16em] text-cyan-200">{number}</p><p className="mt-1 text-sm font-semibold text-slate-100">{title}</p><p className="mt-1 text-xs leading-5 text-slate-500">{text}</p></div>;
}

function Hero() {
  return <section className="vs-surface rounded-[1.5rem] bg-[radial-gradient(circle_at_80%_10%,rgba(34,211,238,.12),transparent_30%),#101827] p-6 md:p-8"><p className="vs-kicker">Render and review</p><h1 className="vs-page-title mt-2">Preview, configure, and render locally.</h1><p className="vs-page-copy mt-3 max-w-3xl">Review your narration-led timing, choose quality motion or Fast Render, then use the saved Windows command to create the final MP4 in your selected output folder.</p><div className="mt-5 flex flex-wrap items-center gap-3"><a href="/api/project-media/latest-worker" download className="inline-flex rounded-lg border border-cyan-200/25 bg-cyan-200/10 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-200/20">Download approved render worker</a><span className="text-xs text-slate-500">Final output stays in your local project folder.</span></div></section>;
}
