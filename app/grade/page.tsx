"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { PageLinks } from "@/app/components/PageLinks";
import { formatChicago, type GradeCheckStatus, type OverallGrade } from "@/app/lib/gradeTrade";

interface GradeCheck {
  id: string;
  label: string;
  status: GradeCheckStatus;
  detail: string;
}

interface GradeResponse {
  overall: OverallGrade;
  scannerGrade: string | null;
  verdict: string | null;
  checks: GradeCheck[];
  notes: string[];
  note: string;
  gradedAt: number;
  quotedAt: number | null;
  quoteNote: string;
  entryPrice: number | null;
  entryPriceSource: "ask" | "typed" | null;
  canSave: boolean;
  saveBlock: string | null;
  saved?: boolean;
  alreadyOpen?: boolean;
  reconnect?: string | null;
  error?: string | null;
}

const INPUT: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  color: "#e2e8f0",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: "12px 14px",
  fontSize: 16,
  outline: "none",
  width: "100%",
  fontFamily: "inherit",
  minHeight: 48,
};

export default function GradePage() {
  const [ticker, setTicker] = useState("");
  const [expiration, setExpiration] = useState("");
  const [strike, setStrike] = useState("");
  const [putCall, setPutCall] = useState<"call" | "put">("call");
  const [plannedEntry, setPlannedEntry] = useState("");
  const [thesis, setThesis] = useState("");
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GradeResponse | null>(null);

  async function submit(save: boolean) {
    if (save) setSaving(true);
    else setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          expiration,
          strike,
          putCall,
          plannedEntry: plannedEntry.trim() === "" ? null : plannedEntry,
          thesis,
          save,
        }),
      });
      const json = await res.json();
      if (!res.ok && !Array.isArray(json.checks)) {
        throw new Error(typeof json.error === "string" ? json.error : "Grade failed");
      }
      if (Array.isArray(json.checks)) setResult(json as GradeResponse);
      if (!res.ok) setError(typeof json.error === "string" ? json.error : "Grade failed");
      else if (typeof json.error === "string" && json.error) setError(json.error);
      else if (save && json.saved) setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Grade failed");
    } finally {
      setPending(false);
      setSaving(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(false);
  }

  return (
    <main style={{ minHeight: "100vh", background: "#0b0f1a", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "16px 16px 14px" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontFamily: "monospace" }}>
          <span style={{ color: "#06b6d4" }}>▣</span> Grade my trade
        </h1>
        <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 15, lineHeight: 1.45 }}>
          Grades this contract with the same checklist as the alerts. Nothing here places an order.
        </p>
        <PageLinks current="grade" />
      </div>

      <div style={{ padding: "16px 16px 40px", maxWidth: 760, margin: "0 auto" }}>
        {error && <Banner color="#fca5a5">{error}</Banner>}
        {result?.saved && <Banner color="#6ee7b7">Saved to the Trade Log as an open paper trade.</Banner>}

        <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
          <Field label="Ticker">
            <input value={ticker} onChange={(event) => setTicker(event.target.value.toUpperCase())} autoCapitalize="characters" autoComplete="off" style={INPUT} />
          </Field>
          <Field label="Expiration">
            <input type="date" value={expiration} onChange={(event) => setExpiration(event.target.value)} required style={{ ...INPUT, colorScheme: "dark" }} />
          </Field>
          <Field label="Strike">
            <input value={strike} onChange={(event) => setStrike(event.target.value)} inputMode="decimal" style={INPUT} />
          </Field>
          <Field label="Call or put">
            <select value={putCall} onChange={(event) => setPutCall(event.target.value === "put" ? "put" : "call")} style={INPUT}>
              <option value="call">Call</option>
              <option value="put">Put</option>
            </select>
          </Field>
          <Field label="Planned entry, optional">
            <input value={plannedEntry} onChange={(event) => setPlannedEntry(event.target.value)} inputMode="decimal" placeholder="Leave blank to use the live ask" style={INPUT} />
          </Field>
          <Field label="Thesis, optional">
            <textarea value={thesis} onChange={(event) => setThesis(event.target.value)} rows={3} style={{ ...INPUT, minHeight: 88, resize: "vertical" }} />
          </Field>
          <button type="submit" disabled={pending || saving} style={primaryButton(pending || saving)}>
            {pending ? "Grading…" : "Grade this trade"}
          </button>
        </form>

        {result && (
          <section style={{ marginTop: 18 }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 13, color: "#64748b", fontWeight: 700, letterSpacing: "0.04em" }}>OVERALL</div>
              <div style={{ fontSize: 42, fontWeight: 800, fontFamily: "monospace", color: gradeColor(result.overall), marginTop: 4 }}>
                {result.overall}
              </div>
              {result.verdict && (
                <p style={{ margin: "4px 0 0", color: "#94a3b8", fontSize: 15 }}>
                  Scanner verdict {result.verdict}
                  {result.scannerGrade && !(result.scannerGrade === "A" && result.overall !== "A") ? ` · letter ${result.scannerGrade}` : ""}
                </p>
              )}
              <p style={{ margin: "10px 0 0", fontSize: 16, lineHeight: 1.45 }}>{result.quoteNote}</p>
              <p style={{ margin: "4px 0 0", color: "#94a3b8", fontSize: 14 }}>
                Graded {formatChicago(result.gradedAt)}
                {result.quotedAt != null ? ` · quote ${formatChicago(result.quotedAt)}` : " · no quote time"}
              </p>
              {result.entryPrice != null && (
                <p style={{ margin: "8px 0 0", fontSize: 15 }}>
                  Entry ${result.entryPrice.toFixed(2)} {result.entryPriceSource === "ask" ? "ask" : "typed"}
                </p>
              )}
              <p style={{ margin: "8px 0 0", color: "#64748b", fontSize: 13 }}>{result.note}</p>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {result.checks.map((check) => (
                <article key={check.id} style={cardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                    <h2 style={{ margin: 0, fontSize: 16 }}>{check.label}</h2>
                    <span style={{ fontFamily: "monospace", fontWeight: 800, color: statusColor(check.status) }}>
                      {check.status.toUpperCase()}
                    </span>
                  </div>
                  <p style={{ margin: "6px 0 0", fontSize: 15, lineHeight: 1.45, color: "#cbd5e1" }}>{check.detail}</p>
                </article>
              ))}
            </div>

            {result.notes.length > 0 && (
              <div style={cardStyle}>
                {result.notes.map((note) => (
                  <p key={note} style={{ margin: "0 0 8px", fontSize: 15, lineHeight: 1.45 }}>{note}</p>
                ))}
              </div>
            )}

            {result.reconnect && (
              <p style={{ margin: "8px 0 0" }}>
                <a href={result.reconnect} style={{ color: "#06b6d4", fontWeight: 700 }}>Reconnect Schwab</a>
              </p>
            )}

            <button
              type="button"
              disabled={saving || pending}
              onClick={() => { void submit(true); }}
              style={primaryButton(saving || pending)}
            >
              {saving ? "Saving…" : "Save to Trade Log"}
            </button>
            {!result.canSave && result.saveBlock && (
              <p style={{ margin: "8px 0 0", color: "#fbbf24", fontSize: 15, lineHeight: 1.45 }}>{result.saveBlock}</p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 13, color: "#64748b", fontWeight: 700 }}>{label}</span>
      {children}
    </label>
  );
}

function Banner({ children, color }: { children: ReactNode; color: string }) {
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px 14px", marginBottom: 12, color, fontSize: 16, lineHeight: 1.4 }}>
      {children}
    </div>
  );
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    width: "100%",
    minHeight: 48,
    marginTop: 8,
    background: "rgba(6,182,212,0.16)",
    color: "#06b6d4",
    border: "1px solid rgba(6,182,212,0.4)",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 17,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}

const cardStyle: React.CSSProperties = {
  background: "#111827",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12,
  padding: 16,
  marginBottom: 10,
};

function gradeColor(grade: OverallGrade): string {
  if (grade === "A") return "#34d399";
  if (grade === "B") return "#67e8f9";
  return "#fca5a5";
}

function statusColor(status: GradeCheckStatus): string {
  if (status === "pass") return "#34d399";
  if (status === "fail") return "#fca5a5";
  return "#fbbf24";
}
