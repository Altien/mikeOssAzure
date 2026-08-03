/**
 * Drive the Mike add-in inside REAL Word on the web, recording video.
 *
 * Word online requires a signed-in Microsoft account, which no automation can
 * (or should) create. So this runs in two modes against ONE persistent
 * browser profile:
 *
 *   node e2e-live/word-web-session.mjs --login
 *     Opens office.com headed. Sign in manually once; the script detects the
 *     session and exits. The profile (~/.cache/mike-word-web-profile) keeps
 *     the cookies for later automated runs.
 *
 *   node e2e-live/word-web-session.mjs --record
 *     Reuses the saved session: opens a new Word document, sideloads
 *     manifest.xml via Add-ins → Upload My Add-in, opens the Mike pane,
 *     signs into Mike, and exercises chat redlines. Records video +
 *     step screenshots to ~/Desktop/mike-word-addin-videos/word-on-the-web/.
 *
 * Prereqs for --record: the add-in dev server on https://localhost:3000 and
 * the Mike backend on :3001 (see scripts/dev.sh), demo user seeded.
 */
import { chromium } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PROFILE = path.join(os.homedir(), ".cache", "mike-word-web-profile");
const OUT_DIR = path.join(
  os.homedir(),
  "Desktop",
  "mike-word-addin-videos",
  "word-on-the-web",
);
const MANIFEST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "manifest.xml",
);

const mode = process.argv.includes("--login")
  ? "login"
  : process.argv.includes("--record")
    ? "record"
    : null;
if (!mode) {
  console.error("Usage: node e2e-live/word-web-session.mjs --login | --record");
  process.exit(2);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1600, height: 950 },
  ignoreHTTPSErrors: true,
  args: ["--ignore-certificate-errors"],
  ...(mode === "record"
    ? { recordVideo: { dir: OUT_DIR, size: { width: 1600, height: 950 } } }
    : {}),
});
const page = context.pages()[0] ?? (await context.newPage());

const shot = async (name) =>
  page
    .screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false })
    .catch(() => {});

async function signedIn() {
  // Logged-out office.com does NOT redirect to login — it shows a marketing
  // page with prominent "Sign in" buttons. Treat their presence as no
  // session; the signed-in home never shows them.
  await page.goto("https://www.office.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  if (page.url().includes("login.microsoftonline.com")) return false;
  const signInButton = page
    .getByRole("button", { name: /^sign in$/i })
    .or(page.getByRole("link", { name: /^sign in$/i }));
  return !(await signInButton.first().isVisible().catch(() => false));
}

if (mode === "login") {
  const already = await signedIn();
  if (already) {
    console.log("Already signed in — profile is ready. Run with --record.");
  } else {
    console.log("Sign in to your Microsoft account in the opened window…");
    await page.waitForURL((url) => !url.href.includes("login.microsoftonline.com"), {
      timeout: 10 * 60 * 1000,
    });
    console.log("Session captured. Run with --record.");
  }
  await context.close();
  process.exit(0);
}

// ---- record mode -----------------------------------------------------------
if (!(await signedIn())) {
  console.error(
    "No Microsoft session in the profile. Run --login first and sign in.",
  );
  await context.close();
  process.exit(1);
}
await shot("01-office-home");

// New blank Word document (opens in its own tab).
await page.goto("https://word.cloud.microsoft/new", {
  waitUntil: "domcontentloaded",
});
// The editing canvas lives in the "WacFrame" iframe once the doc is ready.
const wac = page.frameLocator('iframe[name="WacFrame"], iframe[id*="WacFrame"]');
const canvas = wac.locator('[contenteditable="true"]').first();
await canvas.waitFor({ timeout: 120_000 });
await shot("02-blank-doc");

// Type a small contract with deliberate typos for the demo.
await canvas.click();
await page.keyboard.type(
  [
    "SERVICES AGREEMENT",
    "",
    "1. The Suplier shall provide the consulting services described in Schedule 1 with reasonable skill and care.",
    "",
    "2. The Client shall pay all invoices within thirty (30) days of reciept.",
  ].join("\n"),
  { delay: 12 },
);
await shot("03-contract-typed");

// Sideload: Home ribbon → Add-ins → More Add-ins → My Add-ins → Upload.
await wac.getByRole("button", { name: /add-ins/i }).first().click();
await shot("04-addins-menu");
const more = wac.getByRole("menuitem", { name: /more add-ins/i }).first();
if (await more.isVisible().catch(() => false)) await more.click();
const dialog = wac.frameLocator('iframe[title*="Office Add-ins"], iframe[src*="addinsdialog"]');
await dialog.getByRole("tab", { name: /my add-ins/i }).click({ timeout: 60_000 });
const upload = dialog.getByText(/upload my add-in/i).first();
const chooser = page.waitForEvent("filechooser", { timeout: 30_000 });
await upload.click();
await (await chooser).setFiles(MANIFEST);
await dialog.getByRole("button", { name: /^upload$/i }).click({ timeout: 15_000 }).catch(() => {});
await shot("05-manifest-uploaded");

// The task pane iframe appears on the right; sign into Mike and run a flow.
const pane = wac.frameLocator('iframe[src*="localhost:3000"]');
await pane.getByPlaceholder("you@firm.com").fill("demo@mike.local", { timeout: 120_000 });
await pane.getByPlaceholder("••••••••").fill("MikeDemo!2026");
await pane.getByRole("button", { name: "Sign in" }).click();
await pane.getByRole("tab", { name: "Chat" }).waitFor({ timeout: 60_000 });
await shot("06-mike-signed-in");

await pane.getByRole("switch", { name: "Suggest tracked edits" }).click();
await pane.getByPlaceholder("Ask Mike…").fill("Fix the spelling mistakes in this agreement.");
await pane.getByRole("button", { name: "Send" }).click();
const apply = pane.getByRole("button", { name: /Apply \d+ tracked edits?/ });
await apply.waitFor({ timeout: 180_000 });
await shot("07-redlines-proposed");
await apply.click();
await pane.getByText(/Applied \d+ of \d+/).waitFor({ timeout: 60_000 });
await page.waitForTimeout(3000); // let the redlines render in the document
await shot("08-redlines-applied");

console.log("Recorded. Videos + screenshots in", OUT_DIR);
await context.close();
