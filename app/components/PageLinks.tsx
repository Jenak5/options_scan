const LINKS = [
  { id: "flow", href: "/?tab=flow", label: "Back to Flow" },
  { id: "grade", href: "/grade", label: "Grade my trade" },
  { id: "gate", href: "/gate", label: "Gate" },
  { id: "trades", href: "/trades", label: "Trade log" },
  { id: "scorecard", href: "/scorecard", label: "Alert scorecard" },
  { id: "learn", href: "/learn", label: "Learning mode" },
  { id: "report", href: "/?tab=report", label: "Alert Report" },
] as const;

export function PageLinks({ current }: { current: "flow" | "gate" | "trades" | "report" | "scorecard" | "grade" | "learn" }) {
  const links = LINKS.filter((link) => link.id !== current);
  return (
    <nav aria-label="Pages" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
      {links.map((link) => (
        <a key={link.id} href={link.href} style={{
          color: "#06b6d4",
          fontSize: 16,
          fontWeight: 700,
          textDecoration: "none",
          minHeight: 44,
          display: "inline-flex",
          alignItems: "center",
          padding: "0 12px",
          border: "1px solid rgba(6,182,212,0.35)",
          borderRadius: 8,
          background: "rgba(6,182,212,0.08)",
        }}>{link.label}</a>
      ))}
    </nav>
  );
}
