/**
 * DingTalk stream-mode gateway client: STOMP over WebSocket, zero third-party
 * dependencies (Node ≥ 22 global `WebSocket`; older Node needs a polyfill —
 * the constructor is looked up lazily on `globalThis` so the module loads
 * fine on Node 20, it only fails at connect time).
 *
 * This file is the live network boundary: it is intentionally thin and every
 * protocol detail it depends on lives in the pure modules (stomp.ts,
 * message.ts) that carry the unit tests. Actual connectivity requires real
 * app credentials and an outbound connection to the DingTalk gateway, so it
 * cannot be exercised in CI here.
 * @module dsh-connect-dingtalk/stream
 */
import { decodeFrames, encodeFrame, type StompFrame } from "./stomp.js";
import {
  buildConnectBody,
  INBOUND_DESTINATION,
  INBOUND_SUBSCRIPTION,
  REPLY_DESTINATION,
  type DingtalkBotMessage,
} from "./message.js";

/** Minimal structural subset of the WHATWG WebSocket we rely on. */
interface WebSocketLike {
  readyState: number;
  send(data: string | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface DingtalkStreamOptions {
  clientId: string;
  clientSecret: string;
  /** Gateway URL (default wss://api.dingtalk.com/connect). */
  url?: string;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}

export const DEFAULT_STREAM_URL = "wss://api.dingtalk.com/connect";
/** STOMP heartbeat interval (client → gateway), ms. */
const HEARTBEAT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function lazyWebSocketCtor(): (new (url: string) => WebSocketLike) | undefined {
  return (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
}

/**
 * STOMP-over-WebSocket gateway client. Usage:
 * ```ts
 * const client = new DingtalkStreamClient({ clientId, clientSecret });
 * client.onInbound((raw) => console.log(raw.conversationId, raw.text?.content));
 * await client.connect();
 * await client.sendReply(msgId, buildTextReplyBody(msgId, "hi"));
 * ```
 */
export class DingtalkStreamClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly url: string;
  private readonly logger?: DingtalkStreamOptions["logger"];
  private ws?: WebSocketLike;
  private rest = "";
  private heartbeat?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private backoffMs = RECONNECT_BASE_MS;
  private closedByUs = false;
  private messageHandler?: (raw: DingtalkBotMessage) => void | Promise<void>;

  constructor(options: DingtalkStreamOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.url = options.url ?? DEFAULT_STREAM_URL;
    this.logger = options.logger;
  }

  /** Register the inbound-message handler (called for every gateway push). */
  onInbound(handler: (raw: DingtalkBotMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  /** Open the socket, perform the STOMP handshake and subscribe. Reconnect-safe. */
  async connect(): Promise<void> {
    const Ctor = lazyWebSocketCtor();
    if (Ctor === undefined) {
      throw new Error("connect-dingtalk: WebSocket is not available on this runtime (Node ≥ 22 or a polyfill required)");
    }
    if (this.closedByUs) return;

    this.logger?.info?.(`connect-dingtalk: connecting to ${this.url}`);
    const ws = new Ctor(this.url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("connect-dingtalk: WebSocket handshake timed out"));
      }, 15_000);

      const cleanup = (): void => {
        clearTimeout(timer);
        ws.onopen = null;
        ws.onerror = null;
      };

      ws.onopen = () => {
        cleanup();
        this.onSocketOpen();
        resolve();
      };
      ws.onerror = () => {
        // onclose fires next; the close handler owns reconnect scheduling.
      };
    });

    ws.onmessage = (ev) => this.onSocketMessage(String(ev.data ?? ""));
    ws.onclose = (ev) => this.onSocketClose(ev.code, ev.reason);
  }

  /** Send a reply to an inbound message (SEND frame to the reply topic). */
  async sendReply(msgId: string, body: string): Promise<void> {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== 1 /* OPEN */) {
      throw new Error("connect-dingtalk: stream not connected");
    }
    ws.send(encodeFrame("SEND", { destination: REPLY_DESTINATION }, body));
  }

  /** Stop the client and cancel any scheduled reconnect. */
  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.stopHeartbeat();
    this.ws?.close(1000, "bye");
    this.ws = undefined;
  }

  private onSocketOpen(): void {
    this.logger?.info?.("connect-dingtalk: socket open, sending CONNECT");
    this.sendFrame("CONNECT", {
      "accept-version": "1.2",
      host: "api.dingtalk.com",
      "heart-beat": `${HEARTBEAT_MS},${HEARTBEAT_MS}`,
    }, buildConnectBody(this.clientId, this.clientSecret));
  }

  private onSocketMessage(data: string): void {
    const { frames, rest } = decodeFrames(this.rest + data);
    this.rest = rest;
    for (const frame of frames) this.handleFrame(frame);
  }

  private onSocketClose(code?: number, reason?: string): void {
    this.stopHeartbeat();
    this.ws = undefined;
    if (this.closedByUs) return;
    this.logger?.warn?.(`connect-dingtalk: socket closed (code=${String(code)} reason=${String(reason)}), reconnecting in ${this.backoffMs}ms`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedByUs || this.reconnectTimer !== undefined) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error) => {
        this.logger?.error?.(`connect-dingtalk: reconnect attempt failed: ${String(error)}`);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private handleFrame(frame: StompFrame): void {
    switch (frame.command) {
      case "CONNECTED": {
        this.backoffMs = RECONNECT_BASE_MS;
        this.logger?.info?.("connect-dingtalk: CONNECTED, subscribing");
        this.sendFrame("SUBSCRIBE", { id: INBOUND_SUBSCRIPTION, destination: INBOUND_DESTINATION });
        this.startHeartbeat();
        break;
      }
      case "MESSAGE": {
        if (this.messageHandler === undefined) break;
        try {
          const raw = JSON.parse(frame.body) as DingtalkBotMessage;
          void Promise.resolve(this.messageHandler(raw)).catch((error) => {
            this.logger?.warn?.(`connect-dingtalk: inbound handler failed: ${String(error)}`);
          });
        } catch (error) {
          this.logger?.warn?.(`connect-dingtalk: malformed gateway payload: ${String(error)}`);
        }
        break;
      }
      case "ERROR": {
        this.logger?.error?.(`connect-dingtalk: gateway ERROR: ${frame.body || frame.headers.message || "no detail"}`);
        break;
      }
      case "RECEIPT": {
        this.logger?.info?.("connect-dingtalk: gateway receipt received");
        break;
      }
      default:
        this.logger?.warn?.(`connect-dingtalk: unhandled STOMP frame ${frame.command}`);
    }
  }

  private sendFrame(command: string, headers: Record<string, string>, body = ""): void {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== 1) return;
    ws.send(encodeFrame(command, headers, body));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      const ws = this.ws;
      if (ws !== undefined && ws.readyState === 1) ws.send("\n");
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}
