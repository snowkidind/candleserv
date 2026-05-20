/**
 * Mint an api_keys row for a consumer service (biasserv, phaseserv, dataserv, …).
 *
 * Invoked once per consumer by the ss-devops installer's Phase 10, and usable
 * standalone by operators of candleserv-as-product for key rotation or
 * recovery of a lost secret. Talks directly to the candleserv DB via the
 * existing apiKeys.ts helpers — does not require the HTTP server to be up.
 *
 * Usage:
 *   npx tsx scripts/mintConsumerKey.ts <service-name> [--env <DEV|PROD>] [--rotate]
 *
 * On success prints exactly two lines to stdout (parsable with grep+sed):
 *   CANDLESERV_API_KEY=<apiKey>
 *   CANDLESERV_SECRET=<secret>
 *
 * Exit codes: 0 success · 1 runtime/policy error · 2 bad CLI args.
 */
process.env.TZ = "UTC";        // must be set before any Date is constructed
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "../.env") });

import { getPool } from "../src/db/pool";
import { createApiKey, listApiKeys, revokeApiKey } from "../src/db/apiKeys";

const USAGE = "usage: npx tsx scripts/mintConsumerKey.ts <service-name> [--env <DEV|PROD>] [--rotate]";

interface Args {
  service: string;
  env: "DEV" | "PROD";
  rotate: boolean;
}

function parseArgs(): Args {
  const raw = process.argv.slice(2);
  let service: string | null = null;
  let env: "DEV" | "PROD" = "DEV";
  let rotate = false;

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--rotate") {
      rotate = true;
    } else if (a === "--env") {
      const v = raw[i + 1];
      if (v !== "DEV" && v !== "PROD") {
        throw new ArgError(`--env must be DEV or PROD (got ${v ?? "<missing>"})`);
      }
      env = v;
      i++;
    } else if (a.startsWith("--env=")) {
      const v = a.slice("--env=".length);
      if (v !== "DEV" && v !== "PROD") {
        throw new ArgError(`--env must be DEV or PROD (got ${v})`);
      }
      env = v;
    } else if (a.startsWith("--")) {
      throw new ArgError(`unknown flag: ${a}`);
    } else if (service === null) {
      service = a;
    } else {
      throw new ArgError(`unexpected positional argument: ${a}`);
    }
  }

  if (!service) throw new ArgError("missing required <service-name>");
  if (!/^[a-z][a-z0-9-]*$/i.test(service)) {
    throw new ArgError(`invalid service name: ${service}`);
  }

  return { service, env, rotate };
}

class ArgError extends Error {}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs();
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(`${err.message}\n${USAGE}\n`);
      process.exit(2);
    }
    throw err;
  }

  const label = `${args.service}-${args.env.toLowerCase()}`;

  const existing = (await listApiKeys()).filter(
    (k) => k.label === label && k.enabled
  );

  if (existing.length > 0 && !args.rotate) {
    process.stderr.write(
      `error: ${existing.length} existing enabled key(s) found for label "${label}".\n` +
      `       the secret of an existing key is unrecoverable; re-run with --rotate\n` +
      `       to revoke the old key(s) and mint a fresh one.\n`
    );
    await getPool().end();
    process.exit(1);
  }

  if (existing.length > 0) {
    process.stderr.write(`revoking ${existing.length} existing key(s) for label "${label}":\n`);
    for (const k of existing) {
      await revokeApiKey(k.apiKey);
      process.stderr.write(`  revoked apiKey=${k.apiKey} (id=${k.id})\n`);
    }
  }

  const { apiKey, secret } = await createApiKey(label);
  process.stderr.write(`minted new key for label "${label}"\n`);

  process.stdout.write(`CANDLESERV_API_KEY=${apiKey}\n`);
  process.stdout.write(`CANDLESERV_SECRET=${secret}\n`);

  await getPool().end();
}

main().catch((err: Error) => {
  process.stderr.write(`mintConsumerKey FAILED: ${err.message}\n`);
  if (err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
