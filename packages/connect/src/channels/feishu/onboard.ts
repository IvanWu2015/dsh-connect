/**
 * One-click Feishu onboarding: when no credentials are configured, use the
 * official `registerApp` (OAuth 2.0 Device Authorization Grant) to let the
 * user scan a QR / open a link, create the bot app with the right
 * permissions/events, and receive the App ID + Secret back — no manual
 * developer-console work. Credentials are persisted for later startups.
 * @module dsh-connect/channels/feishu/onboard
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registerApp } from "@larksuiteoapi/node-sdk";
import type { Language } from "../../i18n.js";
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

/**
 * Write the credentials to the legacy JSON file. Returns whether the write
 * succeeded.
 *
 * The file is a mirror, not the source of truth, so a failure here is not fatal
 * — the running instance holds the values in memory and connects fine. But it is
 * the difference between "onboarded once" and "onboarded again on every boot",
 * and only the caller can tell the user which one they got.
 */
export function saveCredentials(credentials: FeishuCredentials): boolean {
  try {
    const file = credentialFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(credentials, null, 2), "utf8");
    // Secrets on disk must not be world-readable: owner-only rw on POSIX
    // (a no-op on Windows, where ACLs apply instead).
    try {
      chmodSync(file, 0o600);
    } catch {
      // Platform without chmod support — best effort.
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Extra hooks for callers that drive the flow themselves — the settings pane's
 * one-click button, which needs the link *before* the flow resolves and needs
 * the failure code to report. All optional, so the CLI path
 * (`register()` → `onboardFeishu(logger, language)`) is unchanged.
 */
export interface OnboardHooks {
  /** Called once, synchronously, with the device-authorization link — before polling starts. */
  onQRCodeReady?: (info: { url: string; expireIn: number }) => void;
  /** Called with the SDK error code just before a failed flow resolves `null`. */
  onError?: (code: string) => void;
  /**
   * Aborts polling and invalidates the link. **Only ever pass a signal a human
   * explicitly cancelled** — the link is single-use and single-person, so an
   * incidental abort (an HTTP response closing, a component unmounting) burns
   * the user's only chance and forces a whole new scan.
   */
  signal?: AbortSignal;
}

/**
 * Run the one-click onboarding flow. Resolves with the created app credentials,
 * or `null` when the user aborts / the flow fails. The returned link (also
 * printable) is valid for ~10 minutes and usable by exactly one person.
 */
export async function onboardFeishu(
  logger?: { warn?: (...args: unknown[]) => void },
  language: Language = "zh",
  hooks: OnboardHooks = {},
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
            "im:message.history:readonly",
          ],
        },
        events: { items: { tenant: ["im.message.receive_v1"] } },
        callbacks: { items: ["card.action.trigger"] },
      },
      // `signal` here is the *cancel* signal only — see OnboardHooks.signal.
      signal: hooks.signal,
      onQRCodeReady(info) {
        logger?.warn?.(t.onboardingLink(info.url));
        logger?.warn?.(t.onboardingLinkExpiry(Math.floor(info.expireIn / 60)));
        hooks.onQRCodeReady?.(info);
      },
    });
    return { appId: result.client_id, appSecret: result.client_secret };
  } catch (error) {
    const code = (error as { code?: string })?.code ?? (error instanceof Error ? error.message : String(error));
    logger?.warn?.(t.onboardingFailed(code));
    // The message was already logged; this hands the *code* to a caller that
    // reports it to the pane, which cannot read the host log.
    hooks.onError?.(code);
    return null;
  }
}
