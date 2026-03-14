/**
 * Fetch daily price history for all ZSE stocks from the ZSE REST API (zse.hr).
 * Stores price, turnover (protrgovani iznos u EUR) and change_pct into price_history.
 * Also updates stocks.price and stocks.last_updated with the latest price.
 *
 * Modes:
 *   (default)    Daily mode — fetches last 7 days for all tickers, verifies the
 *                previous business day against ZSE, fixes discrepancies and logs them.
 *   --backfill   First-run mode — fetches 5 years, compares existing DB prices with
 *                ZSE prices and reports discrepancies, then populates turnover/change_pct.
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

import { getSupabaseAdmin } from '../lib/supabase';
import { SECTORS } from '../lib/sectors';

const TICKERS = Object.keys(SECTORS);
const DELAY_MS = 400;
const BATCH_SIZE = 500;

// Croatia adopted EUR on 01.01.2023 — historical HRK prices divide by this rate
const HRK_TO_EUR = 7.53450;

const BACKFILL_YEARS = 5;
// Allow this much rounding difference before flagging a price mismatch
const PRICE_TOLERANCE = 0.02;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface ZseTrade {
  date: string;       // YYYY-MM-DD
  price: number;      // closing price in EUR
  turnover: number;   // protrgovani iznos in EUR
  change_pct: number; // % change that day (can be 0 if unavailable)
}

/**
 * Parse ZSE date which may come as "14.03.2025." or "2025-03-14"
 */
