/**
 * How much of a stored secret the settings pane is allowed to show.
 *
 * The user has to be able to *confirm* what they configured — a pane that only
 * ever says 「已配置」 cannot tell a correct appId from a typo — but a browser
 * tab (or a screenshot of one) must never hold a usable credential. The two are
 * reconciled here: the host masks the value **before it crosses the wire**, so
 * what the pane receives is already unusable, and `maskSecret` is the only
 * place that decides how much survives.
 *
 * Deliberately pure and dependency-free: the host (`settings-service`) masks
 * with it and the client bundle imports the same compiled module for the input
 * `type`, so the two can never drift into disagreeing about which keys are
 * confidential.
 *
 * @module dsh-connect/settings/secret-disclosure
 */

/**
 * - `full` — shown verbatim. For identifiers, not authenticators.
 * - `mask` — head and tail survive, the middle does not.
 * - `url` — a URL whose *query* carries the token, so only that part is masked.
 */
export type Disclosure = "full" | "mask" | "url";

/**
 * Per-config-key policy, keyed by the channel config key (`CREDENTIAL`-style
 * keys are unique across channels: no channel has two fields that share a name
 * but want different treatment).
 *
 * `appId` / `clientId` are `full` on purpose. They are **identifiers**: they
 * appear in the URL or body of every outbound API call, are readable in the
 * vendor's own console, and grant nothing without the paired secret. Masking
 * them would cost the user the one thing this pane is for — checking that the
 * id they pasted is the one they meant — and buy no secrecy at all.
 */
export const SECRET_DISCLOSURE: Record<string, Disclosure> = Object.freeze({
  appId: "full",
  clientId: "full",
  appSecret: "mask",
  clientSecret: "mask",
  botToken: "mask",
  secret: "mask",
  webhookUrl: "url",
});

/** Query parameters whose *value* is a credential and must not be echoed. */
const SECRET_QUERY_PARAM = /(secret|token|key|sign)/i;

/** Characters kept visible on each end of a masked value. */
const EDGE = 4;

/**
 * Below this length there is no middle to hide — showing 4+4 of a 10-character
 * value would print it in full — so short values collapse to a fixed-width
 * mask, which also avoids leaking the length.
 */
const MIN_MASKABLE = 12;

/** The width of the all-bullets mask used for values too short to split. */
const BULLETS = "••••••";

/** Policy for a config key; unknown keys are treated as confidential. */
export function disclosureOf(configKey: string): Disclosure {
  return SECRET_DISCLOSURE[configKey] ?? "mask";
}

/** True when the pane should render this key as a password input. */
export function isMaskedSecret(configKey: string): boolean {
  return disclosureOf(configKey) !== "full";
}

/** `head…tail`, or the bullets mask when the value is too short to split. */
function maskMiddle(value: string): string {
  if (value.length < MIN_MASKABLE) return BULLETS;
  return value.slice(0, EDGE) + "…" + value.slice(-EDGE);
}

/** Escape a query-parameter name for use inside a `RegExp`. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mask the credential-bearing query parameters of a URL, keeping the origin,
 * path and the innocent parameters readable.
 *
 * Masking such a URL end-to-end would defeat the purpose: DingTalk's webhook is
 * `https://oapi.dingtalk.com/robot/send?access_token=…`, so `https…bcde` tells
 * the user nothing about whether they pasted the right robot. Falls back to the
 * plain mask when the value isn't a parseable URL (a bare token, a typo, an
 * empty-ish string).
 *
 * The masking is a surgical replace on the original text rather than a
 * re-serialize through `URLSearchParams`, which would percent-encode the `…`
 * into `%E2%80%A6` and render the preview unreadable.
 */
function maskUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return maskMiddle(value);
  }
  let masked = value;
  for (const key of new Set(url.searchParams.keys())) {
    if (!SECRET_QUERY_PARAM.test(key)) continue;
    const pattern = new RegExp(`([?&]${escapeForRegExp(key)}=)([^&#]*)`, "g");
    masked = masked.replace(pattern, (whole, prefix: string, held: string) => {
      // Tolerate a percent-encoded token: decode to measure it, mask the
      // decoded form, and splice the readable result back into the raw text.
      let decoded = held;
      try {
        decoded = decodeURIComponent(held);
      } catch {
        /* not encoded — use as-is */
      }
      return decoded.length === 0 ? whole : prefix + maskMiddle(decoded);
    });
  }
  return masked;
}

/**
 * The display preview for one stored secret. Never returns the input: for
 * `mask` and `url` the returned string is lossy by construction, so a caller
 * that echoes it to a browser cannot leak a usable credential.
 *
 * Surrounding whitespace is trimmed first — a pasted value commonly carries a
 * trailing newline, and the mask should describe the stored value, not the
 * paste.
 */
export function maskSecret(configKey: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  switch (disclosureOf(configKey)) {
    case "full":
      return trimmed;
    case "url":
      return maskUrl(trimmed);
    default:
      return maskMiddle(trimmed);
  }
}
