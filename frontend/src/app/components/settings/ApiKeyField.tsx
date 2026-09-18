"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { FieldLabel } from "@/app/components/ui/form-field";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { settingsGlassIconButtonClassName } from "@/app/(pages)/settings/settingsStyles";

// The server returns only status, never a saved credential.
const SAVED_KEY_MASK = "x".repeat(24);

// Upstream divergence (sync-log: 3a10943): upstream gates save/remove behind
// MfaVerificationPopup (Supabase-auth TOTP step-up). Dev has no app-level MFA
// (Entra enforces it at the IdP), so save/remove run directly.
export function ApiKeyField({
    label,
    description,
    placeholder,
    hasSavedKey,
    isServerConfigured = false,
    onSave,
    onRemove,
}: {
    label: string;
    description?: string;
    placeholder: string;
    hasSavedKey: boolean;
    isServerConfigured?: boolean;
    onSave: (value: string) => Promise<boolean>;
    onRemove: () => Promise<boolean>;
}) {
    const [value, setValue] = useState("");
    const [reveal, setReveal] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        setValue("");
    }, [hasSavedKey]);

    const dirty = value.trim().length > 0;
    const showMask = hasSavedKey && !isEditing && !dirty;

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const ok = await onSave(value);
            if (ok) {
                setValue("");
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
            } else {
                alert(`Failed to save ${label}.`);
            }
        } catch {
            alert(`Failed to save ${label}.`);
        } finally {
            setIsSaving(false);
        }
    };

    const handleRemove = async () => {
        setIsSaving(true);
        try {
            const ok = await onRemove();
            if (!ok) alert(`Failed to remove ${label}.`);
        } catch {
            alert(`Failed to remove ${label}.`);
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="px-4 py-5">
            <FieldLabel>{label}</FieldLabel>
            {description && (
                <p className="mb-3 text-sm text-gray-500">{description}</p>
            )}
            <div className="space-y-2">
                <div className="relative flex-1">
                    <SettingsTextInput
                        aria-label={label}
                        type={reveal && !showMask ? "text" : "password"}
                        value={showMask ? SAVED_KEY_MASK : value}
                        readOnly={showMask}
                        onFocus={() => setIsEditing(true)}
                        onBlur={() => setIsEditing(false)}
                        onChange={(event) => setValue(event.target.value)}
                        placeholder={
                            isServerConfigured
                                ? "Server .env key configured"
                                : hasSavedKey
                                  ? "Saved key hidden"
                                  : placeholder
                        }
                        className="pr-10"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={isServerConfigured}
                    />
                    {dirty && (
                        <button
                            type="button"
                            onClick={() => setReveal((current) => !current)}
                            disabled={isServerConfigured}
                            className={`absolute inset-y-1 right-1.5 flex items-center ${settingsGlassIconButtonClassName}`}
                            aria-label={reveal ? "Hide key" : "Show key"}
                        >
                            {reveal ? (
                                <EyeOff className="h-4 w-4" />
                            ) : (
                                <Eye className="h-4 w-4" />
                            )}
                        </button>
                    )}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={
                            isServerConfigured || isSaving || !dirty || saved
                        }
                        className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                    >
                        {isSaving ? "Saving..." : saved ? "Saved" : "Save"}
                    </button>
                    {hasSavedKey && !isServerConfigured && (
                        <button
                            type="button"
                            onClick={handleRemove}
                            disabled={isSaving}
                            className="text-xs font-medium text-red-600 transition-colors hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
                        >
                            Remove
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
