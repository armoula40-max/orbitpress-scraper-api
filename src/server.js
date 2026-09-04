import 'dotenv/config';
import express from 'express';
import { chromium } from 'playwright';

const app = express();
app.use(express.json({ limit: '64kb' }));
const port = Number(process.env.PORT || 8080);
const apiKey = process.env.ORBITPRESS_API_KEY || '';
const maxConcurrent = Number(process.env.MAX_CONCURRENT_JOBS || 2);
let activeJobs = 0;

function auth(req, res, next) {
  if (!apiKey || req.get('x-orbitpress-key') !== apiKey) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function validHttpUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:'; } catch { return false; }
}
function guardJob(res) {
  if (activeJobs >= maxConcurrent) { res.status(429).json({ error: 'Too many scraper jobs. Try again shortly.' }); return false; }
  activeJobs += 1; return true;
}
async function withBrowser(fn) {
  const browser = await chromium.launch({ headless: process.env.BROWSER_HEADLESS !== 'false' });
  try { return await fn(browser); } finally { await browser.close(); }
}

async function facebook(url, maxPosts = 20) {
  return withBrowser(async browser => {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, locale: 'en-US' });
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    const posts = new Map();
    for (let i = 0; i < 8 && posts.size < maxPosts; i++) {
      let rows = await page.locator('[role="article"]').evaluateAll(els => els.map(el => ({
        text: (el.innerText || '').trim(), html: el.innerHTML.slice(0, 2000)
      })));
      if (!rows.length) rows = await page.locator('[data-ad-preview="message"]').evaluateAll(els => els.map(el => ({ text: (el.closest('[role="article"]')?.innerText || el.innerText || '').trim() })));
      rows.forEach(row => { if (row.text) posts.set(row.text.slice(0, 500), { text: row.text.slice(0, 5000) }); });
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(1200);
    }
    return { source: url, posts: [...posts.values()].slice(0, maxPosts) };
  });
}

async function pinterestInitialPins(page) {
  const raw = await page.locator('script#__PWS_INITIAL_PROPS__').textContent().catch(() => null);
  if (!raw) return [];
  try {
    const state = JSON.parse(raw).initialReduxState || {};
    const resources = state.resources?.UserPinsResource || {};
    const resourcePins = Object.values(resources).flatMap(resource => Array.isArray(resource?.data) ? resource.data : []);
    const pins = resourcePins.length ? resourcePins : Object.values(state.pins || {});
    return pins.map(pin => {
      const id = String(pin.id || pin.pin_id || '').trim();
      const image = pin.images?.orig?.url || pin.images?.['736x']?.url || pin.images?.['474x']?.url || '';
      return id ? { id, url: `https://www.pinterest.com/pin/${id}/`, title: '', description: '', image } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

async function enrichPinterestPins(browser, pins, maxEnrich = 10) {
  const detail = await browser.newPage({ viewport: { width: 1365, height: 900 }, locale: 'en-US' });
  try {
    for (const pin of pins.slice(0, maxEnrich)) {
      try {
        await detail.goto(pin.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const title = await detail.locator('meta[property="og:title"]').getAttribute('content').catch(() => null);
        const description = await detail.locator('meta[property="og:description"]').getAttribute('content').catch(() => null);
        const image = await detail.locator('meta[property="og:image"]').getAttribute('content').catch(() => null);
        if (title) pin.title = title.trim();
        if (description) pin.description = description.trim();
        if (image) pin.image = image.trim();
      } catch {
        // Keep the pin discovered from the profile JSON when detail enrichment is blocked.
      }
    }
  } finally {
    await detail.close();
  }
  return pins;
}

async function pinterest(url, maxItems = 50) {
  return withBrowser(async browser => {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, locale: 'en-US' });
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    const pins = new Map();
    const initialPins = await pinterestInitialPins(page);
    initialPins.forEach(pin => pins.set(pin.url, pin));
    for (let i = 0; i < 10 && pins.size < maxItems; i++) {
      const rows = await page.locator('a[href*="/pin/"], a[href*="/pin\\/"]').evaluateAll(els => els.map(a => ({
        url: a.href, title: a.getAttribute('aria-label') || a.innerText || a.querySelector('img')?.alt || '', image: a.querySelector('img')?.src || ''
      })));
      rows.forEach(row => {
        if (!row.url) return;
        const existing = pins.get(row.url) || {};
        pins.set(row.url, { ...existing, ...row });
      });
      if (pins.size >= maxItems) break;
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(1500);
    }
    const results = [...pins.values()].slice(0, maxItems);
    await enrichPinterestPins(browser, results, Math.min(10, maxItems));
    return { source: url, finalUrl: page.url(), title: await page.title(), pins: results, diagnostics: { initialPins: initialPins.length, discoveredPins: pins.size, enrichedPins: Math.min(10, results.length) } };
  });
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'orbitpress-scraper-api', activeJobs }));
app.post('/api/facebook/scrape', auth, async (req, res) => {
  const { url, maxPosts = 20 } = req.body || {};
  if (!validHttpUrl(url) || !/facebook\.com$/i.test(new URL(url).hostname.replace(/^www\./, '')) && !/\.facebook\.com$/i.test(new URL(url).hostname)) return res.status(400).json({ error: 'Use an HTTPS Facebook Page or public Post URL.' });
  if (!guardJob(res)) return;
  try {
    const limit = Math.min(100, Math.max(1, Number(maxPosts)));
    const local = await facebook(url, limit);
    return res.json({ ok: true, ...local, provider: 'playwright', warning: local.posts.length ? undefined : 'Facebook returned no accessible public article elements. The endpoint uses only your VPS Playwright browser and does not use an external scraper.' });
  } catch (e) { res.status(502).json({ error: 'Facebook extraction failed', detail: e.message }); } finally { activeJobs--; }
});
app.post('/api/pinterest/scrape', auth, async (req, res) => {
  const { url, maxItems = 50 } = req.body || {};
  if (!validHttpUrl(url) || !/pinterest\.com$/i.test(new URL(url).hostname.replace(/^www\./, '')) && !/\.pinterest\.com$/i.test(new URL(url).hostname)) return res.status(400).json({ error: 'Use an HTTPS Pinterest Board, Profile, or Pin URL.' });
  if (!guardJob(res)) return;
  try { res.json({ ok: true, ...(await pinterest(url, Math.min(200, Math.max(1, Number(maxItems))))) }); } catch (e) { res.status(502).json({ error: 'Pinterest extraction failed', detail: e.message }); } finally { activeJobs--; }
});
app.listen(port, '0.0.0.0', () => console.log(`OrbitPress Scraper API listening on ${port}`));
