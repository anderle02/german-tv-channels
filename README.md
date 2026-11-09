# german-tv-channels

A curated, machine-readable list of freely receivable German TV channels with their
**official** live stream addresses, program guide (EPG) identifiers and logos.

- `channels.json` – the list (raw URL: `https://raw.githubusercontent.com/anderle02/german-tv-channels/main/channels.json`)
- `logos/` – channel logos, referenced from `channels.json` by relative path

## Scope and rules

- Only streams published by the broadcaster itself or by a platform it authorized.
  No re-broadcasts on third-party servers and nothing that requires circumventing DRM.
- No channels whose distribution is prohibited in the EU (for example RT DE, Council Regulation (EU) 2022/350).
- Included: public broadcasters and private, regional and local channels with free official streams.
- Not included: shopping channels, religious channels and channels of FAST platforms
  (Pluto TV, Samsung TV Plus, Rakuten TV, …).
- Many streams are geo-blocked and only play from within Germany.

## Format (`schema: 1`)

```jsonc
{
  "schema": 1,
  "updated": "2026-11-09T12:00:00Z",
  "groups": [{ "id": "main", "name": "Main channels" }],
  "channels": [
    {
      "id": "daserste",                  // stable identifier, [a-z0-9-]
      "name": "Das Erste",
      "group": "main",                   // id of an entry in "groups"
      "logo": "logos/daserste.png",      // path relative to this repository, or an absolute URL
      "logoSource": "https://…",         // where the logo file was downloaded from
      "iptvOrg": "DasErste.de@HD",       // iptv-org channel/feed id, used for address updates
      "epg": { "ard": "daserste", "magenta": "373" },
      "mediathekView": ["ARD"],          // channel names in the MediathekView film list
      "streams": [{ "url": "https://…/master.m3u8" }],   // HLS addresses, in order of preference
      "note": "optional remark"
    },
    {
      "id": "ndr",
      "name": "NDR",
      "group": "regional-public",
      "epg": { "ard": "ndr" },           // shared by all variants
      "defaultVariant": "ndr-nds",
      "variants": [                      // regional variants of the same channel
        {
          "id": "ndr-nds",
          "name": "Lower Saxony",
          "epg": { "magenta": "377" },     // merged over the channel's "epg"
          "streams": [{ "url": "https://…" }]
        }
      ]
    }
  ]
}
```

A channel has either `streams` or `variants`. Variants differ only during regional programme
windows (regional news, for example).

### Stream entries

| Field      | Meaning                                                                    |
|------------|----------------------------------------------------------------------------|
| `url`      | HLS playlist address                                                       |
| `auto`     | `true` if the entry was added by the update job (see below)               |
| `referrer` | optional `Referer` header some servers require                             |

### EPG identifiers

| Key       | Source                                                                       |
|-----------|------------------------------------------------------------------------------|
| `ard`     | `main_channel_id` in `https://programm-api.ard.de/program/api/program?day=…` |
| `zdf`     | `tvServices` value for `https://api.zdf.de/cmdm/epg/broadcasts`              |
| `magenta` | channel id of the MagentaTV EPG (`api.prod.sngtv.magentatv.de`)              |

## Automatic maintenance

`.github/workflows/update.yml` runs every Monday and can be started manually (*Actions → Update channel list → Run workflow*):

1. `scripts/update.mjs` reads the German playlist of [iptv-org](https://github.com/iptv-org/iptv) and adds
   or removes alternative addresses of a channel **only on hosts that channel already uses** (or lists in
   `allowHosts`). These entries carry `"auto": true`; manually added entries are never changed.
2. It downloads new or changed logos into `logos/` (sources are tracked in `logos/manifest.json`).
3. It writes a reachability report into the job summary. GitHub's runners are outside Germany, so
   geo-blocked streams always show up as unreachable there; the report is informational only.

`.github/workflows/validate.yml` checks the structure of `channels.json` on every push
(`node scripts/validate.mjs` runs the same check locally, Node.js 20 or newer).

## Adding a channel

1. Find the broadcaster's own stream address, e.g. from the network requests of the live player on its website.
2. Add an entry to `channels.json` and run `node scripts/validate.mjs`.
3. Commit. The next update run downloads the logo if `logoSource` (or an iptv-org logo) is available.
