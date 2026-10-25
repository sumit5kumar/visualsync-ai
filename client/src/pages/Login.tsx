import { loginWithPassword, registerWithPassword } from "@/const";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles } from "lucide-react";
import { useState } from "react";

type Mode = "login" | "register";

export default function Login() {
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = mode === "login"
        ? await loginWithPassword(email, password)
        : await registerWithPassword(name, email, password);
      if (!result.ok) {
        setError(result.error ?? "Sign in failed. Try again.");
        return;
      }
      window.location.href = "/";
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#070b12] p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-[14px] bg-gradient-to-br from-cyan-100 via-cyan-300 to-sky-500 text-slate-950 shadow-[0_0_30px_rgba(34,211,238,0.3)]">
            <Sparkles className="h-5 w-5" />
          </span>
          <span>
            <span className="block text-lg font-semibold tracking-tight text-white">VisualSync</span>
            <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-100/70">Video Studio</span>
          </span>
        </div>
        <Card className="border-white/10 bg-white/[0.035] shadow-[0_24px_70px_rgba(0,0,0,0.24)]">
          <CardHeader>
            <CardTitle className="text-white">{mode === "login" ? "Sign in" : "Create your account"}</CardTitle>
            <CardDescription>
              {mode === "login" ? "Continue to your VisualSync workspace." : "Your projects and media stay private to your account."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              {mode === "register" && (
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-slate-300">Name</Label>
                  <Input id="name" value={name} onChange={event => setName(event.target.value)} placeholder="Your name" autoComplete="name" required className="border-white/10 bg-white/[0.04] text-white placeholder:text-slate-500" />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email" className="text-slate-300">Email</Label>
                <Input id="email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" required className="border-white/10 bg-white/[0.04] text-white placeholder:text-slate-500" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-slate-300">Password</Label>
                <Input id="password" type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder={mode === "register" ? "At least 8 characters" : "Your password"} autoComplete={mode === "register" ? "new-password" : "current-password"} required minLength={mode === "register" ? 8 : undefined} className="border-white/10 bg-white/[0.04] text-white placeholder:text-slate-500" />
              </div>
              {error && <p className="text-sm text-rose-300">{error}</p>}
              <Button type="submit" disabled={submitting} className="w-full bg-cyan-200 text-slate-950 hover:bg-cyan-100">
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {mode === "login" ? "Sign in" : "Create account"}
              </Button>
            </form>
            <p className="mt-5 text-center text-sm text-slate-400">
              {mode === "login" ? "New to VisualSync?" : "Already have an account?"}{" "}
              <button type="button" onClick={() => switchMode(mode === "login" ? "register" : "login")} className="font-medium text-cyan-200 hover:text-cyan-100">
                {mode === "login" ? "Create an account" : "Sign in"}
              </button>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
