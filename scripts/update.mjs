// Weekly maintenance of channels.json:
//  1. picks up changed stream addresses from the iptv-org community playlist, but only on
//     hosts a channel already uses (official sources) or lists in "allowHosts";
//  2. downloads channel logos into logos/ so consumers can load them from this repository;
//  3. writes a reachability report into the GitHub job summary. This is informational only:
//     GitHub's runners are outside Germany, so geo-blocked streams always fail there.
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  BOT_AGENT, BROWSER_AGENT, IPTV_ORG_LOGOS, IPTV_ORG_STREAMS,
  fetchText, fetchWithRetry, hostOf, mapLimit, parseCsv, parseM3u, playables, readList, sleep, validate, writeList,
} from "./lib.mjs";

const LOGO_DIR = new URL("../logos/", import.meta.url);
const MANIFEST = new URL("../logos/manifest.json", import.meta.url);
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const IMAGE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp", "image/gif": "gif" };

const original = await readFile(new URL("../channels.json", import.meta.url), "utf8");
const doc = await readList();
const changes = [];
const warnings = [];

// ---- 1. stream addresses -----------------------------------------------------------------
let community = [];
try {
  community = parseM3u(await fetchText(IPTV_ORG_STREAMS));
  console.log(`iptv-org: ${community.length} German stream entries`);
} catch (e) {
  warnings.push(`iptv-org playlist unavailable, stream addresses not updated: ${e.message}`);
}
if (community.length) {
  const byId = new Map();
  for (const entry of community) {
    if (!entry.tvgId) continue;
    if (!byId.has(entry.tvgId)) byId.set(entry.tvgId, []);
    byId.get(entry.tvgId).push(entry);
  }
  for (const { channel, node } of playables(doc)) {
    if (!node.iptvOrg) continue;
    const manual = node.streams.filter((s) => !s.auto);
    const allowed = new Set([
      ...manual.map((s) => hostOf(s.url)),
      ...(channel.allowHosts ?? []),
      ...(node.allowHosts ?? []),
    ]);
    const known = new Set(manual.map((s) => s.url));
    const offered = (byId.get(node.iptvOrg) ?? []).filter((e) => allowed.has(hostOf(e.url)) && !known.has(e.url));
    const offeredUrls = new Set(offered.map((e) => e.url));
    const keptAuto = node.streams.filter((s) => s.auto && offeredUrls.has(s.url));
    const removed = node.streams.filter((s) => s.auto && !offeredUrls.has(s.url));
    const keptAutoUrls = new Set(keptAuto.map((s) => s.url));
    const added = offered
      .filter((e) => !keptAutoUrls.has(e.url))
      .filter((e, i, all) => all.findIndex((x) => x.url === e.url) === i)
      .map((e) => (e.referrer ? { url: e.url, auto: true, referrer: e.referrer } : { url: e.url, auto: true }));
    if (added.length || removed.length) {
      node.streams = [...manual, ...keptAuto, ...added];
      for (const s of added) changes.push(`added stream for ${node.id}: ${s.url}`);
      for (const s of removed) changes.push(`removed stream for ${node.id}: ${s.url}`);
    }
  }
}

