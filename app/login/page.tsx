"use client";

import { useState, type FormEvent } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof json.error === "string" ? json.error : "Sign-in failed");
      }
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setPending(false);
    }
  }

  return (
    <main style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      background: "#0b0f1a",
    }}>
      <form onSubmit={onSubmit} style={{
        width: "100%",
        maxWidth: 380,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        padding: 28,
      }}>
        <h1 style={{ margin: 0, fontSize: 20, fontFamily: "monospace", fontWeight: 700 }}>
          <span style={{ color: "#06b6d4" }}>◆</span> Options Edge Scanner
        </h1>
        <p style={{ margin: "10px 0 0", color: "#94a3b8", fontSize: 14, lineHeight: 1.5 }}>
          Read-only scanner. This app never places orders.
        </p>
        <label htmlFor="password" style={{ display: "block", marginTop: 22, marginBottom: 8, color: "#cbd5e1", fontSize: 13, fontWeight: 600 }}>
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          style={{
            width: "100%",
            background: "rgba(255,255,255,0.06)",
            color: "#e2e8f0",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 15,
          }}
        />
        {error && (
          <p role="alert" style={{ margin: "12px 0 0", color: "#fca5a5", fontSize: 13 }}>{error}</p>
        )}
        <button
          type="submit"
          disabled={pending || password.length === 0}
          style={{
            marginTop: 18,
            width: "100%",
            background: "rgba(6,182,212,0.16)",
            color: "#67e8f9",
            border: "1px solid rgba(6,182,212,0.35)",
            borderRadius: 8,
            padding: "10px 16px",
            fontSize: 15,
            fontWeight: 650,
            cursor: pending ? "wait" : "pointer",
            opacity: pending || password.length === 0 ? 0.55 : 1,
          }}
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
