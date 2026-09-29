import type { ReactNode } from "react";
import { RequirePathParams } from "@/app/lib/usePathParams";

// Static-export divergence (OSS-6, decision 2): upstream has no layout here.
// `output: "export"` needs `generateStaticParams` for every dynamic segment,
// and a "use client" page cannot export it, so this server layout declares
// the single `"_"` placeholder shell and holds the page back until the real
// ids are readable from the URL. The page body stays upstream's apart from
// its id line (usePathParams instead of `use(params)`); this replaces
// OSS-5's page stub + ProjectAssistantChatClient split.
export function generateStaticParams() {
    return [{ chatId: "_" }];
}

export default function ProjectAssistantChatLayout({
    children,
}: {
    children: ReactNode;
}) {
    return (
        <RequirePathParams pattern="/projects/:id/assistant/chat/:chatId">
            {children}
        </RequirePathParams>
    );
}
