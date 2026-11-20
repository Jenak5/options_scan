import { createElement } from "react";

/** Small caption for a seeded row. A normal collection has no note. */
export function EodRowNote({ note }: { note: string | null }) {
  if (!note) return null;
  return createElement("div", {
    style: { color: "#94a3b8", fontSize: 11, marginTop: 2 },
    children: note,
  });
}
