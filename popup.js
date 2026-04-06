/* ============================================================
   Site Inspector v2 — popup.js
   ============================================================ */

const $ = (id) => document.getElementById(id);

const state = {
  url: null,
  host: null,
  origin: null,
  theme: 'dark',
  history: [],
  activeTab: 'overview',
  data: {},
  pendingPS: { mobile: null, desktop: null },
  strategy: 'mobile',
};

/* ----------- boot ----------- */
document.addEventListener('DOMContentLoaded', async () => {
  await loadPersisted();
  applyTheme();
  renderHistory();
  bindEvents();
});

async function loadPersisted() {
  try {
    const stored = await chrome.storage.local.get(['theme', 'history']);
    if (stored.theme) state.theme = stored.theme;
    if (Array.isArray(stored.history)) state.history = stored.history;
  } catch (e) { /* ignore */ }
}

function bindEvents() {
  $('form').addEventListener('submit', onSubmit);
  $('useCurrent').addEventListener('click', useCurrentTab);
  $('themeToggle').addEventListener('click', toggleTheme);
  $('exportBtn').addEventListener('click', exportJSON);
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });
}

/* ----------- theme ----------- */
function applyTheme() {
  document.body.dataset.theme = state.theme;
  $('themeToggle').textContent = state.theme === 'dark' ? '🌙' : '☀️';
}
async function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  try { await chrome.storage.local.set({ theme: state.theme }); } catch {}
}

/* ----------- history ----------- */
function renderHistory() {
  const ul = $('historyList');
  ul.innerHTML = '';
  if (state.history.length === 0) {
    ul.innerHTML = '<li class="empty">No history yet</li>';
    return;
  }
  state.history.forEach(u => {
    const li = document.createElement('li');
    li.textContent = u;
    li.title = u;
    li.addEventListener('click', () => {
      $('url').value = u;
      $('historyDropdown').open = false;
      onSubmit(new Event('submit'));
    });
    ul.appendChild(li);
  });
}
async function pushHistory(url) {
  state.history = [url, ...state.history.filter(u => u !== url)].slice(0, 10);
  renderHistory();
  try { await chrome.storage.local.set({ history: state.history }); } catch {}
}

/* ----------- current tab ----------- */
async function useCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) $('url').value = tab.url;
  } catch (e) {
    setStatus('Could not read current tab', 'error');
  }
}

/* ----------- submit ----------- */
async function onSubmit(e) {
  e.preventDefault();
  let url = $('url').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let parsed;
  try { parsed = new URL(url); }
  catch { setStatus('Invalid URL', 'error'); return; }

  state.url = url;
  state.host = parsed.hostname;
  state.origin = parsed.origin;
  state.data = {};
  state.pendingPS = { mobile: null, desktop: null };
  setStatus('Analyzing…');
  $('exportBtn').disabled = false;
  setTab(state.activeTab); // shows skeleton via render
  pushHistory(url);
  await analyze();
}

/* ============================================================
   ORCHESTRATION
   ============================================================ */
async function analyze() {
  // 1) page first (everything else benefits from knowing the resolved URL/host)
  try {
    const page = await fetchPage(state.url);
    state.data.page = page;
    rerenderActive();
  } catch (err) {
    state.data.pageError = err.message;
    setStatus('Fetch failed: ' + err.message, 'error');
    rerenderActive();
    // continue anyway with third-party fetchers — they don't need the page
  }

  // 2) parallel third-party + local fetches
  const tasks = [
    runTask('dns',         () => fetchAllDNS(state.host)),
    runTask('rdap',        () => fetchRDAP(state.host)),
    runTask('observatory', () => fetchObservatory(state.host)),
    runTask('wayback',     () => fetchWayback(state.url)),
    runTask('robots',      () => fetchRobots(state.origin)),
  ];

  // ipinfo runs after dns resolves the A record
  tasks.push((async () => {
    try {
      const dns = await waitFor(() => state.data.dns?.A?.[0], 8000);
      if (dns) {
        const info = await fetchIPInfo(dns);
        state.data.ipinfo = info;
        rerenderActive();
      }
    } catch (e) { state.data.ipinfoError = e.message; rerenderActive(); }
  })());

  // sitemap runs after robots resolves
  tasks.push((async () => {
    try {
      await waitFor(() => state.data.robots, 8000);
      const sitemapUrl = state.data.robots?.sitemap || (state.origin + '/sitemap.xml');
      const sm = await fetchSitemap(sitemapUrl);
      state.data.sitemap = sm;
      rerenderActive();
    } catch (e) { state.data.sitemapError = e.message; rerenderActive(); }
  })());

  await Promise.allSettled(tasks);

  // 3) PageSpeed last
  setStatus('Running PageSpeed Insights (10–30s)…');
  try {
    const ps = await fetchPageSpeed(state.url, state.strategy);
    state.pendingPS[state.strategy] = ps;
    state.data.pagespeed = state.pendingPS;
    rerenderActive();
    setStatus('Done', 'ok');
  } catch (err) {
    state.data.pagespeedError = err.message;
    rerenderActive();
    setStatus('Done (PageSpeed unavailable)', 'ok');
  }
}

