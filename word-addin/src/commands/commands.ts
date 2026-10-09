/// <reference types="office-js" />
import { initAddinErrorReporting } from "../taskpane/lib/errorReporting";
import { loadRuntimeConfig } from "../taskpane/auth/runtimeConfig";

void loadRuntimeConfig().then((config) => initAddinErrorReporting("commands", config.wordSentryDsn)).catch(() => {});

Office.onReady(() => {
  // no-op — ribbon commands are handled by the task pane
});
