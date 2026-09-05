import 'dotenv/config';
import express from 'express';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const app = express();
app.use(express.json({ limit: '64kb' }));
const port = Number(process.env.PORT || 8080);
const apiKey = process.env.ORBITPRESS_API_KEY || '';
const maxConcurrent = Number(process.env.MAX_CONCURRENT_JOBS || 2);
const usePersistentSessions = process.env.USE_PERSISTENT_SESSIONS !== 'false';
const sessionDir = process.env.SESSION_DIR || '/sessions';
const sessionPlatforms = new Set(['facebook', 'pinterest']);
let activeJobs = 0;
const sessionLocks = new Map();

function auth(req, res, next) {
  if (!apiKey || req.get('x-orbitpress-key') !== apiKey) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function secureSessionTransport(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  return req.secure || forwarded === 'https' || req.ip === '127.0.0.1' || req.ip === '::1';
}
function validHttpUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:'; } catch { return false; }
}
function guardJob(res) {
  if (activeJobs >= maxConcurrent) { res.status(429).json({ error: 'Too many scraper jobs. Try again shortly.' }); return false; }
  activeJobs += 1; return true;
}
async function withBrowser(fn, platform = 'shared') {
  if (usePersistentSessions && sessionPlatforms.has(platform)) {
    await fs.mkdir(sessionDir, { recursive: true });
    const previous = sessionLocks.get(platform) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    sessionLocks.set(platform, previous.then(() => current));
    await previous;
    const profileDir = path.join(sessionDir, platform);
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: process.env.BROWSER_HEADLESS !== 'false',
      viewport: { width: 1365, height: 900 },
      locale: 'en-US',
      args: ['--disable-blink-features=AutomationControlled']
    });
    try { return await fn(context); } finally { await context.close(); release(); }
  }
  const browser = await chromium.launch({ headless: process.env.BROWSER_HEADLESS !== 'false' });
  try { return await fn(browser); } finally { await browser.close(); }
}
function sessionProfile(platform) { return path.join(sessionDir, platform); }
async function sessionStatus(platform) {
  if (!sessionPlatforms.has(platform)) throw new Error('Unsupported platform session.');
  await fs.mkdir(sessionDir, { recursive: true });
  const profile = sessionProfile(platform);
  let entries = [];
  try { entries = await fs.readdir(profile); } catch {}
  return { platform, persistent: usePersistentSessions, profileExists: entries.length > 0, profileDir: profile };
}
async function checkLoggedIn(platform) {
  return withBrowser(async context => {
    const page = await context.newPage();
    const home = platform === 'facebook' ? 'https://www.facebook.com/' : 'https://www.pinterest.com/';
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const cookies = await context.cookies();
    const cookieNames = new Set(cookies.map(cookie => cookie.name));
    const cookieLoggedIn = platform === 'facebook'
      ? cookieNames.has('c_user') && cookieNames.has('xs')
      : cookieNames.has('_pinterest_sess') || cookieNames.has('pinterest_sess');
    const loginForm = await page.locator('input[name="email"], input[name="password"], input[type="password"]').count().catch(() => 0);
    const redirectedToLogin = /\/(login|auth)\b/i.test(new URL(page.url()).pathname);
    const loggedIn = cookieLoggedIn && !redirectedToLogin && loginForm === 0;
    return { ...(await sessionStatus(platform)), checked: true, loggedIn, cookieNames: [...cookieNames].filter(name => /c_user|xs|pinterest_sess/i.test(name)), finalUrl: page.url(), title: await page.title() };
  }, platform);
}
async function addIncomingCookies(context, cookies, platform) {
  if (!Array.isArray(cookies) || !cookies.length) return;
  const domain = platform === 'facebook' ? '.facebook.com' : '.pinterest.com';
  const safe = cookies.filter(cookie => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string')
    .map(cookie => ({ name: cookie.name, value: cookie.value, domain, path: '/', secure: false, sameSite: 'Lax' }));
  if (safe.length) { await context.clearCookies(); await context.addCookies(safe); }
}

async function facebook(url, maxPosts = 20, cookies = []) {
  return withBrowser(async browser => {
    await addIncomingCookies(browser, cookies, 'facebook');
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, locale: 'en-US' });
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(6000);
    const posts = new Map();
    let previousSize = 0;
    let stagnantRounds = 0;
    for (let i = 0; i < 20 && posts.size < maxPosts; i++) {
      let rows = await page.locator('[role="article"]').evaluateAll(els => els.map(el => ({
        text: (el.innerText || '').trim(),
        id: el.getAttribute('data-ft') || el.getAttribute('data-pagelet') || el.querySelector('a[href*="/posts/"],a[href*="/permalink/"]')?.href || ''
      })));
      if (!rows.length) rows = await page.locator('[data-ad-preview="message"]').evaluateAll(els => els.map(el => ({ text: (el.closest('[role="article"]')?.innerText || el.innerText || '').trim() })));
      rows.forEach(row => {
        if (!row.text) return;
        const key = row.id || row.text.slice(0, 500);
        posts.set(key, { text: row.text.slice(0, 5000), ...(row.id ? { url: row.id } : {}) });
      });
      if (posts.size === previousSize) stagnantRounds += 1; else stagnantRounds = 0;
      previousSize = posts.size;
      if (stagnantRounds >= 4) break;
      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(1800);
    }
    return { source: url, posts: [...posts.values()].slice(0, maxPosts) };
  }, 'facebook');
}