async function runTask(key, fn) {
  try {
    const result = await fn();
    state.data[key] = result;
  } catch (e) {
    state.data[key + 'Error'] = e.message;
  } finally {
    rerenderActive();
  }
}

function waitFor(getter, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = getter();
      if (v != null) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

/* ============================================================
   FETCHERS
   ============================================================ */
async function fetchPage(url) {
  const res = await fetch(url, { redirect: 'follow' });
  const headers = Object.fromEntries(res.headers.entries());
  const html = await res.text();
  const sizeBytes = new Blob([html]).size;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return {
    finalUrl: res.url,
    statusCode: res.status,
    headers,
    sizeBytes,
    meta: extractMeta(doc),
    tech: detectTech(headers, html),
    stats: pageStats(doc),
    jsonLd: extractJsonLd(doc),
    hreflang: extractHreflang(doc),
    party: partyBreakdown(doc, state.host),
    httpVersion: detectHttpVersion(headers),
  };
}

const DOH = 'https://cloudflare-dns.com/dns-query';
async function fetchDNS(host, type) {
  const res = await fetch(`${DOH}?name=${encodeURIComponent(host)}&type=${type}`, {
    headers: { 'accept': 'application/dns-json' },
  });
  if (!res.ok) throw new Error('DoH ' + res.status);
  const json = await res.json();
  return (json.Answer || []).map(a => a.data);
}
async function fetchAllDNS(host) {
  const types = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CAA'];
  const out = {};
  await Promise.all(types.map(async t => {
    try { out[t] = await fetchDNS(host, t); }
    catch { out[t] = []; }
  }));
  return out;
}

async function fetchIPInfo(ip) {
  const res = await fetch(`https://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,isp,org,as,query`);
  if (!res.ok) throw new Error('ip-api ' + res.status);
  const j = await res.json();
  if (j.status !== 'success') throw new Error(j.message || 'ip-api failed');
  return j;
}

async function fetchRDAP(host) {
  // strip subdomains down to registrable domain (best-effort, no PSL)
  const parts = host.split('.');
  const domain = parts.length > 2 ? parts.slice(-2).join('.') : host;
  const res = await fetch(`https://rdap.org/domain/${domain}`);
  if (!res.ok) throw new Error('RDAP ' + res.status);
  const j = await res.json();
  const events = j.events || [];
  const find = (action) => events.find(e => e.eventAction === action)?.eventDate || null;
  const registrar = (j.entities || []).find(e => (e.roles || []).includes('registrar'));
  const registrarName = registrar?.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3] || null;
  return {
    domain,
    created: find('registration'),
    expires: find('expiration'),
    updated: find('last changed'),
    registrar: registrarName,
    status: j.status || [],
  };
}

async function fetchObservatory(host) {
  const url = `https://observatory.mozilla.org/api/v2/scan?host=${encodeURIComponent(host)}`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new Error('Observatory ' + res.status);
  const j = await res.json();
  if (j.grade) return { grade: j.grade, score: j.score, state: j.state };
  // poll once if pending
  await new Promise(r => setTimeout(r, 3500));
  const res2 = await fetch(url, { method: 'POST' });
  const j2 = await res2.json();
  return { grade: j2.grade || null, score: j2.score ?? null, state: j2.state || 'PENDING' };
}

