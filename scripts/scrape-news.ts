/**
 * Scrape latest ZSE stock news from Croatian financial RSS feeds + Bing News per ticker.
 * Matches company names against both article title AND description.
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

const DIRECT_FEEDS = [
  { source: 'Poslovni dnevnik', url: 'https://www.poslovni.hr/feed' },
  { source: 'Poslovni dnevnik', url: 'https://www.poslovni.hr/trzista/feed' },
  { source: 'Večernji list',    url: 'https://www.vecernji.hr/feeds/section/biznis' },
  { source: 'Jutarnji list',    url: 'https://www.jutarnji.hr/novac/feed' },
  { source: 'hrportfolio',      url: 'https://hrportfolio.hr/feed/rss/vijesti.php' },
  { source: 'hrportfolio',      url: 'https://hrportfolio.hr/feed/rss/analize.php' },
  { source: 'hrportfolio',      url: 'https://hrportfolio.hr/feed/rss/izdvojeno.php' },
];

// Croatian news domains — used to filter Bing News results
const CROATIAN_DOMAINS = new Set([
  'index.hr', 'jutarnji.hr', 'vecernji.hr', 'poslovni.hr', '24sata.hr',
  'slobodnadalmacija.hr', 'dnevnik.hr', 'rtl.hr', 'hrt.hr', 'net.hr',
  'tportal.hr', 'telegram.hr', 'direktno.hr', 'novilist.hr',
  'glas-slavonije.hr', 'lider.media', 'lidermedia.hr', 'bloombergadria.com',
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
  description?: string; // for matching only, not stored in DB
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

function stripHtml(str: string): string {
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractLink($el: any): string {
  const linkText = $el.find('link').first().text().trim();
  if (linkText.startsWith('http')) return linkText;
  const linkHref = $el.find('link[href]').first().attr('href') ?? '';
  if (linkHref.startsWith('http')) return linkHref;
  return $el.find('guid').first().text().trim();
}

async function fetchFeed(source: string, feedUrl: string, cutoff: Date): Promise<FeedArticle[]> {
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
      const description = stripHtml(decodeEntities($el.find('description').first().text()));

      if (!title || !url) return;

      const published = pubDateStr ? new Date(pubDateStr) : new Date();
      if (isNaN(published.getTime()) || published < cutoff) return;

      articles.push({ title, url, source, published_at: published.toISOString(), description });
    });

    console.log(`  [${source}] ${articles.length} clanaka`);
    return articles;
  } catch (e: unknown) {
    console.log(`  [${source}] greska: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Fetch Bing News RSS for a specific stock.
 * Bing encodes the real URL inside the redirect link — extract without HTTP round-trip.
 * Less likely to be blocked from GitHub Actions (both on Azure infrastructure).
 */
