-- Composite type returned by the kline aggregation functions below.
-- Defined idempotently so re-applying this file on an existing DB is a no-op
-- (CREATE OR REPLACE TYPE does not exist in Postgres).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kline_set') THEN
    CREATE TYPE public.kline_set AS (
      date   timestamp without time zone,
      open   numeric,
      close  numeric,
      high   numeric,
      low    numeric,
      volume numeric
    );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.get_kline_day("Currency" character varying, "Ending" timestamp without time zone, "Interval" integer, "NumberOfRecords" integer)
 RETURNS SETOF kline_set
 LANGUAGE plpgsql
AS $function$
DECLARE
  _r            candles_1m%rowtype;
  _open         numeric := 0;
  _train        integer;
  _train_period integer := 2;
  _kline_set    kline_set;
BEGIN
  _train = "NumberOfRecords" + 2;
  FOR _r IN
    SELECT * FROM candles_1m
    WHERE timestamp <= "Ending"
    AND   currency = "Currency"
    AND   timestamp >  "Ending" - INTERVAL '1 DAY' * "Interval" * ("NumberOfRecords" + 2)
    AND   DATE_PART('day',    timestamp)::INTEGER % "Interval" = 0
    AND   DATE_PART('hour',   timestamp)::INTEGER = 0
    AND   DATE_PART('minute', timestamp)::INTEGER = 0
    ORDER BY timestamp ASC LIMIT _train
  LOOP
    DECLARE
      _high   numeric := 0;
      _low    numeric := 0;
      _volume numeric := 0;
      _add    boolean := false;
    BEGIN
      SELECT MAX(high), MIN(low), SUM("volumeNormalized")
        INTO _high, _low, _volume
        FROM candles_1m
       WHERE timestamp <= _r.timestamp
         AND currency = "Currency"
         AND timestamp >  _r.timestamp - INTERVAL '1 DAY' * "Interval";
      IF _train_period > 0 THEN
        _train_period = _train_period - 1;
      ELSE
        _kline_set.date   = _r.timestamp;
        _kline_set.open   = _open;
        _kline_set.close  = _r.close;
        _kline_set.high   = _high;
        _kline_set.low    = _low;
        _kline_set.volume = _volume;
        _add = true;
      END IF;
      _open = _r.close;
      IF _add THEN
        RETURN NEXT _kline_set;
      END IF;
    END;
  END LOOP;
  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_kline_hour("Currency" character varying, "Ending" timestamp without time zone, "Interval" integer, "NumberOfRecords" integer)
 RETURNS SETOF kline_set
 LANGUAGE plpgsql
AS $function$
DECLARE
  _r            candles_1m%rowtype;
  _open         numeric := 0;
  _train        integer;
  _train_period integer := 2;
  _kline_set    kline_set;
BEGIN
  _train = "NumberOfRecords" + 2;
  FOR _r IN
    SELECT * FROM candles_1m
    WHERE timestamp <= "Ending"
    AND   currency = "Currency"
    AND   timestamp >  "Ending" - INTERVAL '1 HOUR' * "Interval" * ("NumberOfRecords" + 2)
    AND   DATE_PART('hour',   timestamp)::INTEGER % "Interval" = 0
    AND   DATE_PART('minute', timestamp)::INTEGER = 0
    ORDER BY timestamp ASC LIMIT _train
  LOOP
    DECLARE
      _high   numeric := 0;
      _low    numeric := 0;
      _volume numeric := 0;
      _add    boolean := false;
    BEGIN
      SELECT MAX(high), MIN(low), SUM("volumeNormalized")
        INTO _high, _low, _volume
        FROM candles_1m
       WHERE timestamp <= _r.timestamp
         AND currency = "Currency"
         AND timestamp >  _r.timestamp - INTERVAL '1 HOUR' * "Interval";
      IF _train_period > 0 THEN
        _train_period = _train_period - 1;
      ELSE
        _kline_set.date   = _r.timestamp;
        _kline_set.open   = _open;
        _kline_set.close  = _r.close;
        _kline_set.high   = _high;
        _kline_set.low    = _low;
        _kline_set.volume = _volume;
        _add = true;
      END IF;
      _open = _r.close;
      IF _add THEN
        RETURN NEXT _kline_set;
      END IF;
    END;
  END LOOP;
  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_kline_minute("Currency" character varying, "Ending" timestamp without time zone, "Interval" integer, "NumberOfRecords" integer)
 RETURNS SETOF kline_set
 LANGUAGE plpgsql
AS $function$
DECLARE
  _r            candles_1m%rowtype;
  _open         numeric := 0;
  _train        integer;
  _train_period integer := 2;
  _kline_set    kline_set;
BEGIN
  _train = "NumberOfRecords" + 2;
  FOR _r IN
    SELECT * FROM candles_1m
    WHERE timestamp <= "Ending"
    AND   currency = "Currency"
    AND   timestamp >  "Ending" - INTERVAL '1 MINUTE' * "Interval" * ("NumberOfRecords" + 2)
    AND   DATE_PART('minute', timestamp)::INTEGER % "Interval" = 0
    ORDER BY timestamp ASC LIMIT _train
  LOOP
    DECLARE
      _high   numeric := 0;
      _low    numeric := 0;
      _volume numeric := 0;
      _add    boolean := false;
    BEGIN
      SELECT MAX(high), MIN(low), SUM("volumeNormalized")
        INTO _high, _low, _volume
        FROM candles_1m
       WHERE timestamp <= _r.timestamp
         AND currency = "Currency"
         AND timestamp >  _r.timestamp - INTERVAL '1 MINUTE' * "Interval";
      IF _train_period > 0 THEN
        _train_period = _train_period - 1;
      ELSE
        _kline_set.date   = _r.timestamp;
        _kline_set.open   = _open;
        _kline_set.close  = _r.close;
        _kline_set.high   = _high;
        _kline_set.low    = _low;
        _kline_set.volume = _volume;
        _add = true;
      END IF;
      _open = _r.close;
      IF _add THEN
        RETURN NEXT _kline_set;
      END IF;
    END;
  END LOOP;
  RETURN;
END;
$function$;