async function fetchWayback(url) {
  const res = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=19960101`);
  if (!res.ok) throw new Error('Wayback ' + res.status);
  const j = await res.json();
  const snap = j.archived_snapshots?.closest;
  if (!snap) return null;
  // timestamp format: YYYYMMDDhhmmss
  const ts = snap.timestamp;
  const date = `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`;
  return { firstSeen: date, url: snap.url };
}

async function fetchRobots(origin) {
  const res = await fetch(origin + '/robots.txt');
  if (!res.ok) throw new Error('robots.txt ' + res.status);
  const txt = await res.text();
  const disallows = (txt.match(/^\s*Disallow:/gim) || []).length;
  const allows = (txt.match(/^\s*Allow:/gim) || []).length;
  const sitemapMatch = txt.match(/^\s*Sitemap:\s*(\S+)/im);
  const userAgents = (txt.match(/^\s*User-agent:/gim) || []).length;
  return {
    disallows,
    allows,
    userAgents,
    sitemap: sitemapMatch ? sitemapMatch[1] : null,
    raw: txt.slice(0, 500),
  };
}

async function fetchSitemap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('sitemap ' + res.status);
  const xml = await res.text();
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const locs = doc.querySelectorAll('loc');
  const isIndex = doc.querySelector('sitemapindex') != null;
  return {
    url,
    isIndex,
    count: Math.min(locs.length, 1000),
    sample: Array.from(locs).slice(0, 5).map(l => l.textContent),
  };
}

async function fetchPageSpeed(url, strategy) {
  const params = new URLSearchParams({ url, strategy });
  ['performance', 'accessibility', 'best-practices', 'seo'].forEach(c => params.append('category', c));
  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`);
  if (!res.ok) throw new Error('PSI ' + res.status);
  const data = await res.json();
  const cats = data.lighthouseResult?.categories || {};
  const audits = data.lighthouseResult?.audits || {};
  return {
    performance: cats.performance?.score,
    accessibility: cats.accessibility?.score,
    bestPractices: cats['best-practices']?.score,
    seo: cats.seo?.score,
    metrics: {
      lcp: audits['largest-contentful-paint']?.displayValue,
      cls: audits['cumulative-layout-shift']?.displayValue,
      fcp: audits['first-contentful-paint']?.displayValue,
      tbt: audits['total-blocking-time']?.displayValue,
      si: audits['speed-index']?.displayValue,
      lcpScore: audits['largest-contentful-paint']?.score,
      clsScore: audits['cumulative-layout-shift']?.score,
      fcpScore: audits['first-contentful-paint']?.score,
      tbtScore: audits['total-blocking-time']?.score,
      siScore: audits['speed-index']?.score,
    },
  };
}

/* ============================================================
   PARSERS
   ============================================================ */
function extractMeta(doc) {
  const m = (sel, attr = 'content') => doc.querySelector(sel)?.getAttribute(attr) || null;
  let favicon = doc.querySelector('link[rel~="icon" i]')?.getAttribute('href') || null;
  if (favicon && state.origin) {
    try { favicon = new URL(favicon, state.origin).href; } catch {}
  }
  return {
    title: doc.querySelector('title')?.textContent?.trim() || null,
    description: m('meta[name="description" i]'),
    canonical: m('link[rel="canonical" i]', 'href'),
    lang: doc.documentElement.getAttribute('lang'),
    viewport: m('meta[name="viewport" i]'),
    robots: m('meta[name="robots" i]'),
    generator: m('meta[name="generator" i]'),
    favicon,
    ogTitle: m('meta[property="og:title" i]'),
    ogDescription: m('meta[property="og:description" i]'),
    ogImage: m('meta[property="og:image" i]'),
    ogType: m('meta[property="og:type" i]'),
    ogSiteName: m('meta[property="og:site_name" i]'),
    twitterCard: m('meta[name="twitter:card" i]'),
  };
}

