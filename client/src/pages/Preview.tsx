import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { AuthPrompt } from "@/components/AuthPrompt";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { buildNativeRenderCommand } from "@/lib/nativeRenderCommand";
import { Clapperboard, Clipboard, Download, History, Pause, Play, Upload } from "lucide-react";
import { toast } from "sonner";

const handoffName = (name: string) => `${name.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "project"}-approved-render-handoff.json`;

async function uploadVideo(projectId: number, file: File) {
  const response = await fetch("/api/project-media/rendered-video", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": file.type || "video/mp4", "x-project-id": String(projectId), "x-original-filename": encodeURIComponent(file.name) },
    body: file,
  });
  const result = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(result?.error || "Rendered MP4 could not be imported.");
}

type ZoomSettings = { enabled: boolean; amountPercent: 3 | 5 | 8; direction: "IN" | "OUT" | "AUTO" };

export default function Preview() {
  const { isAuthenticated } = useAuth();
  const utils = trpc.useUtils();
  const projects = trpc.project.list.useQuery(undefined, { enabled: isAuthenticated });
  const [projectId, setProjectId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (projectId === null && projects.data?.length) setProjectId(projects.data.find(project => project.status === "timeline_ready")?.id ?? projects.data[0].id);
  }, [projectId, projects.data]);

  const project = useMemo(() => projects.data?.find(item => item.id === projectId) ?? null, [projects.data, projectId]);
  const input = useMemo(() => ({ projectId: project?.id ?? 0 }), [project?.id]);
  const review = trpc.timeline.review.useQuery(input, { enabled: Boolean(project) });
  const rendered = trpc.worker.renderedVideo.useQuery(input, { enabled: Boolean(project) });
  const history = trpc.worker.renderHistory.useQuery(input, { enabled: Boolean(project) });
  const approved = review.data?.approval.status === "approved";
  const handoff = trpc.worker.renderHandoff.useQuery(input, { enabled: Boolean(project && approved), retry: false });
  const updateZoom = trpc.project.updateZoom.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.project.list.invalidate(), utils.timeline.review.invalidate(input), utils.worker.renderHandoff.invalidate(input)]);
      toast.success("Zoom settings saved for the next native render.");
    },
    onError: error => toast.error(error.message || "Zoom settings could not be saved."),
  });
  const command = buildNativeRenderCommand(project?.name ?? "project", project?.imageSourcePath, project?.outputPath);

  if (!isAuthenticated) return <div className="mx-auto max-w-6xl"><Hero /><AuthPrompt noun="video preview" /></div>;

  const selectedZoom: ZoomSettings = {
    enabled: project?.zoomEnabled ?? true,
    amountPercent: (project?.zoomAmountPercent === 3 || project?.zoomAmountPercent === 8 ? project.zoomAmountPercent : 5) as 3 | 5 | 8,
    direction: project?.zoomDirection === "IN" || project?.zoomDirection === "OUT" ? project.zoomDirection : "AUTO",
  };
  const saveZoom = (next: ZoomSettings) => {
    if (!project) return;
    updateZoom.mutate({ projectId: project.id, ...next });
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
  const importMp4 = async (file: File | null) => {
    if (!file || !project) return;
    try {
      setUploading(true);
      await uploadVideo(project.id, file);
      await Promise.all([utils.worker.renderedVideo.invalidate(input), utils.worker.renderHistory.invalidate(input), utils.project.list.invalidate()]);
      toast.success("Rendered MP4 added to this project’s history.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "MP4 import failed.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return <div className="vs-page-enter mx-auto max-w-6xl space-y-6">
    <Hero />
    <select value={project?.id ?? ""} onChange={event => setProjectId(Number(event.target.value))} className="h-11 w-full rounded-xl border border-white/10 bg-[#101827] px-3 text-sm text-slate-200">
      <option value="" disabled>Select project</option>
      {projects.data?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status.replaceAll("_", " ")}</option>)}
    </select>
    {project ? <>
      <section className="grid gap-5 lg:grid-cols-[1.35fr_.65fr]">
        <div className="overflow-hidden rounded-[1.5rem] border border-white/[.07] bg-[#101827]">
          <div className="aspect-video bg-black">
            {rendered.data ? <video controls className="h-full w-full object-contain" src={rendered.data.url} /> : <TimelinePlayer narrationUrl={review.data?.narrationUrl ?? null} segments={review.data?.segments ?? []} zoom={selectedZoom} />}
          </div>
        </div>
        <aside className="rounded-[1.5rem] border border-white/[.07] bg-[#101827] p-6">
          <p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-200">{rendered.data ? "Final render" : "Timeline preview"}</p>
          <h2 className="mt-3 text-lg font-semibold text-white">{rendered.data ? rendered.data.originalFilename : "Watch with narration before rendering"}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">{rendered.data ? "The latest final MP4 is available above. Earlier versions remain in render history." : "This browser preview changes images at the approved timeline times while playing the original narration."}</p>
          <input ref={fileInput} type="file" accept="video/mp4" className="sr-only" onChange={event => importMp4(event.target.files?.[0] ?? null)} />
          <Button onClick={() => fileInput.current?.click()} disabled={uploading} className="mt-5 w-full bg-cyan-200 text-slate-950 hover:bg-cyan-100"><Upload className="mr-2 h-4 w-4" />{uploading ? "Importing…" : "Import rendered MP4"}</Button>
          <Button onClick={download} disabled={!approved || !handoff.data} variant="outline" className="mt-3 w-full border-white/10 text-slate-200"><Download className="mr-2 h-4 w-4" />Download handoff</Button>
        </aside>
      </section>
      <ZoomControls zoom={selectedZoom} saving={updateZoom.isPending} onChange={saveZoom} />
      <section className="rounded-[1.5rem] border border-white/[.07] bg-[#101827] p-6">
        <div className="flex items-center justify-between"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-200">Windows PowerShell</p><h2 className="mt-2 font-semibold text-white">Saved-path render command</h2></div><Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(command).then(() => toast.success("Command copied."))} className="border-white/10 text-slate-200"><Clipboard className="mr-2 h-3.5 w-3.5" />Copy</Button></div>
        <pre className="mt-4 overflow-x-auto rounded-xl bg-black/40 p-4 text-xs leading-6 text-cyan-100"><code>{command}</code></pre>
      </section>
      <section className="rounded-[1.5rem] border border-white/[.07] bg-[#101827] p-6">
        <div className="flex items-center gap-2 text-cyan-200"><History className="h-4 w-4" /><p className="text-xs font-semibold uppercase tracking-[.14em]">Render history</p></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">{history.data?.length ? history.data.map(item => <a key={item.id} href={item.url} target="_blank" rel="noreferrer" className="vs-surface-hover rounded-xl border border-white/[.08] bg-white/[.025] p-4"><p className="truncate text-sm font-medium text-slate-100">{item.originalFilename}</p><p className="mt-1 text-xs text-slate-500">{new Date(item.uploadedAt).toLocaleString()}</p></a>) : <p className="text-sm text-slate-500">Imported final MP4 versions will appear here.</p>}</div>
      </section>
    </> : null}
  </div>;
}

function ZoomControls({ zoom, saving, onChange }: { zoom: ZoomSettings; saving: boolean; onChange: (zoom: ZoomSettings) => void }) {
  const controlClass = "h-10 rounded-lg border border-white/10 bg-black/25 px-3 text-sm text-slate-100 outline-none focus:border-cyan-200/60";
  return <section className="rounded-[1.5rem] border border-cyan-200/[.14] bg-[radial-gradient(circle_at_100%_0%,rgba(34,211,238,.1),transparent_35%),#101827] p-6">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div><p className="text-xs font-semibold uppercase tracking-[.14em] text-cyan-200">Native render motion</p><h2 className="mt-2 text-lg font-semibold text-white">Continuous center zoom</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">The native worker uses the accepted smooth subpixel center transform. Crossfades, narration timing, and image selection remain unchanged.</p></div>
      <Button type="button" variant="outline" disabled={saving} onClick={() => onChange({ ...zoom, enabled: !zoom.enabled })} className="border-cyan-200/25 text-cyan-100">Zoom {zoom.enabled ? "ON" : "OFF"}</Button>
    </div>
    <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <label className="grid gap-1.5 text-xs font-medium text-slate-400">Zoom amount<select aria-label="Zoom amount" disabled={!zoom.enabled || saving} className={controlClass} value={zoom.amountPercent} onChange={event => onChange({ ...zoom, amountPercent: Number(event.target.value) as 3 | 5 | 8 })}><option value={3}>3% subtle</option><option value={5}>5% default</option><option value={8}>8% strong</option></select></label>
      <label className="grid gap-1.5 text-xs font-medium text-slate-400">Direction<select aria-label="Zoom direction" disabled={!zoom.enabled || saving} className={controlClass} value={zoom.direction} onChange={event => onChange({ ...zoom, direction: event.target.value as ZoomSettings["direction"] })}><option value="AUTO">Auto (alternating)</option><option value="IN">Zoom in</option><option value="OUT">Zoom out</option></select></label>
      <div className="rounded-lg border border-white/[.07] bg-black/20 px-3 py-2.5 text-xs leading-5 text-slate-400">{zoom.enabled ? <><span className="font-medium text-slate-200">Saved:</span> {zoom.amountPercent}% · {zoom.direction}</> : <><span className="font-medium text-slate-200">Saved:</span> static frames, crossfade only</>}</div>
    </div>
  </section>;
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
      const hasOutgoing = Boolean(displayedImage);
      setPreviousImage(displayedImage);
      setDisplayedImage(currentImage);
      setTransitioning(hasOutgoing);
      const timeout = window.setTimeout(() => { setPreviousImage(null); setTransitioning(false); }, 560);
      return () => window.clearTimeout(timeout);
    }
  }, [currentImage, displayedImage]);
  if (!narrationUrl || !current) return <div className="grid h-full place-items-center p-8 text-center text-sm text-slate-500"><Clapperboard className="mx-auto mb-3 h-8 w-8 text-cyan-200" />Timeline preview becomes available after narration and image analysis finish.</div>;
  const shotDurationSeconds = (current.endMs - current.startMs) / 1000;
  const resolvedDirection = zoom.direction === "AUTO" ? (currentIndex % 2 === 0 ? "IN" : "OUT") : zoom.direction;
  const zoomMagnitude = 1 + (zoom.amountPercent / 100);
  const zoomStart = !zoom.enabled ? 1 : resolvedDirection === "OUT" ? zoomMagnitude : 1;
  const zoomEnd = !zoom.enabled ? 1 : resolvedDirection === "OUT" ? 1 : zoomMagnitude;
  const format = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
  const seek = (value: number) => { if (audio.current) audio.current.currentTime = value; setTime(value); };
  const toggle = async () => { if (!audio.current) return; if (audio.current.paused) await audio.current.play(); else audio.current.pause(); };
  return <div className="relative h-full overflow-hidden bg-black"><div className="absolute inset-0">{previousImage ? <img src={previousImage} className="vs-preview-previous absolute inset-0 h-full w-full object-cover" alt="" /> : null}{displayedImage ? <img key={displayedImage} src={displayedImage} style={{ ["--preview-zoom-start" as string]: String(zoomStart), ["--preview-zoom-end" as string]: String(zoomEnd), ["--preview-zoom-duration" as string]: `${Math.max(1.8, shotDurationSeconds)}s` }} className={`vs-preview-active ${transitioning ? "vs-preview-transition" : ""} absolute inset-0 h-full w-full object-cover`} alt={current.imageFilename ?? "Timeline image"} /> : null}</div><div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-4 pb-4 pt-16"><input type="range" min="0" max={duration || Math.ceil(segments.at(-1)?.endMs ?? 0) / 1000} step="0.01" value={time} onChange={event => seek(Number(event.target.value))} className="mb-3 h-1.5 w-full accent-cyan-300" aria-label="Timeline position" /><div className="flex items-center gap-3"><Button size="icon" onClick={toggle} className="bg-cyan-200 text-slate-950 hover:bg-cyan-100">{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</Button><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-white">{current.imageFilename ?? "Current image"}</p><p className="text-[11px] text-slate-300">{format(time)} / {format(duration || Math.ceil(segments.at(-1)?.endMs ?? 0) / 1000)}</p></div></div></div><audio ref={audio} src={narrationUrl} onLoadedMetadata={event => setDuration(event.currentTarget.duration)} onTimeUpdate={event => setTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} /></div>;
}

function Hero() {
  return <section className="rounded-[1.5rem] border border-white/[.07] bg-[radial-gradient(circle_at_80%_10%,rgba(34,211,238,.12),transparent_30%),#101827] p-6 md:p-8"><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-cyan-200/70">Render and review</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.035em] text-white">Preview the timing. Render with motion.</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">Play the approved narration and image sequence in the browser, then create a motion-enhanced MP4 with the local worker.</p><a href="/api/project-media/latest-worker" download className="mt-4 inline-flex rounded-lg border border-cyan-200/25 bg-cyan-200/10 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-200/20">Download latest motion-enabled worker</a></section>;
}
