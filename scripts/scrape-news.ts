/**
 * Scrape latest ZSE stock news from Croatian financial RSS feeds + Google News.
 * Accumulates articles over time — only purges those older than MAX_AGE_DAYS.
 *
 * Run:  npx tsx scripts/scrape-news.ts
 */

import { readFileSync } from 'fs';
try {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
} catch { /* CI: env vars from GitHub Secrets */ }

import * as cheerio from 'cheerio';
import { getSupabaseAdmin } from '../lib/supabase';

const MAX_AGE_DAYS = 90;

// Direct Croatian RSS feeds — reliable from cloud/CI
const DIRECT_FEEDS = [
  { source: 'Poslovni dnevnik', url: 'https://www.poslovni.hr/feed' },
  { source: 'Večernji list',    url: 'https://www.vecernji.hr/feeds/section/biznis' },
  { source: 'hrportfolio',      url: 'https://hrportfolio.hr/feed/rss/vijesti.php' },
  { source: 'hrportfolio',      url: 'https://hrportfolio.hr/feed/rss/analize.php' },
];

// Croatian news domains — used to filter Google News results
const CROATIAN_DOMAINS = new Set([
  'index.hr', 'jutarnji.hr', 'vecernji.hr', 'poslovni.hr', '24sata.hr',
  'slobodnadalmacija.hr', 'dnevnik.hr', 'rtl.hr', 'hrt.hr', 'net.hr',
  'tportal.hr', 'telegram.hr', 'direktno.hr', 'novilist.hr',
  'glas-slavonije.hr', 'lider.media', 'bloombergadria.com',
  'seebiz.eu', 'lupiga.com', 'global.hr', 'nacional.hr', 'express.hr',
  'hrportfolio.hr', 'mojedionice.com', 'zse.hr',
]);

function isCroatianDomain(urlStr: string): boolean {
  try {
    const hostname = new URL(urlStr).hostname.replace(/^www\./, '');
    return CROATIAN_DOMAINS.has(hostname) ||
      [...CROATIAN_DOMAINS].some(d => hostname.endsWith('.' + d));
  } catch { return false; }
}

function cleanName(name: string): string {
  return name
    .replace(/\s+(d\.d\.|d\.o\.o\.|j\.d\.d\.|j\.t\.d\.?|d\.d)$/gi, '')
    .trim();
}

/**
 * For compound names like "Končar - Elektroindustrija", also match "Končar".
 */
function nameKeywords(cleanedName: string): string[] {
  const name = cleanedName.toLowerCase();
  const keywords = [name];
  const firstPart = name.split(/\s*[-–—]\s*/)[0].trim();
  if (firstPart !== name && firstPart.length >= 3) {
    keywords.push(firstPart);
  }
  return keywords;
}

interface FeedArticle {
  title: string;
  url: string;
  source: string;
  published_at: string;
}

function decodeEntities(str: string): string {
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractLink($el: any): string {
  const linkText = $el.find('link').first().text().trim();
  if (linkText.startsWith('http')) return linkText;
  const linkHref = $el.find('link[href]').first().attr('href') ?? '';
  if (linkHref.startsWith('http')) return linkHref;
  return $el.find('guid').first().text().trim();
}

async function fetchDirectFeed(source: string, feedUrl: string, cutoff: Date): Promise<FeedArticle[]> {
  try {
    const resp = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FundamentaBot/1.0)',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.log(`  [${source}] HTTP ${resp.status} — preskacemo`);
      return [];
    }
    const xml = await resp.text();
    const $ = cheerio.load(xml, { xml: true });
    const articles: FeedArticle[] = [];

    $('item').each((_i, el) => {
      const $el = $(el);
      const title = decodeEntities($el.find('title').first().text().trim());
      const url = extractLink($el);
      const pubDateStr = $el.find('pubDate').first().text().trim();

      if (!title || !url) return;

      const published = pubDateStr ? new Date(pubDateStr) : new Date();
      if (isNaN(published.getTime()) || published < cutoff) return;

      articles.push({ title, url, source, published_at: published.toISOString() });
    });

    console.log(`  [${source}] ${articles.length} clanaka`);
    return articles;
  } catch (e: unknown) {
    console.log(`  [${source}] greska: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Fetch Google News RSS for a specific stock.
 * Uses <source url> attribute for Croatian domain filtering — no redirect resolution needed.
 * Silent fail if Google News is blocked from this IP.
 */
async function fetchGoogleNewsForStock(
  ticker: string,
  cleanedName: string,
  cutoff: Date,
): Promise<FeedArticle[]> {
  const queries = [
    `"${cleanedName}"`,
    `${cleanedName} dionice`,
    `${ticker} ZSE`,
  ];

  const seen = new Set<string>();
  const articles: FeedArticle[] = [];

  for (const q of queries) {
    const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=hr&gl=HR&ceid=HR:hr`;
    try {
      const resp = await fetch(feedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FundamentaBot/1.0)' },
        signal: AbortSignal.timeout(6_000),
      });
      if (!resp.ok) continue;

      const xml = await resp.text();
      const $ = cheerio.load(xml, { xml: true });

      $('item').each((_i, el) => {
        const $el = $(el);
        const title = decodeEntities($el.find('title').first().text().trim());
        const url = extractLink($el);
        const pubDateStr = $el.find('pubDate').first().text().trim();
        // <source url="https://www.poslovni.hr">Poslovni dnevnik</source>
        const sourceUrl = $el.find('source').attr('url') ?? '';

        if (!title || !url || seen.has(url)) return;

        // Filter to Croatian sources only
        if (sourceUrl && !isCroatianDomain(sourceUrl)) return;

        const published = pubDateStr ? new Date(pubDateStr) : new Date();
        if (isNaN(published.getTime()) || published < cutoff) return;

        seen.add(url);
        const sourceName = $el.find('source').first().text().trim() || 'Google News';
        articles.push({ title, url, source: sourceName, published_at: published.toISOString() });
      });
    } catch { /* blocked or timeout — skip silently */ }
  }

  return articles;
}

