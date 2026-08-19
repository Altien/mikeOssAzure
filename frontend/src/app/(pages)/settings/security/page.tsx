"use client";
import { useState } from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import { getSupabaseClient } from "@/app/lib/supabase";
import { browserAuthCallbackUrl } from "@/app/lib/authRedirects";
import { SupabaseAuthGate } from "@/app/components/auth/SupabaseAuthGate";
import { PillButton } from "@/app/components/ui/pill-button";
import { SettingsSection } from "../SettingsSection";
function PasswordSettings() {
    const { user } = useAuth();
    const [sending, setSending] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    async function sendPasswordReset() {
        if (!user?.email || sending) return;
        setSending(true); setStatus(null);
        try {
            const redirectTo = browserAuthCallbackUrl("/reset-password");
            const { error } = await getSupabaseClient().auth.resetPasswordForEmail(user.email, redirectTo ? { redirectTo } : undefined);
            if (error) throw error;
            setStatus(`Password-reset instructions sent to ${user.email}.`);
        } catch { setStatus("Unable to send a password-reset email right now. Please try again."); }
        finally { setSending(false); }
    }
    return <section className="space-y-3"><h2 className="font-serif text-2xl">Password</h2><SettingsSection>
        <div className="space-y-3 px-4 py-5"><p>Send a secure password-reset link to {user?.email}.</p>
        {status && <p role="status">{status}</p>}
        <PillButton tone="black" onClick={() => void sendPasswordReset()} disabled={sending || !user?.email}>{sending ? "Sending..." : "Send reset email"}</PillButton>
        </div></SettingsSection></section>;
}
export default function SecurityPage() { return <SupabaseAuthGate><PasswordSettings /></SupabaseAuthGate>; }
