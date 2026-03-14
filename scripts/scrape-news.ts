/**
 * Scrape latest news for each ZSE stock from Google News RSS.
 * Filters to Croatian-language sources only; skips articles older than 90 days.
 * Upserts into stock_news table (ticker, url unique).
 *
 * Run:  npx tsx scripts/scrape-news.ts [TICKER]
 *   TICKER — optional, process only that ticker
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

const MAX_NEWS_PER_TICKER = 10;
const DELAY_MS = 1200;
const MAX_AGE_DAYS = 90;

/** Known Croatian news source names as returned by Google News RSS. */
const CROATIAN_SOURCE_NAMES = new Set([
  'Poslovni dnevnik',
  'Lider',
  'Bloomberg Adria',
  'Forbes Hrvatska',
  'Forbes Croatia',
  'Večernji list',
  'Jutarnji list',
  'Tportal',
  'Index.hr',
  'Index',
  'Dnevnik.hr',
  'Slobodna Dalmacija',
  '24sata',
  'ZSE',
  'Novi list',
  'Glas Slavonije',
  'Nacional',
  'Netokracija',
  'Bug',
  'HRT',
  'N1',
  'Direktno.hr',
  'Poslovni.hr',
  'Lider media',
  'Poslovni',
]);

/** Croatian site domains — used as fallback source-URL matching. */
const CROATIAN_DOMAINS = [
  'poslovni.hr',
  'lidermedia.hr',
  'bloombergadria.com',
  'forbes.hr',
  'vecernji.hr',
  'jutarnji.hr',
  'tportal.hr',
  'index.hr',
  'zse.hr',
  'slobodnadalmacija.hr',
  'dnevnik.hr',
  '24sata.hr',
  'novilist.hr',
  'glas-slavonije.hr',
  'nacional.hr',
  'netokracija.com',
  'bug.hr',
  'hrt.hr',
  'n1info.hr',
  'direktno.hr',
];

function isCroatianSource(source: string | null, url: string): boolean {
  if (source && CROATIAN_SOURCE_NAMES.has(source)) return true;
  return CROATIAN_DOMAINS.some(d => url.includes(d));
}

function buildRssUrl(query: string): string {
  const sites = CROATIAN_DOMAINS.map(d => `site:${d}`).join(' OR ');
  const fullQuery = `"${query}" (${sites})`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(fullQuery)}&hl=hr&gl=HR&ceid=HR:hr`;
}

/** Fallback: no site filter, rely on source blocklist instead. */
function buildFallbackRssUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(`"${query}"`)}&hl=hr&gl=HR&ceid=HR:hr`;
}

function extractLinkFromItem(itemXml: string): string {
  const m = itemXml.match(/<link>(https?[^<]+)<\/link>/);
  return m ? m[1].trim() : '';
}

interface NewsRow {
  ticker: string;
  title: string;
  url: string;
  source: string | null;
  published_at: string;
}

function parseItems(
  xml: string,
  ticker: string,
  cutoff: Date,
  fallback = false,
): NewsRow[] {
  const $ = cheerio.load(xml, { xml: true });
  const rows: NewsRow[] = [];

  $('item').each((_i, el) => {
    if (rows.length >= MAX_NEWS_PER_TICKER) return false;

    const rawTitle = $(el).find('title').first().text().trim();
    const source = $(el).find('source').first().text().trim() || null;
    const pubDateStr = $(el).find('pubDate').first().text().trim();
    const guid = $(el).find('guid').first().text().trim();
    const elHtml = $.html(el);
    const articleUrl = extractLinkFromItem(elHtml) || guid;

    if (!articleUrl || !rawTitle) return;

    const published = pubDateStr ? new Date(pubDateStr) : null;
    if (!published || isNaN(published.getTime())) return;
    if (published < cutoff) return; // skip old articles

    // In fallback mode, only accept Croatian sources
    if (fallback && !isCroatianSource(source, articleUrl)) return;

    const title = source
      ? rawTitle.replace(new RegExp(` - ${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '').trim()
      : rawTitle;

    rows.push({ ticker, title, url: articleUrl, source, published_at: published.toISOString() });
  });

  return rows;
}

async function scrapeNews(ticker: string, companyName: string): Promise<NewsRow[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_AGE_DAYS);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/rss+xml, application/xml, text/xml',
  };

  // Primary: site-filtered query (Croatian sites only)
  const primaryUrl = buildRssUrl(companyName);
  const primaryResp = await fetch(primaryUrl, { headers });
  if (primaryResp.ok) {
    const xml = await primaryResp.text();
    const rows = parseItems(xml, ticker, cutoff, false);
    if (rows.length > 0) return rows;
  }

  // Fallback: unfiltered query, but filter results to Croatian sources
  const fallbackUrl = buildFallbackRssUrl(companyName);
  const fallbackResp = await fetch(fallbackUrl, { headers });
  if (!fallbackResp.ok) {
    console.log(`  ${ticker}: HTTP ${fallbackResp.status}`);
    return [];
  }
  const xml = await fallbackResp.text();
  return parseItems(xml, ticker, cutoff, true);
}

async function processTicker(
  ticker: string,
  companyName: string,
  sb: ReturnType<typeof getSupabaseAdmin>
) {
  console.log(`\n=== ${ticker} (${companyName}) ===`);

  let rows: NewsRow[];
  try {
    rows = await scrapeNews(ticker, companyName);
  } catch (e: unknown) {
    console.error(`  Greška: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (!rows.length) {
    console.log(`  Nema vijesti`);
    return;
  }

  console.log(`  Pronađeno ${rows.length} vijesti`);
  rows.forEach(r =>
    console.log(`    [${new Date(r.published_at).toLocaleDateString('hr-HR')}] ${r.title.slice(0, 80)} — ${r.source ?? '?'}`)
  );

  const { error } = await sb
    .from('stock_news')
    .upsert(rows, { onConflict: 'ticker,url' });

  if (error) console.error(`  Greška pri upsertu:`, error.message);
  else console.log(`  OK — upsertano ${rows.length} vijesti`);
}

async function main() {
  const sb = getSupabaseAdmin();
  const targetTicker = process.argv[2]?.toUpperCase();

  // Delete articles older than MAX_AGE_DAYS
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MAX_AGE_DAYS);
  const { error: delErr, count } = await sb
    .from('stock_news')
    .delete({ count: 'exact' })
    .lt('published_at', cutoffDate.toISOString());
  if (delErr) console.error('Greška pri brisanju starih vijesti:', delErr.message);
  else console.log(`Obrisano ${count ?? 0} starih vijesti (> ${MAX_AGE_DAYS} dana).`);

  const { data: allStocks, error } = await sb
    .from('stocks')
    .select('ticker,name')
    .order('ticker');

  if (error || !allStocks?.length) {
    console.error('Greška pri dohvatu dionica:', error?.message);
    process.exit(1);
  }

  const toProcess = targetTicker
    ? allStocks.filter((s: { ticker: string }) => s.ticker === targetTicker)
    : allStocks;

  console.log(`Procesiramo vijesti za ${toProcess.length} tickera...`);

  for (const stock of toProcess) {
    await processTicker(stock.ticker, stock.name, sb);
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log('\nGotovo!');
}

main().catch(console.error);
