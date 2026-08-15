import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { AuthPrompt } from "@/components/AuthPrompt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { AudioLines, FolderOpen, FolderPlus, HardDrive, ImageIcon, LoaderCircle, Plus, Sparkles, TriangleAlert, Upload } from "lucide-react";
import { toast } from "sonner";

type ProjectSummary = { id: number; name: string; narrationOriginalName: string | null; imageSourcePath: string | null; outputPath: string | null; audioDurationMs: number | null; sourceImageCount: number; sourcesAttached: boolean; status: string; analysisBlocker: string | null };
type Selection = { narration: File | null; images: File[]; outputFolderName: string };

const statusLabel = (status: string) => status.replaceAll("_", " ");
const formatDuration = (milliseconds: number | null) => milliseconds === null ? "Duration pending" : `${Math.floor(milliseconds / 60000)}:${String(Math.round(milliseconds / 1000) % 60).padStart(2, "0")} narration`;
const fileOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function emptySelection(): Selection { return { narration: null, images: [], outputFolderName: "" }; }

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

async function uploadMediaFile(projectId: number, assetType: "narration" | "image", file: File, sequenceNumber?: number, durationMs?: number) {
  const response = await fetch("/api/project-media/upload", { method: "POST", credentials: "include", headers: { "content-type": file.type || "application/octet-stream", "x-project-id": String(projectId), "x-asset-type": assetType, "x-original-filename": encodeURIComponent(file.name), ...(sequenceNumber ? { "x-sequence-number": String(sequenceNumber) } : {}), ...(durationMs ? { "x-audio-duration-ms": String(durationMs) } : {}) }, body: file });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(payload?.error || `Upload failed for ${file.name}.`);
}

