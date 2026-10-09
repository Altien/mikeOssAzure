import type { ReactNode } from "react";
import { RequirePathParams } from "@/app/lib/usePathParams";

export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function OrganizationLayout({ children }: { children: ReactNode }) {
    return (
        <RequirePathParams pattern="/organizations/:id">
            {children}
        </RequirePathParams>
    );
}
