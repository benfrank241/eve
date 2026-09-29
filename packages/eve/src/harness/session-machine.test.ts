import { describe, expect, it } from "vitest";

import {
  readSessionMachine,
  settleCall,
  takeSettledSteps,
  type SessionMachine,
} from "#harness/session-machine.js";

const origin = { sequence: 0, stepIndex: 0, turnId: "turn_0" };

function machineWithStep(): SessionMachine {
  return {
    ...readSessionMachine(undefined),
    steps: [
      {
        calls: [
          { callId: "review", input: {}, status: "running", toolName: "review" },
          { callId: "deploy", input: {}, status: "running", toolName: "deploy" },
        ],
        origin,
        response: [
          {
            content: [
              { input: {}, toolCallId: "lint", toolName: "lint", type: "tool-call" },
              { input: {}, toolCallId: "review", toolName: "review", type: "tool-call" },
              { input: {}, toolCallId: "deploy", toolName: "deploy", type: "tool-call" },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { type: "text", value: "clean" },
                toolCallId: "lint",
                toolName: "lint",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
        ],
      },
    ],
  };
}

function result(toolCallId: string) {
  return {
    output: { type: "text" as const, value: `${toolCallId} done` },
    toolCallId,
    toolName: toolCallId,
    type: "tool-result" as const,
  };
}

describe("takeSettledSteps", () => {
  it("commits a step once, when its last call settles, joining its results to its tool message", () => {
    const partial = settleCall(machineWithStep(), "review", result("review"));
    expect(takeSettledSteps(partial).messages).toEqual([]);

    const settled = takeSettledSteps(settleCall(partial, "deploy", result("deploy")));

    expect(settled.machine.steps).toEqual([]);
    expect(settled.messages).toHaveLength(2);
    expect(settled.messages[1]).toMatchObject({
      content: [{ toolCallId: "lint" }, { toolCallId: "review" }, { toolCallId: "deploy" }],
      role: "tool",
    });
  });
});

describe("readSessionMachine", () => {
  it("rejects state written by another session machine version", () => {
    expect(() => readSessionMachine({ "eve.session": { steps: [], version: 0 } })).toThrow(
      "Unsupported session state: start a new session.",
    );
  });
});
