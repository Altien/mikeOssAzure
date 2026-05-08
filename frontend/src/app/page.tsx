"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Client-side redirect rather than next/navigation `redirect()` — the
// server-side variant is incompatible with `output: 'export'`. This
// page renders a blank intermediate frame for the millisecond before
// the router replaces it.
export default function RootPage() {
    const router = useRouter();
    useEffect(() => {
        router.replace("/assistant");
    }, [router]);
    return null;
}
