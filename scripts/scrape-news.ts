/**
 * Scrape latest ZSE stock news directly from Croatian financial news RSS feeds.
 * Replaces Google News RSS (blocked from GitHub Actions cloud IPs).
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

const RSS_FEEDS = [
  { source: 'Poslovni dnevnik', url: 'https://www.poslovni.hr/rss' },
  { source: 'Lider',            url: 'https://lidermedia.hr/rss' },
  { source: 'Bloomberg Adria',  url: 'https://www.bloombergadria.com/rss' },
  { source: 'Tportal Biznis',   url: 'https://tportal.hr/biznis/rss' },
  { source: 'Index.hr',         url: 'https://www.index.hr/rss' },
];

function cleanName(name: string): string {
  return name
    .replace(/\s+(d\.d\.|d\.o\.o\.|j\.d\.d\.|j\.t\.d\.?|d\.d)$/gi, '')
    .trim();
}

interface FeedArticle {
  title: string;
  url: string;
  source: string;
  published_at: string;
}

function extractLink($el: cheerio.Cheerio<cheerio.AnyNode>, $: cheerio.CheerioAPI): string {
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
      const title = $el.find('title').first().text().trim();
      const url = extractLink($el, $);
      const pubDateStr = $el.find('pubDate').first().text().trim();

      if (!title || !url) return;

      // If no pubDate, assume article is recent (feed itself is fresh)
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

function matchesCompany(article: FeedArticle, ticker: string, cleanedName: string): boolean {
  const title = article.title.toLowerCase();
  const name  = cleanedName.toLowerCase();

  if (name.length >= 3 && title.includes(name)) return true;
  if (new RegExp(`\b${ticker.toLowerCase()}\b`).test(title)) return true;

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

  console.log('Dohvacanje RSS feedova...');
  const allArticles: FeedArticle[] = [];
  for (const feed of RSS_FEEDS) {
    const articles = await fetchFeed(feed.source, feed.url, cutoff);
    allArticles.push(...articles);
  }
  console.log(`Ukupno ${allArticles.length} svjezih clanaka.\n`);

  if (!allArticles.length) {
    console.log('Nema clanaka — RSS feedovi nisu dostupni ili su prazni.');
    process.exit(0);
  }

  let totalInserted = 0;

  for (const stock of allStocks as { ticker: string; name: string }[]) {
    const cleaned  = cleanName(stock.name);
    const matching = allArticles.filter(a => matchesCompany(a, stock.ticker, cleaned));

    await sb.from('stock_news').delete().eq('ticker', stock.ticker);

    if (!matching.length) continue;

    const rows = matching.slice(0, 10).map(a => ({ ...a, ticker: stock.ticker }));
    const { error: insErr } = await sb.from('stock_news').insert(rows);

    if (insErr) {
      console.error(`${stock.ticker}: insert greska: ${insErr.message}`);
    } else {
      console.log(`${stock.ticker} (${cleaned}): ${rows.length} vijesti`);
      rows.forEach(r =>
        console.log(`  [${new Date(r.published_at).toLocaleDateString('hr-HR')}] ${r.title.slice(0, 90)} — ${r.source}`)
      );
      totalInserted += rows.length;
    }
  }

  console.log(`\nGotovo! ${totalInserted} vijesti za ${allStocks.length} tickera.`);
}

main().catch(err => { console.error(err); process.exit(1); });
