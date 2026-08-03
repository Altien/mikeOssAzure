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
  args: [
    "--ignore-certificate-errors",
    // Chrome's Local/Private Network Access checks silently block a public
    // origin (word-edit.officeapps.live.com) from iframing localhost — which
    // is exactly what a sideloaded dev add-in is. Disable for the demo.
    "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults,PrivateNetworkAccessForIframes",
  ],
  ...(mode === "record"
    ? { recordVideo: { dir: OUT_DIR, size: { width: 1600, height: 950 } } }
    : {}),
});
const page = context.pages()[0] ?? (await context.newPage());

const shot = async (name) =>
  page
    .screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false })
    .catch(() => {});

// Hostname-anchored login-page detection. A bare substring test on the full
// URL (CodeQL js/incomplete-url-substring-sanitization) would also match
// attacker-shaped hosts like "login.microsoftonline.com.evil.test" or paths
// that merely embed the domain string.
function isLoginUrl(url) {
  try {
    const { hostname } = new URL(url);
    return ["login.microsoftonline.com", "login.live.com"].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

async function signedIn() {
  // Logged-out office.com does NOT redirect to login — it shows a marketing
  // page with prominent "Sign in" buttons. Treat their presence as no
  // session; the signed-in home never shows them.
  await page.goto("https://www.office.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  if (isLoginUrl(page.url())) return false;
  const signInButton = page
    .getByRole("button", { name: /^sign in$/i })
    .or(page.getByRole("link", { name: /^sign in$/i }));
  return !(await signInButton.first().isVisible().catch(() => false));
}

if (mode === "login") {
  if (await signedIn()) {
    console.log("Already signed in — profile is ready. Run with --record.");
    await context.close();
    process.exit(0);
  }

  // Kick off the real login flow (the logged-out office.com page itself is
  // NOT on a login domain, so "left the login domain" is useless as a done
  // signal — poll for an actually signed-in home page instead).
  console.log("Sign in to your Microsoft account in the opened window…");
  console.log("(This window stays open until you finish — up to 10 minutes.)");
  await page.goto(
    "https://www.office.com/login?ru=%2F&es=Click&cs=ShellSignedOut",
    { waitUntil: "domcontentloaded" },
  );

  const deadline = Date.now() + 10 * 60 * 1000;
  let captured = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000).catch(() => {});
    if (page.isClosed()) break;
    const url = page.url();
    // Never re-navigate while the user is still typing on a login or
    // signup page (same hostname-anchored check as isLoginUrl).
    if (isLoginUrl(url) || /signup/i.test(url)) continue;
    if (await signedIn()) {
      captured = true;
      break;
    }
  }
  if (captured) {
    console.log("Session captured. Run with --record.");
  } else {
    console.log(
      "No signed-in session detected (window closed or timed out). Re-run --login to try again.",
    );
  }
  await context.close().catch(() => {});
  process.exit(captured ? 0 : 1);
}

// ---- record mode -----------------------------------------------------------
// Selectors below were established by live recon (word-web-probe*.mjs), not
// guessed: the canvas is #WACViewPanel_EditingElement inside the
// WacFrame_Word_0 iframe; the ribbon Add-ins flyout is #InsertAddInFlyout;
// "More Add-ins" opens the Office Add-ins dialog in a cross-origin iframe
// whose name starts with "_xdm_".
if (!(await signedIn())) {
  console.error(
    "No Microsoft session in the profile. Run --login first and sign in.",
  );
  await context.close();
  process.exit(1);
}

// On any step failure: screenshot + dump every frame's labelled controls so
// the next iteration is informed, then exit non-zero.
async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`Step failed: ${name}: ${String(error).slice(0, 300)}`);
    await shot(`fail-${name}`);
    const dump = [];
    for (const frame of page.frames()) {
      try {
        dump.push({
          frame: frame.name() || frame.url().slice(0, 100),
          items: await frame.evaluate(() =>
            [...document.querySelectorAll(
              "button, [role='button'], [role='menuitem'], [role='tab'], a, input",
            )]
              .map((el) => ({
                label: (el.getAttribute("aria-label") || el.textContent || el.placeholder || "")
                  .trim()
                  .replace(/\s+/g, " ")
                  .slice(0, 70),
                id: el.id,
                type: el.getAttribute("type"),
                role: el.getAttribute("role") || el.tagName.toLowerCase(),
                visible: el.getBoundingClientRect().width > 0,
              }))
              .filter((item) => item.label || item.type === "file"),
          ),
        });
      } catch {
        /* cross-origin */
      }
    }
    fs.writeFileSync(
      path.join(OUT_DIR, `fail-${name}.json`),
      JSON.stringify(dump, null, 2),
    );
    await context.close().catch(() => {});
    process.exit(1);
  }
}

async function waitForFrame(match, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find(match);
    if (frame) return frame;
    await page.waitForTimeout(1000);
  }
  throw new Error("frame not found in time");
}

await step("open-new-doc", async () => {
  await page.goto("https://word.cloud.microsoft/new", {
    waitUntil: "domcontentloaded",
  });
});

