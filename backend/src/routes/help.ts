import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { requireAuth } from "../middleware/auth";

export const helpRouter = Router();

helpRouter.use(requireAuth);

// Help articles are the user-facing guides in docs/help, copied into the
// image at build time. Only that directory is served: the rest of docs/ is
// written for contributors and operators, not for the people using the app.
//
// The image runs compiled code from /app/dist, where the guides sit at
// /app/docs/help; running from source in development puts them one level
// further up, at the repository root. Try both rather than making the layout
// a deployment concern.
function resolveHelpDir(): string {
    const fromEnv = process.env.HELP_DOCS_DIR;
    if (fromEnv) return path.resolve(fromEnv);
    const candidates = [
        path.resolve(__dirname, "..", "..", "docs", "help"),
        path.resolve(__dirname, "..", "..", "..", "docs", "help"),
    ];
    return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
}

const HELP_DIR = resolveHelpDir();

// Slugs map to `<slug>.md` inside HELP_DIR and nothing else. Rejecting
// anything outside this shape is what keeps the route from walking the
// filesystem; the resolved-path check below is the belt to this braces.
const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

function articlePath(slug: string): string | null {
    if (!SLUG_PATTERN.test(slug)) return null;
    const candidate = path.join(HELP_DIR, `${slug}.md`);
    const resolved = path.resolve(candidate);
    if (resolved !== candidate) return null;
    if (!resolved.startsWith(HELP_DIR + path.sep)) return null;
    return resolved;
}

// The first `# heading` is the article title. Falls back to the slug so a
// guide without one still lists, rather than vanishing from the contents.
function readTitle(file: string, slug: string): string {
    try {
        const contents = fs.readFileSync(file, "utf8");
        const heading = contents.match(/^#\s+(.+)$/m);
        return heading ? heading[1].trim() : slug;
    } catch {
        return slug;
    }
}

helpRouter.get("/articles", (_req, res) => {
    // An install without the directory is not an error: the app simply has
    // no guides bundled, and the UI shows that rather than failing.
    if (!fs.existsSync(HELP_DIR)) {
        return res.json({ articles: [] });
    }
    const articles = fs
        .readdirSync(HELP_DIR)
        .filter((name) => name.endsWith(".md"))
        // README.md documents the directory for contributors; it is not a
        // guide. Uppercase would fail the slug test below anyway — this is
        // explicit so the intent survives a rename.
        .filter((name) => name.toLowerCase() !== "readme.md")
        .map((name) => {
            const slug = name.slice(0, -3);
            return { slug, title: readTitle(path.join(HELP_DIR, name), slug) };
        })
        .filter((article) => SLUG_PATTERN.test(article.slug))
        .sort((a, b) => a.title.localeCompare(b.title));
    return res.json({ articles });
});

helpRouter.get("/articles/:slug", (req, res) => {
    const file = articlePath(req.params.slug);
    if (!file || !fs.existsSync(file)) {
        return res.status(404).json({ detail: "Help article not found" });
    }
    const markdown = fs.readFileSync(file, "utf8");
    return res.json({
        slug: req.params.slug,
        title: readTitle(file, req.params.slug),
        markdown,
    });
});
