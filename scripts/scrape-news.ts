/**
 * Scrape latest news for each ZSE stock from Google News RSS.
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

function buildRssUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=hr&gl=HR&ceid=HR:hr`;
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

async function scrapeNews(ticker: string, companyName: string): Promise<NewsRow[]> {
  const url = buildRssUrl(`"${companyName}"`);

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/rss+xml, application/xml, text/xml',
    },
  });

  if (!resp.ok) {
    console.log(`  ${ticker}: HTTP ${resp.status}`);
    return [];
  }

  const xml = await resp.text();
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

    const title = source
      ? rawTitle.replace(new RegExp(` - ${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '').trim()
      : rawTitle;

    const published = pubDateStr ? new Date(pubDateStr) : null;
    if (!published || isNaN(published.getTime())) return;

    rows.push({ ticker, title, url: articleUrl, source, published_at: published.toISOString() });
  });

  return rows;
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
