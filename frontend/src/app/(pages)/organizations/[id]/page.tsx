"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePathParams } from "@/app/lib/usePathParams";

// Dev static-export route: the browser pathname supplies the live id.
// The parent placeholder layout gates this page until the path is resolved.
export default function OrganizationPage() {
  const { id } = usePathParams<"id">("/organizations/:id");
  const router = useRouter();
  useEffect(() => {
    if (id) router.replace(`/organizations/${id}/settings`);
  }, [id, router]);
  return null;
}
