-- Materialized daily / weekly candle indexes.
--
-- Purpose: serve fast daily and weekly OHLCV without the on-demand plpgsql
-- aggregation in func.sql, which recomputes every bar from candles_1m on each
-- call (a deep weekly window measured ~600ms cold vs ~8ms warm). These tables
-- precompute the bars once so reads are simple indexed row fetches (target
-- 3-6ms for ~50 weekly bars). NOT wired into candleserv's REST surface yet —
-- for now the data is pulled directly (candleserv_ro). A cron + endpoints come
-- later.
--
-- Idempotent: re-applying this file is a no-op (IF NOT EXISTS / OR REPLACE), and
-- the incremental functions only append bars newer than what is already stored
-- (INSERT ... ON CONFLICT DO NOTHING), so re-running them never duplicates or
-- mutates a completed bar.
--
-- Conventions — VALIDATED bar-for-bar against candleserv's live /v1/candles
-- (tf=1d and tf=7d) on 2026-06-11:
--   * UTC throughout (SET LOCAL timezone = 'UTC').
--   * Daily bar  = [D 00:00, D+1 00:00), labeled by its START (D 00:00).
--   * Weekly bar = [Thu 00:00, +7d), labeled by its START Thursday. candleserv's
--     7d bars are Thursday-aligned (Unix epoch day 0 is a Thursday), so weeks
--     are anchored to Thursday to match.
--   * open = first 1m open, close = last 1m close, high = max, low = min,
--     volume / volumeNormalized = sum, over the bucket.
--   * Only COMPLETE buckets are stored — the in-progress day/week is excluded
--     (it would mutate), exactly as a closed-bar S/R study wants.
--   * Weekly is built FROM candles_1d (day high/low/close/sum roll up to the
--     week identically to aggregating 1m directly), per the daily->weekly chain.

-- ── Tables ───────────────────────────────────────────────────────────────────
-- Column shape mirrors candles_1m's OHLCV subset (both volume and the
-- source-normalized volumeNormalized are kept). PK (currency, timestamp) is also
-- the read index: `WHERE currency=$1 AND timestamp <= $2 ORDER BY timestamp DESC
-- LIMIT n` is a plain backwards range scan on it.

CREATE TABLE IF NOT EXISTS public.candles_1d (
  currency           character varying           NOT NULL,
  timestamp          timestamp with time zone    NOT NULL,
  open               numeric                     NOT NULL,
  high               numeric                     NOT NULL,
  low                numeric                     NOT NULL,
  close              numeric                     NOT NULL,
  volume             numeric                     NOT NULL,
  "volumeNormalized" numeric                     NOT NULL,
  PRIMARY KEY (currency, timestamp)
);

CREATE TABLE IF NOT EXISTS public.candles_1w (
  currency           character varying           NOT NULL,
  timestamp          timestamp with time zone    NOT NULL,
  open               numeric                     NOT NULL,
  high               numeric                     NOT NULL,
  low                numeric                     NOT NULL,
  close              numeric                     NOT NULL,
  volume             numeric                     NOT NULL,
  "volumeNormalized" numeric                     NOT NULL,
  PRIMARY KEY (currency, timestamp)
);

-- Read access for the puller. trendserv reads these directly as candleserv_ro
-- for now; the eventual REST endpoint supersedes that. Idempotent.
GRANT SELECT ON public.candles_1d, public.candles_1w TO candleserv_ro;

-- ── process_days() ───────────────────────────────────────────────────────────
-- For every currency in candles_1m, find the last synchronized day (max stored
-- timestamp; none -> from the start of history) and append every COMPLETE day
-- after it, aggregated from candles_1m. Returns the number of day bars inserted.
--
-- "Recurses through the unsynchronized candles" set-wise: one INSERT..SELECT over
-- only the unsynced 1m range, which is the SQL-idiomatic (and far cheaper) form
-- of iterating bar-by-bar. ON CONFLICT DO NOTHING makes a re-run a no-op.

CREATE OR REPLACE FUNCTION public.process_days()
  RETURNS integer
  LANGUAGE plpgsql
AS $function$
DECLARE
  _inserted integer := 0;
