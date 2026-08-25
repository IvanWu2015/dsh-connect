/**
 * Minimal STOMP 1.x frame codec used by the DingTalk stream-mode gateway.
 * Pure string logic (no sockets) so it can be unit-tested without a network:
 * DingTalk's stream gateway speaks STOMP over WebSocket with JSON bodies —
 * CONNECT / CONNECTED / SUBSCRIBE / MESSAGE / SEND / ERROR frames and bare
 * newline heartbeats.
 * @module dsh-connect-dingtalk/stomp
 */

/** One decoded STOMP frame. */
export interface StompFrame {
  command: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Escape a header value per STOMP rules: backslash, newline, carriage
 * return and colon become \\, \n, \r, \c.
 */
export function escapeHeader(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "\\": out += "\\\\"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case ":": out += "\\c"; break;
      default: out += ch;
    }
  }
  return out;
}

/** Reverse of {@link escapeHeader}. */
export function unescapeHeader(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      const next = value[++i];
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "c") out += ":";
      else out += "\\"; // "\\" escape sequence → a literal backslash
    } else {
      out += ch;
    }
  }
  return out;
}

/** Serialize one frame (command, header block, blank line, body, NUL). */
export function encodeFrame(command: string, headers: Record<string, string>, body = ""): string {
  const lines: string[] = [command];
  for (const [key, value] of Object.entries(headers)) {
    lines.push(`${key}:${escapeHeader(value)}`);
  }
  lines.push("", body);
  return `${lines.join("\n")}\0`;
}

/** Result of feeding a chunk into the incremental decoder. */
export interface StompDecodeResult {
  frames: StompFrame[];
  /** Unconsumed tail (partial frame) to carry into the next feed. */
  rest: string;
}

/**
 * Incrementally decode STOMP frames from a string buffer. Frames are
 * NUL-terminated; heartbeats (bare newlines) and other whitespace-only
 * segments are skipped. Returns the decoded frames plus the leftover tail.
 */
export function decodeFrames(buffer: string): StompDecodeResult {
  const frames: StompFrame[] = [];
  let rest = buffer;
  for (;;) {
    // STOMP heartbeats are bare EOLs (not NUL-terminated): strip any leading
    // newlines before the next frame so a heartbeat doesn't glue onto it.
    rest = rest.replace(/^(?:\r?\n)+/, "");
    const nul = rest.indexOf("\0");
    if (nul === -1) break;
    const segment = rest.slice(0, nul);
    rest = rest.slice(nul + 1);
    if (segment.replace(/\r?\n/g, "").trim() === "") continue; // NUL-terminated heartbeat / stray EOL
    const normalized = segment.replace(/\r\n/g, "\n");
    const nl = normalized.indexOf("\n");
    const command = (nl === -1 ? normalized : normalized.slice(0, nl)).trim();
    const headerPart = nl === -1 ? "" : normalized.slice(nl + 1);
    const headers: Record<string, string> = {};
    let bodyStart = -1;
    const lines = headerPart.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "") {
        bodyStart = i + 1;
        break;
      }
      const colon = line.indexOf(":");
      if (colon !== -1) {
        headers[unescapeHeader(line.slice(0, colon))] = unescapeHeader(line.slice(colon + 1));
      }
    }
    const body = bodyStart === -1 ? "" : lines.slice(bodyStart).join("\n");
    frames.push({ command, headers, body });
  }
  return { frames, rest };
}