function matchesCompany(article: FeedArticle, ticker: string, cleanedName: string): boolean {
  const title = article.title.toLowerCase();
  const esc   = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const keyword of nameKeywords(cleanedName)) {
    // Long keywords (>= 5 chars): substring match is safe
    if (keyword.length >= 5 && title.includes(keyword)) return true;
    // Short keywords: require whole-word match to avoid "aci" inside "reprezentacija"
    if (new RegExp(`\\b${esc(keyword)}\\b`).test(title)) return true;
  }

  // Also match ticker as standalone word
  if (new RegExp(`\\b${esc(ticker.toLowerCase())}\\b`).test(title)) return true;

  return false;
}

async function main() {
  const sb = getSupabaseAdmin();

  const { data: allStocks, error } = await sb
    .from('stocks')
    .select('ticker,name')
    .order('ticker');

  if (error || !allStocks?.length) {
    console.error('Greska pri dohvatu dionica:', error?.message);
    process.exit(1);
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_AGE_DAYS);

  // Step 1: Purge articles older than MAX_AGE_DAYS
  const { error: purgeErr, count: purgeCount } = await sb
    .from('stock_news')
    .delete({ count: 'exact' })
    .lt('published_at', cutoff.toISOString());
  if (purgeErr) console.error('Purge greska:', purgeErr.message);
  else console.log(`Ocisceno ${purgeCount ?? 0} starih vijesti.\n`);

  // Step 2: Load existing (ticker, url) pairs to avoid re-inserting
  const { data: existingRows } = await sb.from('stock_news').select('ticker,url');
  const existingPairs = new Set((existingRows ?? []).map(r => `${r.ticker}|${r.url}`));
  console.log(`Vec u bazi: ${existingRows?.length ?? 0} vijesti.\n`);

  // Step 3: Fetch direct RSS feeds (all at once)
  console.log('Dohvacanje direktnih RSS feedova...');
  const allDirectArticles: FeedArticle[] = [];
  for (const feed of DIRECT_FEEDS) {
    const articles = await fetchDirectFeed(feed.source, feed.url, cutoff);
    allDirectArticles.push(...articles);
  }
  // Deduplicate by URL (vijesti + analize feeds can overlap)
  const seenDirect = new Set<string>();
  const uniqueDirectArticles = allDirectArticles.filter(a => {
    if (seenDirect.has(a.url)) return false;
    seenDirect.add(a.url);
    return true;
  });
  console.log(`Direktni RSS: ${uniqueDirectArticles.length} jedinstvenih clanaka.\n`);

  let totalInserted = 0;

  // Step 4: Per-stock: match direct RSS + supplement with Google News
  console.log('Obrada dionica...');
  for (const stock of allStocks as { ticker: string; name: string }[]) {
    const cleaned = cleanName(stock.name);

    // Direct RSS matches for this stock
    const directMatches = uniqueDirectArticles
      .filter(a => matchesCompany(a, stock.ticker, cleaned))
      .filter(a => !existingPairs.has(`${stock.ticker}|${a.url}`));

    // Google News supplement — targeted search per stock
    const gnArticles = await fetchGoogleNewsForStock(stock.ticker, cleaned, cutoff);
    const googleMatches = gnArticles
      .filter(a => !existingPairs.has(`${stock.ticker}|${a.url}`));

    // Merge, dedup by URL within this stock
    const seenThisStock = new Set<string>();
    const allMatches: FeedArticle[] = [];
    for (const a of [...directMatches, ...googleMatches]) {
      if (!seenThisStock.has(a.url)) {
        seenThisStock.add(a.url);
        allMatches.push(a);
      }
    }

    if (!allMatches.length) continue;

    const rows = allMatches.map(a => ({ ...a, ticker: stock.ticker }));
    const { error: insErr } = await sb.from('stock_news').insert(rows);

    if (insErr) {
      console.error(`${stock.ticker}: insert greska: ${insErr.message}`);
    } else {
      console.log(`${stock.ticker} (${cleaned}): +${rows.length} novih vijesti`);
      rows.forEach(r => {
        console.log(`  [${new Date(r.published_at).toLocaleDateString('hr-HR')}] ${r.title.slice(0, 90)} — ${r.source}`);
        existingPairs.add(`${stock.ticker}|${r.url}`);
      });
      totalInserted += rows.length;
    }
  }

  console.log(`\nGotovo! +${totalInserted} novih vijesti.`);
}

main().catch(err => { console.error(err); process.exit(1); });
