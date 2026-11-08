// Weekly maintenance of channels.json:
//  1. picks up changed stream addresses from the iptv-org community list, but only for
//     hosts this channel already uses (official sources) or lists in "allowHosts";
//  2. downloads channel logos into logos/ so the app can load them from this repo;
//  3. writes a reachability report into the GitHub job summary (informational only:
//     GitHub's runners are outside Germany, so geo-blocked streams always fail there).
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import {
  readList, writeList, playables, hostOf, validate, parseM3u, parseCsv, fetchText, mapLimit,
  IPTV_ORG_STREAMS, IPTV_ORG_LOGOS, USER_AGENT,
} from "./lib.mjs";

const LOGO_DIR = new URL("../logos/", import.meta.url);
const MANIFEST = new URL("../logos/manifest.json", import.meta.url);
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const before = await readFile(new URL("../channels.json", import.meta.url), "utf8");
const doc = await readList();
const log = [];

// ---- 1. stream addresses ----------------------------------------------------
let community = [];
try {
  community = parseM3u(await fetchText(IPTV_ORG_STREAMS));
  console.log(`iptv-org: ${community.length} German stream entries`);
} catch (e) {
  console.warn(`iptv-org list unavailable, skipping stream update: ${e.message}`);
}
if (community.length) {
  const byId = new Map();
  for (const e of community) {
    if (!e.tvgId) continue;
    if (!byId.has(e.tvgId)) byId.set(e.tvgId, []);
    byId.get(e.tvgId).push(e);
  }
  for (const { channel, node } of playables(doc)) {
    if (!node.iptvOrg) continue;
    const manual = node.streams.filter((s) => !s.auto);
    const allowed = new Set([...manual.map((s) => hostOf(s.url)), ...(channel.allowHosts ?? []), ...(node.allowHosts ?? [])]);
    const known = new Set(manual.map((s) => s.url));
    const offered = (byId.get(node.iptvOrg) ?? []).filter((e) => allowed.has(hostOf(e.url)) && !known.has(e.url));
    const offeredUrls = new Set(offered.map((e) => e.url));
    const keptAuto = node.streams.filter((s) => s.auto && offeredUrls.has(s.url));
    const removed = node.streams.filter((s) => s.auto && !offeredUrls.has(s.url));
    const keptAutoUrls = new Set(keptAuto.map((s) => s.url));
    const added = offered.filter((e) => !keptAutoUrls.has(e.url)).map((e) => {
      const s = { url: e.url, auto: true };
      if (e.referrer) s.referrer = e.referrer;
      return s;
    });
    if (added.length || removed.length) {
      node.streams = [...manual, ...keptAuto, ...added];
      for (const s of added) log.push(`+ ${node.id}: ${s.url}`);
      for (const s of removed) log.push(`- ${node.id}: ${s.url}`);
    }
  }
}

// ---- 2. logos ------------------------------------------------------------------
let manifest = {};
try { manifest = JSON.parse(await readFile(MANIFEST, "utf8")); } catch { /* first run */ }
let iptvLogos = new Map();
try {
  for (const row of parseCsv(await fetchText(IPTV_ORG_LOGOS, 60000))) {
    if (row.feed || row.in_use?.toUpperCase() !== "TRUE") continue;
    const w = Number(row.width) || 0;
    const cur = iptvLogos.get(row.channel);
    if (!cur || w > cur.w) iptvLogos.set(row.channel, { w, url: row.url });
  }
} catch (e) {
  console.warn(`iptv-org logos unavailable: ${e.message}`);
}
await mkdir(LOGO_DIR, { recursive: true });
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp", "image/gif": "gif" };
await mapLimit(doc.channels, 6, async (ch) => {
  if (!ch.logoSource) {
    if (ch.logo && /^https?:/.test(ch.logo)) ch.logoSource = ch.logo;
    else if (ch.iptvOrg && iptvLogos.has(ch.iptvOrg.split("@")[0])) ch.logoSource = iptvLogos.get(ch.iptvOrg.split("@")[0]).url;
  }
  if (!ch.logoSource) return;
  const entry = manifest[ch.id];
  const fileOk = entry && existsSync(new URL(entry.file, LOGO_DIR));
  if (fileOk && entry.source === ch.logoSource) {
    ch.logo = `logos/${entry.file}`;
    return;
  }
  try {
    const res = await fetch(ch.logoSource, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = EXT[type] ?? (ch.logoSource.match(/\.(png|jpe?g|svg|webp|gif)(\?|$)/i)?.[1]?.toLowerCase().replace("jpeg", "jpg"));
    if (!ext) throw new Error(`unexpected content type ${type}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_LOGO_BYTES) throw new Error(`too large (${buf.length} bytes)`);
    const file = `${ch.id}.${ext}`;
    if (entry && entry.file !== file && existsSync(new URL(entry.file, LOGO_DIR))) await unlink(new URL(entry.file, LOGO_DIR));
    await writeFile(new URL(file, LOGO_DIR), buf);
    manifest[ch.id] = { source: ch.logoSource, file };
    ch.logo = `logos/${file}`;
    log.push(`logo ${ch.id} <- ${ch.logoSource}`);
  } catch (e) {
    console.warn(`logo ${ch.id}: ${e.message}`);
    if (!fileOk) ch.logo = ch.logoSource; // keep a remote fallback
  }
});
await writeFile(MANIFEST, JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 2) + "\n");

// ---- 3. write ------------------------------------------------------------------
const problems = validate(doc);
if (problems.length) {
  console.error("Validation failed, nothing written:\n" + problems.join("\n"));
  process.exit(1);
}
const { updated: _ignored, ...rest } = doc;
const oldDoc = JSON.parse(before);
delete oldDoc.updated;
if (JSON.stringify(rest) !== JSON.stringify(oldDoc)) {
  doc.updated = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await writeList(doc);
  console.log(`channels.json updated:\n${log.join("\n")}`);
} else {
  console.log("channels.json unchanged");
}

// ---- 4. reachability report (informational) --------------------------------------
const targets = [];
for (const { channel, node } of playables(doc)) for (const s of node.streams) targets.push({ id: node.id ?? channel.id, url: s.url });
const results = await mapLimit(targets, 8, async (t) => {
  try {
    const res = await fetch(t.url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
    const body = res.ok ? (await res.text()).slice(0, 7) : "";
    return { ...t, status: res.ok && body === "#EXTM3U" ? "ok" : `HTTP ${res.status}` };
  } catch (e) {
    return { ...t, status: e.name === "TimeoutError" ? "timeout" : "error" };
  }
});
const ok = results.filter((r) => r.status === "ok").length;
const summary = [
  `## Senderliste: ${doc.channels.length} Sender`,
  "",
  `Erreichbar von GitHub aus: ${ok} von ${results.length} Stream-Adressen (Geo-Sperren außerhalb Deutschlands sind normal).`,
  "",
  "| Sender/Variante | Status | Adresse |",
  "|---|---|---|",
  ...results.filter((r) => r.status !== "ok").map((r) => `| ${r.id} | ${r.status} | ${r.url} |`),
  "",
  log.length ? "### Änderungen\n\n" + log.map((l) => `- ${l}`).join("\n") : "Keine Änderungen.",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
else console.log(summary);
