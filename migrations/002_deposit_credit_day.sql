-- The daily deposit cap counts deposits by the day they were CREDITED (day only, no time).
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS credited_on DATE;
UPDATE deposits SET credited_on = created_at::date WHERE status = 'credited' AND credited_on IS NULL;
