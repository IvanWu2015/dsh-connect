/**
 * One-click Feishu onboarding: when no credentials are configured, use the
 * official `registerApp` (OAuth 2.0 Device Authorization Grant) to let the
 * user scan a QR / open a link, create the bot app with the right
 * permissions/events, and receive the App ID + Secret back — no manual
 * developer-console work. Credentials are persisted for later startups.
 * @module dsh-connect-feishu/onboard
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registerApp } from "@larksuiteoapi/node-sdk";
import type { Language } from "dsh-connect";
import { feishuMessages } from "./i18n.js";

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

function credentialFile(): string {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.cwd(), ".dsh");
  return join(home, ".dsh-connect", "feishu-credentials.json");
}

export function loadCredentials(): FeishuCredentials | null {
  try {
    const parsed = JSON.parse(readFileSync(credentialFile(), "utf8")) as Partial<FeishuCredentials>;
    if (typeof parsed.appId === "string" && parsed.appId !== "" && typeof parsed.appSecret === "string" && parsed.appSecret !== "") {
      return { appId: parsed.appId, appSecret: parsed.appSecret };
    }
  } catch {
    // Not present yet.
  }
  return null;
}

export function saveCredentials(credentials: FeishuCredentials): void {
  try {
    const file = credentialFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(credentials, null, 2), "utf8");
  } catch {
    // Best-effort persistence; the running instance still works in memory.
  }
}

/**
 * Run the one-click onboarding flow. Resolves with the created app credentials,
 * or `null` when the user aborts / the flow fails. The returned link (also
 * printable) is valid for ~10 minutes and usable by exactly one person.
 */
export async function onboardFeishu(
  logger?: { warn?: (...args: unknown[]) => void },
  language: Language = "zh",
): Promise<FeishuCredentials | null> {
  const t = feishuMessages(language);
  try {
    const result = await registerApp({
      appPreset: {
        name: "DSH 助手",
        desc: "DeepSeek Harness 接入助手",
      },
      addons: {
        scopes: {
          tenant: [
            "im:message",
            "im:message:send_as_bot",
            "im:message.p2p_msg:readonly",
            "im:message.group_at_msg:readonly",
            "im:resource",
          ],
        },
        events: { items: { tenant: ["im.message.receive_v1"] } },
        callbacks: { items: ["card.action.trigger"] },
      },
      onQRCodeReady(info) {
        logger?.warn?.(t.onboardingLink(info.url));
        logger?.warn?.(t.onboardingLinkExpiry(Math.floor(info.expireIn / 60)));
      },
    });
    return { appId: result.client_id, appSecret: result.client_secret };
  } catch (error) {
    const code = (error as { code?: string })?.code ?? (error instanceof Error ? error.message : String(error));
    logger?.warn?.(t.onboardingFailed(code));
    return null;
  }
}
