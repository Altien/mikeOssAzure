const fs = require("node:fs");
// Explicit per-workspace owner configuration. Never inherit a shell's model,
// Azure, Sentry or connection settings, and never let this file replace auth,
// network, database, filesystem or telemetry boundaries.
const ALLOWED = new Set([
  "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "MOONSHOT_API_KEY",
  "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY", "OPENCODE_API_KEY", "AWS_BEARER_TOKEN_BEDROCK",
  "BEDROCK_API_KEY", "BEDROCK_AWS_REGION", "AWS_REGION", "AZURE_OPENAI_API_KEY",
  "AZURE_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_RESOURCE_NAME",
  "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_API_VERSION",
  "AZURE_FOUNDRY_API_KEY", "AZURE_FOUNDRY_ENDPOINT",
  "GOOGLE_VERTEX_CREDENTIALS_JSON", "GOOGLE_VERTEX_LOCATION",
  "XAI_API_KEY", "CUSTOM_API_KEY", "CUSTOM_BASE_URL", "MIKE_MODEL_CONFIG_JSON",
]);
function loadOperatorConfig(file) {
  let content;
  try {
    const metadata = fs.statSync(file);
    if (process.platform !== "win32" && (metadata.mode & 0o077)) {
      throw new Error("Local operator-config.json must be readable only by its owner (chmod 600)");
    }
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const config = JSON.parse(content);
  if (!config || Array.isArray(config) || typeof config !== "object") throw new Error("Invalid local operator configuration");
  for (const [key, value] of Object.entries(config)) {
    if (!ALLOWED.has(key) || typeof value !== "string" || !value.trim()) {
      throw new Error("Local operator configuration contains an unsupported setting");
    }
  }
  return config;
}
module.exports = { loadOperatorConfig };
