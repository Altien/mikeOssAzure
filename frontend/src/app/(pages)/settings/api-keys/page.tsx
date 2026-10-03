"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// Keep existing bookmarks usable with the static-export deployment.
export default function ApiKeysRedirect() {
    const router = useRouter();
    useEffect(() => { router.replace("/settings/byok"); }, [router]);
    return <Link href="/settings/byok">Open model credentials and routers</Link>;
}
