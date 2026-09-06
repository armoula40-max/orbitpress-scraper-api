import 'dotenv/config';
import express from 'express';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildPagination, clampLimit, normalizeFacebookPost, normalizePinterestPin, parseCount, resolveOffset } from './contracts.js';

const app = express();
app.use(express.json({ limit: '64kb' }));
const port = Number(process.env.PORT || 8080);
const apiKey = process.env.ORBITPRESS_API_KEY || '';
const minApiKeyLength = Number(process.env.MIN_API_KEY_LENGTH || 32);
const maxConcurrent = Number(process.env.MAX_CONCURRENT_JOBS || 2);
const jobTimeoutMs = Number(process.env.JOB_TIMEOUT_MS || 90000);
const exposeErrorDetails = process.env.EXPOSE_ERROR_DETAILS === 'true';
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 60);
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const usePersistentSessions = process.env.USE_PERSISTENT_SESSIONS !== 'false';
const sessionDir = process.env.SESSION_DIR || '/sessions';
const sessionPlatforms = new Set(['facebook', 'pinterest']);
let activeJobs = 0;
const sessionLocks = new Map();

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function auth(req, res, next) {
  if (!apiKey || apiKey.length < minApiKeyLength) {
    console.error(`Refusing request: ORBITPRESS_API_KEY is missing or shorter than ${minApiKeyLength} characters.`);
    return res.status(500).json({ error: 'Server is misconfigured.' });
  }
  if (!timingSafeEqual(req.get('x-orbitpress-key'), apiKey)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const rateBuckets = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || 'unknown';
  const bucket = (rateBuckets.get(key) || []).filter(stamp => now - stamp < rateLimitWindowMs);
  if (bucket.length >= rateLimitMax) return res.status(429).json({ error: 'Rate limit exceeded. Try again shortly.' });
  bucket.push(now);
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 5000) {
    for (const [bucketKey, stamps] of rateBuckets) if (!stamps.some(stamp => now - stamp < rateLimitWindowMs)) rateBuckets.delete(bucketKey);
  }
  next();
}

function serverError(res, status, message, err, logLabel) {
  if (err) console.error(`${logLabel || message}:`, err.message || err);
  const body = { error: message };
  if (exposeErrorDetails && err) body.detail = String(err.message || err).slice(0, 300);
  return res.status(status).json(body);
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
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  timer.unref?.();
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: 'en-US' });
  try { return await fn(context); } finally { await context.close(); await browser.close(); }
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
    .map(cookie => ({ name: cookie.name, value: cookie.value, domain, path: '/', secure: true, sameSite: 'Lax' }));
  if (safe.length) await context.addCookies(safe);
}

function isFacebookPostUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    if (!/(^|\.)facebook\.com$/i.test(parsed.hostname.replace(/^www\./i, '')) && !/\.facebook\.com$/i.test(parsed.hostname)) return false;
    if (/[?&](comment_id|reply_comment_id|comment|reply)=/i.test(parsed.search)) return false;
    return /\/(?:[^/]+\/)?posts\/|\/permalink\.php|\/story\.php|\/photo\.php|\/videos?\/|\/reel\/|\/watch\/|\/share\/(?:p|v)\//i.test(parsed.pathname) || /(?:story_fbid|photo_id)=/i.test(parsed.search);
  } catch { return false; }
}

function facebookFeedUrl(value) {
  try {
    const parsed = new URL(value);
    if (isFacebookPostUrl(value)) return value;
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    if (!cleanPath || /^\/[^/]+$/i.test(cleanPath)) {
      parsed.pathname = `${cleanPath || ''}/posts/`;
      parsed.search = '';
      parsed.hash = '';
    }
    return parsed.toString();
  } catch { return value; }
}

