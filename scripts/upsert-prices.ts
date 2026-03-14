/**
 * Fetch price history for all ZSE stocks from stockanalysis.com.
 * Upserts into price_history table (ticker, date unique).
 *
 * Run:  npx tsx scripts/upsert-prices.ts
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
const START_DATE = new Date('2000-01-01').getTime();
const BATCH_SIZE = 500;
const DELAY_MS = 300;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchPrices(ticker: string): Promise<{ date: string; price: number }[]> {
  const url = `https://stockanalysis.com/api/symbol/a/ZSE-${ticker}/history?type=chart`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://stockanalysis.com/',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json() as { status: number; data: [number, number][] };
  if (!json.data || !Array.isArray(json.data)) throw new Error('No data in response');

  return json.data
    .filter(([ts]) => ts >= START_DATE)
    .map(([ts, price]) => ({
      date: new Date(ts).toISOString().split('T')[0],
      price,
    }));
}

async function upsertBatch(
  sb: ReturnType<typeof getSupabaseAdmin>,
  ticker: string,
  rows: { date: string; price: number }[]
) {
  const records = rows.map(r => ({ ticker, date: r.date, price: r.price }));

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from('price_history')
      .upsert(batch, { onConflict: 'ticker,date' });
    if (error) throw new Error(`Upsert error: ${error.message}`);
  }
}

async function main() {
  const sb = getSupabaseAdmin();

  let totalOk = 0;
  let totalFail = 0;

  for (const ticker of TICKERS) {
    process.stdout.write(`${ticker}: `);
    try {
      const rows = await fetchPrices(ticker);
      await upsertBatch(sb, ticker, rows);
      console.log(`${rows.length} rows OK (${rows[0]?.date} → ${rows[rows.length - 1]?.date})`);
      totalOk++;
    } catch (err) {
      console.log(`SKIP — ${err instanceof Error ? err.message : err}`);
      totalFail++;
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nDone: ${totalOk} OK, ${totalFail} failed.`);
}

main().catch(console.error);
