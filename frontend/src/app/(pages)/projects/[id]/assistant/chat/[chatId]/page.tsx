import ProjectAssistantChatClient from "./ProjectAssistantChatClient";

// See app/(pages)/projects/[id]/page.tsx for why we don't pass ids —
// usePathname() inside the client reads the real URL.
export function generateStaticParams() {
    return [{ id: "_", chatId: "_" }];
}

export default function ProjectAssistantChatPage() {
    return <ProjectAssistantChatClient />;
}
