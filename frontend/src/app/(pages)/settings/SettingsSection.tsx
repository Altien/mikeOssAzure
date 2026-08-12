import { GlassCard } from "@/app/components/ui/glass-card";
import { cn } from "@/app/lib/utils";

export function SettingsSection({
    children,
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    children: React.ReactNode;
}) {
    return (
        <GlassCard
            className={cn("overflow-hidden bg-white/55", className)}
            {...props}
        >
            {children}
        </GlassCard>
    );
}
