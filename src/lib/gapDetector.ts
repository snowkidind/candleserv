import { query } from "../db/pool";
import { upsertGap, setGapState, markAlertSent, getPendingGaps } from "../db/gaps";
import { healMinute } from "./healer";
import { recordError } from "../db/errors";
import { getSettingInt } from "../db/appSettings";
import { log, logError } from "./log";

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

  for (const row of res.rows) {
    const ts = new Date(row.expected_ts as string);
    await upsertGap(ts);
    log(`[gapDetector] gap detected: ${ts.toISOString()}`);
    await recordError("collector", "gapDetector", `Gap detected at ${ts.toISOString()}`);
  }
}

/**
 * Attempt to heal all pending gaps.
 */
async function healPendingGaps(): Promise<void> {
  const gaps = await getPendingGaps();
  if (!gaps.length) return;

  const webhookUrl = (await query(`SELECT value FROM app_settings WHERE key = $1`, [ALERT_WEBHOOK_KEY]))
    .rows[0]?.value as string | undefined;

  for (const gap of gaps) {
    await setGapState(gap.id, "healing");

    // Alert on first detection
    if (!gap.alertSent && webhookUrl) {
      await fireWebhook(webhookUrl, {
        type: "gap_detected",
        timestamp: gap.timestamp.toISOString(),
        durationMinutes: gap.durationMinutes,
        sourcesAvailable: gap.sourcesAvailable,
      });
      await markAlertSent(gap.id);
    }

    const healed = await healMinute(gap.timestamp);
    if (healed) {
      await setGapState(gap.id, "healed");
      log(`[gapDetector] healed gap: ${gap.timestamp.toISOString()}`);
    } else {
      await setGapState(gap.id, "unresolvable");
      logError(`[gapDetector] unresolvable gap: ${gap.timestamp.toISOString()}`);
    }
  }
}

/**
 * Full scan: detect + heal. Run on startup (7-day window) and hourly.
 */
export async function runGapScan(windowDays = 1): Promise<void> {
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
  }
}

/**
 * Startup scan (7 days) + hourly scheduled scan (1 day).
 */
export async function startGapDetector(): Promise<void> {
  log("[gapDetector] startup scan (7 days)");
  await runGapScan(7);

  // Hourly scan
  setInterval(() => {
    runGapScan(1).catch((err) => logError("[gapDetector] hourly scan failed:", err));
  }, 60 * 60 * 1000);
}