function detectTech(headers, html) {
  const found = [];
  const add = (name, cat) => found.push({ name, cat });
  const h = (k) => (headers[k.toLowerCase()] || '').toLowerCase();
  const has = (re) => re.test(html);

  if (h('server').includes('cloudflare') || headers['cf-ray']) add('Cloudflare', 'cdn');
  if (h('server').includes('nginx')) add('nginx', 'cdn');
  if (h('server').includes('apache')) add('Apache', 'cdn');
  if (headers['x-vercel-id'] || h('server').includes('vercel')) add('Vercel', 'cdn');
  if (headers['x-amz-cf-id']) add('AWS CloudFront', 'cdn');
  if (headers['x-fastly-request-id'] || h('via').includes('varnish')) add('Fastly', 'cdn');
  if (headers['x-shopify-stage'] || headers['x-shopid']) add('Shopify', 'cms');
  if (h('x-powered-by').includes('express')) add('Express', 'fw');
  if (h('x-powered-by').includes('php')) add('PHP', 'fw');
  if (h('x-powered-by').includes('next')) add('Next.js', 'fw');
  if (h('x-powered-by').includes('asp.net')) add('ASP.NET', 'fw');

  if (has(/wp-content|wp-includes/i) || has(/<meta[^>]+content="WordPress/i)) add('WordPress', 'cms');
  if (has(/__NEXT_DATA__/)) add('Next.js', 'fw');
  if (has(/data-reactroot|react-dom|__REACT_DEVTOOLS/)) add('React', 'fw');
  if (has(/data-v-[a-f0-9]{6,}|__NUXT__/)) add('Vue/Nuxt', 'fw');
  if (has(/svelte-[a-z0-9]{6}/)) add('Svelte', 'fw');
  if (has(/cdn\.shopify\.com/i)) add('Shopify', 'cms');
  if (has(/static\.wixstatic\.com|wix\.com/i)) add('Wix', 'cms');
  if (has(/squarespace/i)) add('Squarespace', 'cms');
  if (has(/jquery[.\-]\d|jquery\.min\.js/i)) add('jQuery', 'fw');
  if (has(/googletagmanager\.com\/gtag|gtag\(/)) add('Google Analytics', 'analytics');
  if (has(/googletagmanager\.com\/gtm/)) add('Google Tag Manager', 'analytics');
  if (has(/connect\.facebook\.net/)) add('Meta Pixel', 'analytics');
  if (has(/cdn\.tailwindcss\.com|--tw-/)) add('Tailwind CSS', 'fw');
  if (has(/bootstrap[.\-]\d|bootstrap\.min/i)) add('Bootstrap', 'fw');
  if (has(/cloudflareinsights\.com/)) add('Cloudflare Insights', 'analytics');
  if (has(/plausible\.io\/js/)) add('Plausible', 'analytics');
  if (has(/hotjar\.com/)) add('Hotjar', 'analytics');
  if (has(/intercom\.io/)) add('Intercom', 'analytics');

  // dedupe by name
  const seen = new Set();
  return found.filter(t => seen.has(t.name) ? false : (seen.add(t.name), true));
}

function pageStats(doc) {
  const text = (doc.body?.textContent || '').trim();
  return {
    links: doc.querySelectorAll('a[href]').length,
    images: doc.querySelectorAll('img').length,
    scripts: doc.querySelectorAll('script').length,
    stylesheets: doc.querySelectorAll('link[rel="stylesheet"]').length,
    iframes: doc.querySelectorAll('iframe').length,
    forms: doc.querySelectorAll('form').length,
    h1: doc.querySelectorAll('h1').length,
    h2: doc.querySelectorAll('h2').length,
    words: text.split(/\s+/).filter(Boolean).length,
  };
}

function extractJsonLd(doc) {
  const out = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const j = JSON.parse(s.textContent);
      const items = Array.isArray(j) ? j : [j];
      items.forEach(it => {
        const t = it['@type'];
        if (t) out.push(Array.isArray(t) ? t.join('/') : t);
      });
    } catch {}
  });
  return [...new Set(out)];
}

function extractHreflang(doc) {
  const out = [];
  doc.querySelectorAll('link[rel="alternate"][hreflang]').forEach(l => {
    out.push(l.getAttribute('hreflang'));
  });
  return [...new Set(out)];
}

function partyBreakdown(doc, host) {
  const collect = (sel, attr) =>
    Array.from(doc.querySelectorAll(sel))
      .map(el => el.getAttribute(attr))
      .filter(Boolean);
  const urls = [...collect('script[src]', 'src'), ...collect('img[src]', 'src'), ...collect('link[href]', 'href')];
  let first = 0, third = 0;
  const thirdDomains = new Set();
  urls.forEach(u => {
    try {
      const parsed = new URL(u, state.origin);
      if (parsed.hostname === host) first++;
      else { third++; thirdDomains.add(parsed.hostname); }
    } catch {}
  });
  return { first, third, thirdDomains: [...thirdDomains].slice(0, 20) };
}

function detectHttpVersion(headers) {
  const altSvc = headers['alt-svc'] || '';
  if (/h3/.test(altSvc)) return 'HTTP/3 (advertised)';
  if (/h2/.test(altSvc)) return 'HTTP/2';
  return 'HTTP/1.1 (assumed)';
}

/* ============================================================
   RENDERERS
   ============================================================ */
