"use client";

import { useState } from "react";
import { authInputClassName } from "@/app/components/auth/authStyles";
import {
    MIN_PASSWORD_LENGTH,
    minimumPasswordMessage,
} from "@/app/components/auth/passwordPolicy";
import { Modal } from "@/app/components/modals/Modal";
import { Input } from "@/app/components/ui/input";
import { PillButton } from "@/app/components/ui/pill-button";
import { useAuth } from "@/app/contexts/AuthContext";
import { browserAuthCallbackUrl } from "@/app/lib/authRedirects";
import { supabase } from "@/app/lib/supabase";
import { SettingsSection } from "@/app/(pages)/settings/SettingsSection";
import { FieldLabel } from "@/app/components/ui/form-field";

export function PasswordSettingsSection() {
    const { user, setPassword } = useAuth();
    const [setPasswordOpen, setSetPasswordOpen] = useState(false);
    const [password, setPasswordValue] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [passwordSaving, setPasswordSaving] = useState(false);
    const [passwordSetError, setPasswordSetError] = useState<string | null>(
        null,
    );
    const [passwordStatus, setPasswordStatus] = useState<string | null>(null);
    const [passwordResetSending, setPasswordResetSending] = useState(false);

    const needsInitialPassword =
        user?.createdWithGoogle === true && user.hasPassword === false;

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
            await setPassword(password);
            setPasswordValue("");
            setConfirmPassword("");
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
            const redirectTo = browserAuthCallbackUrl("/reset-password");
            const { error } = await supabase.auth.resetPasswordForEmail(
                user.email,
                redirectTo ? { redirectTo } : undefined,
            );
            if (error) throw error;
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

    function closeSetPassword() {
        if (passwordSaving) return;
        setSetPasswordOpen(false);
        setPasswordSetError(null);
        setPasswordValue("");
        setConfirmPassword("");
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
                                ? "Set password"
                                : "Reset password"}
                        </p>
                        <p className="text-sm text-gray-500">
                            {needsInitialPassword
                                ? "Add a password to sign in with your email and change your account email."
                                : `Send a secure password-reset link to ${user?.email}.`}
                        </p>
                        {passwordStatus && (
                            <p className="text-xs text-gray-500">
                                {passwordStatus}
                            </p>
                        )}
                    </div>
                    <PillButton
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
                            ? "Set password"
                            : passwordResetSending
                              ? "Sending..."
                              : "Send reset email"}
                    </PillButton>
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
                        <Input
                            id="new-account-password"
                            type="password"
                            autoComplete="new-password"
                            value={password}
                            onChange={(event) =>
                                setPasswordValue(event.target.value)
                            }
                            className={`w-full ${authInputClassName}`}
                        />
                    </div>
                    <div>
                        <FieldLabel htmlFor="confirm-account-password">
                            Confirm password
                        </FieldLabel>
                        <Input
                            id="confirm-account-password"
                            type="password"
                            autoComplete="new-password"
                            value={confirmPassword}
                            onChange={(event) =>
                                setConfirmPassword(event.target.value)
                            }
                            className={`w-full ${authInputClassName}`}
                        />
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
