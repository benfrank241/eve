import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { resolveApprovalOutcome } from "#harness/input-request-resolution.js";
import { isObject } from "#shared/guards.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";

// The session machine is the one durable record of where a session is in its
// lifecycle and what work it still owes. Workflow bodies read it, so this
// module must stay free of runtime dependencies beyond pure helpers.

export const SESSION_MACHINE_KEY = "eve.session";
const SESSION_MACHINE_VERSION = 1;

/** The turn and step every stream event is attributed to. */
export interface EventCoordinates {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

export interface OpenTurn {
  readonly id: string;
  readonly stepIndex: number;
  /** Assistant output streamed in this turn, so steering can no longer restart it. */
  readonly outputStarted?: boolean;
}

type ToolContentPart = Extract<ModelMessage, { role: "tool" }>["content"][number];
export type ToolResultPart = Extract<ToolContentPart, { type: "tool-result" }>;

/**
 * One tool call a parked step still owes a result for.
 *
 * `awaiting-approval` waits on a person; `approved` waits for eve to run it
 * inline; `ready` waits for the runtime to start its workflow run; `running`
 * waits for that run's (or the session's task tool) result; `settled` holds it.
 */
export interface ParkedCall {
  readonly callId: string;
  readonly toolName: string;
  readonly input: JsonObject;
  readonly status: "awaiting-approval" | "approved" | "ready" | "running" | "settled";
  readonly approval?: {
    readonly request: InputRequest;
    /** A response recorded while sibling approvals in the step are still open. */
    readonly decision?: InputResponse;
    /** Connection identity the tool had when approval was requested. */
    readonly replayIdentity?: string;
    /** The tool authorizes responders, so free text cannot answer it. */
    readonly responsePolicy?: true;
  };
  readonly workflow?: {
    readonly request: RuntimeWorkflowTaskRequest;
    readonly run?: { readonly runId: string; readonly hookToken: string };
  };
  readonly task?: TaskToolCall;
  readonly result?: ToolResultPart;
}

/** One model response whose calls have not all settled. It commits to history once. */
export interface ParkedStep {
  readonly origin: EventCoordinates;
  readonly response: readonly ModelMessage[];
  readonly calls: readonly ParkedCall[];
  /** Auth of the caller whose turn requested approval; `null` when anonymous. */
  readonly requester?: SessionAuthContext | null;
  readonly activityRootTurnId?: string;
}

/** The harness-authored session-limit continuation prompt. */
export interface LimitPrompt {
  readonly origin: EventCoordinates;
  readonly request: InputRequest;
}

export interface SessionMachine {
  readonly version: typeof SESSION_MACHINE_VERSION;
  readonly started: boolean;
  /** The open turn's sequence, or the next turn's when none is open. */
  readonly sequence: number;
  readonly turn?: OpenTurn;
  readonly steps: readonly ParkedStep[];
  readonly prompt?: LimitPrompt;
  /** Input held behind the prompt or behind an approval-policy phase. */
  readonly queued?: StepInput;
  /** Approval keys a person approved in this context. */
  readonly grants: readonly string[];
}

const INITIAL: SessionMachine = {
  grants: [],
  sequence: 0,
  started: false,
  steps: [],
  version: SESSION_MACHINE_VERSION,
};

export function readSessionMachine(state: SessionStateMap | undefined): SessionMachine {
  // Only this module writes the key, so a matching version vouches for the shape.
  const raw = state?.[SESSION_MACHINE_KEY] as SessionMachine | undefined;
  if (raw === undefined) return INITIAL;
  if (!isObject(raw) || raw.version !== SESSION_MACHINE_VERSION || !Array.isArray(raw.steps)) {
    throw new Error("Unsupported session state: start a new session.");
  }
  return raw;
}

export function writeSessionMachine<T extends { readonly state?: SessionStateMap }>(
  session: T,
  machine: SessionMachine,
): T {
  assertUniqueCalls(machine);
  return { ...session, state: { ...session.state, [SESSION_MACHINE_KEY]: machine } };
}

export function updateSessionMachine<T extends { readonly state?: SessionStateMap }>(
  session: T,
  update: (machine: SessionMachine) => SessionMachine,
): T {
  return writeSessionMachine(session, update(readSessionMachine(session.state)));
}

function assertUniqueCalls(machine: SessionMachine): void {
  const callIds = new Set<string>();
  const requestIds = new Set<string>();
  for (const step of machine.steps) {
    for (const call of step.calls) {
      if (callIds.has(call.callId)) {
        throw new Error(`Parked steps contain duplicate call id "${call.callId}".`);
      }
      callIds.add(call.callId);
      const requestId = call.approval?.request.requestId;
      if (requestId === undefined) continue;
      if (requestIds.has(requestId)) {
        throw new Error(`Parked steps contain duplicate request id "${requestId}".`);
      }
      requestIds.add(requestId);
    }
  }
}

// ---------------------------------------------------------------------------
// Turn scope
// ---------------------------------------------------------------------------

/** The open turn's id, or the id the next turn will take. */
export function activeTurnId(machine: SessionMachine): string {
  return machine.turn?.id ?? `turn_${machine.sequence}`;
}

export function isBetweenTurns(machine: SessionMachine): boolean {
  return machine.turn === undefined;
}

/** Coordinates of the open turn's current step, or of the next turn's first step. */
export function eventCoordinates(machine: SessionMachine): EventCoordinates {
  return {
    sequence: machine.sequence,
    stepIndex: machine.turn?.stepIndex ?? 0,
    turnId: activeTurnId(machine),
  };
}

export function openTurn(machine: SessionMachine): SessionMachine {
  if (machine.turn !== undefined) return machine;
  return { ...machine, started: true, turn: { id: `turn_${machine.sequence}`, stepIndex: 0 } };
}

export function advanceStep(machine: SessionMachine): SessionMachine {
  if (machine.turn === undefined) return machine;
  const { outputStarted: _outputStarted, ...turn } = machine.turn;
  return { ...machine, turn: { ...turn, stepIndex: turn.stepIndex + 1 } };
}

export function markOutputStarted(machine: SessionMachine): SessionMachine {
  if (machine.turn === undefined || machine.turn.outputStarted === true) return machine;
  return { ...machine, turn: { ...machine.turn, outputStarted: true } };
}

/** Ends the open turn; the next turn takes the following sequence. */
export function closeTurn(machine: SessionMachine): SessionMachine {
  const { turn: _turn, ...rest } = machine;
  return { ...rest, started: true, sequence: machine.sequence + 1 };
}

// ---------------------------------------------------------------------------
// Parked work
// ---------------------------------------------------------------------------

export function allCalls(machine: SessionMachine): readonly ParkedCall[] {
  return machine.steps.flatMap((step) => step.calls);
}

/** Every open approval request, oldest first. */
export function openApprovalRequests(machine: SessionMachine): readonly InputRequest[] {
  return allCalls(machine).flatMap((call) =>
    call.status === "awaiting-approval" && call.approval !== undefined
      ? [call.approval.request]
      : [],
  );
}

/** Every request a response can still answer: open approvals and the prompt. */
export function openRequestIds(machine: SessionMachine): ReadonlySet<string> {
  const ids = new Set(openApprovalRequests(machine).map((request) => request.requestId));
  if (machine.prompt !== undefined) ids.add(machine.prompt.request.requestId);
  return ids;
}

export function hasOpenInput(machine: SessionMachine): boolean {
  return openRequestIds(machine).size > 0;
}

export function findStepForRequest(
  machine: SessionMachine,
  requestId: string,
): ParkedStep | undefined {
  return machine.steps.find((step) =>
    step.calls.some((call) => call.approval?.request.requestId === requestId),
  );
}

/** Calls the open turn waits on the runtime for: workflow runs and task tool calls. */
export function runtimeCalls(machine: SessionMachine): readonly ParkedCall[] {
  return allCalls(machine).filter(
    (call) =>
      (call.status === "ready" || call.status === "running") &&
      (call.workflow !== undefined || call.task !== undefined),
  );
}

export function readyWorkflowCalls(machine: SessionMachine): readonly ParkedCall[] {
  return allCalls(machine).filter((call) => call.status === "ready" && call.workflow !== undefined);
}

/** The origin of the step that owns `callId`. */
export function callOrigin(machine: SessionMachine, callId: string): EventCoordinates | undefined {
  return machine.steps.find((step) => step.calls.some((call) => call.callId === callId))?.origin;
}

export function findCall(machine: SessionMachine, callId: string): ParkedCall | undefined {
  return allCalls(machine).find((call) => call.callId === callId);
}

/** A workflow run the session waits on, by the call it answers. */
export function findWorkflowRun(
  machine: SessionMachine,
  callId: string,
):
  | {
      readonly callId: string;
      readonly toolName: string;
      readonly origin: EventCoordinates;
      readonly address: { readonly runId: string; readonly hookToken: string };
    }
  | undefined {
  for (const step of machine.steps) {
    for (const call of step.calls) {
      if (call.callId !== callId || call.status !== "running") continue;
      const run = call.workflow?.run;
      if (run === undefined) continue;
      return { address: run, callId, origin: step.origin, toolName: call.toolName };
    }
  }
  return undefined;
}

/** Every started workflow run the session still waits on. */
export function workflowRuns(machine: SessionMachine): readonly {
  readonly callId: string;
  readonly toolName: string;
  readonly address: { readonly runId: string; readonly hookToken: string };
}[] {
  return allCalls(machine).flatMap((call) =>
    call.status === "running" && call.workflow?.run !== undefined
      ? [{ address: call.workflow.run, callId: call.callId, toolName: call.toolName }]
      : [],
  );
}

export function parkStep(machine: SessionMachine, step: ParkedStep): SessionMachine {
  return { ...machine, steps: [...machine.steps, step] };
}

export function updateCall(
  machine: SessionMachine,
  callId: string,
  update: (call: ParkedCall) => ParkedCall,
): SessionMachine {
  return {
    ...machine,
    steps: machine.steps.map((step) =>
      step.calls.some((call) => call.callId === callId)
        ? {
            ...step,
            calls: step.calls.map((call) => (call.callId === callId ? update(call) : call)),
          }
        : step,
    ),
  };
}

export function settleCall(
  machine: SessionMachine,
  callId: string,
  result: ToolResultPart,
): SessionMachine {
  return updateCall(machine, callId, (call) =>
    call.status === "settled" ? call : { ...call, result, status: "settled" },
  );
}

/** Starts a ready workflow call: the session now waits on its run. */
export function startWorkflowCall(
  machine: SessionMachine,
  callId: string,
  run: { readonly runId: string; readonly hookToken: string },
): SessionMachine {
  return updateCall(machine, callId, (call) =>
    call.workflow === undefined
      ? call
      : { ...call, status: "running", workflow: { ...call.workflow, run } },
  );
}

/**
 * Removes the steps whose calls have all settled and returns the messages
 * each appends to history, in park order. A step's results join its trailing
 * tool message, or form one.
 */
export function takeSettledSteps(machine: SessionMachine): {
  readonly machine: SessionMachine;
  readonly messages: readonly ModelMessage[];
  readonly steps: readonly ParkedStep[];
} {
  const settled = machine.steps.filter((step) =>
    step.calls.every((call) => call.status === "settled"),
  );
  if (settled.length === 0) return { machine, messages: [], steps: [] };
  return {
    machine: { ...machine, steps: machine.steps.filter((step) => !settled.includes(step)) },
    messages: settled.flatMap(stepTranscript),
    steps: settled,
  };
}

function stepTranscript(step: ParkedStep): ModelMessage[] {
  const parts: ToolContentPart[] = [];
  for (const call of step.calls) {
    const decision = call.approval?.decision;
    if (call.approval !== undefined && decision !== undefined) {
      const outcome = resolveApprovalOutcome(decision);
      const response: Extract<ToolContentPart, { type: "tool-approval-response" }> = {
        approvalId: call.approval.request.requestId,
        approved: outcome.approved,
        type: "tool-approval-response",
      };
      if (outcome.reason !== undefined) response.reason = outcome.reason;
      parts.push(response);
    }
    if (call.result !== undefined) parts.push(call.result);
  }
  const messages = [...step.response];
  if (parts.length === 0) return messages;
  const tail = messages.at(-1);
  if (tail?.role === "tool") {
    messages[messages.length - 1] = { content: [...tail.content, ...parts], role: "tool" };
  } else {
    messages.push({ content: parts, role: "tool" });
  }
  return messages;
}

/** What the model reads for a call a scope close stopped before it settled. */
export const CANCELLED_CALL_RESULT = "The turn was cancelled before this call finished.";

function cancelledResult(call: ParkedCall): ToolResultPart {
  return {
    output: { type: "text", value: CANCELLED_CALL_RESULT },
    toolCallId: call.callId,
    toolName: call.toolName,
    type: "tool-result",
  };
}

/**
 * Closes the open turn as cancelled. Every call the turn waits on, and every
 * call parked by the turn itself, settles as cancelled so the model sees that
 * the work started and stopped rather than a request left unanswered.
 */
export function cancelTurnWork(machine: SessionMachine): SessionMachine {
  const turnId = activeTurnId(machine);
  let next: SessionMachine = { ...machine, prompt: undefined };
  for (const step of machine.steps) {
    const owned = step.origin.turnId === turnId;
    for (const call of step.calls) {
      if (call.status === "settled") continue;
      const waited =
        call.status === "ready" || call.status === "running" || call.status === "approved";
      if (owned || waited) next = settleCall(next, call.callId, cancelledResult(call));
    }
  }
  return next;
}

/** A cleared context owes nothing: parked steps, the prompt, queued input, and grants go. */
export function clearContextWork(machine: SessionMachine): SessionMachine {
  return {
    ...machine,
    grants: [],
    prompt: undefined,
    queued: undefined,
    steps: [],
  };
}

/** Holds input until the prompt or approval policy phase in front of it resolves. */
export function setQueuedInput(
  machine: SessionMachine,
  input: StepInput | undefined,
): SessionMachine {
  const { queued: _queued, ...rest } = machine;
  return input === undefined ? rest : { ...rest, queued: input };
}

export function grantApprovals(machine: SessionMachine, keys: readonly string[]): SessionMachine {
  if (keys.length === 0) return machine;
  return { ...machine, grants: [...new Set([...machine.grants, ...keys])] };
}
