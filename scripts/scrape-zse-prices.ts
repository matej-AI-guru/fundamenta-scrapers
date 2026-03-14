/**
 * Daily price scraper for ZSE stocks.
 *
 * Daily mode (default):
 *   - Stockanalysis.com → upserts recent prices
 *   - ZSE page 310 (transaction table) → today's closing price + total turnover
 *   - change_pct computed from consecutive DB prices
 *   - Verifies previous business day, logs corrections
 *
 * Backfill mode (--backfill):
 *   - Stockanalysis.com → 5 years of daily prices
 *   - Computes change_pct from consecutive prices in-memory
 *   - Upserts everything (price + change_pct, turnover stays NULL for historical)
 *   - Compares with existing DB prices, reports mismatches
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
const DELAY_MS = 400;
const BATCH_SIZE = 500;
const PRICE_TOLERANCE = 0.02;

// Croatia adopted EUR on 01.01.2023 — historical HRK prices divide by this rate
const HRK_TO_EUR = 7.53450;

const SA_START_DATE = new Date('2000-01-01').getTime(); // stockanalysis.com history start

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toIsoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function prevBusinessDay(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
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
// Croatian number parser: "1.234,56" → 1234.56
// ---------------------------------------------------------------------------
function parseCroNum(s: string): number {
  const clean = s.replace(/\./g, '').replace(',', '.').trim();
  return parseFloat(clean) || 0;
}

// ---------------------------------------------------------------------------
// SOURCE 1: Stockanalysis.com — price history
// ---------------------------------------------------------------------------
async function fetchSAPrices(ticker: string): Promise<{ date: string; price: number }[]> {
  const url = `https://stockanalysis.com/api/symbol/a/ZSE-${ticker}/history?type=chart`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://stockanalysis.com/',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`stockanalysis HTTP ${res.status}`);
  const json = await res.json() as { status: number; data: [number, number][] };
  if (!json.data || !Array.isArray(json.data)) throw new Error('No data in SA response');

  const cutoff2023 = new Date('2023-01-01').getTime();
  return json.data
    .filter(([ts]) => ts >= SA_START_DATE)
    .map(([ts, rawPrice]) => {
      const price = ts < cutoff2023 ? rawPrice / HRK_TO_EUR : rawPrice;
      return {
        date: new Date(ts).toISOString().split('T')[0],
        price: Math.round(price * 10000) / 10000,
      };
    });
}

// ---------------------------------------------------------------------------
// SOURCE 2: ZSE page 310 — today's transactions
// Table columns: r.br. | tvtic | vrijeme | cijena | količina | vrijednost | oznake | kumulativna količina | kumulativni promet
// Last row = closing price + total daily turnover
// ---------------------------------------------------------------------------
interface ZseDayData {
  price: number;
  turnover: number;
}

async function fetchZseTodayData(isin: string): Promise<ZseDayData | null> {
  const url = `https://zse.hr/hr/papir/310?isin=${isin}`;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'hr-HR,hr;q=0.9',
        Referer: 'https://zse.hr/',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return null;

    const html = await resp.text();
    const $ = cheerio.load(html);

    // Find the transactions table by looking for "kumulativni promet" in any table
    let priceIdx = -1;
    let turnoverIdx = -1;
    let lastRow: cheerio.Cheerio<cheerio.Element> | null = null;

    $('table').each((_i, tbl) => {
      const headers: string[] = [];
      $(tbl).find('tr').first().find('th,td').each((_j, th) => {
        headers.push($(th).text().trim().toLowerCase());
      });

      // "kumulativni promet" is in this table
      const turnIdx = headers.findIndex(h => h.includes('kumulativni promet'));
      const pIdx = headers.findIndex(h => h === 'cijena');
      if (turnIdx !== -1 && pIdx !== -1) {
        priceIdx = pIdx;
        turnoverIdx = turnIdx;
        // Get the last data row
        const rows = $(tbl).find('tbody tr');
        if (rows.length > 0) {
          lastRow = rows.last();
        }
        return false; // break
      }
    });

    if (!lastRow || priceIdx === -1 || turnoverIdx === -1) return null;

    const cells = $(lastRow).find('td').toArray();
    if (cells.length <= Math.max(priceIdx, turnoverIdx)) return null;

    const price = parseCroNum($(cells[priceIdx]).text());
    const turnover = parseCroNum($(cells[turnoverIdx]).text());

    if (price <= 0) return null;

    // Convert HRK→EUR if needed (pre-2023 — shouldn't apply for today, but just in case)
    const today = new Date();
    const isHrk = today.getFullYear() < 2023;
    return {
      price: Math.round((isHrk ? price / HRK_TO_EUR : price) * 10000) / 10000,
      turnover: Math.round((isHrk ? turnover / HRK_TO_EUR : turnover) * 100) / 100,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DB upsert
// ---------------------------------------------------------------------------
async function upsertBatch(
  sb: ReturnType<typeof getSupabaseAdmin>,
  records: { ticker: string; date: string; price: number; change_pct: number | null; turnover: number | null }[],
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
// Compute change_pct from consecutive sorted prices
// ---------------------------------------------------------------------------
function computeChangePct(prices: { date: string; price: number }[]): Map<string, number> {
  const result = new Map<string, number>();
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1].price;
    const curr = prices[i].price;
    if (prev > 0) {
      result.set(prices[i].date, Math.round(((curr - prev) / prev) * 10000 * 100) / 10000);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// BACKFILL MODE
// ---------------------------------------------------------------------------
async function runBackfill(sb: ReturnType<typeof getSupabaseAdmin>) {
  console.log('\n=== BACKFILL MODE: stockanalysis.com + change_pct ===\n');

  let totalOk = 0;
  let totalFail = 0;
  let totalMismatches = 0;
  let totalUpserted = 0;

  for (const ticker of TICKERS) {
    process.stdout.write(`${ticker}: `);
    try {
      const prices = await fetchSAPrices(ticker);
      if (!prices.length) {
        console.log('nema podataka');
        totalFail++;
        await sleep(DELAY_MS);
        continue;
      }

      // Compare with existing DB
      const fiveYearsAgo = toIsoDate(new Date(Date.now() - 5 * 365.25 * 24 * 3600 * 1000));
      const { data: existing } = await sb
        .from('price_history')
        .select('date,price')
        .eq('ticker', ticker)
        .gte('date', fiveYearsAgo);

      const dbByDate = new Map<string, number>(
        (existing ?? []).map((r: { date: string; price: number }) => [r.date, r.price]),
      );

      let mismatches = 0;
      for (const p of prices) {
        const dbPrice = dbByDate.get(p.date);
        if (dbPrice !== undefined && Math.abs(dbPrice - p.price) > PRICE_TOLERANCE) {
          console.log(`\n  MISMATCH ${p.date}: DB=${dbPrice.toFixed(4)} SA=${p.price.toFixed(4)}`);
          mismatches++;
        }
      }
      totalMismatches += mismatches;

      // Compute change_pct from consecutive prices
      const changePctMap = computeChangePct(prices);

      const records = prices.map(p => ({
        ticker,
        date: p.date,
        price: p.price,
        change_pct: changePctMap.get(p.date) ?? null,
        turnover: null as number | null, // historical turnover not available
      }));

      await upsertBatch(sb, records);
      const latest = prices[prices.length - 1];
      console.log(
        `${prices.length} dana OK (${prices[0].date} → ${latest.date})` +
        (mismatches ? ` | ${mismatches} mismatch` : ''),
      );
      totalOk++;
      totalUpserted += records.length;
    } catch (err) {
      console.log(`GREŠKA — ${err instanceof Error ? err.message : err}`);
      totalFail++;
    }
    await sleep(DELAY_MS);
  }

  console.log(`
========================================
BACKFILL STATISTIKA:
  OK: ${totalOk} tickera
  Greški: ${totalFail}
  Upsertano redova: ${totalUpserted}
  Price mismatch-eva (posljednjih 5g): ${totalMismatches}
========================================`);
}

// ---------------------------------------------------------------------------
// DAILY MODE
// ---------------------------------------------------------------------------
async function runDaily(sb: ReturnType<typeof getSupabaseAdmin>) {
  const today = new Date();
  const toIso = toIsoDate(today);
  const prevBizDay = toIsoDate(prevBusinessDay());

  console.log(`\n=== DAILY MODE (${toIso}, verifikacija: ${prevBizDay}) ===\n`);

  let totalOk = 0;
  let totalFail = 0;
  let totalCorrected = 0;

  for (const ticker of TICKERS) {
    const isin = tickerToIsin(ticker);
    process.stdout.write(`${ticker}: `);
    try {
      // Fetch recent 30 days from stockanalysis.com
      const allPrices = await fetchSAPrices(ticker);
      if (!allPrices.length) {
        console.log('nema podataka (SA)');
        totalFail++;
        await sleep(DELAY_MS);
        continue;
      }

      // Use only recent data for daily upsert (last 30 days)
      const cutoffDate = toIsoDate(new Date(Date.now() - 30 * 24 * 3600 * 1000));
      const recentPrices = allPrices.filter(p => p.date >= cutoffDate);

      // Compute change_pct — need at least one day before the recent window
      const idx = allPrices.findIndex(p => p.date >= cutoffDate);
      const withPrev = idx > 0 ? allPrices.slice(idx - 1) : recentPrices;
      const changePctMap = computeChangePct(withPrev);

      // Fetch today's turnover from ZSE page 310
      const zseTodayData = await fetchZseTodayData(isin);

      const records = recentPrices.map(p => ({
        ticker,
        date: p.date,
        price: p.price,
        change_pct: changePctMap.get(p.date) ?? null,
        turnover: (p.date === toIso && zseTodayData) ? zseTodayData.turnover : null as number | null,
      }));

      await upsertBatch(sb, records);

      const latest = allPrices[allPrices.length - 1];

      // If ZSE had better data for today (closing price + turnover), use it
      const todayPrice = zseTodayData?.price ?? latest.price;
      const todayChangePct = changePctMap.get(toIso) ?? changePctMap.get(latest.date) ?? null;
      const turnoverStr = zseTodayData ? `${(zseTodayData.turnover / 1000).toFixed(1)}K EUR promet` : 'bez prometa';

      console.log(
        `${recentPrices.length} dana OK, zadnji: ${latest.date} ${todayPrice.toFixed(2)} EUR` +
        (todayChangePct !== null ? ` (${todayChangePct >= 0 ? '+' : ''}${todayChangePct.toFixed(2)}%)` : '') +
        `, ${turnoverStr}`,
      );

      // Update stocks.price + last_updated
      await sb
        .from('stocks')
        .update({ price: todayPrice, last_updated: today.toISOString() })
        .eq('ticker', ticker);

      totalOk++;

      // Verify previous business day
      const prevDbRow = recentPrices.find(p => p.date === prevBizDay);
      if (prevDbRow) {
        const { data: dbRow } = await sb
          .from('price_history')
          .select('price')
          .eq('ticker', ticker)
          .eq('date', prevBizDay)
          .single();

        if (dbRow && Math.abs((dbRow.price as number) - prevDbRow.price) > PRICE_TOLERANCE) {
          await sb
            .from('price_history')
            .upsert(
              { ticker, date: prevBizDay, price: prevDbRow.price, change_pct: changePctMap.get(prevBizDay) ?? null, turnover: null },
              { onConflict: 'ticker,date' },
            );
          console.log(`  KOREKCIJA [${ticker}] ${prevBizDay}: DB=${(dbRow.price as number).toFixed(4)} → SA=${prevDbRow.price.toFixed(4)}`);
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
