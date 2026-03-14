/**
 * Fetch daily price history for all ZSE stocks by scraping zse.hr/hr/papir/310.
 * Stores price, turnover (protrgovani iznos u EUR) and change_pct into price_history.
 * Also updates stocks.price and stocks.last_updated with the latest price.
 *
 * Modes:
 *   (default)    Daily mode — fetches last 14 days for all tickers, verifies the
 *                previous business day against ZSE, fixes discrepancies and logs them.
 *   --backfill   First-run mode — fetches 5 years year-by-year, compares existing DB
 *                prices with ZSE prices and reports discrepancies, populates turnover/change_pct.
 *
 * Run:
 *   npx tsx scripts/scrape-zse-prices.ts
 *   npx tsx scripts/scrape-zse-prices.ts --backfill
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
import { SECTORS } from '../lib/sectors';

const TICKERS = Object.keys(SECTORS);
const DELAY_MS = 600;
const BATCH_SIZE = 500;
const PRICE_TOLERANCE = 0.02;

// Croatia adopted EUR on 01.01.2023 — historical HRK prices divide by this rate
const HRK_TO_EUR = 7.53450;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// ISIN helpers — same formula as StockTable.tsx
// ---------------------------------------------------------------------------
function isinCheckDigit(s: string): number {
  const digits: number[] = [];
  for (const ch of s) {
    if (ch >= 'A' && ch <= 'Z') {
      const n = ch.charCodeAt(0) - 55;
      digits.push(Math.floor(n / 10), n % 10);
    } else {
      digits.push(parseInt(ch));
    }
  }
  let sum = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i];
    if ((digits.length - i) % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

function tickerToIsin(ticker: string): string {
  const isPreferred = ticker.endsWith('2');
  const base = isPreferred ? ticker.slice(0, -1) : ticker;
  const padded = base.padEnd(4, '0');
  const shareClass = isPreferred ? 'PA' : 'RA';
  const withoutCheck = `HR${padded}${shareClass}000`;
  return `${withoutCheck}${isinCheckDigit(withoutCheck)}`;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function toIsoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

/** Format date as DD.MM.YYYY for ZSE URL params */
function toCroDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function prevBusinessDay(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}

// ---------------------------------------------------------------------------
// ZSE HTML scraper
// ---------------------------------------------------------------------------
interface ZseTrade {
  date: string;       // YYYY-MM-DD
  price: number;      // closing price in EUR
  turnover: number;   // protrgovani iznos in EUR
  change_pct: number; // % change that day
}

/** Parse Croatian number string: "1.234,56" → 1234.56 */
function parseCroNum(s: string): number {
  const clean = s.replace(/\./g, '').replace(',', '.').trim();
  return parseFloat(clean) || 0;
}