async function pinterest(url, maxItems = 50, cookies = []) {
  return withBrowser(async browser => {
    await addIncomingCookies(browser, cookies, 'pinterest');
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, locale: 'en-US' });
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    const pins = new Map();
    for (let i = 0; i < 10 && pins.size < maxItems; i++) {
      const rows = await page.locator('a[href*="/pin/"], a[href*="/pin\\/"]').evaluateAll(els => els.map(a => ({
        url: a.href, title: a.getAttribute('aria-label') || a.innerText || a.querySelector('img')?.alt || '', image: a.querySelector('img')?.src || ''
      })));
      rows.forEach(row => { if (row.url) pins.set(row.url, row); });
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(1500);
    }
    if (!pins.size && /\/pin\//i.test(page.url())) {
      const meta = await page.evaluate(() => {
        const get = name => document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content || '';
        let jsonLd = null;
        for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
          try { const value = JSON.parse(node.textContent || 'null'); if (value && typeof value === 'object') { jsonLd = value; break; } } catch {}
        }
        return { title: get('og:title') || document.title, description: get('og:description') || get('description'), image: get('og:image'), canonical: document.querySelector('link[rel="canonical"]')?.href || location.href, jsonLd };
      });
      const data = meta.jsonLd || {};
      pins.set(meta.canonical || page.url(), { url: meta.canonical || page.url(), title: meta.title || data.name || '', description: meta.description || data.description || '', image: meta.image || data.image?.url || data.image || '' });
    }
    return { source: url, finalUrl: page.url(), title: await page.title(), pins: [...pins.values()].slice(0, maxItems) };
  }, 'pinterest');
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'orbitpress-scraper-api', activeJobs, persistentSessions: usePersistentSessions }));
app.get('/api/session/status', auth, async (_req, res) => {
  try { res.json({ ok: true, sessions: { facebook: await sessionStatus('facebook'), pinterest: await sessionStatus('pinterest') } }); }
  catch (e) { res.status(500).json({ error: 'Session status failed', detail: e.message }); }
});
app.get('/api/session/:platform/check', auth, async (req, res) => {
  if (!sessionPlatforms.has(req.params.platform)) return res.status(400).json({ error: 'Platform must be facebook or pinterest.' });
  if (!guardJob(res)) return;
  try { res.json({ ok: true, ...(await checkLoggedIn(req.params.platform)) }); }
  catch (e) { res.status(502).json({ error: 'Session check failed', detail: e.message }); } finally { activeJobs--; }
});
app.post('/api/session/:platform/import', auth, async (req, res) => {
  const platform = req.params.platform;
  if (!sessionPlatforms.has(platform)) return res.status(400).json({ error: 'Platform must be facebook or pinterest.' });
  if (!secureSessionTransport(req)) return res.status(400).json({ error: 'Session transfer requires HTTPS. Do not send browser cookies over plain HTTP.' });
  const cookies = Array.isArray(req.body?.cookies) ? req.body.cookies : [];
  if (!cookies.length || cookies.length > 150) return res.status(400).json({ error: 'Provide a valid cookies array.' });
  const domainMatch = platform === 'facebook' ? /(^|\.)facebook\.com$/i : /(^|\.)pinterest\.com$/i;
  const safeCookies = cookies.filter(cookie => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string' && cookie.name.length <= 160 && cookie.value.length <= 10000 && domainMatch.test(String(cookie.domain || `${platform}.com`)))
    .map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/', expires: Number.isFinite(Number(cookie.expires)) ? Number(cookie.expires) : undefined, httpOnly: Boolean(cookie.httpOnly), secure: true, sameSite: ['Strict', 'Lax', 'None'].includes(cookie.sameSite) ? cookie.sameSite : 'Lax' }));
  if (!safeCookies.length) return res.status(400).json({ error: 'No acceptable cookies were provided for this platform.' });
  try {
    await withBrowser(async context => { await context.clearCookies(); await context.addCookies(safeCookies); }, platform);
    res.json({ ok: true, platform, imported: safeCookies.length, message: 'Session imported securely. Run the session check endpoint now.' });
  } catch (e) { res.status(502).json({ error: 'Session import failed', detail: e.message }); }
});

app.post('/api/facebook/scrape', auth, async (req, res) => {
  const { url, maxPosts = 20, cookies = [] } = req.body || {};
  if (!validHttpUrl(url) || !/facebook\.com$/i.test(new URL(url).hostname.replace(/^www\./, '')) && !/\.facebook\.com$/i.test(new URL(url).hostname)) return res.status(400).json({ error: 'Use an HTTPS Facebook Page or public Post URL.' });
  if (!guardJob(res)) return;
  try {
    const limit = Math.min(100, Math.max(1, Number(maxPosts)));
    const local = await facebook(url, limit, cookies);
    return res.json({ ok: true, ...local, provider: 'playwright', warning: local.posts.length ? undefined : 'Facebook returned no accessible public article elements. The endpoint uses only your VPS Playwright browser and does not use an external scraper.' });
  } catch (e) { res.status(502).json({ error: 'Facebook extraction failed', detail: e.message }); } finally { activeJobs--; }
});
app.post('/api/pinterest/scrape', auth, async (req, res) => {
  const { url, maxItems = 50, cookies = [] } = req.body || {};
  if (!validHttpUrl(url) || !/pinterest\.com$/i.test(new URL(url).hostname.replace(/^www\./, '')) && !/\.pinterest\.com$/i.test(new URL(url).hostname)) return res.status(400).json({ error: 'Use an HTTPS Pinterest Board, Profile, or Pin URL.' });
  if (!guardJob(res)) return;
  try { res.json({ ok: true, ...(await pinterest(url, Math.min(200, Math.max(1, Number(maxItems))), cookies)) }); } catch (e) { res.status(502).json({ error: 'Pinterest extraction failed', detail: e.message }); } finally { activeJobs--; }
});
app.listen(port, '0.0.0.0', () => console.log(`OrbitPress Scraper API listening on ${port}`));
