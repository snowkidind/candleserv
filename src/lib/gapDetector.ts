import { query } from "../db/pool.js";
import { upsertGap, setGapState, markAlertSent, getPendingGaps } from "../db/gaps.js";
import { healRange, reHealLowConfidence, runBackfill, isBackfillRunning } from "./healer.js";
import { recordError } from "../db/errors.js";
import { getSettingInt, setSetting } from "../db/appSettings.js";
import { log, logError } from "./log.js";
import { beginActivity, endActivity } from "./healerStatus.js";

const ALERT_WEBHOOK_KEY = "alertWebhookUrl";

async function fireWebhook(url: string, body: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Webhook failures are non-fatal
  }
}

/**
 * Find missing minute slots in a time window and upsert them into the gaps table.
 */
async function detectGapsInWindow(from: Date, to: Date): Promise<void> {
  const res = await query(
    `SELECT gs AS expected_ts
     FROM generate_series($1::timestamptz, $2::timestamptz - INTERVAL '1 minute', INTERVAL '1 minute') gs
     LEFT JOIN candles_1m c ON c."timestamp" = gs
     WHERE c."timestamp" IS NULL
     ORDER BY gs ASC`,
    [from, to]
  );

  if (!res.rows.length) return;

  for (const row of res.rows) {
    const ts = new Date(row.expected_ts as string);
    await upsertGap(ts);
  }

  log(`[gapDetector] detected ${res.rows.length} gap(s) in window ${from.toISOString().slice(0, 16)} → ${to.toISOString().slice(0, 16)}`);

  if (res.rows.length > 100) {
    await recordError("collector", "gapDetector", `${res.rows.length} gaps detected — DB likely empty, backfill running`);
  }
}

/**
 * Group GapRows into contiguous ranges (gaps ≤ 2 minutes apart are merged).
 * Returns an array of { from, to, gaps } — one entry per contiguous block.
 */
function groupGapsIntoRanges(gaps: Awaited<ReturnType<typeof getPendingGaps>>) {
  const sorted = [...gaps].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const ranges: { from: Date; to: Date; gaps: typeof sorted }[] = [];
  let block = [sorted[0]];
  let prev  = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    if (curr.timestamp.getTime() - prev.timestamp.getTime() > 2 * 60000) {
      ranges.push({
        from: block[0].timestamp,
        to:   new Date(prev.timestamp.getTime() + 60000),
        gaps: block,
      });
      block = [curr];
    } else {
      block.push(curr);
    }
    prev = curr;
  }
  ranges.push({
    from: block[0].timestamp,
    to:   new Date(prev.timestamp.getTime() + 60000),
    gaps: block,
  });
  return ranges;
}

/**
 * Heal all pending gaps.
 * Contiguous gaps are fetched as a single range request across all five exchanges
 * rather than one HTTP call per minute, avoiding rate-limit errors.
 */
async function healPendingGaps(): Promise<void> {
  const gaps = await getPendingGaps();
  if (!gaps.length) return;

  if (gaps.length > 100) {
    // Too many to heal inline — hand off to the bulk backfill loop. The
    // backfillComplete flag is a one-way latch set after a successful scan,
    // so on a long-outage restart it's already "true" and runBackfill would
    // short-circuit. Clear it here so the evidence in the gaps table wins
    // over the stale latch.
    log(`[gapDetector] ${gaps.length} pending gaps — triggering backfill`);
    await setSetting("backfillComplete", "false");
    runBackfill().catch((err) => logError("[gapDetector] backfill trigger failed:", err));
    return;
  }

  const webhookUrl = (await query(`SELECT value FROM app_settings WHERE key = $1`, [ALERT_WEBHOOK_KEY]))
    .rows[0]?.value as string | undefined;

  const ranges = groupGapsIntoRanges(gaps);
  let healed = 0;
  let unresolvable = 0;

  for (const range of ranges) {
    // Mark all gaps in this range as healing and fire alerts
    for (const gap of range.gaps) {
      await setGapState(gap.id, "healing");
      if (!gap.alertSent && webhookUrl) {
        await fireWebhook(webhookUrl, {
          type: "gap_detected",
          timestamp: gap.timestamp.toISOString(),
          durationMinutes: gap.durationMinutes,
          sourcesAvailable: gap.sourcesAvailable,
        });
        await markAlertSent(gap.id);
      }
    }

    // Fetch the whole range from all exchanges in one pass
    const written = await healRange(range.from, range.to, true);

    // Update each gap's state based on whether its minute was written
    for (const gap of range.gaps) {
      if (written.has(gap.timestamp.getTime())) {
        await setGapState(gap.id, "healed");
        healed++;
      } else {
        await setGapState(gap.id, "unresolvable");
        unresolvable++;
        logError(`[gapDetector] unresolvable gap: ${gap.timestamp.toISOString()}`);
      }
    }
  }

  if (healed > 0) log(`[gapDetector] healed ${healed} gap(s) across ${ranges.length} range(s)`);
}

/**
 * Full scan: detect + heal. Run on startup (7-day window) and hourly.
 */
export async function runGapScan(windowDays = 1): Promise<void> {
  beginActivity("gapScan", { windowDays });
  try {
    const to = new Date();
    // Round down to completed minutes
    to.setSeconds(0, 0);
    const from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);

    await detectGapsInWindow(from, to);
    await healPendingGaps();
  } catch (err) {
    logError("[gapDetector] runGapScan failed:", err);
    await recordError("healer", "runGapScan", String(err));
  } finally {
    endActivity("gapScan");
  }
}

/**
 * Startup scan (7 days) + hourly scheduled scan (1 day).
 */
export async function startGapDetector(): Promise<void> {
  log("[gapDetector] startup scan (7 days)");
  await runGapScan(7);

  // Upgrade any low-confidence rows — delayed 2s to avoid back-to-back exchange hits.
  // Skip if a backfill is running: both hit the same exchange endpoints over
  // overlapping windows and would race toward rate-limit failures.
  await new Promise(r => setTimeout(r, 2000));
  if (isBackfillRunning()) {
    log("[gapDetector] backfill in progress — skipping reHealLowConfidence");
  } else {
    await reHealLowConfidence(7).catch((err) => logError("[gapDetector] reHealLowConfidence failed:", err));
  }

  // Hourly scan
  setInterval(() => {
    runGapScan(1).catch((err) => logError("[gapDetector] hourly scan failed:", err));
  }, 60 * 60 * 1000);
}