export default function Projects() {
  const { isAuthenticated } = useAuth();
  const utils = trpc.useUtils();
  const projects = trpc.project.list.useQuery(undefined, { enabled: isAuthenticated });
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [mediaProject, setMediaProject] = useState<ProjectSummary | null>(null);
  const [busyLabel, setBusyLabel] = useState("");
  const createProject = trpc.project.create.useMutation();
  const prepareImport = trpc.project.prepareMediaImport.useMutation();
  const updateSetup = trpc.project.updateSetup.useMutation();
  const processTimeline = trpc.project.processGlobalTimeline.useMutation();

  const ingestAndProcess = async (projectId: number, selection: Selection) => {
    if (!selection.narration || !selection.images.length) throw new Error("Choose one narration file and at least one image before continuing.");
    const orderedImages = selection.images.slice().sort((left, right) => fileOrder.compare(left.webkitRelativePath || left.name, right.webkitRelativePath || right.name));
    setBusyLabel("Preparing secure media import…");
    await prepareImport.mutateAsync({ projectId });
    const durationMs = await audioDurationMs(selection.narration);
    setBusyLabel("Uploading narration…");
    await uploadMediaFile(projectId, "narration", selection.narration, undefined, durationMs);
    for (let index = 0; index < orderedImages.length; index += 1) {
      const image = orderedImages[index];
      setBusyLabel(`Uploading image ${index + 1} of ${orderedImages.length}…`);
      await uploadMediaFile(projectId, "image", image, index + 1);
    }
    await updateSetup.mutateAsync({ projectId, narrationOriginalName: selection.narration.name, imageSourcePath: `Browser-selected image folder (${orderedImages.length} files)`, outputPath: selection.outputFolderName ? `Native output folder selected: ${selection.outputFolderName}` : "Choose the output folder in the render command" });
    setBusyLabel("Groq is analyzing narration and building the readable visual flow…");
    const result = await processTimeline.mutateAsync({ projectId });
    await Promise.all([utils.project.list.invalidate(), utils.timeline.review.invalidate({ projectId })]);
    toast.success(`${result.imageCount} ordered images are ready with a ${Math.round(result.minimumDurationMs / 100) / 10}s-or-longer readable hold.`);
  };

  const runCreate = async (name: string, selection: Selection) => {
    try {
      setBusyLabel("Creating project…");
      const created = await createProject.mutateAsync({ name });
      await ingestAndProcess(created.projectId, selection);
      setNewDialogOpen(false);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Project media could not be imported."); }
    finally { setBusyLabel(""); }
  };
  const runExistingImport = async (project: ProjectSummary, selection: Selection) => {
    try { await ingestAndProcess(project.id, selection); setMediaProject(null); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Project media could not be imported."); }
    finally { setBusyLabel(""); }
  };
  const busy = Boolean(busyLabel);

  return <div className="mx-auto max-w-6xl space-y-6">
    <section className="flex flex-col justify-between gap-5 rounded-[1.5rem] border border-white/[0.07] bg-[#101827] p-6 md:flex-row md:items-end md:p-8"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200/70">Project library</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-white">Stories in progress</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Choose media from your computer instead of pasting paths. Selected files are securely uploaded, then Groq creates a readable, all-image visual flow at fixed 1920 × 1080 / 16:9.</p></div>{isAuthenticated ? <NewProjectDialog open={newDialogOpen} onOpenChange={setNewDialogOpen} onCreate={runCreate} busyLabel={busyLabel} /> : null}</section>
    {!isAuthenticated ? <AuthPrompt noun="project library" /> : projects.isLoading ? <LoadingRows /> : projects.data?.length ? <section className="overflow-hidden rounded-[1.5rem] border border-white/[0.07] bg-[#101827]">{projects.data.map(project => <article key={project.id} className="border-b border-white/[0.055] px-6 py-5 last:border-0"><div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><div><div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-slate-100">{project.name}</p><Badge className="w-fit border border-cyan-300/10 bg-cyan-300/[0.08] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-100 hover:bg-cyan-300/[0.08]">{statusLabel(project.status)}</Badge></div><p className="mt-1 text-xs text-slate-500">{project.narrationOriginalName || "Narration not selected"} · 16:9 · 1080p</p></div><div className="flex flex-wrap items-center gap-2 text-xs text-slate-400"><span className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5"><AudioLines className="h-3.5 w-3.5 text-cyan-200" />{formatDuration(project.audioDurationMs)}</span><span className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5"><ImageIcon className="h-3.5 w-3.5 text-cyan-200" />{project.sourceImageCount} images</span><Button size="sm" variant="outline" disabled={busy} onClick={() => setMediaProject(project)} className="border-white/10 text-slate-300 hover:bg-white/[0.06] hover:text-white"><FolderOpen className="mr-1.5 h-3.5 w-3.5" />Choose media</Button></div></div>{project.analysisBlocker ? <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200/10 bg-amber-200/[0.045] p-3 text-xs leading-5 text-amber-100/75"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{project.analysisBlocker}</div> : <p className="mt-3 text-xs text-slate-500">{project.sourcesAttached ? "Secure source media is attached. You can replace the selection to regenerate the full visual timeline." : "Choose narration and image folder to start the secure upload and global readable-pacing workflow."}</p>}</article>)}</section> : <EmptyProjects onCreate={() => setNewDialogOpen(true)} />}
    <MediaSetupDialog project={mediaProject} onOpenChange={open => { if (!open && !busy) setMediaProject(null); }} onImport={runExistingImport} busyLabel={busyLabel} />
  </div>;
}

function NewProjectDialog({ open, onOpenChange, onCreate, busyLabel }: { open: boolean; onOpenChange: (value: boolean) => void; onCreate: (name: string, selection: Selection) => Promise<void>; busyLabel: string }) { const [name, setName] = useState(""); const [selection, setSelection] = useState(emptySelection); const busy = Boolean(busyLabel); useEffect(() => { if (!open && !busy) { setName(""); setSelection(emptySelection()); } }, [open, busy]); const submit = async (event: React.FormEvent) => { event.preventDefault(); if (!name.trim()) return toast.error("Enter a project name."); await onCreate(name.trim(), selection); }; return <Dialog open={open} onOpenChange={onOpenChange}><DialogTrigger asChild><Button className="h-11 bg-cyan-200 text-slate-950 hover:bg-cyan-100"><Plus className="mr-2 h-4 w-4" />New project</Button></DialogTrigger><DialogContent className="max-h-[92vh] overflow-y-auto border-white/10 bg-[#121b2a] text-slate-100 sm:max-w-xl"><DialogHeader><DialogTitle className="text-xl text-white">Create and import a project</DialogTitle><DialogDescription className="text-slate-500">Choose your actual narration and image folder. VisualSync uploads them to secure project storage; pasted local paths are no longer used as input.</DialogDescription></DialogHeader><form onSubmit={submit} className="space-y-4 pt-2"><label className="block space-y-1.5"><span className="text-xs font-medium text-slate-300">Project name</span><input value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Finance Story" required className="flex h-10 w-full rounded-md border border-white/10 bg-white/[0.035] px-3 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-cyan-200/50" /></label><MediaPickers selection={selection} onChange={setSelection} disabled={busy} /><ImportButton busyLabel={busyLabel} /></form></DialogContent></Dialog>; }

function MediaSetupDialog({ project, onOpenChange, onImport, busyLabel }: { project: ProjectSummary | null; onOpenChange: (value: boolean) => void; onImport: (project: ProjectSummary, selection: Selection) => Promise<void>; busyLabel: string }) { const [selection, setSelection] = useState(emptySelection); const busy = Boolean(busyLabel); useEffect(() => { if (!project) setSelection(emptySelection()); }, [project]); return <Dialog open={Boolean(project)} onOpenChange={onOpenChange}><DialogContent className="max-h-[92vh] overflow-y-auto border-white/10 bg-[#121b2a] text-slate-100 sm:max-w-xl"><DialogHeader><DialogTitle className="text-xl text-white">Choose media for {project?.name}</DialogTitle><DialogDescription className="text-slate-500">Replacing media resets the project’s previous timeline and approval. All selected files will be securely uploaded and processed in their folder order.</DialogDescription></DialogHeader><div className="space-y-4 pt-2"><MediaPickers selection={selection} onChange={setSelection} disabled={busy} /><div className="flex justify-end gap-2 pt-2"><Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)} className="text-slate-400 hover:bg-white/[0.06] hover:text-white">Cancel</Button><Button disabled={busy} onClick={() => project && onImport(project, selection)} className="bg-cyan-200 text-slate-950 hover:bg-cyan-100"><Upload className="mr-2 h-4 w-4" />{busy ? busyLabel : "Upload and build timeline"}</Button></div></div></DialogContent></Dialog>; }

