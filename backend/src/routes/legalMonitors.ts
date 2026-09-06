import { Router } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import {
  createLegalMonitor,
  deleteLegalMonitor,
  getLegalMonitor,
  legalMonitorEmailAvailable,
  LEGAL_MONITOR_INTERVALS,
  listLegalMonitorRuns,
  listLegalMonitors,
  LegalMonitorAlreadyRunningError,
  LegalMonitorNotFoundError,
  runLegalMonitor,
  updateLegalMonitor,
  type LegalMonitorInput,
  type LegalMonitorSourceType,
  normalizeSeverity,
} from "../lib/legalMonitors";
import { configuredModelSummaries } from "../lib/llm/registry";
import {
  featureForModel,
  getUserFeatures,
  requireUserFeature,
} from "../lib/userFeatures";
import { listUserMcpConnectors } from "../lib/mcpConnectors";
import { createServerDatabase } from "../lib/database";
import { FINTECH_GC_DIGEST_PRESET } from "../lib/fintechGcDigestPreset";
import { TRADEMARK_PREFIX_MONITOR_PRESET } from "../lib/trademarkMonitorPreset";
import {
  parseOpmlSources,
  type LegalMonitorSourceInput,
} from "../lib/legalMonitorSources";
import { connectorSupportsTrademarkPrefix } from "../lib/legalMonitorConnectorSources";

export const legalMonitorsRouter = Router();
legalMonitorsRouter.use(requireAuth, requireUserFeature("legalMonitors"));

function readInput(body: unknown): LegalMonitorInput {
  const value =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    name: typeof value.name === "string" ? value.name : "",
    topic: typeof value.topic === "string" ? value.topic : "",
    jurisdiction:
      typeof value.jurisdiction === "string" ? value.jurisdiction : "",
    sourceTypes: Array.isArray(value.sourceTypes)
      ? value.sourceTypes.filter(
          (item): item is LegalMonitorSourceType => typeof item === "string",
        )
      : [],
    connectorId:
      typeof value.connectorId === "string" ? value.connectorId : null,
    connectorConfig:
      value.connectorConfig && typeof value.connectorConfig === "object"
        ? (value.connectorConfig as LegalMonitorInput["connectorConfig"])
        : { mode: "agent" },
    sources: Array.isArray(value.sources)
      ? value.sources.filter(
          (source): source is LegalMonitorSourceInput =>
            !!source && typeof source === "object",
        )
      : [],
    documentIds: Array.isArray(value.documentIds)
      ? value.documentIds.filter((id): id is string => typeof id === "string")
      : [],
    model: typeof value.model === "string" ? value.model : "",
    intervalHours:
      typeof value.intervalHours === "number"
        ? value.intervalHours
        : Number(value.intervalHours),
    lookbackDays:
      typeof value.lookbackDays === "number"
        ? value.lookbackDays
        : Number(value.lookbackDays ?? 14),
    maxItemsPerRun:
      typeof value.maxItemsPerRun === "number"
        ? value.maxItemsPerRun
        : Number(value.maxItemsPerRun ?? 50),
    alertEmail: typeof value.alertEmail === "string" ? value.alertEmail : null,
    emailEnabled: value.emailEnabled === true,
    knowledgeCaptureEnabled: value.knowledgeCaptureEnabled === true,
    // Unset means 'low', which filters nothing — the pre-threshold behaviour.
    materialityThreshold: normalizeSeverity(value.materialityThreshold ?? "low"),
    enabled: value.enabled !== false,
  };
}

function sendError(res: import("express").Response, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof LegalMonitorNotFoundError)
    return void res.status(404).json({ detail });
  if (error instanceof LegalMonitorAlreadyRunningError)
    return void res.status(409).json({ detail });
  console.error("[legal-monitors] request failed", { error: detail });
  return void res.status(400).json({ detail });
}

legalMonitorsRouter.get("/configuration", async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDatabase();
  try {
    const features = await getUserFeatures(userId, db);
    const connectors = (await listUserMcpConnectors(userId, db)).filter(
      (connector) =>
        connector.enabled &&
        connector.tools.some(
          (tool) => tool.enabled && !tool.requiresConfirmation,
        ),
    );
    const fintechPresetEnabled =
      process.env.LEGAL_MONITOR_FINTECH_PRESET_ENABLED?.trim().toLowerCase() ===
      "true";
    res.json({
      connectors,
      configuredModels: configuredModelSummaries().filter((model) => {
        const feature = featureForModel(model.id);
        return !feature || features[feature];
      }),
      intervals: LEGAL_MONITOR_INTERVALS,
      emailAvailable: await legalMonitorEmailAvailable(userId, db),
      defaultEmail: (res.locals.userEmail as string | undefined) ?? "",
      presets: [
        ...(fintechPresetEnabled ? [FINTECH_GC_DIGEST_PRESET] : []),
        ...(connectors.some(connectorSupportsTrademarkPrefix)
          ? [TRADEMARK_PREFIX_MONITOR_PRESET]
          : []),
      ],
    });
  } catch (error) {
    sendError(res, error);
  }
});

legalMonitorsRouter.post("/parse-opml", requireMfaIfEnrolled, (req, res) => {
  try {
    const opml = typeof req.body?.opml === "string" ? req.body.opml : "";
    if (!opml || opml.length > 2_000_000)
      return void res
        .status(400)
        .json({
          detail: "OPML content is required and must be smaller than 2 MB.",
        });
    res.json({ sources: parseOpmlSources(opml) });
  } catch (error) {
    sendError(res, error);
  }
});

legalMonitorsRouter.get("/", async (_req, res) => {
  try {
    res.json(await listLegalMonitors(res.locals.userId as string));
  } catch (error) {
    sendError(res, error);
  }
});

legalMonitorsRouter.post("/", requireMfaIfEnrolled, async (req, res) => {
  try {
    res
      .status(201)
      .json(
        await createLegalMonitor(
          res.locals.userId as string,
          readInput(req.body),
        ),
      );
  } catch (error) {
    sendError(res, error);
  }
});

legalMonitorsRouter.get("/:monitorId", async (req, res) => {
  try {
    res.json(
      await getLegalMonitor(res.locals.userId as string, req.params.monitorId),
    );
  } catch (error) {
    sendError(res, error);
  }
});

legalMonitorsRouter.put(
  "/:monitorId",
  requireMfaIfEnrolled,
  async (req, res) => {
    try {
      res.json(
        await updateLegalMonitor(
          res.locals.userId as string,
          req.params.monitorId,
          readInput(req.body),
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

legalMonitorsRouter.delete(
  "/:monitorId",
  requireMfaIfEnrolled,
  async (req, res) => {
    try {
      await deleteLegalMonitor(
        res.locals.userId as string,
        req.params.monitorId,
      );
      res.status(204).send();
    } catch (error) {
      sendError(res, error);
    }
  },
);

legalMonitorsRouter.get("/:monitorId/runs", async (req, res) => {
  try {
    const limit = Number.parseInt(
      typeof req.query.limit === "string" ? req.query.limit : "30",
      10,
    );
    res.json(
      await listLegalMonitorRuns(
        res.locals.userId as string,
        req.params.monitorId,
        Number.isFinite(limit) ? limit : 30,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

legalMonitorsRouter.post("/:monitorId/run", async (req, res) => {
  try {
    res.json(
      await runLegalMonitor(res.locals.userId as string, req.params.monitorId),
    );
  } catch (error) {
    sendError(res, error);
  }
});