function setTab(name) {
  state.activeTab = name;
  document.querySelectorAll('.tab').forEach(b => {
    b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
  });
  rerenderActive();
}

function rerenderActive() {
  const main = $('tabContent');
  if (!state.url && !state.data.page) {
    main.innerHTML = `
      <div class="empty-state">
        <div class="empty-glyph">◎</div>
        <div class="empty-title">No site analyzed yet</div>
        <div class="empty-sub">Enter a URL above to inspect any website</div>
      </div>`;
    return;
  }
  const renderers = {
    overview: renderOverview,
    seo: renderSEO,
    tech: renderTech,
    network: renderNetwork,
    security: renderSecurity,
    performance: renderPerformance,
  };
  main.innerHTML = '';
  main.style.animation = 'none';
  void main.offsetWidth;
  main.style.animation = '';
  renderers[state.activeTab]();
}

function card(title, body) {
  const c = document.createElement('div');
  c.className = 'card';
  c.innerHTML = `<div class="card-title">${title}</div>${body}`;
  return c;
}

function kv(pairs) {
  return `<div class="kv">${pairs.map(([k, v]) =>
    `<div class="k">${k}</div><div class="v ${v == null || v === '' ? 'empty' : ''}">${v == null || v === '' ? '—' : esc(v)}</div>`
  ).join('')}</div>`;
}

function skeleton(lines = 3) {
  return Array(lines).fill('<div class="skeleton"></div>').join('');
}

/* ----- OVERVIEW ----- */
function renderOverview() {
  const main = $('tabContent');
  const p = state.data.page;
  if (!p) { main.appendChild(card('Loading', skeleton(4))); return; }

  const m = p.meta;
  const ogHtml = m.ogImage || m.ogTitle ? `
    <div class="og-card">
      ${m.ogImage ? `<img src="${esc(m.ogImage)}" onerror="this.style.display='none'">` : ''}
      <div class="og-body">
        <div class="og-site">${esc(m.ogSiteName || state.host)}</div>
        <div class="og-title">${esc(m.ogTitle || m.title || '—')}</div>
        <div class="og-desc">${esc(m.ogDescription || m.description || '')}</div>
      </div>
    </div>` : '';

  const favHtml = m.favicon ? `
    <div class="favicon-row">
      <img src="${esc(m.favicon)}" onerror="this.style.display='none'">
      <span class="host">${esc(state.host)}</span>
    </div>` : '';

  const overviewBody = `
    ${ogHtml}
    ${favHtml}
    ${kv([
      ['Final URL', p.finalUrl],
      ['Status', p.statusCode],
      ['HTML size', (p.sizeBytes / 1024).toFixed(1) + ' KB'],
      ['Server', p.headers.server],
      ['Content-Type', p.headers['content-type']],
    ])}`;
  main.appendChild(card('Overview', overviewBody));

  // Wayback
  if (state.data.wayback) {
    main.appendChild(card('First archived', `
      <div class="row">
        <span class="big-num">${state.data.wayback.firstSeen}</span>
        <span class="muted">via Wayback Machine</span>
      </div>
    `));
  } else if (state.data.waybackError) {
    main.appendChild(card('First archived', `<span class="muted">Unavailable</span>`));
  } else {
    main.appendChild(card('First archived', skeleton(1)));
  }
}

