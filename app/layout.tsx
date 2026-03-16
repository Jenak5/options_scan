import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Options Edge Scanner",
  description: "EV Gap · Vol Arb · Kelly Sizing · Flow Alerts · Greeks Dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <style>{`
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            background: #0b0f19;
            color: #e2e8f0;
            font-family: 'Inter', -apple-system, sans-serif;
            -webkit-font-smoothing: antialiased;
          }
          ::-webkit-scrollbar { width: 6px; height: 6px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
          input[type="range"] { accent-color: #06b6d4; }
          select {
            background: rgba(255,255,255,0.06); color: #e2e8f0;
            border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
            padding: 6px 12px; font-size: 13px; outline: none; cursor: pointer;
          }
          select:focus { border-color: #06b6d4; }
          table { width: 100%; border-collapse: collapse; }
          th {
            text-align: left; padding: 8px 10px; color: #64748b; font-size: 11px;
            text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
            border-bottom: 1px solid rgba(255,255,255,0.08);
          }
          td {
            padding: 8px 10px; color: #cbd5e1; font-variant-numeric: tabular-nums;
            border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px;
          }
          tr:nth-child(even) { background: rgba(255,255,255,0.015); }
          button { font-family: inherit; }
          @keyframes spin { to { transform: rotate(360deg); } }
          @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
