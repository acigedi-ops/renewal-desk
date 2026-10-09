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
const html = head + pre.slice(0, split) + "\n</head><body>\n" + pre.slice(split) + boot + rest + "\n</body></html>\n";

mkdirSync("dist", {recursive: true});
cpSync("public", "dist", {recursive: true});
cpSync("src/shim.js", "dist/shim.js");
writeFileSync("dist/index.html", html);
console.log("built dist/index.html", html.length, "bytes");