/* ----- SEO ----- */
function renderSEO() {
  const main = $('tabContent');
  const p = state.data.page;
  if (!p) { main.appendChild(card('Loading', skeleton(4))); return; }
  const m = p.meta;

  const serpHtml = `
    <div class="serp">
      <div class="serp-url">${esc(p.finalUrl)}</div>
      <div class="serp-title">${esc(m.title || '(no title)')}</div>
      <div class="serp-desc">${esc(m.description || '(no description)')}</div>
    </div>`;

  main.appendChild(card('Search preview', serpHtml + kv([
    ['Canonical', m.canonical],
    ['Lang', m.lang],
    ['Robots', m.robots],
    ['Generator', m.generator],
    ['Twitter card', m.twitterCard],
  ])));

  // structured data + hreflang
  const sd = p.jsonLd;
  const hl = p.hreflang;
  main.appendChild(card('Structured data & languages', `
    <div class="kv">
      <div class="k">JSON-LD</div>
      <div class="v">${sd.length ? `<div class="chips">${sd.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : '<span class="muted">none</span>'}</div>
      <div class="k">Hreflang</div>
      <div class="v">${hl.length ? `<div class="chips">${hl.map(l => `<span class="chip">${esc(l)}</span>`).join('')}</div>` : '<span class="muted">none</span>'}</div>
    </div>
  `));

  // robots + sitemap tiles
  const r = state.data.robots;
  const sm = state.data.sitemap;
  let robotsBody;
  if (r) {
    robotsBody = `<div class="tiles">
      <div class="tile"><b>${r.disallows}</b><span>Disallows</span></div>
      <div class="tile"><b>${r.allows}</b><span>Allows</span></div>
      <div class="tile"><b>${r.userAgents}</b><span>User-agents</span></div>
      <div class="tile"><b>${sm ? sm.count : '—'}</b><span>Sitemap URLs</span></div>
    </div>`;
  } else if (state.data.robotsError) {
    robotsBody = `<span class="muted">No robots.txt found</span>`;
  } else {
    robotsBody = skeleton(2);
  }
  main.appendChild(card('Crawlers & sitemap', robotsBody));

  // page stats
  main.appendChild(card('Page stats', `<div class="tiles">
    <div class="tile"><b>${p.stats.words}</b><span>Words</span></div>
    <div class="tile"><b>${p.stats.h1}</b><span>H1</span></div>
    <div class="tile"><b>${p.stats.h2}</b><span>H2</span></div>
    <div class="tile"><b>${p.stats.images}</b><span>Images</span></div>
    <div class="tile"><b>${p.stats.links}</b><span>Links</span></div>
    <div class="tile"><b>${p.stats.forms}</b><span>Forms</span></div>
  </div>`));
}

/* ----- TECH ----- */
function renderTech() {
  const main = $('tabContent');
  const p = state.data.page;
  if (!p) { main.appendChild(card('Loading', skeleton(4))); return; }

  const grouped = {};
  p.tech.forEach(t => {
    (grouped[t.cat] ||= []).push(t.name);
  });
  const labels = { cdn: 'CDN / Hosting', fw: 'Framework', cms: 'CMS / Platform', analytics: 'Analytics' };
  const order = ['cdn', 'fw', 'cms', 'analytics'];

  let techBody = '';
  let any = false;
  order.forEach(cat => {
    if (grouped[cat]) {
      any = true;
      techBody += `<div style="margin-bottom:8px"><div class="card-title" style="margin-bottom:4px">${labels[cat]}</div><div class="chips">${grouped[cat].map(n => `<span class="chip" data-cat="${cat}">${esc(n)}</span>`).join('')}</div></div>`;
    }
  });
  if (!any) techBody = '<span class="muted">No technologies detected</span>';
  main.appendChild(card('Detected stack', techBody));

  // party breakdown
  const pb = p.party;
  const total = pb.first + pb.third || 1;
  const firstPct = (pb.first / total) * 100;
  const r = 26, c = 2 * Math.PI * r;
  const dash = (firstPct / 100) * c;
  main.appendChild(card('First-party vs third-party requests', `
    <div class="party">
      <svg class="donut" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--bad)" stroke-width="10"/>
        <circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--good)" stroke-width="10"
                stroke-dasharray="${dash} ${c}" transform="rotate(-90 32 32)"/>
      </svg>
      <div class="legend">
        <div class="row"><span class="sw" style="background:var(--good)"></span> First-party: <b>${pb.first}</b></div>
        <div class="row"><span class="sw" style="background:var(--bad)"></span> Third-party: <b>${pb.third}</b></div>
        <div class="muted" style="margin-top:4px;font-size:10px">${pb.thirdDomains.length} unique third-party domains</div>
      </div>
    </div>
  `));
}

/* ----- NETWORK ----- */
function renderNetwork() {
  const main = $('tabContent');

  // DNS
  let dnsBody;
  const dns = state.data.dns;
  if (dns) {
    const rows = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CAA']
      .filter(t => dns[t] && dns[t].length)
      .map(t => `<div class="dns-row"><span class="type">${t}</span><div class="records">${dns[t].slice(0, 6).map(r => `<span class="rec">${esc(r)}</span>`).join('')}</div></div>`)
      .join('');
    dnsBody = rows ? `<div class="dns-grid">${rows}</div>` : '<span class="muted">No DNS records found</span>';
  } else if (state.data.dnsError) {
    dnsBody = '<span class="muted">DNS lookup failed</span>';
  } else {
    dnsBody = skeleton(4);
  }
  main.appendChild(card('DNS records', dnsBody));

  // IP geo
  let ipBody;
  const ip = state.data.ipinfo;
  if (ip) {
    const flag = countryFlag(ip.countryCode);
    ipBody = `
      <div class="row" style="margin-bottom:6px">
        <span class="flag">${flag}</span>
        <b>${esc(ip.country)}</b>
        <span class="muted">${esc(ip.city || '')}, ${esc(ip.regionName || '')}</span>
      </div>
      ${kv([
        ['IP', ip.query],
        ['ISP', ip.isp],
        ['Org', ip.org],
        ['ASN', ip.as],
      ])}`;
  } else if (state.data.ipinfoError) {
    ipBody = '<span class="muted">IP info unavailable</span>';
  } else {
    ipBody = skeleton(3);
  }
  main.appendChild(card('Server location', ipBody));

  // RDAP
  let rdapBody;
  const rd = state.data.rdap;
  if (rd) {
    const age = rd.created ? humanAge(rd.created) : '—';
    rdapBody = `
      <div class="row" style="margin-bottom:8px">
        <span class="big-num">${age}</span>
        <span class="muted">domain age</span>
      </div>
      ${kv([
        ['Domain', rd.domain],
        ['Registrar', rd.registrar],
        ['Created', rd.created?.slice(0, 10)],
        ['Expires', rd.expires?.slice(0, 10)],
        ['Updated', rd.updated?.slice(0, 10)],
      ])}`;
  } else if (state.data.rdapError) {
    rdapBody = '<span class="muted">RDAP unavailable for this TLD</span>';
  } else {
    rdapBody = skeleton(4);
  }
  main.appendChild(card('Domain (RDAP/WHOIS)', rdapBody));

  // HTTP version
  if (state.data.page) {
    main.appendChild(card('Protocol', `<b>${esc(state.data.page.httpVersion)}</b>`));
  }
}

/* ----- SECURITY ----- */
function renderSecurity() {
  const main = $('tabContent');
  const obs = state.data.observatory;

  // Observatory grade card
  let gradeBody;
  if (obs && obs.grade) {
    const cls = gradeClass(obs.grade);
    gradeBody = `
      <div class="grade-row">
        <div class="grade ${cls}">${esc(obs.grade)}</div>
        <div class="grade-info">
          <b>Mozilla Observatory</b>
          <span>Score: ${obs.score ?? '—'}</span>
        </div>
      </div>`;
  } else if (obs && obs.state === 'PENDING') {
    gradeBody = '<span class="muted">Scan queued — refresh in a moment</span>';
  } else if (state.data.observatoryError) {
    gradeBody = '<span class="muted">Observatory unavailable</span>';
  } else {
    gradeBody = `<div class="grade-row"><div class="skeleton lg" style="width:56px"></div><div class="skeleton" style="width:120px"></div></div>`;
  }
  main.appendChild(card('Security grade', gradeBody));

  // Security headers
  const p = state.data.page;
  if (!p) { main.appendChild(card('Security headers', skeleton(5))); return; }
  const headers = p.headers;
  const sec = [
    'strict-transport-security',
    'content-security-policy',
    'x-frame-options',
    'x-content-type-options',
    'referrer-policy',
    'permissions-policy',
  ];
  const rows = sec.map(h => {
    const v = headers[h];
    const present = !!v;
    return `<div class="sec-row">
      <span class="icon ${present ? 'good' : 'bad'}">${present ? '✓' : '✗'}</span>
      <span class="name">${h}</span>
      <span class="val" title="${esc(v || '')}">${esc(v ? String(v).slice(0, 60) : 'missing')}</span>
    </div>`;
  }).join('');
  main.appendChild(card('Security headers', rows));
}

/* ----- PERFORMANCE ----- */
function renderPerformance() {
  const main = $('tabContent');

  // strategy toggle
  const toggleHtml = `
    <div class="strategy-toggle">
      <button class="${state.strategy === 'mobile' ? 'active' : ''}" data-strat="mobile">📱 Mobile</button>
      <button class="${state.strategy === 'desktop' ? 'active' : ''}" data-strat="desktop">🖥 Desktop</button>
    </div>`;

  const ps = state.pendingPS[state.strategy];

  let body;
  if (state.data.pagespeedError && !ps) {
    body = `${toggleHtml}<span class="muted">PageSpeed: ${esc(state.data.pagespeedError)}</span>`;
  } else if (!ps) {
    body = `${toggleHtml}
      <div class="gauges">${[1,2,3,4].map(()=>`<div class="gauge"><div class="skeleton lg" style="width:64px;height:64px;border-radius:50%"></div></div>`).join('')}</div>
      <div class="muted" style="font-size:10px">Running PageSpeed Insights…</div>`;
  } else {
    const gauges = [
      ['performance', 'Perf', ps.performance],
      ['accessibility', 'A11y', ps.accessibility],
      ['bestPractices', 'Best', ps.bestPractices],
      ['seo', 'SEO', ps.seo],
    ].map(([_, label, score]) => gaugeSvg(label, score)).join('');

    const m = ps.metrics;
    const tile = (label, value, scoreVal) => {
      const dot = scoreVal == null ? '' : (scoreVal >= 0.9 ? 'good' : scoreVal >= 0.5 ? 'avg' : 'bad');
      return `<div class="tile"><b><span class="dot ${dot}"></span>${esc(value || '—')}</b><span>${label}</span></div>`;
    };

    body = `${toggleHtml}
      <div class="gauges">${gauges}</div>
      <div class="card-title" style="margin-top:6px">Core Web Vitals</div>
      <div class="tiles">
        ${tile('LCP', m.lcp, m.lcpScore)}
        ${tile('CLS', m.cls, m.clsScore)}
        ${tile('FCP', m.fcp, m.fcpScore)}
        ${tile('TBT', m.tbt, m.tbtScore)}
        ${tile('SI',  m.si,  m.siScore)}
      </div>`;
  }

  main.appendChild(card('Lighthouse', body));

  // bind toggle
  document.querySelectorAll('.strategy-toggle button').forEach(b => {
    b.addEventListener('click', async () => {
      const newStrat = b.dataset.strat;
      if (newStrat === state.strategy) return;
      state.strategy = newStrat;
      if (state.pendingPS[newStrat]) {
        rerenderActive();
      } else {
        rerenderActive();
        setStatus(`Running ${newStrat} PageSpeed…`);
        try {
          const ps = await fetchPageSpeed(state.url, newStrat);
          state.pendingPS[newStrat] = ps;
          rerenderActive();
          setStatus('Done', 'ok');
        } catch (e) {
          setStatus('PageSpeed failed: ' + e.message, 'error');
        }
      }
    });
  });
}

function gaugeSvg(label, score) {
  const v = score == null ? 0 : score;
  const num = score == null ? '—' : Math.round(v * 100);
  const r = 26, c = 2 * Math.PI * r;
  const offset = c - v * c;
  const cls = score == null ? '' : v >= 0.9 ? 'good' : v >= 0.5 ? 'avg' : 'bad';
  return `<div class="gauge ${cls}">
    <svg viewBox="0 0 64 64">
      <circle class="ring-bg" cx="32" cy="32" r="${r}" stroke-width="6" fill="none"/>
      <circle class="ring-fg" cx="32" cy="32" r="${r}" stroke-width="6" fill="none"
              stroke-dasharray="${c}" stroke-dashoffset="${offset}"/>
    </svg>
    <div class="gauge-num">${num}</div>
    <span class="gauge-label">${label}</span>
  </div>`;
}

/* ============================================================
   HELPERS
   ============================================================ */
function setStatus(msg, kind = '') {
  const s = $('status');
  s.textContent = msg;
  s.className = 'status ' + kind;
}

function exportJSON() {
  if (!state.data || Object.keys(state.data).length === 0) return;
  const blob = new Blob([JSON.stringify({ url: state.url, data: state.data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  a.download = `site-inspector-${state.host}-${date}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function countryFlag(cc) {
  if (!cc || cc.length !== 2) return '🌐';
  const A = 0x1F1E6;
  return String.fromCodePoint(A + cc.charCodeAt(0) - 65, A + cc.charCodeAt(1) - 65);
}

function gradeClass(grade) {
  if (!grade) return '';
  const letter = grade[0];
  if (letter === 'A') return 'good';
  if (letter === 'B' || letter === 'C') return 'avg';
  return 'bad';
}

function humanAge(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate);
  if (isNaN(d)) return '—';
  const now = new Date();
  let years = now.getFullYear() - d.getFullYear();
  let months = now.getMonth() - d.getMonth();
  if (months < 0) { years--; months += 12; }
  if (years > 0) return `${years}y ${months}mo`;
  return `${months}mo`;
}
