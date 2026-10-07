import React, { useState } from "react";
import { useAuth } from "./useAuth";
import { InputUI } from "@mike/input-ui";
import { Label } from "../../shared/ui/label";
import { WordAddinLogo } from "../components/shell/WordAddinLogo";
import { PillButtonUI as PillButton } from "@mike/pill-button-ui";
import { GoogleIconUI } from "@mike/google-icon-ui";
import { AuthDividerUI as AuthDivider } from "@mike/auth-divider-ui";

const authInputClassName =
  "rounded-lg border border-white/70 bg-white/55 px-3 text-gray-700 shadow-[0_3px_9px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.86),inset_0_-1px_0_rgba(255,255,255,0.58)] backdrop-blur-xl transition-[color,box-shadow,background-color,border-color] placeholder:text-gray-400 hover:bg-white/65 focus-visible:border-white/90 focus-visible:bg-white/75 focus-visible:ring-2 focus-visible:ring-white/70";

export function LoginPage(): React.ReactElement {
  const { login, loginWithGoogle, loading, error, mode } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if ((mode === "local" || mode === "supabase") && !email.trim()) return;
    await login(mode === "local" || mode === "supabase" ? email.trim() : undefined,
      mode === "supabase" ? password : undefined);
  };

  return (
    <div className="h-full overflow-y-auto bg-gray-50/80">
      <main className="relative flex min-h-full items-center justify-center px-6 py-24 @sm:px-8">
        <div className="absolute top-5 left-1/2 -translate-x-1/2 @sm:top-6">
          <WordAddinLogo size="lg" />
        </div>

        <div data-testid="login-form" className="w-full max-w-md">
          <h1 className="mb-6 text-left font-serif text-2xl font-medium text-gray-950">
            Log In
          </h1>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {(mode === "local" || mode === "supabase") && <div>
              <Label
                htmlFor="email"
                className="mb-2 block text-sm font-medium text-gray-700"
              >
                Email
              </Label>
              <InputUI
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email"
                disabled={loading}
                autoComplete="email"
                required
                className={`w-full ${authInputClassName}`}
              />
            </div>}

            {mode === "supabase" && <div>
              <Label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-700">Password</Label>
              <InputUI id="password" type="password" value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password" disabled={loading} required
                className={`w-full ${authInputClassName}`} />
            </div>}

            {error && (
              <div
                className="rounded bg-red-50 p-3 text-sm text-red-600"
                role="alert"
              >
                {error}
              </div>
            )}

            <div className="flex justify-end pt-1">
              <PillButton
                type="submit"
                tone="black"
                size="normal"
                disabled={loading || ((mode === "local" || mode === "supabase") && !email.trim())}
              >
                {loading ? "Signing in..." : mode === "entra" ? "Sign in with Microsoft" : mode === "local" ? "Sign in" : mode === "supabase" ? "Log in" : "Retry"}
              </PillButton>
            </div>
            {mode === "supabase" && <>
              <AuthDivider />
              <PillButton type="button" tone="white" size="normal" disabled={loading}
                onClick={() => void loginWithGoogle()} className="w-full">
                <GoogleIconUI className="h-4 w-4" /> Continue with Google
              </PillButton>
            </>}
          </form>
        </div>
      </main>
    </div>
  );
}