const wac = page.frameLocator('iframe[name^="WacFrame"]');
const canvas = wac.locator("#WACViewPanel_EditingElement");

await step("type-contract", async () => {
  await canvas.waitFor({ timeout: 180_000 });
  // Word online keeps loading after the canvas exists; typing too early is
  // silently dropped. Settle, then type INTO the canvas element (focus
  // follows the locator) and verify the text actually landed — retry once.
  await page.waitForTimeout(8000);
  await shot("02-blank-doc");
  const contract = [
    "SERVICES AGREEMENT",
    "",
    "1. The Suplier shall provide the consulting services described in Schedule 1 with reasonable skill and care.",
    "",
    "2. The Client shall pay all invoices within thirty (30) days of reciept.",
  ].join("\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    await canvas.click();
    await page.waitForTimeout(1000);
    await canvas.pressSequentially(contract, { delay: 10 });
    const landed = await wac
      .getByText("SERVICES AGREEMENT")
      .first()
      .isVisible()
      .catch(() => false);
    if (landed) break;
    if (attempt === 1) throw new Error("typed contract never appeared in the document");
    await page.waitForTimeout(5000);
  }
  await shot("03-contract-typed");
});

const dialogFrame = await step("open-addins-dialog", async () => {
  // The flyout ignores clicks while the ribbon is still initializing —
  // retry the toggle until "More Add-ins" actually renders.
  const more = wac.getByText(/^more add-ins$/i).first();
  for (let attempt = 0; attempt < 4; attempt++) {
    await wac.locator("#InsertAddInFlyout").click();
    try {
      await more.waitFor({ timeout: 8000 });
      break;
    } catch {
      if (attempt === 3) throw new Error("Add-ins flyout never opened");
      await page.waitForTimeout(2000);
    }
  }
  await more.click();
  const frame = await waitForFrame(
    (f) => f.name().startsWith("_xdm_"),
    60_000,
  );
  await frame.getByRole("tab", { name: /my add-ins/i }).click({ timeout: 60_000 });
  await shot("04-my-addins-tab");
  return frame;
});

await step("upload-manifest", async () => {
  // "Upload My Add-in" lives inside the "Manage My Add-ins" dropdown
  // (#ManageInner). The dropdown renders a NEW visible menu item; the
  // always-hidden #UploadMenuInner anchor is a decoy — click whichever
  // "Upload My Add-in" element is actually visible.
  await dialogFrame.locator("#ManageInner").click();
  const uploadCandidates = dialogFrame.getByText(/upload my add-in/i);
  let upload = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !upload) {
    for (const candidate of await uploadCandidates.all()) {
      if (await candidate.isVisible().catch(() => false)) {
        upload = candidate;
        break;
      }
    }
    if (!upload) await page.waitForTimeout(1000);
  }
  if (!upload) throw new Error("no visible 'Upload My Add-in' menu item");
  const chooserPromise = page
    .waitForEvent("filechooser", { timeout: 8_000 })
    .catch(() => null);
  await upload.click();
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(MANIFEST);
  } else {
    const input = dialogFrame.locator('input[type="file"]').first();
    await input.waitFor({ state: "attached", timeout: 15_000 });
    await input.setInputFiles(MANIFEST);
  }
  await shot("05-manifest-chosen");
  await dialogFrame
    .getByRole("button", { name: /^upload$/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
});

const paneFrame = await step("open-task-pane", async () => {
  // Sideloading usually opens the pane; otherwise click the ribbon button
  // the manifest adds (Home → Mike).
  try {
    return await waitForFrame((f) => f.url().includes("localhost:3000"), 30_000);
  } catch {
    await wac.getByRole("button", { name: /mike/i }).first().click();
    return await waitForFrame((f) => f.url().includes("localhost:3000"), 60_000);
  }
});

await step("sign-in-to-mike", async () => {
  await paneFrame.getByPlaceholder("you@firm.com").fill("demo@mike.local", { timeout: 120_000 });
  await paneFrame.getByPlaceholder("••••••••").fill("MikeDemo!2026");
  await paneFrame.getByRole("button", { name: "Sign in" }).click();
  await paneFrame.getByRole("tab", { name: "Chat" }).waitFor({ timeout: 60_000 });
  await shot("06-mike-signed-in");
});

await step("chat-redlines", async () => {
  await paneFrame.getByRole("switch", { name: "Suggest tracked edits" }).click();
  await paneFrame
    .getByPlaceholder("Ask Mike…")
    .fill("Fix the spelling mistakes in this agreement.");
  await paneFrame.getByRole("button", { name: "Send" }).click();
  const apply = paneFrame.getByRole("button", { name: /Apply \d+ tracked edits?/ });
  await apply.waitFor({ timeout: 180_000 });
  await shot("07-redlines-proposed");
  await apply.click();
  await paneFrame.getByText(/Applied \d+ of \d+/).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4000); // let the redlines render in the document
  await shot("08-redlines-applied");
});

console.log("Recorded. Videos + screenshots in", OUT_DIR);
await context.close();
