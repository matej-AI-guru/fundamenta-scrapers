-- Add turnover (protrgovani iznos u EUR) and change_pct (dnevna %-na promjena)
-- to price_history table.

ALTER TABLE price_history
  ADD COLUMN IF NOT EXISTS turnover  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS change_pct DOUBLE PRECISION;

COMMENT ON COLUMN price_history.turnover   IS 'Protrgovani iznos u EUR za taj dan';
COMMENT ON COLUMN price_history.change_pct IS 'Dnevna postotna promjena cijene (%)';
