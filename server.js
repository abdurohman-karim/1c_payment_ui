// Tiny zero-dependency server: serves ./public and proxies /odata/* to 1C.
//
// Connection (base URL + Basic auth) comes from ONE of two places, in this order:
//   1. The browser — header `X-OData-Conn` (base64 of a JSON {base,user,password}),
//      which the UI fills from the "Подключение" dialog (stored in that user's localStorage).
//   2. .env in this folder (ODATA_BASE / ODATA_USER / ODATA_PASSWORD) — optional defaults.
// So the tool can be handed to anyone: they enter their own 1C login in the UI; no .env needed.
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// ---- .env (optional) ------------------------------------------------------
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
const ENV = { base: (process.env.ODATA_BASE || "").replace(/\/+$/, ""), user: process.env.ODATA_USER || "", password: process.env.ODATA_PASSWORD || "" };
const PORT = Number(process.argv[2] || process.env.PORT || 3200);

function connFromRequest(req) {
  const h = req.headers["x-odata-conn"];
  if (h === "none") return { base: "", user: "", password: "", source: "none" }; // browser explicitly refused server defaults
  if (h) {
    try {
      const c = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
      if (c.base) return { base: String(c.base).replace(/\/+$/, ""), user: c.user || "", password: c.password || "", source: "browser" };
    } catch { /* fall through to .env */ }
  }
  return { ...ENV, source: "env" };
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // What the UI needs to know: are there server-side defaults (never the password itself).
  if (url.pathname === "/config") {
    return json(res, 200, { envBase: ENV.base, envUser: ENV.user, hasEnv: !!(ENV.base && ENV.user) });
  }

  // ---- proxy ---------------------------------------------------------------
  if (url.pathname.startsWith("/odata")) {
    const conn = connFromRequest(req);
    if (!conn.base) return json(res, 400, { proxyError: "Не задано подключение к 1С: откройте «Подключение» и введите URL, логин и пароль." });
    let base;
    try { base = new URL(conn.base); } catch { return json(res, 400, { proxyError: "Некорректный URL 1С: " + conn.base }); }

    const rest = req.url.slice("/odata".length); // keep raw encoding + query
    const target = base.pathname.replace(/\/+$/, "") + rest;
    const headers = {
      Authorization: "Basic " + Buffer.from(`${conn.user}:${conn.password}`).toString("base64"),
      Accept: req.headers["accept"] || "application/json",
    };
    if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
    if (req.headers["if-match"]) headers["If-Match"] = req.headers["if-match"];

    const started = Date.now();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      headers["Content-Length"] = body.length; // 1C behind IIS answers 411 to a body-less POST without it
      const mod = base.protocol === "https:" ? https : http;
      const p = mod.request({ hostname: base.hostname, port: base.port || (base.protocol === "https:" ? 443 : 80), path: target, method: req.method, headers, rejectUnauthorized: false }, (up) => {
        const out = [];
        up.on("data", (c) => out.push(c));
        up.on("end", () => {
          const buf = Buffer.concat(out);
          let shown = target; try { shown = decodeURIComponent(target); } catch {}
          console.log(`[${conn.source}:${conn.user}@${base.host}] ${req.method} ${shown} -> ${up.statusCode} (${Date.now() - started} ms, ${buf.length} B)`);
          res.writeHead(up.statusCode, { "Content-Type": up.headers["content-type"] || "application/octet-stream", "X-Upstream-Time": String(Date.now() - started) });
          res.end(buf);
        });
      });
      p.on("error", (e) => json(res, 502, { proxyError: `${e.message} (${base.host})` }));
      p.end(body);
    });
    return;
  }

  // ---- static --------------------------------------------------------------
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  file = path.join(__dirname, "public", path.normalize(file));
  if (!file.startsWith(path.join(__dirname, "public"))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}  (server defaults: ${ENV.base ? `${ENV.user}@${ENV.base}` : "none — connection is entered in the UI"})`));
