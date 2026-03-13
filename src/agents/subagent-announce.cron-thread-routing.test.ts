/**
 * Integration tests for cron thread routing fix.
 *
 * These tests verify that stale `lastThreadId` values in the session store
 * do NOT leak into cron/subagent announce delivery when the requesterOrigin
 * does not carry a threadId. This is the fix for the "cron posts to thread"
 * bug where cron announces posted as replies in stale user threads instead
 * of as top-level channel messages.
 *
 * The tests mirror the mocking setup from subagent-announce.format.e2e.test.ts
 * but use a .test.ts extension so they run with the standard vitest config.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type AgentCallRequest = { method?: string; params?: Record<string, unknown> };
type RequesterResolution = {
  requesterSessionKey: string;
  requesterOrigin?: Record<string, unknown>;
} | null;

const agentSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "run-main", status: "ok" }));
const sendSpy = vi.fn(async (_req: AgentCallRequest) => ({ runId: "send-main", status: "ok" }));
const sessionsDeleteSpy = vi.fn((_req: AgentCallRequest) => undefined);
const readLatestAssistantReplyMock = vi.fn(
  async (_sessionKey?: string): Promise<string | undefined> => "raw subagent reply",
);
const embeddedRunMock = {
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
};
const subagentRegistryMock = {
  isSubagentSessionRunActive: vi.fn(() => true),
  countActiveDescendantRuns: vi.fn((_sessionKey: string) => 0),
  resolveRequesterForChildSession: vi.fn((_sessionKey: string): RequesterResolution => null),
};
const chatHistoryMock = vi.fn(async (_sessionKey?: string) => ({
  messages: [] as Array<unknown>,
}));
let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};
const defaultOutcomeAnnounce = {
  task: "do thing",
  timeoutMs: 1000,
  cleanup: "keep" as const,
  waitForCompletion: false,
  startedAt: 10,
  endedAt: 20,
  outcome: { status: "ok" } as const,
};

async function getSingleAgentCallParams() {
  await expect.poll(() => agentSpy.mock.calls.length).toBe(1);
  const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
  return call?.params ?? {};
}

function loadSessionStoreFixture(): Record<string, Record<string, unknown>> {
  return new Proxy(sessionStore, {
    get(target, key: string | symbol) {
      if (typeof key === "string" && !(key in target) && key.includes(":subagent:")) {
        return { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      }
      return target[key as keyof typeof target];
    },
  });
}

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string; params?: { message?: string; sessionKey?: string } };
    if (typed.method === "agent") {
      return await agentSpy(typed);
    }
    if (typed.method === "send") {
      return await sendSpy(typed);
    }
    if (typed.method === "agent.wait") {
      return { status: "error", startedAt: 10, endedAt: 20, error: "boom" };
    }
    if (typed.method === "chat.history") {
      return await chatHistoryMock(typed.params?.sessionKey);
    }
    if (typed.method === "sessions.patch") {
      return {};
    }
    if (typed.method === "sessions.delete") {
      sessionsDeleteSpy(typed);
      return {};
    }
    return {};
  }),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: readLatestAssistantReplyMock,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => loadSessionStoreFixture()),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions.json",
  resolveMainSessionKey: () => "agent:main:main",
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./pi-embedded.js", () => embeddedRunMock);

vi.mock("./subagent-registry.js", () => subagentRegistryMock);

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

describe("cron thread routing fix", () => {
  beforeEach(() => {
    agentSpy.mockClear();
    sendSpy.mockClear();
    sessionsDeleteSpy.mockClear();
    embeddedRunMock.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReset().mockReturnValue(false);
    embeddedRunMock.queueEmbeddedPiMessage.mockReset().mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockReset().mockResolvedValue(true);
    subagentRegistryMock.isSubagentSessionRunActive.mockReset().mockReturnValue(true);
    subagentRegistryMock.countActiveDescendantRuns.mockReset().mockReturnValue(0);
    subagentRegistryMock.resolveRequesterForChildSession.mockReset().mockReturnValue(null);
    readLatestAssistantReplyMock.mockReset().mockResolvedValue("raw subagent reply");
    chatHistoryMock.mockReset().mockResolvedValue({ messages: [] });
    sessionStore = {};
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("strips stale session threadId for non-completion announce on same channel", async () => {
    // Regression test for cron thread routing bug: when requesterOrigin targets
    // the same channel/to as the session (e.g. both are slack channel:C123),
    // the session's stale lastThreadId must NOT leak into the announce delivery.
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-cron-same-channel",
      },
      "agent:main:main": {
        sessionId: "requester-session-cron",
        lastChannel: "slack",
        lastTo: "channel:C123",
        lastThreadId: "stale-thread-from-user",
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "cron result" }] }],
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-cron-same-channel",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "slack", to: "channel:C123" },
      ...defaultOutcomeAnnounce,
      // Non-completion mode (default for cron announces)
      expectsCompletionMessage: false,
    });

    expect(didAnnounce).toBe(true);
    // Non-completion with no active embedded run → falls through to direct send
    // which calls agentSpy (method: "agent").
    await expect.poll(() => agentSpy.mock.calls.length).toBe(1);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("slack");
    expect(call?.params?.to).toBe("channel:C123");
    // threadId must NOT inherit the stale session value.
    expect(call?.params?.threadId).toBeUndefined();
  });

  it("preserves explicit threadId for non-completion announce on same channel", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-cron-explicit-thread",
      },
      "agent:main:main": {
        sessionId: "requester-session-cron-explicit",
        lastChannel: "slack",
        lastTo: "channel:C123",
        lastThreadId: "stale-thread-should-be-overridden",
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "result" }] }],
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-cron-explicit-thread",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "slack", to: "channel:C123", threadId: "explicit-thread-42" },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: false,
    });

    expect(didAnnounce).toBe(true);
    await expect.poll(() => agentSpy.mock.calls.length).toBe(1);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("slack");
    expect(call?.params?.to).toBe("channel:C123");
    // Explicit threadId from requesterOrigin should be preserved.
    expect(call?.params?.threadId).toBe("explicit-thread-42");
  });

  it("strips stale session threadId in queued cron announce path", async () => {
    // When the queued path is taken (active embedded run + collect mode),
    // the origin resolved via resolveAnnounceOrigin must also strip stale threadId.
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-cron-queued",
        lastChannel: "slack",
        lastTo: "channel:C123",
        lastThreadId: "stale-queued-thread",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-cron-queued",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "slack", to: "channel:C123" },
      ...defaultOutcomeAnnounce,
    });

    expect(didAnnounce).toBe(true);
    const params = await getSingleAgentCallParams();
    expect(params.channel).toBe("slack");
    expect(params.to).toBe("channel:C123");
    // Queued path also goes through resolveAnnounceOrigin; stale threadId must be stripped.
    expect(params.threadId).toBeUndefined();
  });

  it("does not inherit session lastTo when requesterOrigin targets different channel", async () => {
    // Regression test for cron channel contamination (Bug 2): heartbeat
    // overwrites the main session's lastTo with #jarvis-log. When a cron
    // targets #openclaw, the announce must use the cron's explicit target,
    // not the session's contaminated lastTo.
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    sessionStore = {
      "agent:main:subagent:test": {
        sessionId: "child-session-channel-contam",
      },
      "agent:main:main": {
        sessionId: "requester-session-channel-contam",
        lastChannel: "slack",
        lastTo: "C0AAZ13MWAG", // #jarvis-log (heartbeat contamination)
        lastThreadId: "stale-heartbeat-thread",
      },
    };
    chatHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "email triage result" }] }],
    });

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-cron-channel-contam",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: {
        channel: "slack",
        to: "channel:C0A9SNF4BS7", // #openclaw (cron's explicit target)
      },
      ...defaultOutcomeAnnounce,
      expectsCompletionMessage: false,
    });

    expect(didAnnounce).toBe(true);
    await expect.poll(() => agentSpy.mock.calls.length).toBe(1);
    const call = agentSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(call?.params?.channel).toBe("slack");
    // Must use cron's explicit target, NOT the contaminated session lastTo.
    expect(call?.params?.to).toBe("channel:C0A9SNF4BS7");
    expect(call?.params?.threadId).toBeUndefined();
  });

  // NOTE: "completion-mode direct-send" test removed — upstream removed the
  // completionDirect code path in subagent-announce.ts. The remaining 4 tests
  // cover all active cron-thread-routing scenarios.
});