/** Parse ZSE date "14.03.2025." → "2025-03-14" */
function parseCroDate(s: string): string | null {
  const m = s.trim().replace(/\.$/, '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Fetch and parse the ZSE trade history page for a ticker, for a given date range.
 * URL: https://zse.hr/hr/papir/310?isin={isin}&od={DD.MM.YYYY}&do={DD.MM.YYYY}
 */
async function fetchZsePage(
  ticker: string,
  isin: string,
  fromIso: string,
  toIso: string,
): Promise<ZseTrade[]> {
  const od = toCroDate(fromIso);
  const doParam = toCroDate(toIso);
  const url = `https://zse.hr/hr/papir/310?isin=${isin}&od=${od}&do=${doParam}`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'hr-HR,hr;q=0.9',
      Referer: 'https://zse.hr/',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const html = await resp.text();
  const $ = cheerio.load(html);

  // Find the cotation table — ZSE uses a table with class or within a specific section
  // Look for any table that has "Datum" and "Zadnja" or "Cijena" headers
  let targetTable: cheerio.Cheerio<cheerio.Element> | null = null;
  $('table').each((_i, tbl) => {
    const headerText = $(tbl).find('th,td').first().text().trim().toLowerCase();
    const text = $(tbl).text().toLowerCase();
    if (text.includes('zadnja') || text.includes('promet') || text.includes('datum')) {
      targetTable = $(tbl);
      return false; // break
    }
  });

  if (!targetTable) {
    // Debug: log a snippet of the page to help identify the table structure
    console.log(`  [${ticker}] Tablica nije pronađena u HTML-u (${html.length} bytes). Provjeri URL: ${url}`);
    return [];
  }

  // Find header row to determine column indices
  const headers: string[] = [];
  $(targetTable).find('tr').first().find('th,td').each((_i, th) => {
    headers.push($(th).text().trim().toLowerCase());
  });

  const dateIdx    = headers.findIndex(h => h.includes('datum'));
  const priceIdx   = headers.findIndex(h => h.includes('zadnja') || h.includes('cijena') || h.includes('close'));
  const turnIdx    = headers.findIndex(h => h.includes('promet') || h.includes('turnover'));
  const changeIdx  = headers.findIndex(h => h.includes('promjen') || h.includes('change') || h.includes('%'));

  if (dateIdx === -1 || priceIdx === -1) {
    console.log(`  [${ticker}] Nepoznata zaglavlja tablice: ${headers.join(' | ')}`);
    return [];
  }

  const cutoff2023 = new Date('2023-01-01').getTime();
  const trades: ZseTrade[] = [];

  $(targetTable).find('tbody tr,tr').each((_i, tr) => {
    const cells = $(tr).find('td').toArray();
    if (cells.length < Math.max(dateIdx, priceIdx) + 1) return;

    const dateStr = $(cells[dateIdx]).text().trim();
    const date = parseCroDate(dateStr);
    if (!date) return;

    const rawPrice = parseCroNum($(cells[priceIdx]).text());
    if (rawPrice <= 0) return;

    const rawTurnover = turnIdx !== -1 ? parseCroNum($(cells[turnIdx]).text()) : 0;
    const rawChangePct = changeIdx !== -1 ? parseCroNum($(cells[changeIdx]).text()) : 0;

    // Convert HRK → EUR for pre-2023 data
    const tradeTs = new Date(date).getTime();
    const isHrk = tradeTs < cutoff2023;
    const price   = isHrk ? rawPrice / HRK_TO_EUR : rawPrice;
    const turnover = isHrk ? rawTurnover / HRK_TO_EUR : rawTurnover;

    trades.push({
      date,
      price:      Math.round(price * 10000) / 10000,
      turnover:   Math.round(turnover * 100) / 100,
      change_pct: Math.round(rawChangePct * 10000) / 10000,
    });
  });

  return trades.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// DB upsert
// ---------------------------------------------------------------------------
async function upsertBatch(
  sb: ReturnType<typeof getSupabaseAdmin>,
  records: { ticker: string; date: string; price: number; turnover: number; change_pct: number }[],
) {
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from('price_history')
      .upsert(batch, { onConflict: 'ticker,date' });
    if (error) throw new Error(`Upsert error: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// BACKFILL MODE — fetch 5 years year-by-year
// ---------------------------------------------------------------------------
async function runBackfill(sb: ReturnType<typeof getSupabaseAdmin>) {
  const today = new Date();
  const currentYear = today.getFullYear();
  const startYear = currentYear - 5;

  console.log(`\n=== BACKFILL MODE: ${startYear + 1} → ${currentYear} (po godinama) ===\n`);

  let totalMismatches = 0;
  let totalUpserted = 0;

  for (const ticker of TICKERS) {
    const isin = tickerToIsin(ticker);
    console.log(`\n${ticker} (${isin}):`);

    let tickerTotal = 0;
    let tickerMismatches = 0;

    for (let y = startYear + 1; y <= currentYear; y++) {
      const fromIso = `${y}-01-01`;
      const toIso   = y === currentYear ? toIsoDate(today) : `${y}-12-31`;

      try {
        const trades = await fetchZsePage(ticker, isin, fromIso, toIso);

        if (!trades.length) {
          console.log(`  ${y}: nema podataka`);
          await sleep(DELAY_MS);
          continue;
        }

        // Compare prices with existing DB records
        const { data: existing } = await sb
          .from('price_history')
          .select('date,price')
          .eq('ticker', ticker)
          .gte('date', fromIso)
          .lte('date', toIso);

        const dbByDate = new Map<string, number>(
          (existing ?? []).map((r: { date: string; price: number }) => [r.date, r.price]),
        );

        for (const t of trades) {
          const dbPrice = dbByDate.get(t.date);
          if (dbPrice !== undefined && Math.abs(dbPrice - t.price) > PRICE_TOLERANCE) {
            console.log(`  MISMATCH ${t.date}: DB=${dbPrice.toFixed(4)} ZSE=${t.price.toFixed(4)} Δ=${(t.price - dbPrice).toFixed(4)}`);
            tickerMismatches++;
          }
        }

        const records = trades.map(t => ({ ticker, ...t }));
        await upsertBatch(sb, records);
        console.log(`  ${y}: ${trades.length} dana (${trades[0].date} → ${trades[trades.length - 1].date})`);
        tickerTotal += records.length;
      } catch (err) {
        console.log(`  ${y}: GREŠKA — ${err instanceof Error ? err.message : err}`);
      }

      await sleep(DELAY_MS);
    }

    console.log(`  Ukupno: ${tickerTotal} dana, ${tickerMismatches} mismatch-a`);
    totalMismatches += tickerMismatches;
    totalUpserted += tickerTotal;
  }

  console.log(`
========================================
BACKFILL STATISTIKA:
  Tickera: ${TICKERS.length}
  Upsertano redova: ${totalUpserted}
  Price mismatch-eva: ${totalMismatches}
========================================`);
}

// ---------------------------------------------------------------------------
// DAILY MODE
// ---------------------------------------------------------------------------
async function runDaily(sb: ReturnType<typeof getSupabaseAdmin>) {
  const today = new Date();
  const toIso = toIsoDate(today);
  const from14 = new Date(today);
  from14.setDate(from14.getDate() - 14);
  const fromIso = toIsoDate(from14);
  const prevBizDay = toIsoDate(prevBusinessDay());

  console.log(`\n=== DAILY MODE: ${fromIso} → ${toIso} (verifikacija: ${prevBizDay}) ===\n`);

  let totalOk = 0;
  let totalFail = 0;
  let totalCorrected = 0;

  for (const ticker of TICKERS) {
    const isin = tickerToIsin(ticker);
    process.stdout.write(`${ticker}: `);

    try {
      const trades = await fetchZsePage(ticker, isin, fromIso, toIso);

      if (!trades.length) {
        console.log('nema novih podataka');
        totalFail++;
        await sleep(DELAY_MS);
        continue;
      }

      const records = trades.map(t => ({ ticker, ...t }));
      await upsertBatch(sb, records);

      const latest = trades[trades.length - 1];
      console.log(
        `${trades.length} dana OK, zadnji: ${latest.date} ${latest.price.toFixed(2)} EUR` +
        ` (${latest.change_pct >= 0 ? '+' : ''}${latest.change_pct.toFixed(2)}%)`,
      );

      // Update stocks.price and stocks.last_updated
      await sb
        .from('stocks')
        .update({ price: latest.price, last_updated: new Date().toISOString() })
        .eq('ticker', ticker);

      totalOk++;

      // Verify previous business day
      const prevTrade = trades.find(t => t.date === prevBizDay);
      if (prevTrade) {
        const { data: dbRow } = await sb
          .from('price_history')
          .select('price')
          .eq('ticker', ticker)
          .eq('date', prevBizDay)
          .single();

        if (dbRow && Math.abs((dbRow.price as number) - prevTrade.price) > PRICE_TOLERANCE) {
          await sb
            .from('price_history')
            .upsert(
              { ticker, date: prevBizDay, price: prevTrade.price, turnover: prevTrade.turnover, change_pct: prevTrade.change_pct },
              { onConflict: 'ticker,date' },
            );
          console.log(`  KOREKCIJA [${ticker}] ${prevBizDay}: DB=${(dbRow.price as number).toFixed(4)} → ZSE=${prevTrade.price.toFixed(4)}`);
          totalCorrected++;
        }
      }
    } catch (err) {
      console.log(`GREŠKA — ${err instanceof Error ? err.message : err}`);
      totalFail++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`
========================================
STATISTIKA:
  OK: ${totalOk}
  Greški: ${totalFail}
  Korekcija prethodnog dana: ${totalCorrected}
========================================`);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  const sb = getSupabaseAdmin();
  const isBackfill = process.argv.includes('--backfill');

  if (isBackfill) {
    await runBackfill(sb);
  } else {
    await runDaily(sb);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