// ---- 2. logos -------------------------------------------------------------------------------
let manifest = {};
try {
  manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
} catch {
  // first run: no manifest yet
}
const iptvLogos = new Map();
try {
  for (const row of parseCsv(await fetchText(IPTV_ORG_LOGOS, 60000))) {
    if (row.feed || row.in_use?.toUpperCase() !== "TRUE") continue;
    const width = Number(row.width) || 0;
    const current = iptvLogos.get(row.channel);
    if (!current || width > current.width) iptvLogos.set(row.channel, { width, url: row.url });
  }
} catch (e) {
  warnings.push(`iptv-org logo table unavailable: ${e.message}`);
}
await mkdir(LOGO_DIR, { recursive: true });
// Sequential on purpose: image hosts such as upload.wikimedia.org rate-limit parallel requests.
for (const ch of doc.channels) {
  if (!ch.logoSource) {
    const baseId = ch.iptvOrg?.split("@")[0];
    if (ch.logo && /^https?:/.test(ch.logo)) ch.logoSource = ch.logo;
    else if (baseId && iptvLogos.has(baseId)) ch.logoSource = iptvLogos.get(baseId).url;
  }
  if (!ch.logoSource) continue;
  const entry = manifest[ch.id];
  const fileOk = Boolean(entry) && existsSync(new URL(entry.file, LOGO_DIR));
  if (fileOk && entry.source === ch.logoSource) {
    ch.logo = `logos/${entry.file}`;
    continue;
  }
  try {
    const res = await fetchWithRetry(ch.logoSource, { headers: { "user-agent": BOT_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext =
      IMAGE_EXTENSIONS[type] ??
      ch.logoSource.match(/\.(png|jpe?g|svg|webp|gif)(\?|$)/i)?.[1]?.toLowerCase().replace("jpeg", "jpg");
    if (!ext) throw new Error(`unexpected content type "${type}"`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_LOGO_BYTES) throw new Error(`file too large (${data.length} bytes)`);
    const file = `${ch.id}.${ext}`;
    if (entry && entry.file !== file && existsSync(new URL(entry.file, LOGO_DIR))) {
      await unlink(new URL(entry.file, LOGO_DIR));
    }
    await writeFile(new URL(file, LOGO_DIR), data);
    manifest[ch.id] = { source: ch.logoSource, file };
    ch.logo = `logos/${file}`;
    changes.push(`downloaded logo for ${ch.id} from ${ch.logoSource}`);
  } catch (e) {
    warnings.push(`logo for ${ch.id} not downloaded (${ch.logoSource}): ${e.message}`);
    if (!fileOk) ch.logo = ch.logoSource; // keep the remote address as a fallback
  }
  await sleep(hostOf(ch.logoSource) === "upload.wikimedia.org" ? 1500 : 250);
}
await writeFile(MANIFEST, JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 2) + "\n");

// ---- 3. write ---------------------------------------------------------------------------------
const problems = validate(doc);
if (problems.length) {
  console.error(`Validation failed, nothing written:\n${problems.join("\n")}`);
  process.exit(1);
}
const previous = JSON.parse(original);
delete previous.updated;
const { updated: _unused, ...current } = doc;
if (JSON.stringify(current) !== JSON.stringify(previous)) {
  doc.updated = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await writeList(doc);
  console.log(`channels.json updated:\n${changes.join("\n")}`);
} else {
  console.log("channels.json unchanged");
}
for (const w of warnings) console.warn(`warning: ${w}`);

// ---- 4. reachability report (informational) -----------------------------------------------
const targets = [];
for (const { channel, node } of playables(doc)) {
  for (const s of node.streams) targets.push({ id: node.id ?? channel.id, url: s.url });
}
const results = await mapLimit(targets, 8, async (t) => {
  try {
    const res = await fetch(t.url, { headers: { "user-agent": BROWSER_AGENT }, signal: AbortSignal.timeout(10000) });
    const head = res.ok ? (await res.text()).slice(0, 7) : "";
    return { ...t, status: res.ok && head === "#EXTM3U" ? "ok" : `HTTP ${res.status}` };
  } catch (e) {
    return { ...t, status: e.name === "TimeoutError" ? "timeout" : "error" };
  }
});
const reachable = results.filter((r) => r.status === "ok").length;
const summary = [
  `## Channel list: ${doc.channels.length} channels`,
  "",
  `Reachable from GitHub: ${reachable} of ${results.length} stream addresses ` +
    "(failures for geo-blocked streams are expected, the runners are outside Germany).",
  "",
  "| Channel / variant | Status | Address |",
  "|---|---|---|",
  ...results.filter((r) => r.status !== "ok").map((r) => `| ${r.id} | ${r.status} | ${r.url} |`),
  "",
  changes.length ? `### Changes\n\n${changes.map((c) => `- ${c}`).join("\n")}` : "No changes.",
  "",
  warnings.length ? `### Warnings\n\n${warnings.map((w) => `- ${w}`).join("\n")}` : "",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
else console.log(summary);
