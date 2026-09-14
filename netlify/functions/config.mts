// Mirrors GET /config of server.js: are there server-side defaults (never exposes the password).
import type { Config } from "@netlify/functions";

export default async () => {
  const envBase = (Netlify.env.get("ODATA_BASE") || "").replace(/\/+$/, "");
  const envUser = Netlify.env.get("ODATA_USER") || "";
  return new Response(JSON.stringify({ envBase, envUser, hasEnv: !!(envBase && envUser) }), { headers: { "Content-Type": "application/json" } });
};

export const config: Config = { path: "/config" };
