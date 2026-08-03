/**
 * Drive the Mike add-in inside REAL Word on the web, recording video —
 * FULL button tour. Extends word-web-session.mjs (same profile, same
 * sideload path) to exercise every actionable control in the pane:
 *
 *   Chat      : "Suggest tracked edits" switch → Send → "Apply 2 tracked edits"
 *               "Use document as context" switch → Send →
 *               "Insert below cursor" + "Insert below (tracked)"
 *   Actions   : Improve selected text → "Replace selection (tracked)"
 *               Improve selected text → "Replace selection" (plain)
 *               Proofread entire document → "Apply 2 corrections (tracked)"
 *               Find & list PII → "Apply 2 redactions (tracked)"
 *               Draft clause → "Insert below cursor" + "Insert below (tracked)"
 *   Workflows : Run workflow on document → "Insert below cursor"
 *   Projects  : tab renders
 *   Header    : Sign out
 *
 * Each model flow targets DIFFERENT document text (see anthropic-stub.mjs)
 * so the tracked changes never collide:
 *   chat redlines -> Suplier, reciept       proofread -> Schedual, writen
 *   anonymise     -> John Smith, address    improve   -> clauses 4 and 5
 *
 * Prereqs: Microsoft session in ~/.cache/mike-word-web-profile (run the
 * original script with --login), add-in dev server on https://localhost:3000,
 * Mike backend on :3001, demo user seeded.
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

fs.mkdirSync(OUT_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1600, height: 950 },
  ignoreHTTPSErrors: true,
  args: [
    "--ignore-certificate-errors",
    // Word's public editor frame iframes https://localhost:3000; Chrome's
    // Local Network Access checks silently block that for dev sideloads.
    "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults,PrivateNetworkAccessForIframes",
  ],
  recordVideo: { dir: OUT_DIR, size: { width: 1600, height: 950 } },
});
const page = context.pages()[0] ?? (await context.newPage());

let shotIndex = 0;
const shot = async (name) => {
  shotIndex += 1;
  const file = `full-${String(shotIndex).padStart(2, "0")}-${name}.png`;
  await page
    .screenshot({ path: path.join(OUT_DIR, file), fullPage: false })
    .catch(() => {});
};

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
  await page.goto("https://www.office.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  if (isLoginUrl(page.url())) return false;
  const signInButton = page
    .getByRole("button", { name: /^sign in$/i })
    .or(page.getByRole("link", { name: /^sign in$/i }));
  return !(await signInButton.first().isVisible().catch(() => false));
}

if (!(await signedIn())) {
  console.error(
    "No Microsoft session in the profile. Run word-web-session.mjs --login first.",
  );
  await context.close();
  process.exit(1);
}

async function step(name, fn) {
  console.log(`step: ${name}`);
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

// Clicks inside the task-pane iframe (word.cloud.microsoft → officeapps
// _xdm_ frame → localhost:3000) need DOM-dispatched events: Chromium's
// compositor routes real (coordinate) input for this doubly-nested
// cross-origin iframe incorrectly, so locator.click() silently no-ops even
// though Playwright's actionability checks pass. Keyboard input and fill()
// are unaffected. Canvas / add-ins dialog clicks work normally.
async function paneClick(locator, timeoutMs = 180_000) {
  await locator.waitFor({ timeout: timeoutMs });
  await locator.evaluate((el) => el.click());
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
  await page.waitForTimeout(8000);
  await shot("blank-doc");
  // Deliberate flaws, one set per flow: Suplier/reciept (chat redlines),
  // Schedual/writen (proofread), John Smith + address (anonymise), clumsy
  // clauses 4 and 5 (improve tracked / improve plain).
  const contract = [
    "SERVICES AGREEMENT",
    "",
    "This Services Agreement is entered into between Acme Consulting Ltd and John Smith of 10 Downing Street, London.",
    "",
    "1. The Suplier shall provide the consulting services described in Schedual 1 with reasonable skill and care.",
    "",
    "2. The Client shall pay all invoices within thirty (30) days of reciept.",
    "",
    "3. Either party may terminate this agreement on sixty (60) days writen notice.",
    "",
    "4. The Consultant will try to do the work good and in a timely way.",
    "",
    "5. The parties will keep things confidential as agreed between them from time to time.",
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
  await shot("contract-typed");
});

const dialogFrame = await step("open-addins-dialog", async () => {
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
  await shot("my-addins-tab");
  return frame;
});

await step("upload-manifest", async () => {
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
  await shot("manifest-chosen");
  await dialogFrame
    .getByRole("button", { name: /^upload$/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
});

const paneFrame = await step("open-task-pane", async () => {
  try {
    return await waitForFrame((f) => f.url().includes("localhost:3000"), 30_000);
  } catch {
    await wac.getByRole("button", { name: /mike/i }).first().click();
    return await waitForFrame((f) => f.url().includes("localhost:3000"), 60_000);
  }
});

await step("sign-in-to-mike", async () => {
  // The profile persists localStorage, so a previous run's Mike session may
  // still be live — land on either the login page or the tab shell.
  const emailInput = paneFrame.getByPlaceholder("you@firm.com");
  const chatTab = paneFrame.getByRole("tab", { name: "Chat" });
  await emailInput.or(chatTab).first().waitFor({ timeout: 120_000 });
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill("demo@mike.local");
    await paneFrame.getByPlaceholder("••••••••").fill("MikeDemo!2026");
    await paneClick(paneFrame.getByRole("button", { name: "Sign in" }));
  }
  await chatTab.waitFor({ timeout: 60_000 });
  await shot("mike-signed-in");
});

// ---- Chat: redlines → Apply 2 tracked edits --------------------------------
await step("chat-apply-tracked-edits", async () => {
  await paneClick(paneFrame.getByRole("switch", { name: "Suggest tracked edits" }));
  await paneFrame
    .getByPlaceholder("Ask Mike…")
    .fill("Fix the spelling mistakes in this agreement.");
  await paneClick(paneFrame.getByRole("button", { name: "Send" }));
  const apply = paneFrame.getByRole("button", { name: "Apply 2 tracked edits", exact: true });
  await apply.waitFor({ timeout: 180_000 });
  await shot("chat-redlines-proposed");
  await page.waitForTimeout(1500);
  await paneClick(apply);
  await paneFrame.getByText(/Applied 2 of 2 edits as tracked/).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4000); // let the redlines render in the document
  await shot("chat-redlines-applied");
});

// ---- Chat: plain answer → Insert below cursor / Insert below (tracked) -----
await step("chat-insert-below", async () => {
  // Redline mode off, document-context switch on (it unlocks once redline
  // mode is released).
  await paneClick(paneFrame.getByRole("switch", { name: "Suggest tracked edits" }));
  await paneClick(paneFrame.getByRole("switch", { name: "Use document as context" }));
  await paneFrame
    .getByPlaceholder("Ask Mike…")
    .fill("Summarize this agreement in two sentences.");
  await paneClick(paneFrame.getByRole("button", { name: "Send" }));
  // The stub summary ends "...confidentiality between the parties (clause 5)."
  await paneFrame
    .getByText("confidentiality between the parties")
    .waitFor({ timeout: 180_000 });
  await page.waitForTimeout(2000); // stream fully settled
  await shot("chat-summary-answer");

  const insertPlain = paneFrame
    .getByRole("button", { name: "Insert below cursor", exact: true })
    .last();
  await paneClick(insertPlain);
  await wac.getByText("standard of work required").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  await shot("chat-insert-below-cursor");

  const insertTracked = paneFrame
    .getByRole("button", { name: "Insert below (tracked)", exact: true })
    .last();
  await paneClick(insertTracked);
  await page.waitForTimeout(5000); // tracked paragraphs render as redline
  await shot("chat-insert-below-tracked");
});

// ---- Actions: Improve Writing (tracked, then plain) ------------------------
await step("improve-writing-tracked", async () => {
  await paneClick(paneFrame.getByRole("tab", { name: "Actions" }));
  await page.waitForTimeout(1000);
  // Select clause 4 in the document (triple-click selects the paragraph).
  await wac.getByText("do the work good").first().click({ clickCount: 3 });
  await page.waitForTimeout(1000);
  await paneClick(paneFrame.getByRole("button", { name: "Improve selected text" }));
  const replaceTracked = paneFrame.getByRole("button", {
    name: "Replace selection (tracked)",
    exact: true,
  });
  await replaceTracked.waitFor({ timeout: 180_000 });
  await shot("improve-rewrite-ready");
  await page.waitForTimeout(1500);
  await paneClick(replaceTracked);
  await wac.getByText("perform the services diligently").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  await shot("improve-replaced-tracked");
});

await step("improve-writing-plain", async () => {
  // Select clause 5 and rewrite it, this time replacing without tracking.
  await wac.getByText("keep things confidential").first().click({ clickCount: 3 });
  await page.waitForTimeout(1000);
  await paneClick(paneFrame.getByRole("button", { name: "Improve selected text" }));
  const replacePlain = paneFrame.getByRole("button", {
    name: "Replace selection",
    exact: true,
  });
  await replacePlain.waitFor({ timeout: 180_000 });
  await page.waitForTimeout(1500);
  await paneClick(replacePlain);
  await wac.getByText("maintain the confidentiality").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  await shot("improve-replaced-plain");
});

// ---- Actions: Proofread → Apply 2 corrections (tracked) --------------------
await step("proofread-apply", async () => {
  await paneClick(paneFrame.getByRole("button", { name: "Proofread entire document" }));
  const apply = paneFrame.getByRole("button", {
    name: "Apply 2 corrections (tracked)",
    exact: true,
  });
  await apply.waitFor({ timeout: 180_000 });
  await shot("proofread-corrections-listed");
  await page.waitForTimeout(1500);
  await paneClick(apply);
  await paneFrame
    .getByText(/Applied 2 of 2 corrections as tracked changes/)
    .waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4000);
  await shot("proofread-applied");
});

// ---- Actions: Anonymise → Apply 2 redactions (tracked) ---------------------
await step("anonymise-apply", async () => {
  await paneClick(paneFrame.getByRole("button", { name: "Find & list PII" }));
  const apply = paneFrame.getByRole("button", {
    name: "Apply 2 redactions (tracked)",
    exact: true,
  });
  await apply.waitFor({ timeout: 180_000 });
  await shot("anonymise-pii-listed");
  await page.waitForTimeout(1500);
  await paneClick(apply);
  await paneFrame
    .getByText(/Applied 2 of 2 redactions as tracked changes/)
    .waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4000);
  await shot("anonymise-applied");
});

// ---- Actions: Draft Clause → both insert buttons ---------------------------
await step("draft-clause-inserts", async () => {
  await paneFrame
    .getByPlaceholder("e.g. limitation of liability for SaaS product")
    .fill("mutual confidentiality clause for a consulting agreement");
  await paneClick(paneFrame.getByRole("button", { name: "Draft clause", exact: true }));
  const insertPlain = paneFrame.getByRole("button", {
    name: "Insert below cursor",
    exact: true,
  });
  await insertPlain.waitFor({ timeout: 180_000 });
  await shot("draft-clause-ready");
  await page.waitForTimeout(1500);
  await paneClick(insertPlain);
  await wac.getByText("Receiving Party").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  await shot("draft-insert-below-cursor");
  await paneClick(
    paneFrame.getByRole("button", { name: "Insert below (tracked)", exact: true }),
  );
  await page.waitForTimeout(5000);
  await shot("draft-insert-below-tracked");
});

// ---- Workflows: run one and insert the result ------------------------------
await step("workflow-run-insert", async () => {
  await paneClick(paneFrame.getByRole("tab", { name: "Workflows" }));
  await paneFrame.locator("#workflow-select").waitFor({ timeout: 60_000 });
  await shot("workflows-tab");
  await paneClick(paneFrame.getByRole("button", { name: "Run workflow on document" }));
  const insert = paneFrame.getByRole("button", {
    name: "Insert below cursor",
    exact: true,
  });
  await insert.waitFor({ timeout: 180_000 });
  await shot("workflow-result");
  await page.waitForTimeout(1500);
  await paneClick(insert);
  await page.waitForTimeout(4000);
  await shot("workflow-inserted");
});

// ---- Projects tab ----------------------------------------------------------
await step("projects-tab", async () => {
  await paneClick(paneFrame.getByRole("tab", { name: "Projects" }));
  await page.waitForTimeout(4000);
  await shot("projects-tab");
});

// ---- Sign out --------------------------------------------------------------
await step("sign-out", async () => {
  await paneClick(paneFrame.getByRole("button", { name: "Sign out" }));
  await paneFrame.getByPlaceholder("you@firm.com").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2000);
  await shot("signed-out");
});

console.log("Recorded. Videos + screenshots in", OUT_DIR);
await context.close();
