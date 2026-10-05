"use client";
import { useState } from "react";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export default function Login() {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  async function submit(form: React.FormEvent<HTMLFormElement>) {
    form.preventDefault();
    setPending(true);
    setError("");
    const values = new FormData(form.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: values.get("email"), password: values.get("password") }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(
          data.code === "supabase_not_configured"
            ? "This workspace isn't connected to Supabase yet. Ask the project owner to complete setup."
            : "We couldn't sign you in. Check your details and try again.",
        );
        return;
      }
      // A new document resets AgentGate's cached session after the account changes.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/tickets");
    } catch {
      setError("Couldn't reach the workspace. Please try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#171e30] px-5">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex items-center justify-center gap-3">
          <Image src="/favicon.svg" width={38} height={38} alt="" />
          <span className="text-2xl font-semibold tracking-tight text-white">parallel.</span>
        </div>
        <div className="rounded-2xl bg-white p-8 shadow-xl">
          <h1 className="mb-2 text-2xl font-semibold tracking-tight">Welcome to your workspace</h1>
          <p className="mb-7 text-sm leading-6 text-slate-500">
            Sign in with your research account to continue.
          </p>
          <form onSubmit={submit} className="space-y-5">
            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-medium">
                Email
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@example.com"
                className="h-11"
              />
            </div>
            <div>
              <label htmlFor="password" className="mb-2 block text-sm font-medium">
                Password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="h-11"
              />
            </div>
            {error && (
              <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm leading-6 text-rose-700">
                {error}
              </p>
            )}
            <Button disabled={pending} type="submit" className="h-11 w-full">
              {pending && <Loader2 className="size-4 animate-spin" />}
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </div>
        <p className="mt-6 text-center text-xs text-slate-400">
          Research accounts are provided by your project operator.
        </p>
      </div>
    </main>
  );
}
