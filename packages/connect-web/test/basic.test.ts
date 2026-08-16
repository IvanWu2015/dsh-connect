/**
 * Basic tests for WebAdapter functionality.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebAdapter } from "../src/adapter.js";
import type { BindingStore, ChatBinding } from "dsh-connect/binding";

// Mock BindingStore for testing
class MockBindingStore implements Partial<BindingStore> {
  private bindings = new Map<string, ChatBinding>();
  private listeners = new Set<(binding: ChatBinding, changeType: "add" | "update" | "delete") => void>();

  get(channel: string, chatKey: string): ChatBinding | undefined {
    return this.bindings.get(`${channel}\u0000${chatKey}`);
  }

  put(binding: ChatBinding): void {
    const key = `${binding.channel}\u0000${binding.chatKey}`;
    const existed = this.bindings.has(key);
    this.bindings.set(key, binding);
    
    // Emit change event
    for (const listener of this.listeners) {
      listener(binding, existed ? "update" : "add");
    }
  }

  onChange(callback: (binding: ChatBinding, changeType: "add" | "update" | "delete") => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  list(): ChatBinding[] {
    return [...this.bindings.values()];
  }

  findByWebMirror(sessionId: string): ChatBinding[] {
    const results: ChatBinding[] = [];
    for (const binding of this.bindings.values()) {
      if (binding.webMirrorSessionId === sessionId) {
        results.push(binding);
      }
    }
    return results;
  }
}

describe("WebAdapter", () => {
  let adapter: WebAdapter;
  let mockBindings: MockBindingStore;

  beforeEach(() => {
    mockBindings = new MockBindingStore();
    adapter = new WebAdapter(mockBindings as unknown as BindingStore, {
      pollIntervalMs: 100, // Fast polling for tests
    });
  });

  afterEach(async () => {
    await adapter.stop();
  });

  it("should start without errors", async () => {
    await expect(adapter.start()).resolves.not.toThrow();
  });

  it("should detect new mirror sessions", async () => {
    const receivedMessages: any[] = [];
    adapter.onInbound((msg) => {
      receivedMessages.push(msg);
    });

    await adapter.start();

    // Simulate a new mirror being created
    const binding: ChatBinding = {
      channel: "feishu",
      chatKey: "test-chat-123",
      chatType: "p2p",
      sessionId: "session-abc",
      ownerKey: "user-1",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      webMirrorSessionId: "session-abc",
      lockOwner: "feishu",
      lockAcquiredAt: Date.now(),
      lockTimeoutMs: 300000,
      sessions: [],
    };

    mockBindings.put(binding);

    // Wait for event processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receivedMessages.length).toBeGreaterThan(0);
    expect(receivedMessages[0].channel).toBe("web");
    expect(receivedMessages[0].text).toContain("[Mirror]");
  });

  it("should track mirrored sessions", async () => {
    await adapter.start();

    const binding: ChatBinding = {
      channel: "feishu",
      chatKey: "test-chat-456",
      chatType: "group",
      sessionId: "session-xyz",
      ownerKey: "user-2",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      webMirrorSessionId: "session-xyz",
      sessions: [],
    };

    mockBindings.put(binding);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(adapter.isSessionMirrored("session-xyz")).toBe(true);
    expect(adapter.isSessionMirrored("nonexistent")).toBe(false);
  });

  it("should get mirror source", async () => {
    await adapter.start();

    const binding: ChatBinding = {
      channel: "feishu",
      chatKey: "chat-789",
      chatType: "p2p",
      sessionId: "session-123",
      ownerKey: "user-3",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      webMirrorSessionId: "session-123",
      sessions: [],
    };

    mockBindings.put(binding);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const source = adapter.getMirrorSource("session-123");
    expect(source).toBe("feishu:chat-789");
  });

  it("should check lock status", async () => {
    await adapter.start();

    const binding: ChatBinding = {
      channel: "feishu",
      chatKey: "chat-lock-test",
      chatType: "p2p",
      sessionId: "session-lock",
      ownerKey: "user-4",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      webMirrorSessionId: "session-lock",
      lockOwner: "feishu",
      lockAcquiredAt: Date.now(),
      lockTimeoutMs: 300000,
      sessions: [],
    };

    mockBindings.put(binding);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(adapter.getSessionLock("session-lock")).toBe("feishu");
  });

  it("should handle missing locks", async () => {
    await adapter.start();

    const binding: ChatBinding = {
      channel: "feishu",
      chatKey: "chat-no-lock",
      chatType: "p2p",
      sessionId: "session-no-lock",
      ownerKey: "user-5",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      webMirrorSessionId: "session-no-lock",
      sessions: [],
    };

    mockBindings.put(binding);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(adapter.getSessionLock("session-no-lock")).toBeUndefined();
  });

  it("should stop cleanly", async () => {
    await adapter.start();
    await expect(adapter.stop()).resolves.not.toThrow();
  });
});