BEGIN
  SET LOCAL timezone TO 'UTC';

  INSERT INTO public.candles_1d
    (currency, timestamp, open, high, low, close, volume, "volumeNormalized")
  SELECT currency, bucket, open, high, low, close, volume, vol_norm
  FROM (
    SELECT
      currency,
      bucket,
      (array_agg(open  ORDER BY ts ASC ))[1] AS open,
      max(high)                              AS high,
      min(low)                               AS low,
      (array_agg(close ORDER BY ts DESC))[1] AS close,
      sum(volume)                            AS volume,
      sum(vol_norm)                          AS vol_norm
    FROM (
      SELECT
        m.currency,
        m.timestamp                       AS ts,
        m.open, m.high, m.low, m.close,
        m.volume,
        m."volumeNormalized"              AS vol_norm,
        date_trunc('day', m.timestamp)    AS bucket
      FROM public.candles_1m m
      WHERE m.timestamp >= COALESCE(
              (SELECT max(d.timestamp) + interval '1 day'
                 FROM public.candles_1d d
                WHERE d.currency = m.currency),
              '-infinity'::timestamptz)
    ) src
    GROUP BY currency, bucket
  ) agg
  -- Only complete days: drop the bucket that contains the latest 1m row for the
  -- currency (the in-progress day).
  WHERE agg.bucket < date_trunc('day',
          (SELECT max(mm.timestamp) FROM public.candles_1m mm WHERE mm.currency = agg.currency))
  ON CONFLICT (currency, timestamp) DO NOTHING;

  GET DIAGNOSTICS _inserted = ROW_COUNT;
  RETURN _inserted;
END;
$function$;

-- ── process_weeks() ──────────────────────────────────────────────────────────
-- Same shape as process_days(), but reads candles_1d and rolls 7 day bars into a
-- Thursday-anchored week. Only weeks with all 7 day bars present are stored, so
-- the current partial week is excluded until it closes. Returns rows inserted.

CREATE OR REPLACE FUNCTION public.process_weeks()
  RETURNS integer
  LANGUAGE plpgsql
AS $function$
DECLARE
  _inserted integer := 0;
BEGIN
  SET LOCAL timezone TO 'UTC';

  INSERT INTO public.candles_1w
    (currency, timestamp, open, high, low, close, volume, "volumeNormalized")
  SELECT currency, wk, open, high, low, close, volume, vol_norm
  FROM (
    SELECT
      currency,
      wk,
      (array_agg(open  ORDER BY day ASC ))[1] AS open,
      max(high)                               AS high,
      min(low)                                AS low,
      (array_agg(close ORDER BY day DESC))[1] AS close,
      sum(volume)                             AS volume,
      sum(vol_norm)                           AS vol_norm,
      count(*)                                AS ndays
    FROM (
      SELECT
        d.currency,
        d.timestamp AS day,
        d.open, d.high, d.low, d.close,
        d.volume,
        d."volumeNormalized" AS vol_norm,
        -- Thursday on-or-before this day: dow 4 = Thursday; subtract (dow+3)%7.
        d.timestamp - ((extract(dow FROM d.timestamp)::int + 3) % 7) * interval '1 day' AS wk
      FROM public.candles_1d d
      WHERE d.timestamp >= COALESCE(
              (SELECT max(w.timestamp) + interval '7 days'
                 FROM public.candles_1w w
                WHERE w.currency = d.currency),
              '-infinity'::timestamptz)
    ) src
    GROUP BY currency, wk
  ) agg
  WHERE agg.ndays = 7   -- complete weeks only
  ON CONFLICT (currency, timestamp) DO NOTHING;

  GET DIAGNOSTICS _inserted = ROW_COUNT;
  RETURN _inserted;
END;
$function$;

-- ── process_candle_indexes() ─────────────────────────────────────────────────
-- Operator entry point: bring both indexes current. Days first (weeks read from
-- days). CALL public.process_candle_indexes();
CREATE OR REPLACE PROCEDURE public.process_candle_indexes()
  LANGUAGE plpgsql
AS $procedure$
DECLARE
  _days  integer;
  _weeks integer;
BEGIN
  _days  := public.process_days();
  _weeks := public.process_weeks();
  RAISE NOTICE 'process_candle_indexes: % day bar(s), % week bar(s) inserted', _days, _weeks;
END;
$procedure$;
