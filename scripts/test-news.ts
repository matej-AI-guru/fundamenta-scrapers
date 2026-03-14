/**
 * Test script: diagnose news scraping issues without writing to DB.
 * Run: npx tsx scripts/test-news.ts
 */

import { readFileSync } from 'fs';
try {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
} catch { /* CI */ }

import * as cheerio from 'cheerio';
import { getSupabaseAdmin } from '../lib/supabase';

const RSS_FEEDS = [
  { source: 'Poslovni dnevnik', url: 'https://www.poslovni.hr/rss' },
  { source: 'Lider',            url: 'https://lidermedia.hr/rss' },
  { source: 'Bloomberg Adria',  url: 'https://www.bloombergadria.com/rss' },
  { source: 'Tportal Biznis',   url: 'https://tportal.hr/biznis/rss' },
];

// Stocks to spotlight in matching test
const SPOTLIGHT = ['ACI', 'KOEI', 'ADPL', 'PODR', 'KRAS', 'ERNT', 'HT', 'ZABA', 'INA'];

function cleanName(name: string): string {
  return name
    .replace(/\s+(d\.d\.|d\.o\.o\.|j\.d\.d\.|j\.t\.d\.?|d\.d)$/gi, '')
    .trim();
}

function extractLink($el: cheerio.Cheerio<cheerio.AnyNode>, $: cheerio.CheerioAPI): string {
  const linkText = $el.find('link').first().text().trim();
  if (linkText.startsWith('http')) return linkText;
  const linkHref = $el.find('link[href]').first().attr('href') ?? '';
  if (linkHref.startsWith('http')) return linkHref;
  return $el.find('guid').first().text().trim();
}

interface FeedArticle { title: string; url: string; source: string; published_at: string; }

async function fetchFeed(source: string, feedUrl: string): Promise<FeedArticle[]> {
  try {
    const resp = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FundamentaBot/1.0)',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.error(`  ✗ [${source}] HTTP ${resp.status}`);
      return [];
    }
    const xml = await resp.text();
    const $ = cheerio.load(xml, { xml: true });
    const articles: FeedArticle[] = [];

    $('item').each((_i, el) => {
      const $el = $(el);
      const title = $el.find('title').first().text().trim();
      const url = extractLink($el, $);
      const pubDateStr = $el.find('pubDate').first().text().trim();
      if (!title || !url) return;
      const published = pubDateStr ? new Date(pubDateStr) : new Date();
      articles.push({ title, url, source, published_at: published.toISOString() });
    });

    const withDate = articles.filter(a => a.published_at !== new Date().toISOString().slice(0, 10));
    console.log(`  ✓ [${source}] ${articles.length} articles (${articles.filter(a => {
      const d = new Date(a.published_at); return !isNaN(d.getTime()) && d > new Date(Date.now() - 90*24*60*60*1000);
    }).length} within 90 days)`);

    // Print first 3 titles to verify content
    articles.slice(0, 3).forEach(a =>
      console.log(`    "${a.title.slice(0, 80)}"`)
    );

    return articles;
  } catch (e: unknown) {
    console.error(`  ✗ [${source}] ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

function matchesCompany(article: FeedArticle, ticker: string, cleanedName: string): { match: boolean; reason: string } {
  const title = article.title.toLowerCase();
  const name  = cleanedName.toLowerCase();
  const esc   = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (name.length >= 5 && title.includes(name)) return { match: true, reason: `substring "${name}"` };
  if (new RegExp(`\\b${esc(name)}\\b`).test(title)) return { match: true, reason: `word-boundary name "${name}"` };
  if (new RegExp(`\\b${esc(ticker.toLowerCase())}\\b`).test(title)) return { match: true, reason: `ticker "${ticker}"` };
  return { match: false, reason: '' };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  TEST: Fetching RSS feeds');
  console.log('═══════════════════════════════════════════════════════');

  const allArticles: FeedArticle[] = [];
  for (const feed of RSS_FEEDS) {
    const articles = await fetchFeed(feed.source, feed.url);
    allArticles.push(...articles);
  }

  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const fresh = allArticles.filter(a => new Date(a.published_at) > cutoff);
  console.log(`\nTotal: ${allArticles.length} articles, ${fresh.length} within 90 days\n`);

  // ─── TEST: DB read ────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════');
  console.log('  TEST: DB connection + stocks table');
  console.log('═══════════════════════════════════════════════════════');
  const sb = getSupabaseAdmin();
  const { data: allStocks, error } = await sb.from('stocks').select('ticker,name').order('ticker');
  if (error) { console.error('  ✗ DB error:', error.message); process.exit(1); }
  console.log(`  ✓ ${allStocks!.length} stocks loaded from DB`);

  // ─── TEST: DB current news_count per spotlight ticker ────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  TEST: Current stock_news in DB for spotlight tickers');
  console.log('═══════════════════════════════════════════════════════');
  for (const ticker of SPOTLIGHT) {
    const { data, error: e } = await sb.from('stock_news').select('title,source,published_at').eq('ticker', ticker).order('published_at', { ascending: false }).limit(3);
    if (e) { console.log(`  ✗ ${ticker}: ${e.message}`); continue; }
    if (!data?.length) { console.log(`  [${ticker}] 0 articles in DB`); continue; }
    console.log(`  [${ticker}] ${data.length}+ articles in DB:`);
    data.forEach(r => console.log(`    "${r.title?.slice(0, 70)}" — ${r.source} (${r.published_at?.slice(0,10)})`));
  }

  // ─── TEST: Matching logic for spotlight tickers ───────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  TEST: Matching against RSS articles (dry run)');
  console.log('═══════════════════════════════════════════════════════');

  const spotlightStocks = (allStocks as { ticker: string; name: string }[])
    .filter(s => SPOTLIGHT.includes(s.ticker));

  for (const stock of spotlightStocks) {
    const cleaned = cleanName(stock.name);
    const matches = fresh.map(a => ({ ...matchesCompany(a, stock.ticker, cleaned), article: a }))
                         .filter(r => r.match);
    if (matches.length) {
      console.log(`\n  ✓ ${stock.ticker} (cleaned: "${cleaned}") — ${matches.length} match(es):`);
      matches.slice(0, 5).forEach(m =>
        console.log(`    [${m.reason}] "${m.article.title.slice(0, 80)}" — ${m.article.source}`)
      );
    } else {
      console.log(`\n  ✗ ${stock.ticker} (cleaned: "${cleaned}") — NO MATCHES`);
      console.log(`    Matching against: name="${cleaned.toLowerCase()}", ticker="${stock.ticker.toLowerCase()}"`);
    }
  }

  // ─── TEST: Delete test (non-destructive: delete then re-insert current data)
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  TEST: Delete operation (ACI — verify delete works)');
  console.log('═══════════════════════════════════════════════════════');
  const { data: before } = await sb.from('stock_news').select('id').eq('ticker', 'ACI');
  console.log(`  Before delete: ${before?.length ?? 0} ACI rows`);
  const { error: delErr, count } = await sb.from('stock_news').delete({ count: 'exact' }).eq('ticker', 'ACI');
  if (delErr) {
    console.error(`  ✗ Delete FAILED: ${delErr.message}`);
  } else {
    console.log(`  ✓ Delete succeeded, ${count} rows removed`);
  }
  const { data: after } = await sb.from('stock_news').select('id').eq('ticker', 'ACI');
  console.log(`  After delete: ${after?.length ?? 0} ACI rows`);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  DONE');
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error(err); process.exit(1); });
