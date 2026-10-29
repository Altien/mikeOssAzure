import type { ReactNode } from "react";
import { RequirePathParams } from "@/app/lib/usePathParams";

// Dev static export: resolve the live URL inside the shared Playbooks workspace.
export function generateStaticParams() { return [{ playbookId: "_" }]; }
export default function PlaybookLayout({ children }: { children: ReactNode }) {
  return <RequirePathParams pattern="/playbooks/:playbookId">{children}</RequirePathParams>;
}
