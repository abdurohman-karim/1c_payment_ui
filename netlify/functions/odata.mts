// Same job as server.js for local runs, but as a Netlify Function:
// proxies /odata/* to the 1C OData service with Basic auth.
// Connection comes from the browser header `X-OData-Conn` (base64 JSON {base,user,password},
// filled by the "Подключение" dialog) or, as a fallback, from Netlify env vars
// ODATA_BASE / ODATA_USER / ODATA_PASSWORD. The header value "none" disables the fallback.
import type { Config, Context } from "@netlify/functions";

type Conn = { base: string; user: string; password: string; source: string };

const envConn = (): Conn => ({
  base: (Netlify.env.get("ODATA_BASE") || "").replace(/\/+$/, ""),
  user: Netlify.env.get("ODATA_USER") || "",
  password: Netlify.env.get("ODATA_PASSWORD") || "",
  source: "env",
});

function connFromRequest(req: Request): Conn {
  const h = req.headers.get("x-odata-conn");
  if (h === "none") return { base: "", user: "", password: "", source: "none" };
  if (h) {
    try {
      const c = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
      if (c.base) return { base: String(c.base).replace(/\/+$/, ""), user: c.user || "", password: c.password || "", source: "browser" };
    } catch { /* fall through */ }
  }
  return envConn();
}

const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

export default async (req: Request, _context: Context) => {
  const conn = connFromRequest(req);
  if (!conn.base) return json({ proxyError: "Не задано подключение к 1С: откройте «Подключение» и введите URL, логин и пароль." }, 400);
  let base: URL;
  try { base = new URL(conn.base); } catch { return json({ proxyError: "Некорректный URL 1С: " + conn.base }, 400); }

  const url = new URL(req.url);
  const target = base.origin + base.pathname.replace(/\/+$/, "") + url.pathname.slice("/odata".length) + url.search;

  const headers: Record<string, string> = {
    Authorization: "Basic " + Buffer.from(`${conn.user}:${conn.password}`).toString("base64"),
    Accept: req.headers.get("accept") || "application/json",
  };
  const ct = req.headers.get("content-type"); if (ct) headers["Content-Type"] = ct;
  const im = req.headers.get("if-match"); if (im) headers["If-Match"] = im;

  const hasBody = !["GET", "HEAD"].includes(req.method);
  const body = hasBody ? await req.arrayBuffer() : undefined;
  if (hasBody) headers["Content-Length"] = String(body!.byteLength); // 1C behind IIS answers 411 without it

  const started = Date.now();
  let up: Response;
  try {
    up = await fetch(target, { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(25_000) });
  } catch (e: any) {
    return json({ proxyError: `${e?.cause?.message || e?.message || e} (${base.host}) — 1С недоступна из интернета? Netlify не видит адреса внутренней сети.` }, 502);
  }
  const buf = await up.arrayBuffer();
  console.log(`[${conn.source}:${conn.user}@${base.host}] ${req.method} ${decodeURIComponent(url.pathname + url.search)} -> ${up.status} (${Date.now() - started} ms, ${buf.byteLength} B)`);
  return new Response(buf, { status: up.status, headers: { "Content-Type": up.headers.get("content-type") || "application/octet-stream", "X-Upstream-Time": String(Date.now() - started) } });
};

export const config: Config = { path: ["/odata", "/odata/*"] };
