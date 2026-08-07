/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");

module.exports = async (_env, options) => {
  const isDev = options.mode !== "production";

  if (!isDev) {
    // Dev fork: no Supabase URL/key — sign-in is Entra (MSAL) and its tenant /
    // client / scope come from the backend's GET /config at runtime.
    const required = ["REACT_APP_API_BASE_URL", "REACT_APP_WEB_APP_URL"];
    const missing = required.filter((name) => !process.env[name]?.trim());
    if (missing.length > 0) {
      throw new Error(
        `Production Word build is missing: ${missing.join(", ")}`
      );
    }
  }

  /** @type {import('webpack-dev-server').Configuration} */
  const devServerConfig = {
    port: 3000,
    hot: true,
    // compress defaults to true, and the gzip middleware buffers
    // text/event-stream bodies until the response ends — which turns the /chat
    // SSE proxy into one giant blob delivered only when generation finishes.
    // Disable it so streamed tokens reach the task pane as they arrive.
    compress: false,
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
    static: [
      {
        directory: path.join(__dirname, "assets"),
        publicPath: "/assets",
      },
    ],
  };

  if (isDev) {
    // Dev-only: self-signed HTTPS cert for the webpack-dev-server on
    // localhost:3000. office-addin-dev-certs installs its CA into the OS
    // keychain, which pops an admin prompt — impossible to approve in
    // automated/headless environments. DEV_HTTPS_CERT/DEV_HTTPS_KEY serve
    // existing cert files directly instead (the driving browser must then
    // tolerate the untrusted cert, e.g. --ignore-certificate-errors).
    if (process.env.DEV_HTTPS_CERT && process.env.DEV_HTTPS_KEY) {
      const fs = require("fs");
      devServerConfig.server = {
        type: "https",
        options: {
          cert: fs.readFileSync(process.env.DEV_HTTPS_CERT),
          key: fs.readFileSync(process.env.DEV_HTTPS_KEY),
        },
      };
    } else {
      // Required lazily so production builds (`--mode production`) don't
      // depend on this dev-only package at all.
      const { getHttpsServerOptions } = require("office-addin-dev-certs");
      const httpsOptions = await getHttpsServerOptions();
      devServerConfig.server = { type: "https", options: httpsOptions };
    }

    // Word loads the task pane over HTTPS, and its WebView blocks "mixed content"
    // (HTTP requests from an HTTPS page). The local Mike API only serves HTTP,
    // so calling it directly fails with "Load failed". Proxy it through this
    // HTTPS dev server instead, so the pane makes only same-origin HTTPS calls
    // (REACT_APP_API_BASE_URL=https://localhost:3000) that webpack forwards to
    // the local HTTP backend server-side. The target is overridable so the
    // proxy tracks whatever port the backend is actually on.
    // Dev fork: the backend mounts its routers under /api and serves the
    // runtime auth config at /config, so both are forwarded unchanged (no
    // path rewrite); there is no Supabase proxy (sign-in is Entra / MSAL,
    // which talks to login.microsoftonline.com directly).
    const apiTarget = process.env.API_PROXY_TARGET || "http://localhost:3001";
    devServerConfig.proxy = [
      {
        context: ["/api", "/config"],
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
    ];
  }

  /** @type {import('webpack').Configuration} */
  const config = {
    devtool: "source-map",
    entry: {
      // process-shim MUST load first: it installs a browser `process` global so
      // the shared @mike/api-client's module-eval-time `process?.env?.…` reads
      // don't throw "process is not defined" (see src/process-shim.ts).
      taskpane: ["./src/process-shim.ts", "./src/taskpane/index.tsx"],
      commands: ["./src/process-shim.ts", "./src/commands/commands.ts"],
      // Office-dialog fallback for Microsoft sign-in (hosts without NAA).
      "auth-dialog": [
        "./src/process-shim.ts",
        "./src/auth-dialog/auth-dialog.ts",
      ],
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "[name].js",
      clean: true,
    },
    resolve: {
      extensions: [".ts", ".tsx", ".js", ".jsx"],
      alias: {
        // Shared design system (the @mike/shared package). In the fork this
        // lives in the monorepo's packages/; here the files are vendored under
        // src/vendor. Same name the fork's web app imports.
        "@mike/shared": path.resolve(__dirname, "src/vendor/shared"),
        // Shared typed API client + core types/enums. Point at the TS entry so
        // ts-loader compiles them (transpileOnly) exactly like @mike/shared
        // above — these resolve purely by alias (no package.json dependency).
        // @mike/api-client transitively imports @mike/core, so both are aliased.
        "@mike/api-client": path.resolve(
          __dirname,
          "src/vendor/api-client/index.ts"
        ),
        "@mike/core": path.resolve(__dirname, "src/vendor/core/index.ts"),
        // De-dupe React when resolving the shared sources.
        react: path.resolve(__dirname, "node_modules/react"),
        "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      },
      // Resolve bare imports (cva, lucide-react, radix, …) from the add-in's
      // own node_modules; the trailing "node_modules" keeps default walk-up
      // behaviour.
      modules: [path.resolve(__dirname, "node_modules"), "node_modules"],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          // transpileOnly so ts-loader compiles the shared .tsx sources that
          // live outside this project's rootDir without cross-project type
          // errors; type-checking is done separately via `tsc --noEmit`.
          use: {
            loader: "ts-loader",
            options: { transpileOnly: true },
          },
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ["style-loader", "css-loader", "postcss-loader"],
        },
        {
          test: /\.svg$/i,
          type: "asset/resource",
          generator: {
            filename: "icons/[name].[contenthash][ext]",
          },
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        filename: "taskpane.html",
        template: "./src/taskpane/index.html",
        chunks: ["taskpane"],
      }),
      new HtmlWebpackPlugin({
        filename: "commands.html",
        template: "./src/commands/commands.html",
        chunks: ["commands"],
      }),
      new HtmlWebpackPlugin({
        filename: "auth-dialog.html",
        template: "./src/auth-dialog/auth-dialog.html",
        chunks: ["auth-dialog"],
      }),
      // Expose env vars to the bundle so TypeScript process.env calls compile
      new webpack.EnvironmentPlugin({
        // Backend ORIGIN (no /api suffix) — same meaning as the web
        // frontend's NEXT_PUBLIC_API_BASE_URL.
        // Upstream divergence (sync-log: 148635e3): same-origin /api and
        // /config retain the Entra runtime configuration boundary.
        REACT_APP_API_BASE_URL: isDev ? "" : undefined,
        REACT_APP_DEFAULT_MODEL: "claude-sonnet-4-6",
        // The Mike web app origin — the task pane links here (e.g. the
        // account/api-keys page); it never fetches from it.
        REACT_APP_WEB_APP_URL: isDev ? "http://localhost:3000" : undefined,
        NODE_ENV: isDev ? "development" : "production",
      }),
    ],
    devServer: devServerConfig,
  };

  return config;
};
