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

async function pinterest(url, maxItems = 50) {
  return withBrowser(async browser => {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const pins = new Map();
    for (let i = 0; i < 10 && pins.size < maxItems; i++) {
      const rows = await page.locator('a[href*="/pin/"]').evaluateAll(els => els.map(a => ({
        url: a.href, title: a.getAttribute('aria-label') || a.innerText || '', image: a.querySelector('img')?.src || ''
      })));
      rows.forEach(row => { if (row.url) pins.set(row.url, row); });
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(1000);
    }
    return { source: url, pins: [...pins.values()].slice(0, maxItems) };
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
