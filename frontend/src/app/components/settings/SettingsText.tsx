import type { ReactNode } from "react";

export function SettingsLabel({ children }: { children: ReactNode }) {
    return (
        <p className="text-sm font-medium text-gray-700">{children}</p>
    );
}

export function SettingsDescription({ children }: { children: ReactNode }) {
    return <p className="text-sm text-gray-500">{children}</p>;
}
