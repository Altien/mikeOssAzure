"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Trash2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { FieldLabel } from "@/app/components/ui/form-field";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { useAuth } from "@/app/contexts/AuthContext";
import { useConfig } from "@/app/contexts/ConfigContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
// Upstream divergence (sync-log: 3a10943; OSS-6): upstream gates account
// deletion and email changes behind MfaVerificationPopup (Supabase-auth
// TOTP step-up). Dev has no app-level MFA — Entra enforces MFA at sign-in
// via Conditional Access — so the popup and its retry paths are omitted.
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { deleteAccount } from "@/app/lib/mikeApi";
import { SettingsSection } from "./SettingsSection";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

export default function SettingsPage() {
    const router = useRouter();
    const { user, signOut, updateEmail } = useAuth();
    const { profile, updateDisplayName, updateOrganisation } = useUserProfile();
    // Dev (OSS-6, auth): see the Email and Danger Zone notes.
    const { authProvider } = useConfig();
    const emailEditable = authProvider === "supabase";
    const [displayName, setDisplayName] = useState("");
    const [isSavingName, setIsSavingName] = useState(false);
    const [saved, setSaved] = useState(false);
    const [organisation, setOrganisation] = useState("");
    const [isSavingOrg, setIsSavingOrg] = useState(false);
    const [orgSaved, setOrgSaved] = useState(false);
    const [email, setEmail] = useState("");
    const [isSavingEmail, setIsSavingEmail] = useState(false);
    const [emailSaved, setEmailSaved] = useState(false);
    const [emailStatus, setEmailStatus] = useState<string | null>(null);
    const [emailWarning, setEmailWarning] = useState<string | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    const handleLogout = async () => {
        await signOut();
        router.push("/");
    };

    useEffect(() => {
        if (profile?.displayName) {
            setDisplayName(profile.displayName);
        }
        if (profile?.organisation) {
            setOrganisation(profile.organisation);
        }
    }, [profile]);

    useEffect(() => {
        if (user?.email) {
            setEmail(user.pendingEmail || user.email);
        }
    }, [user?.email, user?.pendingEmail]);

    const handleDeleteAccount = async () => {
        devLog("[account] delete account requested");
        setIsDeleting(true);
        try {
            await deleteAccount();
            await signOut();
            router.push("/");
        } catch (error) {
            setIsDeleting(false);
            devLog("[account] delete account failed", { error });
            setDeleteConfirm(false);
            alert("Failed to delete account. Please try again.");
        }
    };

    const handleSaveEmail = async () => {
        const nextEmail = email.trim();
        if (!nextEmail || nextEmail === user?.email) return;

        devLog("[account] save email requested");
        setIsSavingEmail(true);
        setEmailStatus(null);
        setEmailWarning(null);
        try {
            const updatedUser = await updateEmail(nextEmail);
            const pendingEmail = updatedUser.pendingEmail;
            setEmail(pendingEmail || updatedUser.email);
            setEmailSaved(true);
            setEmailStatus(
                pendingEmail
                    ? `Confirmation sent to ${pendingEmail}. Your current email remains ${updatedUser.email} until the change is confirmed.`
                    : "Email updated.",
            );
            setTimeout(() => setEmailSaved(false), 2000);
        } catch (error: unknown) {
            devLog("[account] save email failed", { error });
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to update email. Please try again.";

            if (isAlreadyRegisteredEmailError(message)) {
                setEmail(user?.pendingEmail || user?.email || "");
                setEmailWarning(message);
                return;
            }

            setEmailStatus(message);
        } finally {
            setIsSavingEmail(false);
        }
    };

    const handleSaveDisplayName = async () => {
        setIsSavingName(true);
        const success = await updateDisplayName(displayName.trim());
        setIsSavingName(false);

        if (success) {
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } else {
            alert("Failed to update display name. Please try again.");
        }
    };

    const handleSaveOrganisation = async () => {
        setIsSavingOrg(true);
        const success = await updateOrganisation(organisation.trim());
        setIsSavingOrg(false);

        if (success) {
            setOrgSaved(true);
            setTimeout(() => setOrgSaved(false), 2000);
        } else {
            alert("Failed to update organisation. Please try again.");
        }
    };

    if (!user) return null;

    return (
        <div className="space-y-8">
            {/* Profile Settings */}
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Profile
                </h2>
                <SettingsSection>
                    <div className="space-y-8 p-4">
                        <div>
                            <FieldLabel className="text-sm text-gray-600">
                                Display Name
                            </FieldLabel>
                            <div className="space-y-2">
                                <SettingsTextInput
                                    type="text"
                                    value={displayName}
                                    onChange={(e) =>
                                        setDisplayName(e.target.value)
                                    }
                                    placeholder="Enter your name"
                                />
                                <div className="flex justify-end">
                                    <button
                                        type="button"
                                        onClick={handleSaveDisplayName}
                                        disabled={
                                            isSavingName ||
                                            !displayName.trim() ||
                                            saved
                                        }
                                        className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                                    >
                                        {isSavingName
                                            ? "Saving..."
                                            : saved
                                              ? "Saved"
                                              : "Save"}
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div>
                            <FieldLabel className="text-sm text-gray-600">
                                Organisation
                            </FieldLabel>
                            <div className="space-y-2">
                                <SettingsTextInput
                                    type="text"
                                    value={organisation}
                                    onChange={(e) =>
                                        setOrganisation(e.target.value)
                                    }
                                    placeholder="Enter your organisation"
                                />
                                <div className="flex justify-end">
                                    <button
                                        type="button"
                                        onClick={handleSaveOrganisation}
                                        disabled={
                                            isSavingOrg ||
                                            organisation.trim() ===
                                                (profile?.organisation ?? "") ||
                                            orgSaved
                                        }
                                        className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                                    >
                                        {isSavingOrg
                                            ? "Saving..."
                                            : orgSaved
                                              ? "Saved"
                                              : "Save"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </SettingsSection>
            </section>

            {/* Email */}
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Email
                </h2>
                <SettingsSection>
                    {/* Upstream divergence (OSS-6, auth): the email editor
                        exists only in supabase mode. In entra/local mode the
                        sign-in provider owns the address (AuthContext's
                        updateEmail rejects), so it is shown read-only. */}
                    {!emailEditable ? (
                        <div className="space-y-2 p-4">
                            <SettingsTextInput
                                type="email"
                                value={user.email ?? ""}
                                readOnly
                                disabled
                            />
                            <p className="text-xs text-gray-500">
                                Your email is managed by your
                                organisation&apos;s sign-in provider.
                            </p>
                        </div>
                    ) : (
                    <div className="space-y-2 p-4">
                        <SettingsTextInput
                            type="email"
                            value={email}
                            onChange={(event) => {
                                setEmail(event.target.value);
                                setEmailStatus(null);
                                setEmailWarning(null);
                                setEmailSaved(false);
                            }}
                            placeholder="Enter your email"
                        />
                        {emailStatus ? (
                            <p className="text-xs text-gray-500">
                                {emailStatus}
                            </p>
                        ) : user.pendingEmail ? (
                            <p className="text-xs text-gray-500">
                                Pending confirmation: {user.pendingEmail}
                            </p>
                        ) : null}
                        {emailStatus && (
                            <p className="text-xs text-gray-400">
                                Current email: {user.email}
                            </p>
                        )}
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={handleSaveEmail}
                                disabled={
                                    isSavingEmail ||
                                    !email.trim() ||
                                    email.trim() === user.email ||
                                    email.trim() === user.pendingEmail ||
                                    emailSaved
                                }
                                className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                            >
                                {isSavingEmail
                                    ? "Saving..."
                                    : emailSaved
                                      ? "Saved"
                                      : "Save"}
                            </button>
                        </div>
                    </div>
                    )}
                </SettingsSection>
            </section>

            {/* Plan */}
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Usage Plan
                </h2>
                <SettingsSection>
                    <div className="p-4">
                        <p className="text-base font-medium text-gray-500 capitalize">
                            {profile?.tier || "Free"}
                        </p>
                    </div>
                </SettingsSection>
            </section>

            {/* Actions */}
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Actions
                </h2>
                <PillButton
                    tone="black"
                    size="sm"
                    onClick={handleLogout}
                    className="w-full sm:w-auto"
                >
                    <LogOut className="h-4 w-4 shrink-0" />
                    Sign Out
                </PillButton>
            </section>

            {/* Danger Zone
                Upstream divergence (OSS-6, auth; dev behaviour kept): hidden
                in entra mode. The identity is owned by the customer's Entra
                tenant, so self-service deletion is misleading (group
                membership lets the user sign straight back in); closure and
                erasure go through a tenant-admin ticket. Supabase and local
                modes, where the app owns the identity, keep it. */}
            {authProvider !== "entra" && (
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-red-600">
                    Danger Zone
                </h2>
                <SettingsSection>
                    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                            <p className="text-sm font-medium text-gray-700">
                                Delete account
                            </p>
                            <p className="text-sm text-gray-500">
                                Permanently delete your account and all
                                associated data. This action cannot be undone.
                            </p>
                        </div>
                        <PillButton
                            tone="danger"
                            size="sm"
                            onClick={() => setDeleteConfirm(true)}
                            disabled={isDeleting}
                            className="w-full shrink-0 sm:w-auto"
                        >
                            <Trash2 className="h-4 w-4 shrink-0" />
                            Delete account
                        </PillButton>
                    </div>
                </SettingsSection>
            </section>
            )}
            <ConfirmPopup
                open={deleteConfirm}
                title="Delete account?"
                message="This will permanently delete your account and all associated data. This action cannot be undone."
                confirmLabel="Delete"
                confirmStatus={isDeleting ? "loading" : "idle"}
                cancelLabel="Cancel"
                onCancel={() => {
                    if (isDeleting) return;
                    setDeleteConfirm(false);
                }}
                onConfirm={() => void handleDeleteAccount()}
            />
            <WarningPopup
                open={!!emailWarning}
                title="Email already registered"
                message={emailWarning}
                onClose={() => setEmailWarning(null)}
            />
        </div>
    );
}

function isAlreadyRegisteredEmailError(message: string) {
    return message
        .toLowerCase()
        .includes("a user with this email address has already been registered");
}
