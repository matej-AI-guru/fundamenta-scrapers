/**
 * Scrape dividend history for all ZSE stocks from stockanalysis.com.
 * Upserts into dividend_history table (ticker, ex_date unique).
 *
 * Run:  npx tsx scripts/scrape-dividends.ts [TICKER]
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

// ADRS2/KODT2 share dividends with ADRS/KODT
const REPLICATE: Record<string, string> = {
  ADRS2: 'ADRS',
  KODT2: 'KODT',
  CROS2: 'CROS',
};

function parseDate(s: string | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

function parseAmount(s: string): number | null {
  if (!s) return null;
  const clean = s.replace(/[^0-9.]/g, '');
  const n = parseFloat(clean);
  return isNaN(n) || n <= 0 ? null : n;
}

interface DividendRow {
  ticker: string;
  ex_date: string;
  amount_eur: number;
  div_type: string;
  pay_date: string | null;
}

async function scrapeDividends(ticker: string): Promise<DividendRow[]> {
  const url = `https://stockanalysis.com/quote/zse/${ticker}/dividend/`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/html',
    },
  });

  if (!resp.ok) {
    if (resp.status === 404) return [];
    throw new Error(`HTTP ${resp.status}`);
  }

  const html = await resp.text();
  const $ = cheerio.load(html);

  const table = $('table').first();
  if (!table.length) return [];

  const rows: DividendRow[] = [];

  const headers: string[] = [];
  table.find('thead th').each((_i, th) => {
    headers.push($(th).text().trim().toLowerCase());
  });

  const exDateIdx   = headers.findIndex(h => h.includes('ex') && h.includes('date'));
  const amountIdx   = headers.findIndex(h => h.includes('amount') || h.includes('cash'));
  const typeIdx     = headers.findIndex(h => h === 'type' || h.includes('div type'));
  const payDateIdx  = headers.findIndex(h => h.includes('pay') && h.includes('date'));

  table.find('tbody tr').each((_i, tr) => {
    const cells = $(tr).find('td').toArray();
    if (!cells.length) return;

    const exDateStr = exDateIdx !== -1
      ? $(cells[exDateIdx]).text().trim()
      : $(cells[0]).text().trim();

    const amountStr = amountIdx !== -1
      ? $(cells[amountIdx]).text().trim()
      : $(cells[1]).text().trim();

    const typeStr = typeIdx !== -1
      ? $(cells[typeIdx]).text().trim()
      : (cells.length > 3 ? $(cells[cells.length - 1]).text().trim() : 'Regular');

    const payDateStr = payDateIdx !== -1 ? $(cells[payDateIdx]).text().trim() : undefined;

    const ex_date = parseDate(exDateStr);
    const amount_eur = parseAmount(amountStr);

    if (!ex_date || !amount_eur) return;

    const div_type = typeStr.toLowerCase().includes('special') ? 'Special' : 'Regular';
    const pay_date = parseDate(payDateStr) ?? null;

    rows.push({ ticker, ex_date, amount_eur, div_type, pay_date });
  });

  return rows;
}

async function replicateDividends(
  sb: ReturnType<typeof getSupabaseAdmin>,
  sourceTicker: string,
  destTicker: string
) {
  const { data: sourceData } = await sb
    .from('dividend_history')
    .select('ex_date, amount_eur, div_type, pay_date')
    .eq('ticker', sourceTicker);

  if (!sourceData?.length) {
    console.log(`  ${destTicker}: nema dividendi od ${sourceTicker}`);
    return;
  }

  const rows = sourceData.map((r: { ex_date: string; amount_eur: number; div_type: string; pay_date: string | null }) => ({
    ticker: destTicker,
    ex_date: r.ex_date,
    amount_eur: r.amount_eur,
    div_type: r.div_type,
    pay_date: r.pay_date,
  }));

  const { error } = await sb
    .from('dividend_history')
    .upsert(rows, { onConflict: 'ticker,ex_date' });

  if (error) console.error(`  ${destTicker} replika greška:`, error.message);
  else console.log(`  ${destTicker}: repliciran ${rows.length} dividendi od ${sourceTicker}`);
}

async function processTicker(
  ticker: string,
  sb: ReturnType<typeof getSupabaseAdmin>
) {
  console.log(`\n=== ${ticker} ===`);

  let rows: DividendRow[];
  try {
    rows = await scrapeDividends(ticker);
  } catch (e: unknown) {
    console.error(`  Greška: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (!rows.length) {
    console.log(`  Nema dividendi`);
    return;
  }

  console.log(`  Pronađeno ${rows.length} dividendi`);
  rows.forEach(r => console.log(`    ${r.ex_date}  ${r.amount_eur.toFixed(4)} EUR  [${r.div_type}]  pay: ${r.pay_date ?? '-'}`));

  const { error } = await sb
    .from('dividend_history')
    .upsert(rows, { onConflict: 'ticker,ex_date' });

  if (error) console.error(`  Greška pri upsertu:`, error.message);
  else console.log(`  OK — upsertano ${rows.length} redova`);
}

async function main() {
  const sb = getSupabaseAdmin();
  const targetTicker = process.argv[2]?.toUpperCase();

  const { data: allStocks, error } = await sb
    .from('stocks')
    .select('ticker')
    .order('ticker');

  if (error || !allStocks?.length) {
    console.error('Greška pri dohvatu dionica:', error?.message);
    process.exit(1);
  }

  const allTickers = allStocks.map((s: { ticker: string }) => s.ticker);
  const skipSet = new Set(Object.keys(REPLICATE));
  const toProcess = targetTicker
    ? [targetTicker]
    : allTickers.filter((t: string) => !skipSet.has(t));

  console.log(`Procesiramo dividende za ${toProcess.length} tickera...`);

  for (const ticker of toProcess) {
    await processTicker(ticker, sb);
    await new Promise(r => setTimeout(r, 800));
  }

  // Replicate for duplicate tickers
  for (const [dest, source] of Object.entries(REPLICATE)) {
    if (targetTicker && targetTicker !== dest) continue;
    console.log(`\n=== ${dest} (replika od ${source}) ===`);
    await replicateDividends(sb, source, dest);
  }

  console.log('\nGotovo!');
}

main().catch(console.error);
