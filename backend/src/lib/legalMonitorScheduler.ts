import { recoverInterruptedLegalMonitorRuns, runDueLegalMonitors } from "./legalMonitors";
import { deploymentModuleEnabled } from "./deploymentModules";

const DEFAULT_POLL_INTERVAL_MS = 60_000;

function pollInterval(): number {
    const parsed = Number.parseInt(process.env.LEGAL_MONITOR_POLL_INTERVAL_MS ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : DEFAULT_POLL_INTERVAL_MS;
}

export function startLegalMonitorScheduler(): () => void {
    if (
        !deploymentModuleEnabled("legalMonitors") ||
        process.env.LEGAL_MONITOR_SCHEDULER_ENABLED?.trim().toLowerCase() === "false"
    ) {
        return () => undefined;
    }
    let ticking = false;
    const tick = async () => {
        if (ticking) return;
        ticking = true;
        try {
            await runDueLegalMonitors();
        } catch (error) {
            console.error("[legal-monitor] scheduler tick failed", error);
        } finally {
            ticking = false;
        }
    };
    const timer = setInterval(() => void tick(), pollInterval());
    timer.unref();
    void recoverInterruptedLegalMonitorRuns()
        .then(() => tick())
        .catch((error) => console.error("[legal-monitor] recovery failed", error));
    return () => clearInterval(timer);
}
