import React, { useState } from "react";
import { useAuth } from "./useAuth";
import { Button } from "@mike/shared/ui/button";
import { Input } from "@mike/shared/ui/input";
import { Label } from "@mike/shared/ui/label";
import { Spinner } from "@mike/shared/ui/spinner";
import { MikeIcon } from "@mike/shared/chat/mike-icon";

// Dev-fork divergence (upstream sync b8bd5b0c): upstream's email + password
// form posted to Supabase. Sign-in here follows the backend's auth mode
// (GET /config): "Sign in with Microsoft" for Entra (MSAL, see auth/entra.ts),
// an email-only form for the local development provider, and an explanatory
// error for Supabase mode (NOT SUPPORTED in the add-in).
export function LoginPage(): React.ReactElement {
  const { login, loading, error, mode } = useAuth();
  const [email, setEmail] = useState("");

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (mode === "local") {
      if (!email.trim()) return;
      await login(email.trim());
      return;
    }
    await login();
  };

  // mode is null only when GET /config failed — the button then retries it.
  const canSubmit =
    mode === null || mode === "entra" || (mode === "local" && !!email.trim());

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-background px-5 py-8 @sm:px-6">
      <form
        className="flex w-full max-w-[320px] flex-col gap-5"
        onSubmit={handleSubmit}
        noValidate
      >
        <div className="flex flex-col items-center gap-2.5 text-center">
          <MikeIcon size={44} />
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Welcome to Mike
            </h1>
            <p className="text-sm text-muted-foreground">
              AI-powered legal assistant
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {mode === "local" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@firm.com"
                disabled={loading}
                autoComplete="email"
                required
              />
              <p className="text-xs text-muted-foreground">
                Local development sign-in (AUTH_PROVIDER=local)
              </p>
            </div>
          )}

          {error && (
            <p
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}

          {mode !== "unsupported" && (
            <Button
              type="submit"
              className="w-full"
              disabled={loading || !canSubmit}
            >
              {loading ? (
                <Spinner label="Signing in…" />
              ) : mode === "entra" ? (
                "Sign in with Microsoft"
              ) : mode === "local" ? (
                "Sign in"
              ) : (
                "Retry"
              )}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
