"use client";

import { RedirectToSettings } from "../RedirectToSettings";

// Dev (static export): see RedirectToSettings.
export default function AccountRedirectPage() {
    return <RedirectToSettings to="/settings/api-keys" />;
}