async function fetchBingNewsForStock(
  ticker: string,
  cleanedName: string,
  cutoff: Date,
): Promise<FeedArticle[]> {
  const query = `${cleanedName} ZSE`;
  const feedUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setLang=hr&cc=HR`;

  try {
    const resp = await fetch(feedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FundamentaBot/1.0)' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return [];

    const xml = await resp.text();
    const $ = cheerio.load(xml, { xml: true });
    const articles: FeedArticle[] = [];

    $('item').each((_i, el) => {
      const $el = $(el);
      const title = decodeEntities($el.find('title').first().text().trim());
      const rawLink = extractLink($el);
      const pubDateStr = $el.find('pubDate').first().text().trim();
      const description = stripHtml(decodeEntities($el.find('description').first().text()));

      if (!title || !rawLink) return;

      // Extract real URL from Bing redirect: ?url=https%3a%2f%2f...
      let url = rawLink;
      try { url = new URL(rawLink).searchParams.get('url') ?? rawLink; } catch {}

      // Filter to Croatian sources only
      if (!isCroatianDomain(url)) return;

      const published = pubDateStr ? new Date(pubDateStr) : new Date();
      if (isNaN(published.getTime()) || published < cutoff) return;

      const sourceName = $el.find('source').first().text().trim() || 'Bing vijesti';
      articles.push({ title, url, source: sourceName, published_at: published.toISOString(), description });
    });

    if (articles.length > 0) {
      console.log(`  [Bing] ${ticker}: ${articles.length} clanaka`);
    }
    return articles;
  } catch { return []; /* blocked or timeout */ }
}

function matchesCompany(article: FeedArticle, ticker: string, cleanedName: string): boolean {
  const title = article.title.toLowerCase();
  const desc  = (article.description ?? '').toLowerCase();
  const esc   = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const keyword of nameKeywords(cleanedName)) {
    // Title match (long keywords: substring; short: word-boundary)
    if (keyword.length >= 5 && title.includes(keyword)) return true;
    if (new RegExp(`\\b${esc(keyword)}\\b`).test(title)) return true;
    // Description match (word-boundary only to avoid false positives in longer text)
    if (new RegExp(`\\b${esc(keyword)}\\b`).test(desc)) return true;
  }

  // Ticker as standalone word in title or description
  const tickerPattern = new RegExp(`\\b${esc(ticker.toLowerCase())}\\b`);
  if (tickerPattern.test(title) || tickerPattern.test(desc)) return true;

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

  // Step 3: Fetch RSS feeds
  console.log('Dohvacanje RSS feedova...');
  const allArticles: FeedArticle[] = [];
  for (const feed of DIRECT_FEEDS) {
    const articles = await fetchFeed(feed.source, feed.url, cutoff);
    allArticles.push(...articles);
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const uniqueArticles = allArticles.filter(a => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
  console.log(`\nUkupno dohvaceno: ${uniqueArticles.length} jedinstvenih clanaka.\n`);

  if (!uniqueArticles.length) {
    console.log('UPOZORENJE: Nema clanaka — svi RSS feedovi su nedostupni ili prazni.');
    process.exit(1);
  }

  let totalMatched = 0;
  let totalSkipped = 0;
  let totalInserted = 0;

  // Step 4: Per-stock: match direct RSS + Bing News supplement
  console.log('Obrada dionica + Bing News...');
  for (const stock of allStocks as { ticker: string; name: string }[]) {
    const cleaned = cleanName(stock.name);

    // Direct RSS matches
    const directMatches = uniqueArticles.filter(a => matchesCompany(a, stock.ticker, cleaned));

    // Bing News — targeted per-stock (1 query, real URL from redirect)
    const bingArticles = await fetchBingNewsForStock(stock.ticker, cleaned, cutoff);
    const bingMatches = bingArticles.filter(a => matchesCompany(a, stock.ticker, cleaned));

    // Merge, dedup by URL within this stock
    const seenUrls = new Set<string>();
    const allMatches: FeedArticle[] = [];
    for (const a of [...directMatches, ...bingMatches]) {
      if (!seenUrls.has(a.url)) { seenUrls.add(a.url); allMatches.push(a); }
    }

    const newMatches = allMatches.filter(a => !existingPairs.has(`${stock.ticker}|${a.url}`));
    const alreadyInDb = allMatches.length - newMatches.length;

    totalMatched += allMatches.length;
    totalSkipped += alreadyInDb;

    if (!newMatches.length) continue;

    // Strip description before inserting (not a DB column)
    const rows = newMatches.map(({ description: _d, ...a }) => ({ ...a, ticker: stock.ticker }));
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

  console.log(`
========================================
STATISTIKA:
  RSS feedovi: ${uniqueArticles.length} clanaka dohvaceno
  Matchova po dionicama: ${totalMatched}
  Vec u bazi (preskoceno): ${totalSkipped}
  Novo insertano: ${totalInserted}
========================================`);

  if (uniqueArticles.length > 0 && totalMatched === 0) {
    console.log('UPOZORENJE: Feedovi rade, ali nijedan clanak nije matchao nijednu dionicu!');
    console.log('Provjeri matchesCompany() i RSS feed sadrzaj.');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
