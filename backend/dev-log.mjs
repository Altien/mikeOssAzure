/**
 * Tees this process's stdout/stderr into a file so local development has a
 * readable log to grep. Preloaded by `npm run dev` — it writes nothing in
 * production, because nothing preloads it there.
 *
 * Everything is captured: console.*, express output, unhandled rejections,
 * and the stack traces tsx prints on a failed reload.
 *
 * Override the path with DEV_LOG_FILE. Appends rather than truncates: tsx
 * restarts the child on every file change, and truncating would erase the
 * stack trace you are usually chasing. Each run writes a separator, so
 * `tail` still shows the current one. Delete the file when it gets long.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const file = resolve(process.env.DEV_LOG_FILE ?? ".tmp/backend-dev.log");
mkdirSync(dirname(file), { recursive: true });
const log = createWriteStream(file, { flags: "a" });
log.write(`\n===== dev start ${new Date().toISOString()} =====\n`);

for (const name of /** @type {const} */ (["stdout", "stderr"])) {
    const stream = process[name];
    const original = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
        try {
            log.write(
                typeof chunk === "string"
                    ? chunk
                    : Buffer.from(chunk).toString("utf8"),
            );
        } catch {
            // Never let logging break the process it is observing.
        }
        return original(chunk, encoding, callback);
    };
}

process.stdout.write(`[dev-log] writing to ${file}\n`);
