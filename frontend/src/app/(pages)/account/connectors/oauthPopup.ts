/**
 * Shared browser-popup OAuth flow.
 *
 * Both the MCP connector authorization and the GitHub skill-import connection
 * follow the same ritual: open a blank popup synchronously (so the browser does
 * not treat it as an unsolicited pop-up), fetch the authorization URL, point the
 * popup at it, then race a `postMessage` result from the backend callback page
 * against a timeout and the user closing the window.
 */

const OAUTH_POPUP_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_POPUP_POLL_MS = 700;

export type OAuthPopupMessage = {
    type?: string;
    success?: boolean;
    detail?: string;
};

export type OAuthPopupWaitOptions<TMessage extends OAuthPopupMessage> = {
    /** URL the popup is navigated to once the backend has minted it. */
    authorizationUrl: string;
    /** `data.type` the callback page posts when the flow finishes. */
    messageType: string;
    /** When set, an ack of this type is posted back to the callback window. */
    acknowledgeType?: string;
    /** Extra filter on the message payload (e.g. matching connector id). */
    accept?: (data: TMessage) => boolean;
    timedOutMessage: string;
    closedMessage: string;
    failedMessage: string;
};

/**
 * `"redirected"` means the popup was blocked and the current window was sent to
 * the authorization URL instead — the caller has nothing left to do.
 */
export type OAuthPopupWaitResult = "completed" | "redirected";

export type OAuthPopup = {
    close: () => void;
    wait: <TMessage extends OAuthPopupMessage>(
        options: OAuthPopupWaitOptions<TMessage>,
    ) => Promise<OAuthPopupWaitResult>;
};

function getOAuthMessageOrigin(): string {
    const configuredBase = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
    if (!configuredBase) return window.location.origin;
    try {
        return new URL(configuredBase, window.location.origin).origin;
    } catch {
        return window.location.origin;
    }
}

export function openOAuthPopup(
    windowName: string,
    features: string,
): OAuthPopup {
    const popup = window.open("about:blank", windowName, features);

    return {
        close: () => popup?.close(),
        wait: async <TMessage extends OAuthPopupMessage>(
            options: OAuthPopupWaitOptions<TMessage>,
        ): Promise<OAuthPopupWaitResult> => {
            if (!popup) {
                window.location.assign(options.authorizationUrl);
                return "redirected";
            }
            popup.location.href = options.authorizationUrl;
            const expectedOrigin = getOAuthMessageOrigin();

            await new Promise<void>((resolve, reject) => {
                const timeout = window.setTimeout(() => {
                    cleanup();
                    reject(new Error(options.timedOutMessage));
                }, OAUTH_POPUP_TIMEOUT_MS);
                const poll = window.setInterval(() => {
                    if (popup.closed) {
                        cleanup();
                        reject(new Error(options.closedMessage));
                    }
                }, OAUTH_POPUP_POLL_MS);
                const cleanup = () => {
                    window.clearTimeout(timeout);
                    window.clearInterval(poll);
                    window.removeEventListener("message", onMessage);
                };
                const onMessage = (event: MessageEvent<TMessage>) => {
                    if (event.origin !== expectedOrigin) return;
                    if (event.data?.type !== options.messageType) return;
                    if (options.accept && !options.accept(event.data)) return;
                    if (options.acknowledgeType) {
                        const sourceWindow = event.source as Window | null;
                        sourceWindow?.postMessage(
                            { type: options.acknowledgeType },
                            event.origin,
                        );
                    }
                    cleanup();
                    if (event.data.success) {
                        resolve();
                        return;
                    }
                    reject(
                        new Error(event.data.detail || options.failedMessage),
                    );
                };
                window.addEventListener("message", onMessage);
            });

            return "completed";
        },
    };
}
