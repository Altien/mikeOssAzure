import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Multi-tenant issue 009: the cross-tenant canary against the local Docker
// stack (docker-compose.dev.yml: Postgres + PostgREST). `npm run test:canary`.
// Point it elsewhere with CANARY_DATABASE_URL (a role that bypasses RLS, for
// seeding), CANARY_POSTGREST_URL and CANARY_JWT_SECRET (PostgREST's
// PGRST_JWT_SECRET).
const databaseUrl = process.env.CANARY_DATABASE_URL ?? "postgres://mikeadmin:devpassword@localhost:5432/mike";
const postgrestUrl = process.env.CANARY_POSTGREST_URL ?? "http://localhost:4000";
const jwtSecret = process.env.CANARY_JWT_SECRET ?? process.env.JWT_SECRET ?? "local-dev-secret-change-me-please-32chars-min";
const unlimited = "1000000";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: false,
    include: ["src/__tests__/canary/**/*.canary.ts"],
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    env: {
      CANARY_DATABASE_URL: databaseUrl,
      AUTH_PROVIDER: "entra",
      SUPABASE_URL: postgrestUrl,
      POSTGREST_JWT_SECRET: jwtSecret,
      TENANT_CONTEXT_STRICT: "true",
      ENTRA_ADMIN_GROUP_IDS: "canary-admins",
      RATE_LIMIT_GENERAL_MAX: unlimited,
      RATE_LIMIT_TOOL_RESULT_MAX: unlimited,
      RATE_LIMIT_CHAT_MAX: unlimited,
      RATE_LIMIT_CHAT_CREATE_MAX: unlimited,
      RATE_LIMIT_UPLOAD_MAX: unlimited,
      RATE_LIMIT_EXPORT_MAX: unlimited,
      RATE_LIMIT_DATA_DELETE_MAX: unlimited,
    },
  },
});
