/**
 * Human-usable interactive menu for the candleserv operator CLI — same house
 * style as the other servs' cli/menu.ts. It does NOT reimplement anything: each
 * choice shells out to `cli/ctl.ts <command>`, so the scriptable interface
 * stays the single source of truth (and is still callable directly for automation).
 *
 * Launched by cli/index.ts:
 *   npx tsx cli/index.ts        # interactive menu
 *   npx tsx cli/ctl.ts stats    # same action, scriptable
 */
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CTL = path.join(__dirname, "ctl.ts");
const WINDOWS = ["1h", "4h", "8h", "24h"];

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on("close", () => process.exit(0));

function getAnswer(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question("\n" + prompt + "\n> ", (a) => resolve(a.trim())));
}

// Run the scriptable CLI as a subprocess, inheriting stdio so its output prints
// straight through. Never rejects — a failed command shouldn't kill the menu.
function runCtl(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", CTL, ...args], { stdio: "inherit" });
    child.on("close", () => resolve());
    child.on("error", (err) => { console.error("  failed to run ctl:", err.message); resolve(); });
  });
}

// API request-counter submenu: pick a window, show its full per-source breakdown,
// stay here until the operator backs out. Same recursive style as runMenu().
async function apiMenu(): Promise<void> {
  const menu =
    "  --- API request counters ---\n" +
    "  1    1h   full per-source breakdown\n" +
    "  2    4h   full per-source breakdown\n" +
    "  3    8h   full per-source breakdown\n" +
    "  4    24h  full per-source breakdown\n" +
    "  b    Back\n" +
    "  q    Quit";

  const ans = await getAnswer(menu);
  if (ans === "b" || ans === "") return;
  if (ans === "q") { console.log("  Exit."); rl.close(); return; }

  const win = WINDOWS[Number(ans) - 1];
  if (win) await runCtl(["api", win]);
  else console.log(`  Unknown option: ${ans}`);

  return apiMenu();
}

export async function runMenu(): Promise<void> {
  const menu =
    "  ####### candleserv cli #######\n" +
    "  s    Runtime stats (heap, token map, rate-limit IPs, SSE, sessions, redis)\n" +
    "  a    API request counters (rolling 1h/4h/8h/24h)\n" +
    "  c    Flush candle cache\n" +
    "  x    Flush all sessions (logs everyone out)\n" +
    "  q    Exit";

  const ans = await getAnswer(menu);
  if (!ans) return runMenu();

  switch (ans) {
    case "s":
      await runCtl(["stats"]);
      break;
    case "a":
      await apiMenu();
      break;
    case "c":
      await runCtl(["cache:flush"]);
      break;
    case "x": {
      const confirm = await getAnswer("  Flush ALL sessions — logs out everyone (including you). Type 'yes' to confirm:");
      if (confirm === "yes") await runCtl(["sessions:flush"]);
      else console.log("  Cancelled.");
      break;
    }
    case "q":
      console.log("  Exit.");
      rl.close();
      return;
    default:
      console.log(`  Unknown option: ${ans}`);
  }

  return runMenu();
}
