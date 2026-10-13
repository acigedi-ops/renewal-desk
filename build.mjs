// Builds dist/ for Cloudflare Pages (build command `node build.mjs`, output `dist`): wraps src/app.html (the same source as the claude.ai artifact) in a full page
// and loads the Supabase client, config and shim before the app's own scripts.
import {readFileSync, writeFileSync, mkdirSync, cpSync} from "node:fs";

const app = readFileSync("src/app.html", "utf8");
const at = app.indexOf("<script");
if (at < 0) throw new Error("src/app.html has no <script>");
const head = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0E6655">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Renewals">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon-180.png">
<style>[hidden]{display:none!important}</style>
`;
const boot = `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>
<script src="/config.js"></script>
<script src="/shim.js"></script>
`;
// The artifact source starts with <title>, styles and markup; everything before the first <script> is head + body markup.
const pre = app.slice(0, at), rest = app.slice(at);
const split = pre.indexOf("</style>") + "</style>".length;
// The Outbox (src/outbox.js), Qtax mode (src/qtax.js + qtaxplus.js), To do, Invoices, health strip, client timeline, client documents, search and the Assistant chat load after the app's scripts; they live outside app.html because the L&I routine overwrites that file.
// The phone layout (src/mobile.css, plus src/mobile.js for the hide-on-scroll header) is linked last so it wins over every other stylesheet, including the ones those scripts add.
const html = head + pre.slice(0, split) + "\n</head><body>\n" + pre.slice(split) + boot + rest + '\n<script src="/outbox.js"></script>\n<script src="/qtax.js"></script>\n<script src="/qtaxplus.js"></script>\n<script src="/tasks.js"></script>\n<script src="/invoices.js"></script>\n<script src="/health.js"></script>\n<script src="/timeline.js"></script>\n<script src="/clientdocs.js"></script>\n<script src="/search.js"></script>\n<script src="/chat.js"></script>\n<script src="/mobile.js"></script>\n<link rel="stylesheet" href="/mobile.css">\n</body></html>\n';

mkdirSync("dist", {recursive: true});
cpSync("public", "dist", {recursive: true});
cpSync("src/shim.js", "dist/shim.js");
cpSync("src/outbox.js", "dist/outbox.js");
cpSync("src/qtax.js", "dist/qtax.js");
cpSync("src/tasks.js", "dist/tasks.js");
cpSync("src/health.js", "dist/health.js");
for (const f of ["invoices.js", "qtaxplus.js", "timeline.js", "clientdocs.js", "search.js", "chat.js"]) cpSync("src/" + f, "dist/" + f);
cpSync("src/mobile.css", "dist/mobile.css");
cpSync("src/mobile.js", "dist/mobile.js");
writeFileSync("dist/index.html", html);
console.log("built dist/index.html", html.length, "bytes");

// GMAIL_APP_PASSWORD and ANTHROPIC_API_KEY live in the dashboard's Build "Variables and secrets", which only the build can read.
// On main, copy them into the Worker's own secrets so /api/outbox/send and /api/chat can use them. Values go over stdin, never into logs or dist/.
if (process.env.WORKERS_CI_BRANCH === "main"){
  const {spawnSync} = await import("node:child_process");
  for (const [name, broken] of [["GMAIL_APP_PASSWORD", "emails will say Gmail isn't connected"], ["ANTHROPIC_API_KEY", "the Assistant will say it isn't connected"]]){
    if (!process.env[name]) continue;
    const r = spawnSync("npx", ["--yes", "wrangler", "secret", "put", name],
      {input: process.env[name].replace(/\s+/g, ""), stdio: ["pipe", "inherit", "inherit"], timeout: 120000});
    console.log(r.status === 0 ? `copied ${name} to the Worker` : `could not copy ${name} (exit ${r.status}); ${broken}`);
  }
}
