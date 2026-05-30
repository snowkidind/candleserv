#!/usr/bin/env npx tsx
/**
 * candleserv operator CLI — interactive menu entrypoint.
 *
 * Mirrors the house style used by the other servs: `cli/index.ts` is the thin
 * launcher that wires up the menu and hands off control. All real actions live
 * in sibling modules (menu.ts → ctl.ts) so they stay independently callable.
 *
 *   npx tsx cli/index.ts        # interactive operator menu
 *   npx tsx cli/ctl.ts <command> # same action, scriptable
 */
import { runMenu } from "./menu.js";

runMenu().catch((err) => {
  console.error("\n  Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
