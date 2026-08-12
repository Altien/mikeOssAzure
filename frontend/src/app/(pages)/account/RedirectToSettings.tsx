"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Dev (static export): upstream (317a8f05) redirects /account/** to
// /settings/** with `redirects()` in next.config.ts, which is unsupported
// under `output: "export"`. These tiny client pages do the same with
// router.replace so old bookmarks and links keep working.
export function RedirectToSettings({ to }: { to: string }) {
    const router = useRouter();
    useEffect(() => {
        router.replace(to);
    }, [router, to]);
    return null;
}
