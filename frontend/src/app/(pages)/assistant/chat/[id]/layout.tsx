import type { ReactNode } from "react";
import { RequireResolvedPath } from "@/app/lib/usePathParams";

// Static-export divergence (OSS-6, decision 2): upstream has no layout here.
// `output: "export"` needs `generateStaticParams` for every dynamic segment,
// and a "use client" page cannot export it, so this server layout declares
// the single `"_"` placeholder shell and holds the page back until the real
// id is readable from the URL. The page body stays upstream's apart from
// its id line (usePathParams instead of useParams).
// Sync-log 6e3ef6fa: upstream #559 keeps this page mounted while it moves
// between the new-chat URL and a chat id with history.pushState, so the
// gate waits only for a live (non-placeholder) URL, not for a chat id.
export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function AssistantChatLayout({
    children,
}: {
    children: ReactNode;
}) {
    return (
        <RequireResolvedPath>
            {children}
        </RequireResolvedPath>
    );
}
