/**
 * Scrape quarterly financials from stockanalysis.com for all ZSE tickers.
 * Upserts only quarters NOT already in DB (source='stockanalysis').
 *
 * Run:  npx tsx scripts/scrape-stockanalysis-quarterly.ts [TICKER] [--force]
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

const DUPLICATE_TICKERS: Record<string, string> = {
  ADRS2: 'ADRS',
  KODT2: 'KODT',
};
const SKIP_SA = new Set<string>(['ADRS2', 'KODT2']);

function parseNum(s: string | undefined): number | null {
  if (!s || s === '-' || s === '') return null;
  const clean = s.replace(/,/g, '').replace(/%$/, '').trim();
  if (clean === '-' || clean === '') return null;
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

function parseQuarterHeader(h: string): { year: number; period: string } | null {
  const m = h.match(/^Q([1-4])\s+(\d{4})$/);
  if (!m) return null;
  return { year: parseInt(m[2]), period: `Q${m[1]}` };
}

async function fetchFinancials(ticker: string, page: 'income' | 'balance' | 'cashflow'): Promise<Record<string, Record<string, number | null>>> {
  const urlMap = {
    income: `https://stockanalysis.com/quote/zse/${ticker}/financials/?p=quarterly`,
    balance: `https://stockanalysis.com/quote/zse/${ticker}/financials/balance-sheet/?p=quarterly`,
    cashflow: `https://stockanalysis.com/quote/zse/${ticker}/financials/cash-flow-statement/?p=quarterly`,
  };

  const resp = await fetch(urlMap[page], {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/html',
    },
  });

  if (!resp.ok) {
    if (resp.status === 404) return {};
    throw new Error(`HTTP ${resp.status}`);
  }

  const html = await resp.text();
  const $ = cheerio.load(html);
  const table = $('#main-table');
  if (!table.length) return {};

  const headers: Array<{ year: number; period: string } | null> = [];
  table.find('thead th').each((i, th) => {
    if (i === 0) return;
    headers.push(parseQuarterHeader($(th).text().trim()));
  });

  const result: Record<string, Record<string, number | null>> = {};
  table.find('tbody tr').each((_i, tr) => {
    const cells = $(tr).find('td');
    const label = $(cells[0]).text().trim();
    if (!label) return;
    result[label] = {};
    cells.each((j, td) => {
      if (j === 0) return;
      const h = headers[j - 1];
      if (!h) return;
      result[label][`${h.year}_${h.period}`] = parseNum($(td).text().trim());
    });
  });

  return result;
}

const SA_SCALE = 1_000_000;
const scaleM = (v: number | null) => (v !== null ? Math.round(v * SA_SCALE) : null);

function buildSaData(
  incomeData: Record<string, Record<string, number | null>>,
  balanceData: Record<string, Record<string, number | null>>,
  cfData: Record<string, Record<string, number | null>>,
  key: string
): Record<string, Record<string, number | null>> {
  const section = (data: Record<string, Record<string, number | null>>) =>
    Object.fromEntries(
      Object.entries(data)
        .map(([label, years]) => [label, years[key] !== undefined ? scaleM(years[key]) : null])
        .filter(([, v]) => v !== undefined)
    );
  return {
    income: section(incomeData),
    balance: section(balanceData),
    cashflow: section(cfData),
  };
}

function mapRow(
  incomeData: Record<string, Record<string, number | null>>,
  balanceData: Record<string, Record<string, number | null>>,
  cfData: Record<string, Record<string, number | null>>,
  key: string
): Partial<Record<string, number | null>> {
  const g = (data: Record<string, Record<string, number | null>>, label: string) =>
    data[label]?.[key] ?? null;

  const revenue = scaleM(g(incomeData, 'Revenue') ?? g(incomeData, 'Total Revenue'));
  const ebit = scaleM(g(incomeData, 'Operating Income'));
  const depreciation = scaleM(g(cfData, 'Depreciation & Amortization'));
  const ebitda = ebit !== null && depreciation !== null ? ebit + depreciation : null;
  const net_profit = scaleM(g(incomeData, 'Net Income'));
  const profit_before_tax = scaleM(g(incomeData, 'Pretax Income'));
  const income_tax = scaleM(g(incomeData, 'Income Tax Expense'));
  const financial_income = scaleM(g(incomeData, 'Interest & Investment Income'));
  const fin_exp_raw = g(incomeData, 'Interest Expense');
  const financial_expenses = fin_exp_raw !== null ? scaleM(Math.abs(fin_exp_raw)) : null;
  const material_costs = scaleM(g(incomeData, 'Cost of Revenue'));
  const personnel_costs = scaleM(g(incomeData, 'Selling, General & Admin'));
  const operating_expenses = scaleM(g(incomeData, 'Operating Expenses'));
  const cash = scaleM(g(balanceData, 'Cash & Equivalents'));
  const current_assets = scaleM(g(balanceData, 'Total Current Assets'));
  const total_assets = scaleM(g(balanceData, 'Total Assets'));
  const current_liabilities = scaleM(g(balanceData, 'Total Current Liabilities'));
  const long_term_liabilities = scaleM(g(balanceData, 'Long-Term Debt'));
  const equity = scaleM(g(balanceData, "Shareholders' Equity"));
  const retained_earnings = scaleM(g(balanceData, 'Retained Earnings'));
  const share_capital = scaleM(g(balanceData, 'Common Stock'));
  const receivables = scaleM(g(balanceData, 'Receivables'));
  const inventories = scaleM(g(balanceData, 'Inventory'));
  const tangible_assets = scaleM(g(balanceData, 'Property, Plant & Equipment'));
  const ig = g(balanceData, 'Goodwill');
  const io = g(balanceData, 'Other Intangible Assets');
  const intangible_assets = scaleM(ig !== null || io !== null ? (ig ?? 0) + (io ?? 0) : null);
  const non_current_assets = total_assets !== null && current_assets !== null ? total_assets - current_assets : null;
  const operating_cash_flow = scaleM(g(cfData, 'Operating Cash Flow'));
  const capex = scaleM(g(cfData, 'Capital Expenditures'));
  const free_cash_flow = scaleM(g(cfData, 'Free Cash Flow'));
  const investing_cash_flow = scaleM(g(cfData, 'Investing Cash Flow'));
  const financing_cash_flow = scaleM(g(cfData, 'Financing Cash Flow'));
  const dividends_raw = g(cfData, 'Common Dividends Paid');
  const dividends_paid = dividends_raw !== null ? scaleM(Math.abs(dividends_raw)) : null;
  const net_margin = revenue && net_profit !== null ? net_profit / revenue : null;

  return {
    revenue, ebit, depreciation, net_profit, ebitda,
    operating_profit: ebit, other_operating_income: null,
    material_costs, personnel_costs, operating_expenses,
    financial_income, financial_expenses,
    profit_before_tax, income_tax,
    total_assets, equity, current_assets, current_liabilities,
    long_term_liabilities, cash, receivables, inventories,
    tangible_assets, intangible_assets, non_current_assets,
    share_capital, retained_earnings, provisions: null,
    current_financial_assets: null,
    operating_cash_flow, capex, free_cash_flow,
    investing_cash_flow, financing_cash_flow, dividends_paid,
    net_margin, roe: null, roce: null, current_ratio: null, eps: null,
  };
}

async function replicateTicker(sb: ReturnType<typeof getSupabaseAdmin>, sourceTicker: string, destTicker: string) {
  const { data: existing } = await sb.from('stock_financials').select('year, period').eq('ticker', destTicker).neq('period', 'FY');
  const existingKeys = new Set((existing ?? []).map((r: { year: number; period: string }) => `${r.year}_${r.period}`));
  const { data: sourceData } = await sb.from('stock_financials').select('*').eq('ticker', sourceTicker).neq('period', 'FY');

  if (!sourceData?.length) { console.log(`  ${destTicker}: nema podataka od ${sourceTicker}`); return; }

  const toInsert = sourceData
    .filter((r: { year: number; period: string }) => !existingKeys.has(`${r.year}_${r.period}`))
    .map(({ id: _id, created_at: _ca, ticker: _t, ...rest }: { id: string; created_at: string; ticker: string; [key: string]: unknown }) => ({ ...rest, ticker: destTicker }));

  if (!toInsert.length) { console.log(`  ${destTicker}: svi kvartali već postoje`); return; }

  const { error } = await sb.from('stock_financials').upsert(toInsert, { onConflict: 'ticker,year,period' });
  if (error) console.error(`  ${destTicker} replika greška:`, error.message);
  else console.log(`  ${destTicker}: repliciran ${toInsert.length} kvartal(a) od ${sourceTicker}`);
}

async function processTicker(ticker: string, sb: ReturnType<typeof getSupabaseAdmin>) {
  console.log(`\n=== ${ticker} ===`);
  const force = process.argv.includes('--force');

  const { data: existing } = await sb.from('stock_financials').select('year, period, source').eq('ticker', ticker).neq('period', 'FY');
  const saKeys = force
    ? new Set<string>()
    : new Set((existing ?? []).filter((r: { source: string | null }) => r.source === 'stockanalysis').map((r: { year: number; period: string }) => `${r.year}_${r.period}`));

  console.log(`  Postojeći kvartali: ${(existing ?? []).length} (${saKeys.size} od stockanalysis, force=${force})`);

  let incomeData: Record<string, Record<string, number | null>>;
  let balanceData: Record<string, Record<string, number | null>>;
  let cfData: Record<string, Record<string, number | null>>;

  try {
    console.log(`  Dohvaćam income statement...`);
    incomeData = await fetchFinancials(ticker, 'income');
    await new Promise(r => setTimeout(r, 500));
    console.log(`  Dohvaćam balance sheet...`);
    balanceData = await fetchFinancials(ticker, 'balance');
    await new Promise(r => setTimeout(r, 500));
    console.log(`  Dohvaćam cash flow...`);
    cfData = await fetchFinancials(ticker, 'cashflow');
    await new Promise(r => setTimeout(r, 500));
  } catch (e: unknown) {
    console.error(`  Greška: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (!Object.keys(incomeData).length) { console.log(`  Nema podataka na stockanalysis.com`); return; }

  const revenueRow = incomeData['Revenue'] ?? incomeData['Total Revenue'] ?? {};
  const allKeys = Object.keys(revenueRow);

  const toUpsert: Record<string, unknown>[] = [];
  for (const key of allKeys) {
    if (saKeys.has(key)) continue;
    const [yearStr, period] = key.split('_');
    const year = parseInt(yearStr);
    const mapped = mapRow(incomeData, balanceData, cfData, key);
    if (mapped.revenue === null && mapped.total_assets === null) continue;
    const sa_data = buildSaData(incomeData, balanceData, cfData, key);
    toUpsert.push({ ticker, year, period, source: 'stockanalysis', report_type: 'group', ...mapped, sa_data });
  }

  if (!toUpsert.length) { console.log(`  Svi dostupni kvartali već postoje`); return; }

  console.log(`  Upsertam ${toUpsert.length} novih kvartal(a)...`);
  const { error } = await sb.from('stock_financials').upsert(toUpsert, { onConflict: 'ticker,year,period' });
  if (error) console.error(`  Greška:`, error.message);
  else console.log(`  OK — upsertano ${toUpsert.length} kvartal(a)`);
}

async function main() {
  const sb = getSupabaseAdmin();
  const force = process.argv.includes('--force');
  const targetTicker = process.argv.filter(a => !a.startsWith('-'))[2]?.toUpperCase();

  const { data: allStocks } = await sb.from('stocks').select('ticker').order('ticker');
  const allTickers = (allStocks ?? []).map((r: { ticker: string }) => r.ticker);

  const { data: qCounts } = await sb.from('stock_financials').select('ticker, period').neq('period', 'FY');
  const countsByTicker: Record<string, number> = {};
  for (const r of qCounts ?? []) countsByTicker[(r as { ticker: string }).ticker] = (countsByTicker[(r as { ticker: string }).ticker] || 0) + 1;

  const tickersToProcess = targetTicker
    ? [targetTicker]
    : force
    ? allTickers
    : allTickers.filter((t: string) => (countsByTicker[t] ?? 0) < 28);

  console.log(`Procesiramo ${tickersToProcess.length} tickera`);

  for (const ticker of tickersToProcess) {
    if (SKIP_SA.has(ticker)) continue;
    await processTicker(ticker, sb);
    await new Promise(r => setTimeout(r, 1000));
  }

  for (const [dest, source] of Object.entries(DUPLICATE_TICKERS)) {
    if (targetTicker && targetTicker !== dest) continue;
    console.log(`\n=== ${dest} (replika od ${source}) ===`);
    await replicateTicker(sb, source, dest);
  }

  console.log('\nGotovo!');
}

main().catch(console.error);
