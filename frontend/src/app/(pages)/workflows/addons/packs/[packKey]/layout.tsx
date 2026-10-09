import type { ReactNode } from "react";
import { RequirePathParams } from "@/app/lib/usePathParams";

export function generateStaticParams() {
    return [{ packKey: "_" }];
}

export default function AddonPackLayout({ children }: { children: ReactNode }) {
    return <RequirePathParams pattern="/workflows/addons/packs/:packKey">{children}</RequirePathParams>;
}
