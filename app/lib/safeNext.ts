/**
 * Same-origin path to resume after /login.
 * Accepts a relative path, or an absolute URL only when it matches `origin`.
 * Rejects protocol-relative URLs, other hosts, and /login so a crafted
 * `next` cannot bounce the browser off-site or loop the login page.
 */
export function safeNextPath(candidate: string | null | undefined, origin?: string): string | null {
  if (!candidate) return null;
  const value = candidate.trim();
  if (value.length === 0 || value.length > 2048) return null;
  if (/[\u0000-\u001F\\]/.test(value)) return null;
  if (/%5c|%0d|%0a|%00|%2f%2f/i.test(value)) return null;

  const base = origin && origin.length > 0 ? origin : "https://scanner.local";
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return null;
  }

  const relative = value.startsWith("/");
  const absolute = /^https?:\/\//i.test(value);
  if (!relative && !absolute) return null;
  if (relative && (value.startsWith("//") || value.startsWith("/\\"))) return null;

  let url: URL;
  try {
    url = new URL(value, baseUrl.origin);
  } catch {
    return null;
  }
  if (url.origin !== baseUrl.origin) return null;
  if (url.username || url.password) return null;
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return null;
  if (url.pathname === "/api/auth/login" || url.pathname === "/api/auth/logout") return null;
  return `${url.pathname}${url.search}`;
}
