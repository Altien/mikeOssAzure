"use client";

import { useEffect, useState } from "react";
import { useParams, usePathname, useSearchParams } from "next/navigation";

// Empirical test of what each Next.js route hook returns under
// `output: "export"`. The hypothesis we are validating:
//
//   - useParams() returns the prerender's matched static params (so
//     for our setup it always reports id="_" regardless of the URL).
//   - usePathname() reflects the live URL bar after hydration.
//   - window.location.pathname is the ground truth on the client.
//
// If usePathname() agrees with window.location.pathname, the page-
// level fix is to parse the id out of usePathname (or window.location)
// instead of useParams. If usePathname also reports "_", we need a
// different approach — maybe a useEffect that reads window.location
// post-mount, or restructuring the route.

export function RouteDiagnostic() {
    const params = useParams();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [windowLocation, setWindowLocation] = useState<{
        href: string;
        pathname: string;
    } | null>(null);

    useEffect(() => {
        if (typeof window !== "undefined") {
            setWindowLocation({
                href: window.location.href,
                pathname: window.location.pathname,
            });
        }
    }, [pathname]);

    const idFromParams = (() => {
        const v = params?.id;
        return Array.isArray(v) ? v[0] : (v ?? "");
    })();
    const idFromPathname = (() => {
        const m = pathname?.match(/\/diagnostics\/route\/([^/?#]+)/);
        return m?.[1] ?? "";
    })();
    const idFromWindow = (() => {
        const m = windowLocation?.pathname.match(
            /\/diagnostics\/route\/([^/?#]+)/,
        );
        return m?.[1] ?? "";
    })();

    return (
        <div
            style={{
                fontFamily: "ui-monospace, Menlo, Consolas, monospace",
                maxWidth: 900,
                margin: "2rem auto",
                padding: "0 1rem",
                color: "#222",
            }}
        >
            <h1 style={{ fontSize: "1.3rem" }}>Route hook diagnostic</h1>
            <p style={{ fontSize: "0.9rem", color: "#555" }}>
                Try navigating to{" "}
                <code>/diagnostics/route/abc-123-fake-id</code> and compare what
                each row reports. The id we want is{" "}
                <strong>abc-123-fake-id</strong>.
            </p>
            <table
                style={{
                    borderCollapse: "collapse",
                    width: "100%",
                    fontSize: "0.9rem",
                    marginTop: "1rem",
                }}
            >
                <thead>
                    <tr style={{ background: "#f6f8fa" }}>
                        <th style={cell}>Source</th>
                        <th style={cell}>Raw value</th>
                        <th style={cell}>Parsed id</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td style={cell}>
                            <code>useParams()</code>
                        </td>
                        <td style={cell}>
                            <pre style={pre}>{JSON.stringify(params, null, 2)}</pre>
                        </td>
                        <td style={cell}>
                            <code>{idFromParams || "(empty)"}</code>
                        </td>
                    </tr>
                    <tr>
                        <td style={cell}>
                            <code>usePathname()</code>
                        </td>
                        <td style={cell}>
                            <code>{pathname ?? "(null)"}</code>
                        </td>
                        <td style={cell}>
                            <code>{idFromPathname || "(empty)"}</code>
                        </td>
                    </tr>
                    <tr>
                        <td style={cell}>
                            <code>window.location.pathname</code>
                        </td>
                        <td style={cell}>
                            <code>
                                {windowLocation?.pathname ?? "(null — pre-mount)"}
                            </code>
                        </td>
                        <td style={cell}>
                            <code>{idFromWindow || "(empty)"}</code>
                        </td>
                    </tr>
                    <tr>
                        <td style={cell}>
                            <code>window.location.href</code>
                        </td>
                        <td style={cell} colSpan={2}>
                            <code>
                                {windowLocation?.href ?? "(null — pre-mount)"}
                            </code>
                        </td>
                    </tr>
                    <tr>
                        <td style={cell}>
                            <code>useSearchParams()</code>
                        </td>
                        <td style={cell} colSpan={2}>
                            <code>{searchParams?.toString() || "(empty)"}</code>
                        </td>
                    </tr>
                </tbody>
            </table>
            <p style={{ fontSize: "0.85rem", color: "#666", marginTop: "1rem" }}>
                Interpretation: if any row reports the placeholder{" "}
                <code>_</code> when the URL says otherwise, that hook is reading
                the prerender state, not the live URL — and is therefore not
                safe to use as a source of truth for ids in this app.
            </p>
        </div>
    );
}

const cell: React.CSSProperties = {
    padding: "0.5rem 0.75rem",
    border: "1px solid #eee",
    verticalAlign: "top",
    textAlign: "left",
    wordBreak: "break-word",
};
const pre: React.CSSProperties = {
    margin: 0,
    fontSize: "0.85rem",
    background: "#f6f8fa",
    padding: "0.4rem",
    borderRadius: 3,
};
