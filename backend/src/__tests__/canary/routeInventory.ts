// Multi-tenant issue 009: enumerate every route buildApp() registers, so the
// cross-tenant canary picks up new routes automatically.
//
// Express 4 keeps no mount path on a router layer, only the compiled regexp
// and its param keys, so the mount prefix is recovered from the regexp
// source. Only the shapes app.ts uses are supported (literal segments and
// `:name` params); anything else throws, so an unsupported mount is noticed
// instead of silently dropping routes.

import type express from "express";

export interface RegisteredRoute {
  method: string;
  /** Express path with `:params`, e.g. `/api/projects/:projectId`. */
  path: string;
}

type Layer = {
  name?: string;
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: { name: string | number }[];
  route?: { path: string | RegExp | (string | RegExp)[]; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
};

function mountPrefix(layer: Layer): string {
  const regexp = layer.regexp;
  if (!regexp || regexp.fast_slash) return "";
  let source = regexp.source;
  // `^\/api\/projects\/(?:([^\/]+?))\/memory\/?(?=\/|$)`
  source = source.replace(/^\^/, "").replace(/\\\/\?\(\?=\\\/\|\$\)$/, "");
  // path-to-regexp 0.1.x emits `(?:\/([^/]+?))` (newer) or `\/(?:([^\/]+?))`.
  const param = /\(\?:\\\/\(\[\^\\?\/\]\+\?\)\)|\(\?:\(\[\^\\?\/\]\+\?\)\)/;
  for (const key of layer.keys ?? []) {
    const match = param.exec(source);
    if (!match) throw new Error(`Unsupported mount regexp: ${regexp.source}`);
    const replacement = match[0].startsWith("(?:\\/") ? `\\/:${String(key.name)}` : `:${String(key.name)}`;
    source = source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
  }
  const path = source.replace(/\\\//g, "/").replace(/\\\./g, ".").replace(/\\-/g, "-");
  if (/[\\()[\]?*+^$|]/.test(path)) throw new Error(`Unsupported mount regexp: ${regexp.source}`);
  return path;
}

function walk(stack: Layer[], prefix: string, out: RegisteredRoute[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const path of paths) {
        if (typeof path !== "string") continue;
        for (const [method, on] of Object.entries(layer.route.methods)) {
          if (!on || method === "_all") continue;
          out.push({ method: method.toUpperCase(), path: `${prefix}${path === "/" && prefix ? "" : path}` || "/" });
        }
      }
    } else if (layer.name === "router" && layer.handle?.stack) {
      walk(layer.handle.stack, `${prefix}${mountPrefix(layer)}`, out);
    }
  }
}

/** Every concrete (method, path) the app answers, de-duplicated and sorted. */
export function listRoutes(app: express.Express): RegisteredRoute[] {
  const router = (app as unknown as { _router?: { stack: Layer[] } })._router;
  if (!router) throw new Error("The app has no router");
  const out: RegisteredRoute[] = [];
  walk(router.stack, "", out);
  const seen = new Set<string>();
  return out
    .filter((route) => {
      const key = routeKey(route);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
}

export function routeKey(route: RegisteredRoute): string {
  return `${route.method} ${route.path}`;
}

export function routeParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}
