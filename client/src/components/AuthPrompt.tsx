import { startLogin } from "@/const";
import { Button } from "@/components/ui/button";
import { LockKeyhole } from "lucide-react";

export function AuthPrompt({ noun = "workspace" }: { noun?: string }) {
  return <div className="rounded-[1.35rem] border border-white/10 bg-white/[0.035] p-7 text-center shadow-[0_24px_70px_rgba(0,0,0,0.24)]"><div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-200"><LockKeyhole className="h-5 w-5" /></div><h2 className="text-lg font-semibold text-white">Sign in to use this {noun}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-400">Your projects, encrypted Gemini key vault, and S3-backed media references are private to your account.</p><Button onClick={() => startLogin()} className="mt-5 bg-cyan-200 text-slate-950 hover:bg-cyan-100">Sign in securely</Button></div>;
}
