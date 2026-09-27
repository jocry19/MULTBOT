-- Retention: drop whole day partitions older than a cutoff (cheap, no table bloat).
CREATE OR REPLACE FUNCTION drop_daily_partitions_before(parent TEXT, cutoff DATE) RETURNS INTEGER AS $$
DECLARE
  r RECORD;
  dropped INTEGER := 0;
  suffix TEXT;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = parent
  LOOP
    suffix := right(r.relname, 8);
    IF suffix ~ '^\d{8}$' AND to_date(suffix, 'YYYYMMDD') < cutoff THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END;
$$ LANGUAGE plpgsql;