function MediaPickers({ selection, onChange, disabled }: { selection: Selection; onChange: (selection: Selection) => void; disabled: boolean }) { const imageInput = useRef<HTMLInputElement>(null); const outputFallback = useRef<HTMLInputElement>(null); useEffect(() => { imageInput.current?.setAttribute("webkitdirectory", ""); imageInput.current?.setAttribute("directory", ""); outputFallback.current?.setAttribute("webkitdirectory", ""); outputFallback.current?.setAttribute("directory", ""); }, []); const pickOutput = async () => { const pickerWindow = window as Window & { showDirectoryPicker?: () => Promise<{ name: string }> }; if (pickerWindow.showDirectoryPicker) { try { const handle = await pickerWindow.showDirectoryPicker(); onChange({ ...selection, outputFolderName: handle.name }); return; } catch { /* Fall through to the browser directory-input fallback. */ } } outputFallback.current?.click(); }; return <div className="space-y-3"><input type="file" accept="audio/*" className="sr-only" id="narration-picker" disabled={disabled} onChange={event => onChange({ ...selection, narration: event.target.files?.[0] ?? null })} /><input ref={imageInput} type="file" accept="image/*" multiple className="sr-only" disabled={disabled} onChange={event => onChange({ ...selection, images: Array.from(event.target.files ?? []).filter(file => file.type.startsWith("image/")) })} /><input ref={outputFallback} type="file" multiple className="sr-only" disabled={disabled} onChange={event => { const first = event.target.files?.[0]; if (first) onChange({ ...selection, outputFolderName: first.webkitRelativePath.split("/")[0] || "selected folder" }); }} /><PickerCard icon={<AudioLines className="h-4 w-4" />} title="Narration audio" detail={selection.narration ? `${selection.narration.name} · ${(selection.narration.size / 1024 / 1024).toFixed(1)} MB` : "Click to open File Explorer and select one audio file."} action="Select audio" onClick={() => document.getElementById("narration-picker")?.click()} disabled={disabled} /><PickerCard icon={<ImageIcon className="h-4 w-4" />} title="Images folder" detail={selection.images.length ? `${selection.images.length} images selected in natural folder order.` : "Click to open File Explorer and choose the folder containing your images."} action="Select folder" onClick={() => imageInput.current?.click()} disabled={disabled} /><PickerCard icon={<HardDrive className="h-4 w-4" />} title="Native MP4 output folder" detail={selection.outputFolderName ? `${selection.outputFolderName} selected. The Windows render command will open this destination by default.` : "Click to open File Explorer and choose the destination folder for this project’s MP4."} action="Choose output" onClick={pickOutput} disabled={disabled} /></div>; }

function PickerCard({ icon, title, detail, action, onClick, disabled }: { icon: React.ReactNode; title: string; detail: string; action: string; onClick: () => void; disabled: boolean }) { return <div className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-cyan-200/10 text-cyan-200">{icon}</span><div className="min-w-0 flex-1"><p className="text-sm font-medium text-slate-200">{title}</p><p className="mt-0.5 truncate text-xs text-slate-500">{detail}</p></div><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onClick} className="shrink-0 border-white/10 text-slate-200 hover:bg-white/[0.06] hover:text-white">{action}</Button></div>; }
function ImportButton({ busyLabel }: { busyLabel: string }) { return <Button disabled={Boolean(busyLabel)} className="w-full bg-cyan-200 text-slate-950 hover:bg-cyan-100">{busyLabel ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />{busyLabel}</> : <><Sparkles className="mr-2 h-4 w-4" />Securely upload and build timeline</>}</Button>; }
function EmptyProjects({ onCreate }: { onCreate: () => void }) { return <section className="rounded-[1.5rem] border border-dashed border-white/10 bg-white/[0.018] px-6 py-14 text-center"><FolderPlus className="mx-auto h-7 w-7 text-cyan-200" /><h2 className="mt-4 text-lg font-semibold text-white">Your library is empty</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">Create a project, select the real narration and image folder from File Explorer, and build a readable 1920 × 1080 visual timeline.</p><Button onClick={onCreate} className="mt-5 bg-cyan-200 text-slate-950 hover:bg-cyan-100"><Plus className="mr-2 h-4 w-4" />New project</Button></section>; }
function LoadingRows() { return <div className="space-y-3">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-[78px] animate-pulse rounded-2xl border border-white/[0.06] bg-white/[0.025]" />)}</div>; }
