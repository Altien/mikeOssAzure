"use client";

import { SupabaseAuthGate } from "@/app/components/auth/SupabaseAuthGate";
import { PasswordSettingsSection } from "@/app/components/settings/PasswordSettingsSection";

export default function SecurityPage() {
    return <SupabaseAuthGate><PasswordSettingsSection /></SupabaseAuthGate>;
}
