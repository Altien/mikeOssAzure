import AssistantChatClient from "./AssistantChatClient";

// Placeholder param so Next.js generates one static HTML shell for this
// dynamic route. The real id is read at runtime from usePathname()
// inside AssistantChatClient — server-baked params would always be the
// "_" placeholder under output: "export".
export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function AssistantChatPage() {
    return <AssistantChatClient />;
}
