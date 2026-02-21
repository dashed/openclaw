/**
 * End-to-end tests for cron thread routing through the delivery plan resolution.
 *
 * These tests verify that the full delivery chain (resolveAgentDeliveryPlan →
 * resolveSessionDeliveryTarget) does not leak stale session threadIds when
 * an explicit delivery target (explicitTo) is provided, as happens with
 * cron announces.
 *
 * This complements:
 * - targets.test.ts: unit tests for resolveSessionDeliveryTarget
 * - subagent-announce.cron-thread-routing.test.ts: tests for Layer 1
 *   (resolveAnnounceOrigin stripping stale threadId from requesterOrigin)
 *
 * These tests exercise the Layer 2 fix: resolveSessionDeliveryTarget no
 * longer inherits session lastThreadId when explicitTo is provided.
 */
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveAgentDeliveryPlan } from "./agent-delivery.js";

describe("cron thread routing through delivery plan", () => {
  /**
   * Simulates the session state that exists when a cron announce runs:
   * - lastChannel/lastTo are from the user's last interaction on #openclaw
   * - lastThreadId is stale from a previous user thread
   */
  const sessionWithStaleThread: SessionEntry = {
    sessionId: "d0e63c96-5505-4056-b82a-2705636cab98",
    updatedAt: Date.now(),
    lastChannel: "slack",
    lastTo: "channel:C0A9SNF4BS7",
    lastThreadId: "1771694347.023959",
    lastAccountId: "acct-user",
  };

  it("does not leak stale threadId when cron delivers to same channel with explicitTo", () => {
    // This is the exact scenario that caused the bug:
    // Cron announce calls callGateway({ method: "agent", channel: "slack",
    //   to: "channel:C0A9SNF4BS7", threadId: undefined })
    // The gateway resolves explicitTo = "channel:C0A9SNF4BS7" and
    // explicitThreadId = undefined.
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: sessionWithStaleThread,
      requestedChannel: "slack",
      explicitTo: "channel:C0A9SNF4BS7",
      explicitThreadId: undefined,
      wantsDelivery: true,
    });

    expect(plan.resolvedChannel).toBe("slack");
    expect(plan.resolvedTo).toBe("channel:C0A9SNF4BS7");
    // The stale lastThreadId must NOT leak into the delivery plan.
    expect(plan.resolvedThreadId).toBeUndefined();
    expect(plan.deliveryTargetMode).toBe("explicit");
  });

  it("does not leak stale threadId when cron delivers to different channel target", () => {
    // Session has lastTo for #jarvis-log (from heartbeat), but cron
    // targets #openclaw. The stale threadId from #jarvis-log must not leak.
    const sessionContaminated: SessionEntry = {
      sessionId: "session-contaminated",
      updatedAt: Date.now(),
      lastChannel: "slack",
      lastTo: "C0AAZ13MWAG", // #jarvis-log
      lastThreadId: "stale-heartbeat-thread",
    };

    const plan = resolveAgentDeliveryPlan({
      sessionEntry: sessionContaminated,
      requestedChannel: "slack",
      explicitTo: "channel:C0A9SNF4BS7", // #openclaw
      explicitThreadId: undefined,
      wantsDelivery: true,
    });

    expect(plan.resolvedChannel).toBe("slack");
    expect(plan.resolvedTo).toBe("channel:C0A9SNF4BS7");
    expect(plan.resolvedThreadId).toBeUndefined();
  });

  it("preserves explicit threadId even when explicitTo suppresses session threadId", () => {
    // When the caller explicitly provides both a target and threadId,
    // the explicit threadId should be used.
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: sessionWithStaleThread,
      requestedChannel: "slack",
      explicitTo: "channel:C0A9SNF4BS7",
      explicitThreadId: "explicit-thread-42",
      wantsDelivery: true,
    });

    expect(plan.resolvedChannel).toBe("slack");
    expect(plan.resolvedTo).toBe("channel:C0A9SNF4BS7");
    expect(plan.resolvedThreadId).toBe("explicit-thread-42");
  });

  it("still inherits session threadId for normal user replies (no explicitTo)", () => {
    // Normal user reply flow: no explicitTo, so the session's
    // lastThreadId should be used for reply continuity.
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: sessionWithStaleThread,
      requestedChannel: "last",
      explicitTo: undefined,
      explicitThreadId: undefined,
      wantsDelivery: true,
    });

    expect(plan.resolvedChannel).toBe("slack");
    expect(plan.resolvedTo).toBe("channel:C0A9SNF4BS7");
    // Normal replies should still use the session threadId.
    expect(plan.resolvedThreadId).toBe("1771694347.023959");
  });

  it("handles requestedChannel=last with explicitTo correctly", () => {
    // When requestedChannel is "last", channel resolves from session.
    // explicitTo still suppresses stale threadId.
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: sessionWithStaleThread,
      requestedChannel: "last",
      explicitTo: "channel:C0A9SNF4BS7",
      explicitThreadId: undefined,
      wantsDelivery: true,
    });

    expect(plan.resolvedChannel).toBe("slack");
    expect(plan.resolvedTo).toBe("channel:C0A9SNF4BS7");
    expect(plan.resolvedThreadId).toBeUndefined();
  });

  it("handles empty string threadId the same as undefined", () => {
    // Gateway agent.ts converts empty/whitespace threadId to undefined.
    // Verify the delivery plan handles this correctly.
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: sessionWithStaleThread,
      requestedChannel: "slack",
      explicitTo: "channel:C0A9SNF4BS7",
      explicitThreadId: "",
      wantsDelivery: true,
    });

    expect(plan.resolvedChannel).toBe("slack");
    expect(plan.resolvedTo).toBe("channel:C0A9SNF4BS7");
    // Empty string threadId should be treated as "no threadId".
    expect(plan.resolvedThreadId).toBeUndefined();
  });
});
