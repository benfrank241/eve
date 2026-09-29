import { describe, expect, it, vi } from "vitest";

import {
  CreateOnceClaimPendingError,
  createChannelAddress,
  resolveCreateOnceOwner,
} from "#channel/channel-address.js";
import {
  attachChannelActivityPresentation,
  getChannelActivityPresentation,
} from "#channel/activity-renderer.js";
import type { Runtime } from "#channel/types.js";

function createRuntime(): Runtime {
  return {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn().mockResolvedValue({ sessionId: "sess_1", status: "accepted" }),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn(),
    getStreamTailIndex: vi.fn(),
    resolveContinuation: vi.fn(),
  };
}

describe("createChannelAddress", () => {
  it("rejects channel addresses in the framework-reserved session namespace", () => {
    expect(() =>
      createChannelAddress({
        adapter: { kind: "http" },
        channelName: "eve",
        continuationToken: "session:wrun_1:inbox",
        runtime: createRuntime(),
      }),
    ).toThrow("reserved session namespace");
  });

  it("sends directly through the address and returns a fixed session handle", async () => {
    const runtime = createRuntime();
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    const session = await address.send("hello", { auth: null });
    await session.clear();

    expect(runtime.dispatchContinuation).toHaveBeenCalledWith({
      command: {
        auth: null,
        kind: "send",
        payload: { message: "hello" },
        requestId: undefined,
        turnPolicy: "steer",
      },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.resolveContinuation).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.dispatchSession).toHaveBeenCalledWith({
      command: { kind: "clear" },
      sessionId: "sess_1",
    });
  });

  it("uses the channel policy unless a send overrides it", async () => {
    const runtime = createRuntime();
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
      turnPolicy: "queue",
    });

    await address.send("queued", { auth: null });
    await address.send("replace", { auth: null, turnPolicy: "steer" });
    await address.respond([{ optionId: "yes", requestId: "input-1" }], { auth: null });

    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: expect.objectContaining({ turnPolicy: "queue" }) }),
    );
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: expect.objectContaining({ turnPolicy: "steer" }),
      }),
    );
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ command: expect.objectContaining({ turnPolicy: undefined }) }),
    );
  });

  it("mints a distinct delivery identity for each channel operation", async () => {
    const runtime = createRuntime();
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      metadata: {
        channelKind: "channel:slack",
        channelName: "slack",
        requestId: "request-1",
      },
      runtime,
    });

    await address.send("first", { auth: null });
    await address.send("second", { auth: null });

    const calls = vi.mocked(runtime.dispatchContinuation).mock.calls;
    const first = calls[0]?.[0].command;
    const second = calls[1]?.[0].command;
    expect(first?.kind === "send" ? first.delivery : undefined).toMatchObject({
      channelKind: "channel:slack",
      channelName: "slack",
      requestId: "request-1",
    });
    expect(first?.kind === "send" ? first.delivery?.deliveryId : undefined).not.toBe(
      second?.kind === "send" ? second.delivery?.deliveryId : undefined,
    );
  });

  it("enables activity only for a newly created session with configured renderers", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.dispatchContinuation).mockResolvedValue({ status: "session_not_active" });
    vi.mocked(runtime.createSession).mockResolvedValue({
      events: new ReadableStream(),
      sessionId: "sess_activity",
    });
    const adapter = { kind: "slack" };
    attachChannelActivityPresentation(adapter, {
      destination: () => ({}),
      renderers: [{ id: "status", render: vi.fn() }],
    });
    const address = createChannelAddress<{ channelId: string; threadTs: string }>({
      adapter,
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    await address.send("hello", {
      auth: null,
      state: { channelId: "C1", threadTs: "T1" },
    });

    expect(runtime.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: expect.objectContaining({ state: { channelId: "C1", threadTs: "T1" } }),
        capabilities: { requestInput: true },
        continuationConflictCommand: expect.objectContaining({
          kind: "send",
          payload: { message: "hello" },
        }),
      }),
    );
    const created = vi.mocked(runtime.createSession).mock.calls[0]?.[0].adapter;
    expect(created).toBeDefined();
    expect(getChannelActivityPresentation(created!)?.renderers).toEqual([
      expect.objectContaining({ id: "status" }),
    ]);
  });

  it("binds every control directly to the namespaced continuation token", async () => {
    const runtime = createRuntime();
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    await address.cancel({ turnId: "turn_1" });
    await address.compact();
    await address.clear();
    await address.reset({ reason: "fresh start" });

    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(1, {
      command: { kind: "cancel", turnId: "turn_1" },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(2, {
      command: { kind: "compact" },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(3, {
      command: { kind: "clear" },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.dispatchContinuation).toHaveBeenNthCalledWith(4, {
      command: { kind: "reset", reason: "fresh start" },
      continuationToken: "slack:C1:T1",
    });
    expect(runtime.resolveContinuation).not.toHaveBeenCalled();
  });

  it("resolves explicitly to a fixed session handle", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.resolveContinuation).mockResolvedValue({ sessionId: "sess_2" });
    const address = createChannelAddress({
      adapter: { kind: "slack" },
      channelName: "slack",
      continuationToken: "C1:T1",
      runtime,
    });

    const session = await address.resolveSession();
    await session?.clear();

    expect(runtime.resolveContinuation).toHaveBeenCalledWith("slack:C1:T1");
    expect(runtime.dispatchSession).toHaveBeenCalledWith({
      command: { kind: "clear" },
      sessionId: "sess_2",
    });
  });

  describe("create-once delivery", () => {
    const token = "eve-scheduled:app:tasks:schedule_1:execution_1";

    it("uses the occurrence identity for creation, skips the conflict command, and reports the claim owner", async () => {
      const runtime = createRuntime();
      vi.mocked(runtime.resolveContinuation)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({ sessionId: "winner" });
      vi.mocked(runtime.createSession).mockResolvedValue({ sessionId: "started" } as never);
      const address = createChannelAddress({
        adapter: { kind: "http" },
        channelName: "slack",
        continuationToken: "C1:",
        runtime,
        requestInput: false,
        occurrenceToken: token,
      });
      const session = await address.send("Run", { auth: null });
      expect(session.id).toBe("winner");
      expect(runtime.dispatchContinuation).not.toHaveBeenCalled();
      expect(runtime.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          continuationToken: "slack:C1:",
          occurrenceToken: token,
          continuationConflictCommand: undefined,
          capabilities: { requestInput: false },
        }),
      );
    });

    it("resolves an existing claim without dispatching or creating", async () => {
      const runtime = createRuntime();
      vi.mocked(runtime.resolveContinuation).mockResolvedValue({ sessionId: "winner" });
      const address = createChannelAddress({
        adapter: { kind: "http" },
        channelName: "slack",
        continuationToken: "C1:",
        runtime,
        occurrenceToken: token,
      });
      const session = await address.send("Run", { auth: null });
      expect(session.id).toBe("winner");
      expect(runtime.createSession).not.toHaveBeenCalled();
      expect(runtime.dispatchContinuation).not.toHaveBeenCalled();
    });

    it("converges concurrent admissions on the single claim owner", async () => {
      const runtime = createRuntime();
      // Both senders find no claim, both start, and then both see the single winner.
      vi.mocked(runtime.resolveContinuation)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({ sessionId: "run_1" });
      let started = 0;
      vi.mocked(runtime.createSession).mockImplementation(
        async () => ({ sessionId: `run_${++started}` }) as never,
      );
      const address = createChannelAddress({
        adapter: { kind: "http" },
        channelName: "slack",
        continuationToken: "C1:",
        runtime,
        occurrenceToken: token,
      });
      const sessions = await Promise.all([
        address.send("Run", { auth: null }),
        address.send("Run", { auth: null }),
      ]);
      expect(sessions.map((session) => session.id)).toEqual(["run_1", "run_1"]);
      expect(runtime.createSession).toHaveBeenCalledTimes(2);
      for (const [run] of vi.mocked(runtime.createSession).mock.calls) {
        expect(run.continuationToken).toBe("slack:C1:");
        expect(run.occurrenceToken).toBe(token);
        expect(run.continuationConflictCommand).toBeUndefined();
      }
      expect(runtime.dispatchContinuation).not.toHaveBeenCalled();
    });

    it("refuses to report admission when the claim never settles", async () => {
      const runtime = createRuntime();
      vi.mocked(runtime.resolveContinuation).mockResolvedValue(undefined);
      vi.useFakeTimers();
      try {
        const owner = expect(
          resolveCreateOnceOwner(runtime, token, { timeoutMs: 50 }),
        ).rejects.toBeInstanceOf(CreateOnceClaimPendingError);
        await vi.advanceTimersByTimeAsync(100);
        await owner;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
