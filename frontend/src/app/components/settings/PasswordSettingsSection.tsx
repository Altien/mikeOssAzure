"use client";

import { useState } from "react";
import { authInputUIClassName } from "@/shared/ui/AuthStylesUI";
import {
    MIN_PASSWORD_LENGTH,
    minimumPasswordMessage,
} from "@/app/components/auth/passwordPolicy";
import { Modal } from "@/app/components/modals/Modal";
import { InputUI } from "@/shared/ui/InputUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { requestPasswordReset, requestReauthentication } from "@/app/lib/authApi";
import { SettingsSection } from "@/app/(pages)/settings/SettingsSection";
import { FieldLabel } from "@/app/components/ui/form-field";

export function PasswordSettingsSection() {
    const { user, setPassword } = useAuth();
    const { profile, syncPasswordSet } = useUserProfile();
    const [setPasswordOpen, setSetPasswordOpen] = useState(false);
    const [password, setPasswordValue] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [reauthCode, setReauthCode] = useState("");
    const [reauthSending, setReauthSending] = useState(false);
    const [reauthStatus, setReauthStatus] = useState<string | null>(null);
    const [passwordSaving, setPasswordSaving] = useState(false);
    const [passwordSetError, setPasswordSetError] = useState<string | null>(
        null,
    );
    const [passwordStatus, setPasswordStatus] = useState<string | null>(null);
    const [passwordResetSending, setPasswordResetSending] = useState(false);

    const needsInitialPassword =
        user?.createdWithGoogle === true && profile?.passwordSet !== true;

    async function addPassword() {
        setPasswordSetError(null);
        if (password.length < MIN_PASSWORD_LENGTH) {
            setPasswordSetError(`${minimumPasswordMessage}.`);
            return;
        }
        if (password !== confirmPassword) {
            setPasswordSetError("Passwords do not match.");
            return;
        }

        setPasswordSaving(true);
        try {
            await setPassword(password, reauthCode || undefined);
            const synced = await syncPasswordSet();
            if (!synced) {
                throw new Error(
                    "Your password was set, but its account status could not be refreshed. Reload the page and try again.",
                );
            }
            setPasswordValue("");
            setConfirmPassword("");
            setReauthCode("");
            setReauthStatus(null);
            setSetPasswordOpen(false);
            setPasswordStatus("Password added to your account.");
        } catch (error) {
            setPasswordSetError(
                error instanceof Error
                    ? error.message
                    : "Unable to set your password.",
            );
        } finally {
            setPasswordSaving(false);
        }
    }

    async function sendPasswordReset() {
        if (!user?.email || passwordResetSending) return;
        setPasswordResetSending(true);
        setPasswordStatus(null);
        try {
            await requestPasswordReset(user.email);
            setPasswordStatus(
                `Password-reset instructions sent to ${user.email}.`,
            );
        } catch {
            setPasswordStatus(
                "Unable to send a password-reset email right now. Please try again.",
            );
        } finally {
            setPasswordResetSending(false);
        }
    }

    async function sendReauthCode() {
        setReauthSending(true);
        setPasswordSetError(null);
        try {
            await requestReauthentication();
            setReauthStatus("A verification code was sent to your email.");
        } catch {
            setPasswordSetError("Unable to send a verification code. Try again shortly.");
        } finally {
            setReauthSending(false);
        }
    }

    function closeSetPassword() {
        if (passwordSaving) return;
        setSetPasswordOpen(false);
        setPasswordSetError(null);
        setPasswordValue("");
        setConfirmPassword("");
        setReauthCode("");
        setReauthStatus(null);
    }

    return (
        <section className="space-y-3">
            <h2 className="font-serif text-2xl font-medium text-gray-900">
                Password
            </h2>
            <SettingsSection>
                <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium text-gray-700">
                            {needsInitialPassword
                                ? "Set or update password"
                                : "Reset password"}
                        </p>
                        <p className="text-sm text-gray-500">
                            {needsInitialPassword
                                ? "Set or update a password to sign in with your email."
                                : `Send a secure password-reset link to ${user?.email}.`}
                        </p>
                        {passwordStatus && (
                            <p className="text-xs text-gray-500">
                                {passwordStatus}
                            </p>
                        )}
                    </div>
                    <PillButtonUI
                        tone="black"
                        size="sm"
                        onClick={() =>
                            needsInitialPassword
                                ? setSetPasswordOpen(true)
                                : void sendPasswordReset()
                        }
                        disabled={
                            passwordResetSending ||
                            !user?.email ||
                            passwordSaving
                        }
                        className="shrink-0"
                    >
                        {needsInitialPassword
                            ? "Set or update password"
                            : passwordResetSending
                              ? "Sending..."
                              : "Send reset email"}
                    </PillButtonUI>
                </div>
            </SettingsSection>

            <Modal
                open={setPasswordOpen}
                onClose={closeSetPassword}
                breadcrumbs={["Security", "Set password"]}
                size="sm"
                className="h-auto"
                cancelAction={{
                    label: "Cancel",
                    onClick: closeSetPassword,
                    disabled: passwordSaving,
                }}
                primaryAction={{
                    label: passwordSaving ? "Setting..." : "Set password",
                    onClick: () => void addPassword(),
                    disabled:
                        passwordSaving || !password || !confirmPassword,
                }}
            >
                <div className="space-y-4 pb-5">
                    <p className="text-sm text-gray-500">
                        Use at least {MIN_PASSWORD_LENGTH} characters.
                    </p>
                    <div>
                        <FieldLabel htmlFor="new-account-password">
                            Password
                        </FieldLabel>
                        <InputUI
                            id="new-account-password"
                            type="password"
                            autoComplete="new-password"
                            value={password}
                            onChange={(event) =>
                                setPasswordValue(event.target.value)
                            }
                            className={`w-full ${authInputUIClassName}`}
                        />
                    </div>
                    <div>
                        <FieldLabel htmlFor="confirm-account-password">
                            Confirm password
                        </FieldLabel>
                        <InputUI
                            id="confirm-account-password"
                            type="password"
                            autoComplete="new-password"
                            value={confirmPassword}
                            onChange={(event) =>
                                setConfirmPassword(event.target.value)
                            }
                            className={`w-full ${authInputUIClassName}`}
                        />
                    </div>
                    <div>
                        <FieldLabel htmlFor="account-reauth-code">
                            Verification code (if required by your sign-in provider)
                        </FieldLabel>
                        <InputUI
                            id="account-reauth-code"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            value={reauthCode}
                            onChange={(event) => setReauthCode(event.target.value.replace(/\D/g, ""))}
                            className={`w-full ${authInputUIClassName}`}
                        />
                        <button type="button" onClick={() => void sendReauthCode()}
                            disabled={reauthSending} className="mt-2 text-sm underline">
                            {reauthSending ? "Sending..." : "Send verification code"}
                        </button>
                        {reauthStatus && <p className="mt-2 text-sm text-gray-500">{reauthStatus}</p>}
                    </div>
                    {passwordSetError && (
                        <p className="text-sm text-red-600" role="alert">
                            {passwordSetError}
                        </p>
                    )}
                </div>
            </Modal>
        </section>
    );
}