function parseZseDate(s: unknown): string | null {
  if (!s) return null;
  const str = String(s);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

/**
 * Previous business day (skips weekends)
 */
function prevBusinessDay(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
}

function toIsoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

/**
 * Fetch trade history for a ticker from the ZSE REST API.
 * ZSE API: GET https://rest.zse.hr/web/Ticker/{ticker}/tradeHistory?fromDate={}&toDate={}
 */
async function fetchZseHistory(
  ticker: string,
  fromDate: string,
  toDate: string,
): Promise<ZseTrade[]> {
  const url =
    `https://rest.zse.hr/web/Ticker/${ticker}/tradeHistory` +
    `?fromDate=${fromDate}&toDate=${toDate}`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; FundamentaBot/1.0)',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${ticker}`);

  const json = await resp.json();

  // ZSE API may wrap results in various keys
  const items: unknown[] = Array.isArray(json)
    ? json
    : (json.tradeHistory ?? json.tradeHistoryList ?? json.data ?? []);

  if (!Array.isArray(items)) throw new Error(`Unexpected response shape for ${ticker}`);

  const cutoff2023 = new Date('2023-01-01').getTime();

  return items
    .map((item) => {
      const r = item as Record<string, unknown>;

      const rawDate = r.date ?? r.Date ?? r.tradeDate ?? r.settlementDate ?? '';
      const date = parseZseDate(rawDate);
      if (!date) return null;

      // Closing price field name variations
      const rawPrice = Number(
        r.closingPrice ?? r.closePrice ?? r.lastPrice ?? r.price ?? r.zadnjaCijena ?? 0,
      );
      if (rawPrice <= 0) return null;

      // Turnover (protrgovani iznos) field name variations
      let rawTurnover = Number(
        r.turnover ?? r.totalTurnover ?? r.promet ?? r.prometIznos ?? 0,
      );

      // Percentage change field name variations
      const rawChangePct = Number(
        r.changePct ?? r.changePercent ?? r.changePercentage ??
        r.priceChangePct ?? r.postotnaPromjena ?? 0,
      );

      // Convert HRK → EUR for pre-2023 records
      const tradeTs = new Date(date).getTime();
      const isHrk = tradeTs < cutoff2023;
      const price = isHrk ? rawPrice / HRK_TO_EUR : rawPrice;
      if (isHrk) rawTurnover = rawTurnover / HRK_TO_EUR;

      return {
        date,
        price: Math.round(price * 10000) / 10000,
        turnover: Math.round(rawTurnover * 100) / 100,
        change_pct: Math.round(rawChangePct * 10000) / 10000,
      };
    })
    .filter((r): r is ZseTrade => r !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

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
// BACKFILL MODE
// ---------------------------------------------------------------------------
async function runBackfill(sb: ReturnType<typeof getSupabaseAdmin>) {
  const toDate = toIsoDate(new Date());
  const fromDate = toIsoDate(
    new Date(Date.now() - BACKFILL_YEARS * 365.25 * 24 * 3600 * 1000),
  );

  console.log(`\n=== BACKFILL MODE: ${fromDate} → ${toDate} ===\n`);

  let totalMismatches = 0;
  let totalUpserted = 0;

  for (const ticker of TICKERS) {
    process.stdout.write(`${ticker}: `);
    try {
      const trades = await fetchZseHistory(ticker, fromDate, toDate);

      if (!trades.length) {
        console.log('nema podataka');
        await sleep(DELAY_MS);
        continue;
      }

      // Load existing DB prices for this ticker in the date range
      const { data: existing } = await sb
        .from('price_history')
        .select('date,price')
        .eq('ticker', ticker)
        .gte('date', fromDate)
        .lte('date', toDate);

      const dbByDate = new Map<string, number>(
        (existing ?? []).map((r: { date: string; price: number }) => [r.date, r.price]),
      );

      // Find price mismatches
      const mismatches: string[] = [];
      for (const t of trades) {
        const dbPrice = dbByDate.get(t.date);
        if (dbPrice !== undefined && Math.abs(dbPrice - t.price) > PRICE_TOLERANCE) {
          mismatches.push(
            `  MISMATCH ${t.date}: DB=${dbPrice.toFixed(4)} ZSE=${t.price.toFixed(4)} Δ=${(t.price - dbPrice).toFixed(4)}`,
          );
        }
      }

      if (mismatches.length) {
        totalMismatches += mismatches.length;
        console.log(`\n  [${ticker}] ${mismatches.length} price mismatch(a):`);
        mismatches.forEach(m => console.log(m));
      }

      // Upsert all records (fills in turnover + change_pct, corrects prices)
      const records = trades.map(t => ({ ticker, ...t }));
      await upsertBatch(sb, records);

      const latest = trades[trades.length - 1];
      console.log(
        `${trades.length} dana OK (${trades[0].date} → ${latest.date})` +
        (mismatches.length ? ` — ${mismatches.length} korigirano` : ''),
      );
      totalUpserted += records.length;
    } catch (err) {
      console.log(`GREŠKA — ${err instanceof Error ? err.message : err}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`
========================================
BACKFILL STATISTIKA:
  Tickera: ${TICKERS.length}
  Upsertano redova: ${totalUpserted}
  Price mismatch-eva: ${totalMismatches}
========================================`);

  if (totalMismatches > 0) {
    console.log('\nUPOZORENJE: Pronađene razlike između DB i ZSE cijena — provjeriti gore!');
  }
}

// ---------------------------------------------------------------------------
// DAILY MODE
// ---------------------------------------------------------------------------
async function runDaily(sb: ReturnType<typeof getSupabaseAdmin>) {
  // Fetch last 7 days to ensure we catch data even if ZSE was slow
  const toDate = toIsoDate(new Date());
  const fromDate = toIsoDate(new Date(Date.now() - 7 * 24 * 3600 * 1000));
  const prevBizDay = toIsoDate(prevBusinessDay());

  console.log(`\n=== DAILY MODE: ${fromDate} → ${toDate} (verifikacija: ${prevBizDay}) ===\n`);

  let totalOk = 0;
  let totalFail = 0;
  let totalCorrected = 0;

  for (const ticker of TICKERS) {
    process.stdout.write(`${ticker}: `);
    try {
      const trades = await fetchZseHistory(ticker, fromDate, toDate);

      if (!trades.length) {
        console.log('nema novih podataka');
        totalFail++;
        await sleep(DELAY_MS);
        continue;
      }

      const records = trades.map(t => ({ ticker, ...t }));
      await upsertBatch(sb, records);

      const latest = trades[trades.length - 1];
      console.log(`${trades.length} dana OK, zadnji: ${latest.date} ${latest.price.toFixed(2)} EUR (${latest.change_pct >= 0 ? '+' : ''}${latest.change_pct.toFixed(2)}%)`);

      // --- Update stocks.price and stocks.last_updated with latest price ---
      await sb
        .from('stocks')
        .update({ price: latest.price, last_updated: new Date().toISOString() })
        .eq('ticker', ticker);

      totalOk++;

      // --- Verify previous business day ---
      const prevTrade = trades.find(t => t.date === prevBizDay);
      if (prevTrade) {
        const { data: dbRow } = await sb
          .from('price_history')
          .select('price,turnover,change_pct')
          .eq('ticker', ticker)
          .eq('date', prevBizDay)
          .single();

        if (dbRow && Math.abs((dbRow.price as number) - prevTrade.price) > PRICE_TOLERANCE) {
          // Mismatch — fix it
          await sb
            .from('price_history')
            .upsert(
              { ticker, date: prevBizDay, price: prevTrade.price, turnover: prevTrade.turnover, change_pct: prevTrade.change_pct },
              { onConflict: 'ticker,date' },
            );

          const msg = `KOREKCIJA [${ticker}] ${prevBizDay}: DB=${(dbRow.price as number).toFixed(4)} → ZSE=${prevTrade.price.toFixed(4)}`;
          console.log(`  ${msg}`);
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
