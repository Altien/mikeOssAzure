import { getConfig } from "./config";
/** Public runtime link, with no executable/custom URL schemes. */
export async function controlPlaneUrl(): Promise<string | null> {
  const raw = await getConfig("control-plane-url").catch(() => "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || (url.protocol !== "https:"
      && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return null;
    return url.toString();
  } catch { return null; }
}
