import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { AuthPrompt } from "@/components/AuthPrompt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { trpc } from "@/lib/trpc";
import { AudioLines, Clock3, FolderOpen, FolderPlus, HardDrive, ImageIcon, LoaderCircle, Plus, Sparkles, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import { toast } from "sonner";

type ProjectProcessingProgress = { stage: string; label: string; message: string; completedPercent: number; narration: { status: "pending" | "processing" | "completed"; durationMs: number | null; chunks: { totalChunks: number; completedChunks: number; activeChunkIndex: number; chunkOverlapMs: number; state: "processing" | "waiting" | "completed"; lastError: { category: string; message: string; retryAfterMs?: number; httpStatus?: number; requestDurationMs: number } | null } | null }; images: { completed: number; total: number }; elapsedMs: number; startedAtMs: number; estimatedRemainingMs: number | null; estimatedRemainingRange: { lowerMs: number; upperMs: number } | null; estimatedAtMs: number; initialEstimatedTotalMs: number; estimateSource: "preparing" | "observed" };
type ProjectSummary = { id: number; name: string; narrationOriginalName: string | null; imageSourcePath: string | null; outputPath: string | null; audioDurationMs: number | null; sourceImageCount: number; sourcesAttached: boolean; status: string; workerState: string; analysisBlocker: string | null; processingProgress: ProjectProcessingProgress | null; timelineGenerationJob: { status: string; currentStage: string; retryAt: number | null; lastError: unknown } | null };
type Selection = { narration: File | null; images: File[]; sourceFolderName: string; outputFolderName: string; nativeSourceDirectory: string; nativeOutputDirectory: string };

const statusLabel = (status: string) => status.replaceAll("_", " ");
const formatDuration = (milliseconds: number | null) => milliseconds === null ? "Duration pending" : `${Math.floor(milliseconds / 60000)}:${String(Math.round(milliseconds / 1000) % 60).padStart(2, "0")} narration`;
const formatElapsed = (milliseconds: number) => { const seconds = Math.max(0, Math.round(milliseconds / 1000)); const minutes = Math.floor(seconds / 60); return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`; };
const fileOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function emptySelection(): Selection { return { narration: null, images: [], sourceFolderName: "", outputFolderName: "", nativeSourceDirectory: "", nativeOutputDirectory: "" }; }

async function audioDurationMs(file: File) {
  return await new Promise<number>((resolve, reject) => {
    const audio = document.createElement("audio");
    const objectUrl = URL.createObjectURL(file);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => { URL.revokeObjectURL(objectUrl); const duration = Math.round(audio.duration * 1000); Number.isFinite(duration) && duration > 0 ? resolve(duration) : reject(new Error("The selected audio file has no usable duration.")); };
    audio.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("The selected audio file could not be read by this browser.")); };
    audio.src = objectUrl;
  });
}

async function uploadMediaFile(projectId: number, assetType: "narration" | "image", file: File, signal: AbortSignal, sequenceNumber?: number, durationMs?: number) {
  const response = await fetch("/api/project-media/upload", { method: "POST", credentials: "include", signal, headers: { "content-type": file.type || "application/octet-stream", "x-project-id": String(projectId), "x-asset-type": assetType, "x-original-filename": encodeURIComponent(file.name), ...(sequenceNumber ? { "x-sequence-number": String(sequenceNumber) } : {}), ...(durationMs ? { "x-audio-duration-ms": String(durationMs) } : {}) }, body: file });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(payload?.error || `Upload failed for ${file.name}.`);
}

export default function Projects() {
  const { isAuthenticated } = useAuth();
  const utils = trpc.useUtils();
  const projects = trpc.project.list.useQuery(undefined, { enabled: isAuthenticated });
  const hasLiveProcessing = Boolean(projects.data?.some(project => project.processingProgress));
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [mediaProject, setMediaProject] = useState<ProjectSummary | null>(null);
  const [busyLabel, setBusyLabel] = useState("");
  const activeImportAbort = useRef<AbortController | null>(null);
  const createProject = trpc.project.create.useMutation();
  const prepareImport = trpc.project.prepareMediaImport.useMutation();
  const updateSetup = trpc.project.updateSetup.useMutation();
  const processTimeline = trpc.project.processGlobalTimeline.useMutation();
  const removeProject = trpc.project.remove.useMutation({ onSuccess: async () => { await Promise.all([utils.project.list.invalidate(), utils.timeline.review.invalidate(), utils.timeline.candidates.invalidate(), utils.worker.renderHandoff.invalidate(), utils.worker.renderedVideo.invalidate()]); toast.success("Project removed from the workspace."); }, onError: error => toast.error(error.message) });

  const ingestAndProcess = async (projectId: number, selection: Selection) => {
    if (!selection.narration || !selection.images.length) throw new Error("Choose one narration file and at least one image before continuing.");
    const importAbort = new AbortController();
    activeImportAbort.current = importAbort;
    const orderedImages = selection.images.slice().sort((left, right) => fileOrder.compare(left.webkitRelativePath || left.name, right.webkitRelativePath || right.name));
    const assertNotAborted = () => { if (importAbort.signal.aborted) throw new DOMException("Upload cancelled by user.", "AbortError"); };
    try {
      setBusyLabel("Preparing secure media import…");
      await prepareImport.mutateAsync({ projectId });
      assertNotAborted();
      const durationMs = await audioDurationMs(selection.narration);
      assertNotAborted();
      setBusyLabel("Uploading narration…");
      await uploadMediaFile(projectId, "narration", selection.narration, importAbort.signal, undefined, durationMs);
      for (let index = 0; index < orderedImages.length; index += 1) {
        assertNotAborted();
        const image = orderedImages[index];
        setBusyLabel(`Uploading image ${index + 1} of ${orderedImages.length}…`);
        await uploadMediaFile(projectId, "image", image, importAbort.signal, index + 1);
      }
      assertNotAborted();
      await updateSetup.mutateAsync({ projectId, narrationOriginalName: selection.narration.name, imageSourcePath: selection.nativeSourceDirectory.trim() || (selection.sourceFolderName ? `Native source folder selected: ${selection.sourceFolderName}` : `Browser-selected image folder (${orderedImages.length} files)`), outputPath: selection.nativeOutputDirectory.trim() || (selection.outputFolderName ? `Native output folder selected: ${selection.outputFolderName}` : "Choose the output folder in the render command") });
      setBusyLabel("Groq is analyzing narration and building the readable visual flow…");
      await processTimeline.mutateAsync({ projectId });
      await Promise.all([utils.project.list.invalidate(), utils.timeline.review.invalidate({ projectId })]);
      toast.success("Hosted Timeline Generation is queued. You may safely close the browser; progress is saved server-side.");
    } finally {
      if (activeImportAbort.current === importAbort) activeImportAbort.current = null;
    }
  };

  const cancelImport = () => {
    if (!activeImportAbort.current) return;
    setBusyLabel("Cancelling upload…");
    activeImportAbort.current.abort();
    setNewDialogOpen(false);
    setMediaProject(null);
  };

  const runCreate = async (name: string, selection: Selection) => {
    try {
      setBusyLabel("Creating project…");
      const created = await createProject.mutateAsync({ name });
      await ingestAndProcess(created.projectId, selection);
      setNewDialogOpen(false);
    } catch (error) { if (error instanceof DOMException && error.name === "AbortError") toast.message("Upload cancelled. You can select media and start again."); else toast.error(error instanceof Error ? error.message : "Project media could not be imported."); }
    finally { setBusyLabel(""); }
  };
  const runExistingImport = async (project: ProjectSummary, selection: Selection) => {
    try { await ingestAndProcess(project.id, selection); setMediaProject(null); }
    catch (error) { if (error instanceof DOMException && error.name === "AbortError") toast.message("Upload cancelled. You can select media and start again."); else toast.error(error instanceof Error ? error.message : "Project media could not be imported."); }
    finally { setBusyLabel(""); }
  };
  const retryAnalysis = async (project: ProjectSummary) => {
    try {
      setBusyLabel("Restarting Groq analysis with your existing uploaded media…");
      await processTimeline.mutateAsync({ projectId: project.id });
      await Promise.all([utils.project.list.invalidate(), utils.timeline.review.invalidate({ projectId: project.id })]);
      toast.success("Hosted Timeline Generation is queued from the saved progress state.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Project analysis could not be restarted.");
    } finally {
      setBusyLabel("");
    }
  };
  const busy = Boolean(busyLabel);

  useEffect(() => {
    if (!hasLiveProcessing) return;
    const poll = window.setInterval(() => { setLiveNowMs(Date.now()); void projects.refetch(); }, 2_000);
    return () => window.clearInterval(poll);
  }, [hasLiveProcessing, projects.refetch]);

  return <div className="vs-page-enter mx-auto max-w-6xl space-y-6">
    <section className="vs-surface flex flex-col justify-between gap-5 rounded-[1.5rem] p-6 md:flex-row md:items-end md:p-8"><div><p className="vs-kicker">Project library</p><h1 className="vs-page-title mt-2">Projects and source media</h1><p className="vs-page-copy mt-3 max-w-2xl">Create a project, choose your narration and image folder, then let VisualSync prepare a reviewable visual timeline at 1920 × 1080.</p></div>{isAuthenticated ? <NewProjectDialog open={newDialogOpen} onOpenChange={setNewDialogOpen} onCreate={runCreate} onCancel={cancelImport} busyLabel={busyLabel} /> : null}</section>
    {!isAuthenticated ? <AuthPrompt noun="project library" /> : projects.isLoading ? <LoadingRows /> : projects.data?.length ? <section className="vs-surface overflow-hidden rounded-[1.5rem]">{projects.data.map(project => <article key={project.id} className="border-b border-white/[0.055] px-5 py-5 last:border-0 sm:px-6"><div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><div><div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-slate-100">{project.name}</p><Badge className="w-fit border border-cyan-300/10 bg-cyan-300/[0.08] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-100 hover:bg-cyan-300/[0.08]">{statusLabel(project.status)}</Badge></div><p className="mt-1 text-xs text-slate-500">{project.narrationOriginalName || "Narration not selected"} · 1080p · 16:9</p></div><div className="flex flex-wrap items-center gap-2 text-xs text-slate-400"><span className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5"><AudioLines className="h-3.5 w-3.5 text-cyan-200" />{formatDuration(project.audioDurationMs)}</span><span className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5"><ImageIcon className="h-3.5 w-3.5 text-cyan-200" />{project.sourceImageCount} images</span><Button size="sm" variant="outline" disabled={busy} onClick={() => setMediaProject(project)} className="border-white/10 text-slate-300 hover:bg-white/[0.06] hover:text-white"><FolderOpen className="mr-1.5 h-3.5 w-3.5" />Source media</Button><Button size="sm" variant="outline" disabled={busy || removeProject.isPending} onClick={() => { if (window.confirm(`Delete “${project.name}”? Its timeline and media references will be removed from VisualSync.`)) removeProject.mutate({ projectId: project.id }); }} className="border-rose-300/15 text-rose-200 hover:bg-rose-300/10 hover:text-rose-100"><Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete</Button></div></div>{project.processingProgress ? <LiveProcessingStatus progress={project.processingProgress} nowMs={liveNowMs} /> : project.analysisBlocker ? <div className="mt-4 rounded-xl border border-amber-200/10 bg-amber-200/[0.045] p-3 text-xs leading-5 text-amber-100/75"><div className="flex items-start gap-2"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{project.analysisBlocker}</div>{project.status === "failed" || project.workerState === "error" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => retryAnalysis(project)} className="mt-3 border-amber-200/20 text-amber-100 hover:bg-amber-200/10 hover:text-amber-50"><LoaderCircle className="mr-1.5 h-3.5 w-3.5" />Retry analysis</Button> : null}</div> : <p className="mt-3 text-xs text-slate-500">{project.sourcesAttached ? "Source media is ready. Replace the selection only if you want to rebuild the visual timeline." : "Select narration and an image folder to begin secure upload and analysis."}</p>}</article>)}</section> : <EmptyProjects onCreate={() => setNewDialogOpen(true)} />}
    <MediaSetupDialog project={mediaProject} onOpenChange={open => { if (!open && !busy) setMediaProject(null); }} onImport={runExistingImport} onCancel={cancelImport} busyLabel={busyLabel} />
  </div>;
}

function NewProjectDialog({ open, onOpenChange, onCreate, onCancel, busyLabel }: { open: boolean; onOpenChange: (value: boolean) => void; onCreate: (name: string, selection: Selection) => Promise<void>; onCancel: () => void; busyLabel: string }) { const [name, setName] = useState(""); const [selection, setSelection] = useState(emptySelection); const busy = Boolean(busyLabel); useEffect(() => { if (!open && !busy) { setName(""); setSelection(emptySelection()); } }, [open, busy]); const submit = async (event: React.FormEvent) => { event.preventDefault(); if (!name.trim()) return toast.error("Enter a project name."); await onCreate(name.trim(), selection); }; const close = () => { if (busy) onCancel(); else onOpenChange(false); }; return <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) close(); else onOpenChange(true); }}><DialogTrigger asChild><Button className="h-11 bg-cyan-200 text-slate-950 hover:bg-cyan-100"><Plus className="mr-2 h-4 w-4" />New project</Button></DialogTrigger><DialogContent showCloseButton={false} className="max-h-[92vh] overflow-x-hidden overflow-y-auto border-white/10 bg-[#121b2a] p-5 text-slate-100 sm:max-w-xl sm:p-6"><button type="button" onClick={close} className="absolute right-4 top-4 rounded-md p-1.5 text-slate-400 transition hover:bg-white/[0.08] hover:text-white" aria-label={busy ? "Cancel upload" : "Close project setup"} title={busy ? "Cancel upload" : "Close setup"}><X className="h-4 w-4" /></button><DialogHeader className="pr-10"><DialogTitle className="text-xl text-white">Set up a new project</DialogTitle><DialogDescription className="text-slate-500">Name the project, select your narration and image folder, then choose where the local Windows render should save the final MP4.</DialogDescription></DialogHeader><form onSubmit={submit} className="min-w-0 space-y-4 pt-2"><label className="block min-w-0 space-y-1.5"><span className="text-xs font-medium text-slate-300">Project name</span><input value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Finance Story" required className="vs-field flex w-full px-3 text-sm placeholder:text-slate-600" /></label><MediaPickers selection={selection} onChange={setSelection} disabled={busy} /><ImportButton busyLabel={busyLabel} /></form></DialogContent></Dialog>; }

function MediaSetupDialog({ project, onOpenChange, onImport, onCancel, busyLabel }: { project: ProjectSummary | null; onOpenChange: (value: boolean) => void; onImport: (project: ProjectSummary, selection: Selection) => Promise<void>; onCancel: () => void; busyLabel: string }) { const [selection, setSelection] = useState(emptySelection); const busy = Boolean(busyLabel); useEffect(() => { if (!project) setSelection(emptySelection()); }, [project]); const close = () => { if (busy) onCancel(); else onOpenChange(false); }; return <Dialog open={Boolean(project)} onOpenChange={nextOpen => { if (!nextOpen) close(); else onOpenChange(true); }}><DialogContent showCloseButton={false} className="max-h-[92vh] overflow-x-hidden overflow-y-auto border-white/10 bg-[#121b2a] p-5 text-slate-100 sm:max-w-xl sm:p-6"><button type="button" onClick={close} className="absolute right-4 top-4 rounded-md p-1.5 text-slate-400 transition hover:bg-white/[0.08] hover:text-white" aria-label={busy ? "Cancel upload" : "Close media setup"} title={busy ? "Cancel upload" : "Close setup"}><X className="h-4 w-4" /></button><DialogHeader className="pr-10"><DialogTitle className="text-xl text-white">Choose media for {project?.name}</DialogTitle><DialogDescription className="text-slate-500">Replacing media resets the project’s previous timeline and approval. All selected files will be securely uploaded and processed in their folder order.</DialogDescription></DialogHeader><div className="min-w-0 space-y-4 pt-2"><MediaPickers selection={selection} onChange={setSelection} disabled={busy} /><div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end"><Button type="button" variant="ghost" onClick={close} className="text-slate-400 hover:bg-white/[0.06] hover:text-white">{busy ? "Cancel upload" : "Cancel"}</Button><Button disabled={busy} onClick={() => project && onImport(project, selection)} className="bg-cyan-200 text-slate-950 hover:bg-cyan-100"><Upload className="mr-2 h-4 w-4" />{busy ? busyLabel : "Upload and build timeline"}</Button></div></div></DialogContent></Dialog>; }

function MediaPickers({ selection, onChange, disabled }: { selection: Selection; onChange: (selection: Selection) => void; disabled: boolean }) { const narrationInput = useRef<HTMLInputElement>(null); const imageInput = useRef<HTMLInputElement>(null); const outputFallback = useRef<HTMLInputElement>(null); useEffect(() => { imageInput.current?.setAttribute("webkitdirectory", ""); imageInput.current?.setAttribute("directory", ""); outputFallback.current?.setAttribute("webkitdirectory", ""); outputFallback.current?.setAttribute("directory", ""); }, []); const pickOutput = async () => { const pickerWindow = window as Window & { showDirectoryPicker?: () => Promise<{ name: string }> }; if (pickerWindow.showDirectoryPicker) { try { const handle = await pickerWindow.showDirectoryPicker(); onChange({ ...selection, outputFolderName: handle.name }); return; } catch { /* Fall through to the browser directory-input fallback. */ } } outputFallback.current?.click(); }; const clearNarration = () => { if (narrationInput.current) narrationInput.current.value = ""; onChange({ ...selection, narration: null }); }; const clearImages = () => { if (imageInput.current) imageInput.current.value = ""; onChange({ ...selection, images: [], sourceFolderName: "", nativeSourceDirectory: "" }); }; const clearOutput = () => { if (outputFallback.current) outputFallback.current.value = ""; onChange({ ...selection, outputFolderName: "", nativeOutputDirectory: "" }); }; return <div className="space-y-3"><input ref={narrationInput} type="file" accept="audio/*" className="sr-only" disabled={disabled} onChange={event => onChange({ ...selection, narration: event.target.files?.[0] ?? null })} /><input ref={imageInput} type="file" accept="image/*" multiple className="sr-only" disabled={disabled} onChange={event => { const images = Array.from(event.target.files ?? []).filter(file => file.type.startsWith("image/")); onChange({ ...selection, images, sourceFolderName: images[0]?.webkitRelativePath.split("/")[0] || "" }); }} /><input ref={outputFallback} type="file" multiple className="sr-only" disabled={disabled} onChange={event => { const first = event.target.files?.[0]; if (first) onChange({ ...selection, outputFolderName: first.webkitRelativePath.split("/")[0] || "selected folder" }); }} /><PickerCard icon={<AudioLines className="h-4 w-4" />} title="1. Narration" detail={selection.narration ? `${selection.narration.name} · ${(selection.narration.size / 1024 / 1024).toFixed(1)} MB` : "Select one audio file to establish the timing of the video."} action="Select audio" onClick={() => narrationInput.current?.click()} onClear={selection.narration ? clearNarration : undefined} disabled={disabled} /><PickerCard icon={<ImageIcon className="h-4 w-4" />} title="2. Image folder" detail={selection.images.length ? `${selection.images.length} images selected from ${selection.sourceFolderName || "your folder"}.` : "Choose the folder that contains your ordered visual assets."} action="Select folder" onClick={() => imageInput.current?.click()} onClear={selection.images.length ? clearImages : undefined} disabled={disabled} /><PickerCard icon={<HardDrive className="h-4 w-4" />} title="3. Local output folder" detail={selection.outputFolderName ? `${selection.outputFolderName} selected. The Windows render command will use this destination automatically.` : "Choose where the local Windows worker should save this project’s MP4."} action="Choose folder" onClick={pickOutput} onClear={selection.outputFolderName ? clearOutput : undefined} disabled={disabled} /><div className="rounded-xl border border-cyan-200/[.12] bg-cyan-200/[.035] p-3"><p className="text-xs font-medium text-cyan-100">Exact Windows paths for future render commands</p><p className="mt-1 text-[11px] leading-5 text-slate-500">Browser folder pickers protect your privacy and only expose the folder name. Paste the real paths once, for example <code className="text-cyan-100">D:\\Test</code>, so the handoff command never guesses a Downloads folder.</p><div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="grid gap-1 text-[11px] font-medium text-slate-400">Source folder path<input aria-label="Native source folder path" value={selection.nativeSourceDirectory} onChange={event => onChange({ ...selection, nativeSourceDirectory: event.target.value })} placeholder="D:\\Test" className="vs-field w-full px-2.5 py-2 text-xs placeholder:text-slate-600" /></label><label className="grid gap-1 text-[11px] font-medium text-slate-400">Output folder path<input aria-label="Native output folder path" value={selection.nativeOutputDirectory} onChange={event => onChange({ ...selection, nativeOutputDirectory: event.target.value })} placeholder="D:\\Test" className="vs-field w-full px-2.5 py-2 text-xs placeholder:text-slate-600" /></label></div></div></div>; }

function PickerCard({ icon, title, detail, action, onClick, onClear, disabled }: { icon: React.ReactNode; title: string; detail: string; action: string; onClick: () => void; onClear?: () => void; disabled: boolean }) { return <div className="min-w-0 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3"><div className="flex min-w-0 items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-cyan-200/10 text-cyan-200">{icon}</span><div className="min-w-0 flex-1"><p className="text-sm font-medium text-slate-200">{title}</p><p className="mt-0.5 break-words text-xs leading-5 text-slate-500">{detail}</p></div>{onClear ? <Button type="button" variant="ghost" size="icon" disabled={disabled} onClick={onClear} title={`Clear ${title.toLowerCase()}`} aria-label={`Clear ${title.toLowerCase()}`} className="h-8 w-8 shrink-0 text-slate-400 hover:bg-rose-400/10 hover:text-rose-200"><X className="h-4 w-4" /></Button> : null}</div><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onClick} className="mt-3 w-full border-white/10 text-slate-200 hover:bg-white/[0.06] hover:text-white">{action}</Button></div>; }
function LiveProcessingStatus({ progress, nowMs }: { progress: ProjectProcessingProgress; nowMs: number }) {
  const elapsedMs = Math.max(progress.elapsedMs, nowMs - progress.startedAtMs);
  const sinceEstimateMs = Math.max(0, nowMs - progress.estimatedAtMs);
  const lowerMs = progress.estimatedRemainingRange ? Math.max(0, progress.estimatedRemainingRange.lowerMs - sinceEstimateMs) : null;
  const upperMs = progress.estimatedRemainingRange ? Math.max(0, progress.estimatedRemainingRange.upperMs - sinceEstimateMs) : null;
  const chunks = progress.narration.chunks;
  return <div className="mt-4 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.045] p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="flex items-start gap-2.5"><LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-cyan-200" /><div><p className="text-sm font-semibold text-cyan-50">{progress.label}</p><p className="mt-1 text-xs leading-5 text-cyan-100/70">{progress.message}</p><p className="mt-1 text-[11px] leading-5 text-cyan-100/55">Hosted job state is saved server-side. You may close this browser and return later to see the current status.</p></div></div><div className="flex items-center gap-1.5 text-xs text-cyan-100/75"><Clock3 className="h-3.5 w-3.5" />Elapsed {formatElapsed(elapsedMs)}</div></div><div className="mt-4"><div className="mb-2 flex items-center justify-between gap-3 text-xs"><span className="text-cyan-100/70">{progress.completedPercent ? `${progress.completedPercent}% complete` : "Preparing"}</span><span className="text-cyan-100/70">{lowerMs !== null && upperMs !== null ? `Approx. ${formatElapsed(lowerMs)}–${formatElapsed(upperMs)} remaining` : "ETA appears after real work is measured"}</span></div><Progress value={progress.completedPercent} className="h-2 bg-cyan-950/70" /></div><div className="mt-4 grid gap-2 text-xs sm:grid-cols-3"><div className="rounded-lg bg-slate-950/25 p-2.5"><span className="text-slate-500">Narration</span><p className="mt-1 font-medium text-slate-100">{chunks ? `Chunk ${chunks.activeChunkIndex} of ${chunks.totalChunks}` : progress.narration.status === "completed" ? "Analyzed" : progress.narration.status === "processing" ? "Analyzing" : "Waiting"} · {formatDuration(progress.narration.durationMs)}</p>{chunks ? <p className="mt-1 text-[11px] text-slate-500">{chunks.completedChunks} saved · {chunks.chunkOverlapMs ? `${Math.round(chunks.chunkOverlapMs / 1000)}s boundary overlap` : "single request"}{chunks.state === "waiting" ? " · waiting for Groq" : ""}</p> : null}</div><div className="rounded-lg bg-slate-950/25 p-2.5"><span className="text-slate-500">Images</span><p className="mt-1 font-medium text-slate-100">{progress.images.completed} / {progress.images.total} analyzed</p></div><div className="rounded-lg bg-slate-950/25 p-2.5"><span className="text-slate-500">Estimate</span><p className="mt-1 font-medium text-slate-100">{progress.estimateSource === "observed" ? "Based on current speed" : "Preparing — no measured ETA yet"}</p></div></div></div>;
}
function ImportButton({ busyLabel }: { busyLabel: string }) { return <Button disabled={Boolean(busyLabel)} className="w-full bg-cyan-200 text-slate-950 hover:bg-cyan-100">{busyLabel ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />{busyLabel}</> : <><Sparkles className="mr-2 h-4 w-4" />Upload and analyze project</>}</Button>; }
function EmptyProjects({ onCreate }: { onCreate: () => void }) { return <section className="rounded-[1.5rem] border border-dashed border-white/10 bg-white/[0.018] px-6 py-14 text-center"><FolderPlus className="mx-auto h-7 w-7 text-cyan-200" /><h2 className="mt-4 text-lg font-semibold text-white">Your library is empty</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">Create a project, select the real narration and image folder from File Explorer, and build a readable 1920 × 1080 visual timeline.</p><Button onClick={onCreate} className="mt-5 bg-cyan-200 text-slate-950 hover:bg-cyan-100"><Plus className="mr-2 h-4 w-4" />New project</Button></section>; }
function LoadingRows() { return <div className="space-y-3">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-[78px] animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.025]" />)}</div>; }