async function openFacebookPostsTab(page) {
  const tabs = page.getByRole('tab', { name: /^Posts$/i }).first();
  if (await tabs.count().catch(() => 0)) {
    await tabs.click({ force: true, timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(8000);
    return true;
  }
  return false;
}

async function dismissFacebookLogin(page) {
  const closeSelectors = [
    '[role="dialog"] [aria-label="Close"]',
    '[role="dialog"] [aria-label*="close" i]',
    '[role="dialog"] [role="button"][data-tooltip-content*="Close" i]'
  ];
  for (const selector of closeSelectors) {
    const button = page.locator(selector).first();
    if (await button.count().catch(() => 0)) {
      await button.click({ force: true, timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(400);
      return true;
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

async function facebook(url, maxPosts = 20, cookies = [], { offset = 0 } = {}) {
  const target = offset + maxPosts;
  return withBrowser(async browser => {
    await addIncomingCookies(browser, cookies, 'facebook');
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, locale: 'en-US' });
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    const networkSamples = [];
    page.on('response', response => {
      const responseUrl = response.url();
      if (/(graphql|ajax|feed|timeline|reel|video)/i.test(responseUrl) && networkSamples.length < 80) {
        networkSamples.push({ url: responseUrl.slice(0, 500), status: response.status(), contentType: response.headers()['content-type'] || '' });
      }
    });
    const targetUrl = facebookFeedUrl(url);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(12000);
    await dismissFacebookLogin(page);
    const postsTabClicked = await openFacebookPostsTab(page);
    if (postsTabClicked) await dismissFacebookLogin(page);
    const posts = new Map();
    let previousSize = 0;
    let stagnantRounds = 0;
    let exhausted = false;
    for (let i = 0; i < 36 && posts.size < target; i++) {
      await dismissFacebookLogin(page);
      const rows = await page.locator('[role="article"]').evaluateAll(els => els.map(el => {
        const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
        const parseCountInPage = value => {
          const match = clean(value).replace(/,/g, '').match(/(\d+(?:\.\d+)?)([KMB])?/i);
          if (!match) return null;
          const factor = { K: 1e3, M: 1e6, B: 1e9 }[String(match[2] || '').toUpperCase()] || 1;
          return Math.round(Number(match[1]) * factor);
        };
        const hrefs = Array.from(el.querySelectorAll('a[href]')).map(anchor => anchor.href).filter(Boolean);
        const postHref = hrefs.find(href => /facebook\.com\//i.test(href) && !/[?&](comment_id|reply_comment_id|comment|reply)=/i.test(href) && /\/(?:[^/]+\/)?posts\/|\/permalink\.php|\/story\.php|\/photo\.php|\/videos?(?:\/|$)|\/reel\/|\/watch\/|\/share\/(?:p|v)\//i.test(href));
        const time = el.querySelector('time[datetime], abbr[data-utime], a[aria-label*="ago" i], a[title]');
        const text = clean(el.innerText || '');
        const publishedAt = time?.getAttribute('datetime') || time?.getAttribute('data-utime') || time?.getAttribute('aria-label') || time?.getAttribute('title') || (text.match(/(?:^|\s)(\d+\s*(?:m|h|d|w|mo|y))\s*[·•]/i)?.[1] || '');
        const labels = Array.from(el.querySelectorAll('[aria-label], [role="button"]')).map(node => clean(node.getAttribute('aria-label') || node.textContent));
        const findMetric = patterns => { for (const label of labels) if (patterns.some(pattern => pattern.test(label))) { const count = parseCountInPage(label); if (count != null) return count; } return null; };
        const visibleReactions = text.match(/(?:all\s+)?reactions?\s*[:\s]+([\d,.]+\s*[KMB]?)/i)?.[1] || '';
        const visibleComments = text.match(/(?:reactions?[^]*?)\b([\d,.]+\s*[KMB]?)\s+[\d,.]+\s*[KMB]?\s+Like\b/i)?.[1] || text.match(/([\d,.]+\s*[KMB]?)\s+(?:comments?|replies?)/i)?.[1] || '';
        const comments = parseCountInPage(visibleComments) ?? findMetric([/comment/i, /reply/i]);
        const reactions = parseCountInPage(visibleReactions) ?? findMetric([/reaction/i, /like/i, /love/i, /haha/i, /wow/i, /sad/i, /angry/i]);
        const author = clean(el.querySelector('h2 a, h3 a, strong a, [data-ad-rendering-role="profile_name"] a')?.textContent || '');
        return { text, url: postHref || '', author, publishedAt, comments, reactions, kind: postHref ? 'facebook_post' : 'unknown', isComment: false };
      }));
      rows.filter(row => row.text && row.url && isFacebookPostUrl(row.url)).forEach(row => {
        const key = row.url.split('#')[0];
        posts.set(key, normalizeFacebookPost({ kind: 'facebook_post', isComment: false, text: row.text, url: key, author: row.author, publishedAt: row.publishedAt, comments: row.comments, reactions: row.reactions }));
      });
      if (posts.size === previousSize) stagnantRounds += 1; else stagnantRounds = 0;
      previousSize = posts.size;
      if (stagnantRounds >= 6) { exhausted = true; break; }
      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(1800);
      await dismissFacebookLogin(page);
    }
    let mobileFallbackUsed = false;
    if (!posts.size && !/^m\./i.test(new URL(page.url()).hostname)) {
      const mobileUrl = new URL(targetUrl);
      mobileUrl.hostname = 'm.facebook.com';
      mobileFallbackUsed = true;
      await page.goto(mobileUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(7000);
      await dismissFacebookLogin(page);
      for (let i = 0; i < 12 && posts.size < target; i++) {
        const mobileRows = await page.locator('a[href*="/posts/"], a[href*="/reel/"], a[href*="/videos/"], a[href*="/permalink.php"], a[href*="/story.php"], a[href*="/photo.php"]').evaluateAll(anchors => anchors.map(anchor => {
          let node = anchor;
          let text = '';
          for (let depth = 0; depth < 10 && node; depth++, node = node.parentElement) {
            const candidate = String(node.innerText || '').replace(/\s+/g, ' ').trim();
            if (candidate.length >= 40 && candidate.length <= 6000) { text = candidate; break; }
          }
          return { url: anchor.href, text };
        }));
        for (const row of mobileRows) {
          if (!row.text || !row.url || !isFacebookPostUrl(row.url)) continue;
          const key = row.url.split('#')[0];
          const reactionMatch = row.text.match(/(?:all\s+)?reactions?\s*[:\s]+([\d,.]+\s*[KMB]?)/i)?.[1] || '';
          const commentMatch = row.text.match(/([\d,.]+\s*[KMB]?)\s+(?:comments?|replies?)/i)?.[1] || '';
          posts.set(key, normalizeFacebookPost({ kind: 'facebook_post', isComment: false, text: row.text, url: key, comments: parseCount(commentMatch), reactions: parseCount(reactionMatch) }));
          if (posts.size >= target) break;
        }
        await page.mouse.wheel(0, 2200).catch(() => {});
        await page.waitForTimeout(1800);
      }
      if (posts.size) exhausted = false;
    }
    const contextCookies = await browser.cookies('https://www.facebook.com/').catch(() => []);
    const articleCount = await page.locator('[role="article"]').count().catch(() => 0);
    const loginFormCount = await page.locator('input[name="email"], input[name="password"], input[type="password"]').count().catch(() => 0);
    const bodyPreview = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 500);
    const articleSamples = await page.locator('[role="article"]').evaluateAll(els => els.slice(0, 5).map(el => ({ text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300), hrefs: Array.from(el.querySelectorAll('a[href]')).map(a => a.href).filter(Boolean).slice(0, 20) }))).catch(() => []);
    const globalPostLinks = await page.locator('a[href*="/posts/"], a[href*="/reel/"], a[href*="/videos/"], a[href*="/permalink.php"], a[href*="/story.php"], a[href*="/photo.php"]').evaluateAll(els => els.map(a => a.href).filter(Boolean).slice(0, 30)).catch(() => []);
    const collected = posts.size;
    return { source: url, targetUrl, postsTabClicked, posts: [...posts.values()].slice(offset, offset + maxPosts), pagination: buildPagination({ offset, limit: maxPosts, collected, exhausted }), sessionCookieCount: cookies.length, persistentCookieNames: contextCookies.map(cookie => cookie.name).filter(name => /c_user|xs|checkpoint|fr/i.test(name)), articleCount, loginFormCount, bodyPreview, articleSamples, globalPostLinks, networkSamples, mobileFallbackUsed, finalUrl: page.url(), title: await page.title(), extractionRule: mobileFallbackUsed ? 'posts-tab-with-metrics-mobile-fallback' : 'posts-tab-with-metrics-and-dialog-dismissal' };
  }, 'facebook');
}

function apifyMetric(item, keys) {
  for (const key of keys) {
    const value = Number(item?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function mapApifyPost(item) {
  const likes = apifyMetric(item, ['likes', 'reactionLikeCount', 'likeCount']);
  const reactions = apifyMetric(item, ['reactions', 'totalReactions', 'reactionCount']) || likes;
  const comments = apifyMetric(item, ['comments', 'commentsCount', 'commentCount']);
  const shares = apifyMetric(item, ['shares', 'sharesCount', 'shareCount']);
  const url = item?.url || item?.topLevelUrl || item?.facebookUrl || '';
  return normalizeFacebookPost({
    kind: 'facebook_post',
    isComment: false,
    text: String(item?.text || item?.caption || ''),
    url,
    author: item?.pageName || item?.user?.name || '',
    publishedAt: item?.time || (item?.timestamp ? new Date(Number(item.timestamp) * 1000).toISOString() : ''),
    comments,
    reactions,
    likes,
    shares
  });
}

async function apifyFacebook(url, maxPosts = 20, options = {}) {
  const token = process.env.APIFY_API_TOKEN || '';
  if (!token) throw new Error('APIFY_API_TOKEN is not configured on the VPS.');
  const offset = Number.isFinite(options.offset) ? options.offset : 0;
  const target = offset + maxPosts;
  const input = {
    startUrls: [{ url }],
    resultsLimit: target,
    ...(options.onlyPostsNewerThan ? { onlyPostsNewerThan: String(options.onlyPostsNewerThan) } : {}),
    ...(options.onlyPostsOlderThan ? { onlyPostsOlderThan: String(options.onlyPostsOlderThan) } : {})
  };
  const endpoint = `https://api.apify.com/v2/acts/apify~facebook-posts-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(input) });
  const bodyText = await response.text();
  if (!response.ok) throw new Error(`Apify request failed (${response.status}): ${bodyText.slice(0, 200)}`);
  let items;
  try { items = JSON.parse(bodyText); } catch { throw new Error('Apify returned invalid JSON.'); }
  const collected = (Array.isArray(items) ? items : []).map(mapApifyPost).filter(item => item.url || item.text);
  if (String(options.sort || 'engagement').toLowerCase() === 'engagement') collected.sort((a, b) => (b.reactions + b.comments + b.shares) - (a.reactions + a.comments + a.shares));
  return { source: url, posts: collected.slice(offset, offset + maxPosts), pagination: buildPagination({ offset, limit: maxPosts, collected: collected.length, exhausted: collected.length < target }), provider: 'apify', actor: 'apify/facebook-posts-scraper', apifyCount: collected.length, filters: { onlyPostsNewerThan: options.onlyPostsNewerThan || null, onlyPostsOlderThan: options.onlyPostsOlderThan || null, sort: options.sort || 'engagement' } };
}

async function enrichPinterestPin(page, pin) {
  try {
    await page.goto(pin.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);
    const meta = await page.evaluate(() => {
      const get = name => document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content || '';
      let jsonLd = null;
      for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { const value = JSON.parse(node.textContent || 'null'); if (value && typeof value === 'object') { jsonLd = value; break; } } catch {}
      }
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const stat = pattern => {
        const labelled = Array.from(document.querySelectorAll('[aria-label]')).map(node => clean(node.getAttribute('aria-label')));
        const body = clean(document.body?.innerText || '');
        const haystack = [...labelled, body];
        for (const candidate of haystack) {
          const match = candidate.match(pattern);
          if (match) return match[1];
        }
        return '';
      };
      return {
        title: get('og:title') || document.title,
        description: get('og:description') || get('description'),
        image: get('og:image'),
        canonical: document.querySelector('link[rel="canonical"]')?.href || location.href,
        publishedAt: jsonLd?.datePublished || jsonLd?.uploadDate || '',
        jsonLdName: jsonLd?.name || '',
        jsonLdDescription: jsonLd?.description || '',
        jsonLdImage: typeof jsonLd?.image === 'string' ? jsonLd.image : (jsonLd?.image?.url || ''),
        commentCount: jsonLd?.commentCount ?? jsonLd?.interactionStatistic?.find?.(entry => /comment/i.test(entry?.interactionType || ''))?.userInteractionCount ?? null,
        savesRaw: stat(/([\d,.]+\s*[KMB]?)\s*(?:saves?|pin saves|repins?)/i),
        sharesRaw: stat(/([\d,.]+\s*[KMB]?)\s*(?:shares?|shared)/i)
      };
    });
    pin.url = meta.canonical || pin.url;
    pin.title = pin.title || meta.title || meta.jsonLdName || '';
    pin.description = pin.description || meta.description || meta.jsonLdDescription || '';
    pin.imageUrl = pin.imageUrl || meta.image || meta.jsonLdImage || '';
    pin.publishedAt = pin.publishedAt || meta.publishedAt || null;
    if (meta.commentCount != null) pin.comments = Number(meta.commentCount) || pin.comments;
    const saves = parseCount(meta.savesRaw);
    const shares = parseCount(meta.sharesRaw);
    if (saves != null) pin.saves = saves;
    if (shares != null) pin.shares = shares;
  } catch {}
  return pin;
}

async function pinterest(url, maxItems = 50, cookies = [], { offset = 0 } = {}) {
  const target = offset + maxItems;
  const enrichLimit = clampLimit(process.env.PINTEREST_ENRICH_LIMIT, { min: 0, max: 10, fallback: 5 });
  return withBrowser(async browser => {
    await addIncomingCookies(browser, cookies, 'pinterest');
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, locale: 'en-US' });
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    const pins = new Map();
    let previousSize = 0;
    let stagnantRounds = 0;
    let exhausted = false;
    for (let i = 0; i < 14 && pins.size < target; i++) {
      const rows = await page.locator('a[href*="/pin/"], a[href*="/pin\\/"]').evaluateAll(els => els.map(a => {
        const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
        let node = a;
        let contextText = '';
        for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
          const candidate = clean(node.innerText || '');
          if (candidate.length >= 20 && candidate.length <= 3000) { contextText = candidate; break; }
        }
        const metric = pattern => { const match = contextText.match(pattern); return match ? match[1] : ''; };
        return {
          url: a.href,
          title: a.getAttribute('aria-label') || clean(a.innerText) || a.querySelector('img')?.alt || '',
          imageUrl: a.querySelector('img')?.src || '',
          description: a.querySelector('img')?.alt || '',
          savesRaw: metric(/([\d,.]+\s*[KMB]?)\s*(?:saves?|repins?)/i),
          commentsRaw: metric(/([\d,.]+\s*[KMB]?)\s*comments?/i),
          sharesRaw: metric(/([\d,.]+\s*[KMB]?)\s*shares?/i)
        };
      }));
      rows.forEach(row => {
        if (!row.url) return;
        const saves = parseCount(row.savesRaw);
        const comments = parseCount(row.commentsRaw);
        const shares = parseCount(row.sharesRaw);
        pins.set(row.url, normalizePinterestPin({ url: row.url, title: row.title, description: row.description, imageUrl: row.imageUrl, saves, comments, shares }));
      });
      if (pins.size === previousSize) stagnantRounds += 1; else stagnantRounds = 0;
      previousSize = pins.size;
      if (stagnantRounds >= 4) { exhausted = true; break; }
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
      pins.set(meta.canonical || page.url(), normalizePinterestPin({ url: meta.canonical || page.url(), title: meta.title || data.name || '', description: meta.description || data.description || '', imageUrl: meta.image || data.image?.url || data.image || '', publishedAt: data.datePublished || data.uploadDate || null }));
      exhausted = true;
    }
    const ordered = [...pins.values()];
    if (ordered.length && enrichLimit > 0) {
      const top = [...ordered].sort((a, b) => b.viralScore - a.viralScore).slice(0, enrichLimit);
      for (const pin of top) await enrichPinterestPin(page, pin);
      const deduped = new Map();
      for (const pin of ordered) deduped.set(pin.url, normalizePinterestPin(pin));
      ordered.splice(0, ordered.length, ...deduped.values());
    }
    const collected = ordered.length;
    return { source: url, finalUrl: page.url(), title: await page.title(), sessionCookieCount: cookies.length, pins: ordered.slice(offset, offset + maxItems), pagination: buildPagination({ offset, limit: maxItems, collected, exhausted }) };
  }, 'pinterest');
}

app.get('/health', rateLimit, (_req, res) => res.json({ ok: true, service: 'orbitpress-scraper-api', activeJobs, persistentSessions: usePersistentSessions }));
app.get('/api/session/status', rateLimit, auth, async (_req, res) => {
  try { res.json({ ok: true, sessions: { facebook: await sessionStatus('facebook'), pinterest: await sessionStatus('pinterest') } }); }
  catch (e) { serverError(res, 500, 'Session status failed', e, 'Session status'); }
});
app.get('/api/session/:platform/check', rateLimit, auth, async (req, res) => {
  if (!sessionPlatforms.has(req.params.platform)) return res.status(400).json({ error: 'Platform must be facebook or pinterest.' });
  if (!guardJob(res)) return;
  try { res.json({ ok: true, ...(await withTimeout(checkLoggedIn(req.params.platform), jobTimeoutMs, 'Session check')) }); }
  catch (e) { serverError(res, 502, 'Session check failed', e, 'Session check'); } finally { activeJobs--; }
});
app.post('/api/session/:platform/import', rateLimit, auth, async (req, res) => {
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
  } catch (e) { serverError(res, 502, 'Session import failed', e, 'Session import'); }
});

app.post('/api/facebook/scrape', rateLimit, auth, async (req, res) => {
  const { url, maxPosts = 20, cookies = [], provider = 'playwright', onlyPostsNewerThan, onlyPostsOlderThan, sort = 'engagement', cursor, offset: rawOffset } = req.body || {};
  if (!validHttpUrl(url) || !/facebook\.com$/i.test(new URL(url).hostname.replace(/^www\./, '')) && !/\.facebook\.com$/i.test(new URL(url).hostname)) return res.status(400).json({ error: 'Use an HTTPS Facebook Page or public Post URL.' });
  if (!guardJob(res)) return;
  try {
    const limit = clampLimit(maxPosts, { min: 1, max: 100, fallback: 20 });
    const { offset } = resolveOffset({ cursor, offset: rawOffset });
    if (String(provider).toLowerCase() === 'apify') {
      return res.json({ ok: true, ...(await withTimeout(apifyFacebook(url, limit, { onlyPostsNewerThan, onlyPostsOlderThan, sort, offset }), jobTimeoutMs, 'Apify Facebook scrape')) });
    }
    const local = await withTimeout(facebook(url, limit, cookies, { offset }), jobTimeoutMs, 'Facebook scrape');
    return res.json({ ok: true, ...local, provider: 'playwright', warning: local.posts.length ? undefined : 'Facebook returned no accessible public article elements. The endpoint uses only your VPS Playwright browser and does not use an external scraper.' });
  } catch (e) { serverError(res, 502, 'Facebook extraction failed', e, 'Facebook scrape'); } finally { activeJobs--; }
});
app.post('/api/pinterest/scrape', rateLimit, auth, async (req, res) => {
  const { url, maxItems = 50, cookies = [], cursor, offset: rawOffset } = req.body || {};
  if (!validHttpUrl(url) || !/pinterest\.com$/i.test(new URL(url).hostname.replace(/^www\./, '')) && !/\.pinterest\.com$/i.test(new URL(url).hostname)) return res.status(400).json({ error: 'Use an HTTPS Pinterest Board, Profile, or Pin URL.' });
  if (!guardJob(res)) return;
  try {
    const limit = clampLimit(maxItems, { min: 1, max: 200, fallback: 50 });
    const { offset } = resolveOffset({ cursor, offset: rawOffset });
    res.json({ ok: true, ...(await withTimeout(pinterest(url, limit, cookies, { offset }), jobTimeoutMs, 'Pinterest scrape')) });
  } catch (e) { serverError(res, 502, 'Pinterest extraction failed', e, 'Pinterest scrape'); } finally { activeJobs--; }
});
app.listen(port, '0.0.0.0', () => console.log(`OrbitPress Scraper API listening on ${port}`));
