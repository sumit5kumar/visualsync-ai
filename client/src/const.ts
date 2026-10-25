export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

export const goToLogin = () => {
  window.location.href = "/login";
};

type AuthResult = { ok: boolean; error?: string };

async function postAuth(path: string, body: Record<string, string>): Promise<AuthResult> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) return { ok: false, error: payload?.error ?? `Request failed (${response.status}).` };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the server. Check your connection and try again." };
  }
}

export const loginWithPassword = (email: string, password: string) =>
  postAuth("/api/auth/login", { email, password });

export const registerWithPassword = (name: string, email: string, password: string) =>
  postAuth("/api/auth/register", { name, email, password });
