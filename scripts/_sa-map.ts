/**
 * Shared mapping: SA row labels → stock_financials column names.
 * Used by both scrape-stockanalysis-annual.ts and scrape-stockanalysis-quarterly.ts.
 */

export const SA_SCALE = 1_000_000;
export const scaleM = (v: number | null): number | null =>
  v !== null ? Math.round(v * SA_SCALE) : null;

export function mapSaRow(
  incomeData: Record<string, Record<string, number | null>>,
  balanceData: Record<string, Record<string, number | null>>,
  cfData: Record<string, Record<string, number | null>>,
  key: string
): Record<string, number | null> {
  const gi = (label: string) => incomeData[label]?.[key] ?? null;
  const gb = (label: string) => balanceData[label]?.[key] ?? null;
  const gc = (label: string) => cfData[label]?.[key] ?? null;

  // ─── RDG ────────────────────────────────────────────────────────────────────
  const revenue          = scaleM(gi('Revenue') ?? gi('Total Revenue'));
  const ebit             = scaleM(gi('Operating Income'));
  const depreciation     = scaleM(gc('Depreciation & Amortization'));
  const ebitda           = ebit !== null && depreciation !== null ? ebit + depreciation : null;
  const net_profit       = scaleM(gi('Net Income'));
  const material_costs   = scaleM(gi('Cost of Revenue'));
  const gross_profit     = scaleM(gi('Gross Profit'));
  const personnel_costs  = scaleM(gi('Selling, General & Admin'));
  const rnd              = scaleM(gi('Research & Development'));
  const amort_goodwill   = scaleM(gi('Amortization of Goodwill & Intangibles'));
  const other_opex       = scaleM(gi('Other Operating Expenses'));
  const operating_expenses = scaleM(gi('Operating Expenses'));
  const fin_exp_raw      = gi('Interest Expense');
  const financial_expenses = fin_exp_raw !== null ? scaleM(Math.abs(fin_exp_raw)) : null;
  const financial_income = scaleM(gi('Interest & Investment Income'));
  const earnings_equity  = scaleM(gi('Earnings From Equity Investments'));
  const currency_gains   = scaleM(gi('Currency Exchange Gain (Loss)'));
  const other_non_operating = scaleM(gi('Other Non Operating Income (Expenses)'));
  const ebt_excl_unusual = scaleM(gi('EBT Excluding Unusual Items'));
  const merger_charges   = scaleM(gi('Merger & Restructuring Charges'));
  const impairment       = scaleM(gi('Impairment of Goodwill'));
  const gain_investments = scaleM(gi('Gain (Loss) on Sale of Investments'));
  const gain_assets      = scaleM(gi('Gain (Loss) on Sale of Assets'));
  const asset_writedown  = scaleM(gi('Asset Writedown'));
  const legal_settlements = scaleM(gi('Legal Settlements'));
  const other_unusual    = scaleM(gi('Other Unusual Items'));
  const profit_before_tax = scaleM(gi('Pretax Income'));
  const income_tax       = scaleM(gi('Income Tax Expense'));
  const minority_interest = scaleM(gi('Minority Interest in Earnings'));
  const eps_basic        = gi('EPS (Basic)');    // already per-share, no scale
  const eps              = gi('EPS (Diluted)');  // already per-share
  const dps              = gi('Dividend Per Share'); // already per-share
  const net_margin       = revenue && net_profit !== null ? net_profit / revenue : null;

  // ─── Bilanca ────────────────────────────────────────────────────────────────
  const cash                   = scaleM(gb('Cash & Equivalents'));
  const current_financial_assets = scaleM(gb('Short-Term Investments'));
  const total_cash             = scaleM(gb('Cash & Short-Term Investments'));
  const accounts_receivable    = scaleM(gb('Accounts Receivable'));
  const other_receivables      = scaleM(gb('Other Receivables'));
  const receivables            = scaleM(gb('Receivables'));
  const inventories            = scaleM(gb('Inventory'));
  const prepaid_expenses       = scaleM(gb('Prepaid Expenses'));
  const other_current_assets   = scaleM(gb('Other Current Assets'));
  const current_assets         = scaleM(gb('Total Current Assets'));
  const tangible_assets        = scaleM(gb('Property, Plant & Equipment'));
  const long_term_investments  = scaleM(gb('Long-Term Investments'));
  const goodwill               = scaleM(gb('Goodwill'));
  const ig                     = gb('Goodwill');
  const io                     = gb('Other Intangible Assets');
  const intangible_assets      = scaleM(ig !== null || io !== null ? (ig ?? 0) + (io ?? 0) : null);
  const lt_accounts_receivable = scaleM(gb('Long-Term Accounts Receivable'));
  const deferred_tax_assets    = scaleM(gb('Long-Term Deferred Tax Assets'));
  const other_lt_assets        = scaleM(gb('Other Long-Term Assets'));
  const non_current_assets     = (() => {
    const ta = scaleM(gb('Total Assets'));
    const ca = scaleM(gb('Total Current Assets'));
    return ta !== null && ca !== null ? ta - ca : null;
  })();
  const total_assets           = scaleM(gb('Total Assets'));
  const accounts_payable       = scaleM(gb('Accounts Payable'));
  const accrued_expenses       = scaleM(gb('Accrued Expenses'));
  const short_term_debt        = scaleM(gb('Short-Term Debt'));
  const current_portion_lt_debt = scaleM(gb('Current Portion of Long-Term Debt'));
  const current_leases         = scaleM(gb('Current Portion of Leases'));
  const current_taxes_payable  = scaleM(gb('Current Income Taxes Payable'));
  const unearned_revenue       = scaleM(gb('Current Unearned Revenue'));
  const other_current_liabilities = scaleM(gb('Other Current Liabilities'));
  const current_liabilities    = scaleM(gb('Total Current Liabilities'));
  const long_term_liabilities  = scaleM(gb('Long-Term Debt'));
  const lt_leases              = scaleM(gb('Long-Term Leases'));
  const pension_benefits       = scaleM(gb('Pension & Post-Retirement Benefits'));
  const lt_deferred_tax_liab   = scaleM(gb('Long-Term Deferred Tax Liabilities'));
  const other_lt_liabilities   = scaleM(gb('Other Long-Term Liabilities'));
  const total_liabilities      = scaleM(gb('Total Liabilities'));
  const share_capital          = scaleM(gb('Common Stock'));
  const retained_earnings      = scaleM(gb('Retained Earnings'));
  const treasury_stock         = scaleM(gb('Treasury Stock'));
  const other_equity           = scaleM(gb('Comprehensive Income & Other'));
  const equity                 = scaleM(gb('Total Common Equity'));
  const minority_interest_bs   = scaleM(gb('Minority Interest'));
  const total_debt             = scaleM(gb('Total Debt'));
  const net_cash               = scaleM(gb('Net Cash (Debt)'));
  const bvps                   = gb('Book Value Per Share'); // per-share, no scale
  const tangible_book_value    = scaleM(gb('Tangible Book Value'));
  const current_ratio          = current_assets !== null && current_liabilities !== null && current_liabilities !== 0
    ? current_assets / current_liabilities : null;

  // ─── Novčani tok ────────────────────────────────────────────────────────────
  const net_income_cf       = scaleM(gc('Net Income'));
  const other_amortization  = scaleM(gc('Other Amortization'));
  const gain_assets_cf      = scaleM(gc('Gain (Loss) on Sale of Assets'));
  const asset_writedown_cf  = scaleM(gc('Asset Writedown'));
  const gain_investments_cf = scaleM(gc('Gain (Loss) on Sale of Investments'));
  const income_equity_cf    = scaleM(gc('Earnings From Equity Investments'));
  const sbc                 = scaleM(gc('Stock-Based Compensation'));
  const provision_writeoff  = scaleM(gc('Provision / Writeoff of Bad Debts'));
  const change_ar           = scaleM(gc('Change in Accounts Receivable'));
  const change_inventory    = scaleM(gc('Change in Inventory'));
  const change_ap           = scaleM(gc('Change in Accounts Payable'));
  const change_unearned_rev = scaleM(gc('Change in Unearned Revenue'));
  const change_income_tax   = scaleM(gc('Change in Income Taxes'));
  const change_other_assets = scaleM(gc('Change in Other Net Operating Assets'));
  const other_operating_cf  = scaleM(gc('Other Operating Activities'));
  const operating_cash_flow = scaleM(gc('Operating Cash Flow'));
  const capex               = scaleM(gc('Capital Expenditures'));
  const sale_ppe            = scaleM(gc('Sale of Property, Plant & Equipment'));
  const cash_acquisition    = scaleM(gc('Cash Acquisitions'));
  const divestitures        = scaleM(gc('Divestitures'));
  const sale_intangibles    = scaleM(gc('Sale / Purchase of Intangibles'));
  const invest_securities   = scaleM(gc('Investment in Securities'));
  const other_investing     = scaleM(gc('Other Investing Activities'));
  const investing_cash_flow = scaleM(gc('Investing Cash Flow'));
  const st_debt_issued      = scaleM(gc('Short-Term Debt Issued'));
  const lt_debt_issued      = scaleM(gc('Long-Term Debt Issued'));
  const st_debt_repaid      = scaleM(gc('Short-Term Debt Repaid'));
  const lt_debt_repaid      = scaleM(gc('Long-Term Debt Repaid'));
  const net_debt_issued     = scaleM(gc('Net Debt Issued (Repaid)'));
  const common_issued       = scaleM(gc('Issuance of Common Stock'));
  const common_repurchased  = scaleM(gc('Repurchase of Common Stock'));
  const dividends_raw       = gc('Common Dividends Paid');
  const dividends_paid      = dividends_raw !== null ? scaleM(Math.abs(dividends_raw)) : null;
  const preferred_dividend_cf = scaleM(gc('Preferred Dividends Paid'));
  const other_financing     = scaleM(gc('Other Financing Activities'));
  const financing_cash_flow = scaleM(gc('Financing Cash Flow'));
  const fx_adjustments      = scaleM(gc('Foreign Exchange Rate Adjustments'));
  const net_cash_flow       = scaleM(gc('Net Cash Flow'));
  const free_cash_flow      = scaleM(gc('Free Cash Flow'));
  const cash_interest_paid  = scaleM(gc('Cash Interest Paid'));
  const cash_taxes_paid     = scaleM(gc('Cash Income Tax Paid'));
  const levered_fcf         = scaleM(gc('Levered Free Cash Flow'));
  const unlevered_fcf       = scaleM(gc('Unlevered Free Cash Flow'));

  return {
    // RDG — osnovni
    revenue, ebit, depreciation, net_profit, ebitda,
    operating_profit: ebit, other_operating_income: null,
    material_costs, personnel_costs, operating_expenses,
    financial_income, financial_expenses,
    profit_before_tax, income_tax,
    net_margin, eps, eps_basic, dps,
    // RDG — prošireni
    gross_profit, rnd, amort_goodwill, other_opex,
    earnings_equity, currency_gains, other_non_operating, ebt_excl_unusual,
    merger_charges, impairment, gain_investments, gain_assets,
    asset_writedown, legal_settlements, other_unusual, minority_interest,
    // Bilanca — osnovna
    total_assets, equity, current_assets, current_liabilities,
    long_term_liabilities, cash, receivables, inventories,
    tangible_assets, intangible_assets, non_current_assets,
    share_capital, retained_earnings, provisions: null,
    current_financial_assets, current_ratio,
    roe: null, roce: null,
    // Bilanca — proširena
    total_cash, accounts_receivable, other_receivables,
    prepaid_expenses, other_current_assets, long_term_investments,
    goodwill, lt_accounts_receivable, deferred_tax_assets, other_lt_assets,
    accounts_payable, accrued_expenses, short_term_debt, current_portion_lt_debt,
    current_leases, current_taxes_payable, unearned_revenue, other_current_liabilities,
    lt_leases, pension_benefits, lt_deferred_tax_liab, other_lt_liabilities,
    total_liabilities, treasury_stock, other_equity, minority_interest_bs,
    total_debt, net_cash, bvps, tangible_book_value,
    // Novčani tok — osnovni
    operating_cash_flow, capex, free_cash_flow,
    investing_cash_flow, financing_cash_flow, dividends_paid,
    // Novčani tok — prošireni
    net_income_cf, other_amortization, gain_assets_cf, asset_writedown_cf,
    gain_investments_cf, income_equity_cf, sbc, provision_writeoff,
    change_ar, change_inventory, change_ap, change_unearned_rev,
    change_income_tax, change_other_assets, other_operating_cf,
    sale_ppe, cash_acquisition, divestitures, sale_intangibles,
    invest_securities, other_investing,
    st_debt_issued, lt_debt_issued, st_debt_repaid, lt_debt_repaid,
    net_debt_issued, common_issued, common_repurchased,
    preferred_dividend_cf, other_financing, fx_adjustments,
    net_cash_flow, cash_interest_paid, cash_taxes_paid,
    levered_fcf, unlevered_fcf,
  };
}
