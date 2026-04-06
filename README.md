# Site Inspector

A polished Chrome (Manifest V3) extension that takes any URL and shows everything you can learn about it from free, public data — metadata, DNS, WHOIS, IP geolocation, security headers, Mozilla Observatory grade, Lighthouse scores, and more.

No paid APIs. No tracking. No background services. Just a popup, four files, and a handful of free public endpoints.

## Features

### Six tabbed views

| Tab | What you see |
|---|---|
| **Overview** | OG card preview, favicon, final URL, status, HTML size, server, Wayback first-snapshot date |
| **SEO** | Google-style search-result preview, JSON-LD structured-data types, hreflang languages, robots.txt analysis, sitemap URL count, page word count, heading counts |
| **Tech** | Detected stack (CDN / Framework / CMS / Analytics) as categorized chips, first-party vs third-party request donut |
| **Network** | DNS records (A / AAAA / MX / NS / TXT / CAA), IP geolocation with country flag, ASN, ISP, domain age + registrar + expiry (RDAP), HTTP protocol version |
| **Security** | Mozilla Observatory letter grade, security headers (HSTS, CSP, X-Frame-Options, etc.) with present/missing indicators |
| **Performance** | Lighthouse scores as animated SVG ring gauges, Core Web Vitals (LCP / CLS / FCP / TBT / SI), Mobile ⇄ Desktop toggle |

### UX

- **Dark theme by default**, light theme toggle, persisted across sessions
- **History** of last 10 analyzed URLs (`chrome.storage.local`)
- **Export results as JSON** for any analyzed URL
- **Use current tab** button — auto-fills the input with the active Chrome tab
- **Skeleton shimmer** loading placeholders while async fetches resolve
- **Incremental rendering** — fast tabs (Overview/SEO/Tech) populate immediately, slower tabs (Network/Security/Performance) fill in as third-party APIs respond

## Install

1. Clone or download this repo
2. Open Chrome and go to `chrome://extensions`
3. Toggle **Developer mode** (top-right)
4. Click **Load unpacked**
5. Select the `site-inspector` folder
6. Pin the extension from the puzzle-piece icon in the toolbar

## Usage

1. Click the Site Inspector icon
2. Enter a URL (or click **Use current tab**)
3. Hit ▶ — the tabs will populate progressively
4. Click any tab to view that section
5. Toggle Mobile / Desktop in the **Performance** tab to compare PageSpeed scores
6. Click **⬇ Export JSON** in the footer to download the full result

## Architecture

```
┌──────────────────────────────────────────┐
│           popup.html (UI shell)          │
└────────────────┬─────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────┐
│              popup.js                     │
│                                            │
│  state ──▶ orchestrator ──▶ fetchers      │
│                │                           │
│                └──▶ renderers per tab     │
└────────────────┬─────────────────────────┘
                 │
       ┌─────────┴─────────┬─────────────┐
       ▼                   ▼             ▼
   page fetch         third-party    PageSpeed
   (direct HTML)         APIs        Insights
```

The orchestrator runs:

1. **Page fetch** first (direct HTTP request, parses HTML once)
2. **Third-party fetchers in parallel** — DNS, RDAP, Mozilla Observatory, Wayback, robots.txt
3. **Chained fetchers** — IP info waits for DNS A record, sitemap waits for robots.txt
4. **PageSpeed last** (slowest, 10–30 s)

Each fetcher updates `state.data[key]` and triggers a re-render of only the active tab. Non-active tabs render lazily on switch — clicking a tab is always instant.

## File structure

```
site-inspector/
├── manifest.json    Manifest V3, host_permissions: ["<all_urls>"], permissions: storage + activeTab + tabs
├── popup.html       Header, input pill, tab strip, content slot, footer
├── popup.js         State, fetchers, parsers, renderers, theme, history, export
├── styles.css       CSS variables for dark/light, cards, gauges, chips, skeleton, animations
└── README.md        This file
```

No build step. No dependencies. No external CSS/JS. ~35 KB total.

## Free APIs used

All endpoints below are free and require **no API key**:

| Source | Endpoint | What it provides |
|---|---|---|
| Cloudflare DoH | `https://cloudflare-dns.com/dns-query` | DNS records (A / AAAA / MX / NS / TXT / CAA) |
| ip-api.com | `https://ip-api.com/json/{ip}` | IP geolocation, ASN, ISP (45 req/min cap) |
| rdap.org | `https://rdap.org/domain/{domain}` | Domain registration data (creation, expiry, registrar) |
| Mozilla Observatory | `https://observatory.mozilla.org/api/v2/scan` | Security grade A+ to F |
| Wayback Machine | `https://archive.org/wayback/available` | First snapshot date |
| Google PageSpeed Insights | `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` | Lighthouse scores + Core Web Vitals |
| (direct fetch) | `{origin}/robots.txt` | Disallow rules, sitemap directive |
| (direct fetch) | `{sitemap_url}` | Sitemap URL count |

## Limitations

- **No real visitor analytics.** Visitor count, bounce rate, session duration, traffic sources — none of that is publicly available for sites you don't own. Anyone offering "free" traffic numbers is either selling your browsing history or showing low-quality estimates. This extension does not pretend otherwise.
- **PageSpeed takes 10–30 seconds.** Google actually loads the page in a real Lighthouse run on their servers.
- **rdap.org TLD coverage varies** — common gTLDs (`.com`, `.net`, `.org`, `.io`, `.dev`) work; some country TLDs return 404. Shown as "Unavailable" gracefully.
- **Mozilla Observatory scans are async.** First call may return `PENDING`; the extension polls once after ~3 s, then displays "Scan queued — refresh in a moment" if still not ready.
- **Bot-protected sites** (Cloudflare challenge pages, Akamai bot manager, login walls) may return captcha HTML instead of real content. Tabs that depend on direct HTML parsing will reflect that. Tabs that depend on third-party APIs (Network, Security, Performance) will still work — each fetcher is decoupled.
- **Sitemap parse is capped at 1000 `<loc>` entries** to keep the popup responsive on huge sites.

## Privacy

- All requests originate from the user's browser. No data is sent to any server owned by the extension author (because there is no server).
- The only persistent storage is `chrome.storage.local`: theme preference and a list of the last 10 analyzed URLs. Both are local-only and never transmitted.
- No analytics, no telemetry, no tracking.

## License

MIT
