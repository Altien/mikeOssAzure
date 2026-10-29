"use client";

import type { ReactNode } from "react";
import { OrganizationSettingsProvider } from "@/app/components/organizations/OrganizationSettingsShell";
import { useAuth } from "@/app/contexts/AuthContext";
import { usePathParams } from "@/app/lib/usePathParams";

// Dev static-export boundary: organizations/[id]/layout.tsx supplies the
// placeholder generateStaticParams and RequirePathParams gate. The generic
// backend HTML/RSC shell resolver serves every nested settings route.
export default function OrganizationSettingsLayout({ children }: { children: ReactNode }) {
  const { id } = usePathParams<"id">("/organizations/:id/settings");
  const { user } = useAuth();
  return (
    <OrganizationSettingsProvider key={`${user?.id ?? "signed-out"}:${id}`} orgId={id}>
      {children}
    </OrganizationSettingsProvider>
  );
}
