import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAnnounceOrigin } from "./announce-origin.js";

describe("resolveAnnounceOrigin", () => {
  it("uses requesterOrigin threadId when present", () => {
    const result = resolveAnnounceOrigin(
      {
        lastChannel: "slack",
        lastTo: "channel:C123",
        lastThreadId: "old-thread-999",
      },
      {
        channel: "slack",
        to: "channel:C123",
        threadId: "current-thread-456",
      },
    );
    expect(result?.threadId).toBe("current-thread-456");
  });

  it("does NOT inherit threadId from session when requesterOrigin lacks one", () => {
    const result = resolveAnnounceOrigin(
      {
        lastChannel: "slack",
        lastTo: "channel:C123",
        lastThreadId: "stale-thread-789",
      },
      {
        channel: "slack",
        to: "channel:C123",
        // no threadId — e.g. cron announce
      },
    );
    expect(result?.threadId).toBeUndefined();
    expect(result?.channel).toBe("slack");
    expect(result?.to).toBe("channel:C123");
  });

  it("does NOT inherit to from session fallback when requesterOrigin lacks it", () => {
    const result = resolveAnnounceOrigin(
      {
        lastChannel: "slack",
        lastTo: "channel:C456",
        lastAccountId: "acct-1",
      },
      {
        channel: "slack",
        // no to, no accountId
      },
    );
    expect(result?.channel).toBe("slack");
    // `to` must NOT leak from session fallback — this prevents heartbeat
    // contamination where lastTo gets overwritten with the heartbeat channel.
    expect(result?.to).toBeUndefined();
    expect(result?.accountId).toBe("acct-1");
    expect(result?.threadId).toBeUndefined();
  });

  it("returns undefined when both entry and requesterOrigin are empty", () => {
    expect(resolveAnnounceOrigin(undefined, undefined)).toBeUndefined();
  });

  it("returns session-derived context when requesterOrigin is undefined", () => {
    const result = resolveAnnounceOrigin(
      {
        lastChannel: "slack",
        lastTo: "channel:C123",
        lastThreadId: "thread-123",
      },
      undefined,
    );
    // When requesterOrigin is completely absent (not just threadId-less),
    // session fallback is the only source and should be used as-is.
    expect(result?.channel).toBe("slack");
    expect(result?.to).toBe("channel:C123");
    expect(result?.threadId).toBe("thread-123");
  });

  it("uses requesterOrigin to when present, ignoring session lastTo", () => {
    const result = resolveAnnounceOrigin(
      {
        lastChannel: "slack",
        lastTo: "channel:HEARTBEAT_CHANNEL",
        lastThreadId: "stale-thread",
      },
      {
        channel: "slack",
        to: "channel:CORRECT_CHANNEL",
      },
    );
    expect(result?.channel).toBe("slack");
    expect(result?.to).toBe("channel:CORRECT_CHANNEL");
    expect(result?.threadId).toBeUndefined();
  });

  it("does NOT inherit to or threadId when requesterOrigin has neither", () => {
    const result = resolveAnnounceOrigin(
      {
        lastChannel: "slack",
        lastTo: "channel:CONTAMINATED",
        lastThreadId: "stale-thread",
      },
      {
        channel: "slack",
        accountId: "acct-1",
        // no to, no threadId
      },
    );
    expect(result?.channel).toBe("slack");
    expect(result?.to).toBeUndefined();
    expect(result?.accountId).toBe("acct-1");
    expect(result?.threadId).toBeUndefined();
  });

  it("heartbeat contamination scenario: session lastTo=#jarvis-log, cron targets #openclaw", () => {
    // Reproduces Bug 2: heartbeat overwrites session lastTo with #jarvis-log,
    // cron with explicit delivery.to should not be affected.
    const result = resolveAnnounceOrigin(
      {
        lastChannel: "slack",
        lastTo: "C0AAZ13MWAG", // #jarvis-log (heartbeat contamination)
        lastThreadId: "1771421496.421189",
      },
      {
        channel: "slack",
        to: "channel:C0A9SNF4BS7", // #openclaw (cron delivery target)
        // no threadId — crons never target a thread
      },
    );
    expect(result?.channel).toBe("slack");
    expect(result?.to).toBe("channel:C0A9SNF4BS7");
    expect(result?.threadId).toBeUndefined();
  });

  it("preserves threadId when requesterOrigin explicitly has one matching session", () => {
    const result = resolveAnnounceOrigin(
      {
        lastChannel: "slack",
        lastTo: "channel:C123",
        lastThreadId: "thread-456",
      },
      {
        channel: "slack",
        to: "channel:C123",
        threadId: "thread-456",
      },
    );
    expect(result?.threadId).toBe("thread-456");
  });
});

describe("subagent-announce wiring", () => {
  it("resolveAnnounceOrigin is available (inline or from announce-origin.ts)", () => {
    // Verify that resolveAnnounceOrigin exists in the codebase, either as an
    // inline definition in subagent-announce.ts or extracted to announce-origin.ts.
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "subagent-announce.ts"),
      "utf8",
    );
    const hasImport = src.includes('from "./announce-origin.js"');
    const hasInline = /^function resolveAnnounceOrigin/m.test(src);
    expect(hasImport || hasInline).toBe(true);
  });
});
