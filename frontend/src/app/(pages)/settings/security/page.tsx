"use client";

import { SupabaseAuthGate } from "@/app/components/auth/SupabaseAuthGate";
import { PasswordSettingsSection } from "@/app/components/settings/PasswordSettingsSection";

// Upstream divergence (sync-log: c94052d7): password controls remain Supabase-only;
// Entra/local security and MFA are managed by the identity provider.
export default function SecurityPage() {
    return <SupabaseAuthGate><PasswordSettingsSection /></SupabaseAuthGate>;
}
