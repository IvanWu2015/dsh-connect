/**
 * The one thing the one-click flow cannot declare through `registerApp`'s
 * `addons`: the event-subscription **mode**.
 *
 * `addons` carries permissions, events and callbacks, but the subscription
 * *mode* (webhook vs. long connection) is a "sensitive" application setting, so
 * it needs a separate `application/v7` config PATCH — the Feishu README says so
 * outright (`README.zh.md`, the `registerApp` section).
 *
 * Two honest caveats, both from the API's own doc comment, both reported rather
 * than smoothed over:
 *
 * 1. The endpoint may refuse an app created through the bot-assistant flow
 *    ("仅支持更新开发者后台创建的自建应用，不包含通过机器人助手等其他渠道创建的自建应用"), and the SDK never
 *    documents which channel `registerApp` uses. So this is attempted, and a
 *    rejection is surfaced verbatim.
 * 2. Success here is **not** proof the long connection is live: of the
 *    immediately-effective settings only a whitelist qualifies, everything else
 *    needs a release + review. Nothing in this module claims otherwise.
 *
 * @module dsh-connect/settings/app-config
 */
import { AppType, Client } from "@larksuiteoapi/node-sdk";
import type { FeishuCredentials } from "../channels/feishu/onboard.js";

/** What the caller gets back: a verdict, plus the API's own words on failure. */
export interface SubscriptionResult {
  status: "applied" | "failed";
  /** The API's `msg`/`code` or the thrown message, verbatim — never rewritten. */
  reason?: string;
}

/** The slice of the SDK client this module uses, so tests can hand in a stub. */
export interface ConfigPatchingClient {
  application: {
    v7: {
      applicationConfig: {
        patch(payload: {
          data: { event: { subscription_type: "webhook" | "websocket" } };
          path: { app_id: string };
        }): Promise<{ code?: number; msg?: string } | null | undefined>;
      };
    };
  };
}

/** Builds the authenticated client for one app. Injectable for tests. */
export type AppConfigClientFactory = (credentials: FeishuCredentials) => ConfigPatchingClient;

/** The real factory: authenticate as the app itself (`tenant_access_token`). */
function defaultClientFactory(credentials: FeishuCredentials): ConfigPatchingClient {
  return new Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    appType: AppType.SelfBuild,
  }) as unknown as ConfigPatchingClient;
}

/** A thrown value as a short string. */
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}

/**
 * PATCH the app's event subscription to long-connection (WebSocket) mode.
 *
 * Never throws and never guesses: the endpoint's failure modes (a refusal for
 * this app's origin, a permission error, a network fault) all come back as
 * `{status: "failed", reason}` so the pane can print the API's own explanation.
 */
export async function setEventSubscription(
  credentials: FeishuCredentials,
  deps: { clientFactory?: AppConfigClientFactory } = {},
): Promise<SubscriptionResult> {
  try {
    const client = (deps.clientFactory ?? defaultClientFactory)(credentials);
    const response = await client.application.v7.applicationConfig.patch({
      data: { event: { subscription_type: "websocket" } },
      path: { app_id: credentials.appId },
    });
    // Feishu reports application-level errors *inside* an HTTP 200 body, so a
    // resolved promise with a non-zero `code` is a failure — the SDK's axios
    // interceptor only rejects on transport/HTTP-status errors.
    const code = response?.code ?? 0;
    if (code !== 0) {
      const message = response?.msg ?? "";
      return { status: "failed", reason: message === "" ? `code ${code}` : `${code}: ${message}` };
    }
    return { status: "applied" };
  } catch (error) {
    return { status: "failed", reason: reasonOf(error) };
  }
}
