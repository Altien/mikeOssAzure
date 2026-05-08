import { RouteDiagnostic } from "@/app/components/diagnostics/RouteDiagnostic";

// Mirrors the same generateStaticParams pattern used by every other
// dynamic route in this app. Lets us reproduce — and observe — the
// "_" placeholder substitution behaviour without touching the real
// pages. Navigate to /diagnostics/route/abc-123 to see what each
// route hook returns.
export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function RouteDiagnosticPage() {
    return <RouteDiagnostic />;
}
