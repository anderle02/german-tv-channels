# german-tv-channels

Channel list for the **Fernseher** desktop app: freely receivable German TV channels with their
**official** live stream addresses, program-guide (EPG) IDs and logos.

The app downloads `channels.json` from this repository at startup and falls back to the copy
built into the app when GitHub is unreachable.

## Rules for entries

- Only streams published by the broadcaster itself or by a platform it authorized.
  No re-broadcasts on third-party servers, no streams that need DRM circumvention.
- No channels whose distribution is prohibited in the EU (e.g. RT DE, EU Regulation 2022/350).
- Scope: public broadcasters, private/regional/local channels with free official streams.
  Shopping, religious and FAST platform channels (Pluto TV, Samsung TV Plus, …) are out of scope.

## Automatic maintenance

`.github/workflows/update.yml` runs every Monday (and manually via *Run workflow*):

1. `scripts/update.mjs` reads the [iptv-org](https://github.com/iptv-org/iptv) German playlist and
   adds or removes alternative addresses for a channel **only on hosts that channel already uses**
   (or lists in `allowHosts`). Such entries carry `"auto": true`; hand-written entries are never touched.
2. It downloads missing or changed logos into `logos/` (source tracked in `logos/manifest.json`).
3. It writes a reachability table into the job summary. GitHub's runners are outside Germany,
   so geo-blocked streams always fail there. The table is informational only; the app checks
   reachability itself from your location.

`scripts/validate.mjs` runs on every push and checks the structure.

## Format (`schema: 1`)

```jsonc
{
  "schema": 1,
  "updated": "2026-11-08T18:00:00Z",
  "groups": [{ "id": "haupt", "name": "Hauptsender" }],
  "channels": [
    {
      "id": "daserste",                 // stable id, [a-z0-9-]
      "name": "Das Erste",
      "group": "haupt",
      "logo": "logos/daserste.png",     // relative to this repo, or an absolute URL
      "logoSource": "https://…",        // where the logo was downloaded from
      "iptvOrg": "DasErste.de@HD",      // iptv-org id used for address updates
      "epg": { "ard": "daserste", "zdf": "…", "magenta": "373" },
      "mediathek": ["ARD"],             // MediathekView channel names, for "watch in Mediathek"
      "streams": [{ "url": "https://…/master.m3u8" }],   // in order of preference
      "note": "optional hint shown in the app"
    },
    {
      "id": "ndr", "name": "NDR", "group": "dritte",
      "epg": { "ard": "ndr" },          // shared by all variants
      "defaultVariant": "ndr-nds",
      "variants": [                     // regional variants: one list entry, picker in the app
        { "id": "ndr-nds", "name": "Niedersachsen", "epg": { "magenta": "377" }, "streams": [{ "url": "…" }] }
      ]
    }
  ]
}
```

EPG keys: `ard` = `main_channel_id` of programm-api.ard.de, `zdf` = `tvServices` id of api.zdf.de,
`magenta` = channel id of the MagentaTV EPG.

## Adding a channel

Add an entry to `channels.json`, run `node scripts/validate.mjs`, commit. Use the broadcaster's own
stream address (look at the network requests of the live player on the broadcaster's website).
