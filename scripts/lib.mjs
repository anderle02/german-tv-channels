// Shared helpers for the channel list scripts (Node >= 20, no dependencies).
import { readFile, writeFile } from "node:fs/promises";

export const LIST_FILE = new URL("../channels.json", import.meta.url);
export const IPTV_ORG_STREAMS = "https://raw.githubusercontent.com/iptv-org/iptv/master/streams/de.m3u";
export const IPTV_ORG_LOGOS = "https://raw.githubusercontent.com/iptv-org/database/master/data/logos.csv";
/** Browser-like agent for stream checks (some CDNs reject unknown clients). */
export const BROWSER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
/** Descriptive agent for file downloads (required by e.g. the Wikimedia user-agent policy). */
export const BOT_AGENT = "german-tv-channels-updater/1.0 (+https://github.com/anderle02/german-tv-channels)";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export async function readList() {
  return JSON.parse(await readFile(LIST_FILE, "utf8"));
}

export async function writeList(doc) {
  await writeFile(LIST_FILE, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

/** Every playable unit: channels without variants and every variant. */
export function* playables(doc) {
  for (const ch of doc.channels) {
    if (ch.variants?.length) {
      for (const v of ch.variants) yield { channel: ch, variant: v, node: v };
    } else {
      yield { channel: ch, variant: null, node: ch };
    }
  }
}

export function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function isHttpUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Validates the document structure. Returns a list of problems (empty = valid). */
export function validate(doc) {
  const problems = [];
  if (doc.schema !== 1) problems.push("schema must be 1");
  if (!Array.isArray(doc.groups) || !doc.groups.length) problems.push("groups missing");
  if (!Array.isArray(doc.channels) || doc.channels.length < 10) problems.push("too few channels");
  const groupIds = new Set();
  for (const g of doc.groups ?? []) {
    if (!ID_PATTERN.test(g.id ?? "") || groupIds.has(g.id) || !g.name) problems.push(`invalid group ${g.id}`);
    groupIds.add(g.id);
  }
  const ids = new Set();
  for (const ch of doc.channels ?? []) {
    const where = `channel ${ch.id ?? "?"}`;
    if (!ID_PATTERN.test(ch.id ?? "")) problems.push(`${where}: invalid id`);
    if (ids.has(ch.id)) problems.push(`${where}: duplicate id`);
    ids.add(ch.id);
    if (!ch.name) problems.push(`${where}: name missing`);
    if (!groupIds.has(ch.group)) problems.push(`${where}: unknown group ${ch.group}`);
    if (ch.logo != null && typeof ch.logo !== "string") problems.push(`${where}: logo must be a string`);
    if (ch.epg != null && (typeof ch.epg !== "object" || Array.isArray(ch.epg))) problems.push(`${where}: epg must be an object`);
    if (ch.mediathekView != null && !Array.isArray(ch.mediathekView)) problems.push(`${where}: mediathekView must be an array`);
    const hasStreams = Array.isArray(ch.streams) && ch.streams.length > 0;
    const hasVariants = Array.isArray(ch.variants) && ch.variants.length > 0;
    if (hasStreams === hasVariants) problems.push(`${where}: needs either streams or variants`);
    if (hasVariants) {
      const variantIds = new Set();
      for (const v of ch.variants) {
        if (!ID_PATTERN.test(v.id ?? "") || variantIds.has(v.id)) problems.push(`${where}: bad variant id ${v.id}`);
        variantIds.add(v.id);
        if (!v.name) problems.push(`${where}/${v.id}: name missing`);
        if (!Array.isArray(v.streams) || !v.streams.length) problems.push(`${where}/${v.id}: no streams`);
      }
      if (!variantIds.has(ch.defaultVariant)) problems.push(`${where}: defaultVariant not found`);
    }
  }
  for (const { channel, node } of playables(doc)) {
    for (const s of node.streams ?? []) {
      if (!isHttpUrl(s.url)) problems.push(`${channel.id}: bad stream url ${s.url}`);
    }
  }
  return problems;
}

/** Parses an extended M3U playlist into {tvgId, url, userAgent, referrer} entries. */
export function parseM3u(text) {
  const out = [];
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const attrs = Object.fromEntries([...line.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
      pending = { tvgId: attrs["tvg-id"] ?? "", referrer: attrs["http-referrer"], userAgent: attrs["http-user-agent"] };
    } else if (line.startsWith("#EXTVLCOPT:") && pending) {
      const [key, ...rest] = line.slice("#EXTVLCOPT:".length).split("=");
      if (key === "http-user-agent") pending.userAgent = rest.join("=");
      if (key === "http-referrer") pending.referrer = rest.join("=");
    } else if (!line.startsWith("#") && pending) {
      out.push({ ...pending, url: line });
      pending = null;
    }
  }
  return out;
}

/** Minimal CSV parser (RFC 4180 quoting). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

export async function fetchText(url, timeoutMs = 30000) {
  const res = await fetch(url, { headers: { "user-agent": BOT_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET with retries on HTTP 429/5xx and network errors. Honours Retry-After (seconds),
 * otherwise waits 5 s, 15 s, 45 s.
 */
export async function fetchWithRetry(url, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      if (res.status !== 429 && res.status < 500) return res;
      lastError = new Error(`HTTP ${res.status}`);
      const retryAfter = Number(res.headers.get("retry-after"));
      await res.arrayBuffer().catch(() => {});
      if (attempt < attempts - 1) {
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : 5000 * 3 ** attempt);
      }
    } catch (e) {
      lastError = e;
      if (attempt < attempts - 1) await sleep(5000 * 3 ** attempt);
    }
  }
  throw lastError;
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
