import type { ModelMessage } from "ai";

import {
  createMessageReceivedEvent,
  createSessionFailedEvent,
  createSessionStartedEvent,
  createSessionWaitingEvent,
  createStepFailedEvent,
  createStepStartedEvent,
  createTurnCancelledEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
  type RuntimeIdentity,
  type RuntimeTraceContext,
} from "#protocol/message.js";
import {
  activeTurnId,
  closeTurn,
  eventCoordinates,
  openTurn,
  type SessionMachine,
} from "#harness/session-machine.js";
import type { HarnessEmitFn, StepInput } from "#harness/types.js";
import type { JsonObject } from "#shared/json.js";

// Every turn and session lifecycle event is projected here, from the
// transition that causes it. Callers never emit these events directly.

/**
 * Opens a turn: `session.started` once, `turn.started`, then
 * `message.received` for the turn's message. Steering re-enters an open turn,
 * keeping its id and step and emitting only the new message.
 */
export async function emitTurnOpened(input: {
  readonly emit: HarnessEmitFn;
  readonly machine: SessionMachine;
  readonly messages: readonly ModelMessage[];
  readonly runtimeIdentity?: RuntimeIdentity;
  readonly stepInput: StepInput;
  readonly traceContext?: RuntimeTraceContext;
}): Promise<SessionMachine> {
  const { emit, machine } = input;
  const opened = openTurn(machine);
  const turnId = activeTurnId(opened);
  if (!machine.started) {
    await emit(
      createSessionStartedEvent({ runtime: input.runtimeIdentity, trace: input.traceContext }),
    );
  }
  if (machine.turn === undefined) {
    await emit(
      createTurnStartedEvent({ sequence: opened.sequence, trace: input.traceContext, turnId }),
      input.messages,
    );
  }
  if (input.stepInput.message !== undefined) {
    await emit(
      createMessageReceivedEvent({
        message: input.stepInput.message,
        sequence: opened.sequence,
        turnId,
      }),
    );
  }
  return opened;
}

export async function emitStepStarted(
  emit: HarnessEmitFn,
  machine: SessionMachine,
  modelId: string,
  messages?: readonly ModelMessage[],
): Promise<void> {
  await emit(createStepStartedEvent({ ...eventCoordinates(machine), modelId }), messages);
}

/** Every session that settles without ending waits for the next message. */
export async function emitSessionWaiting(emit: HarnessEmitFn): Promise<void> {
  await emit(createSessionWaitingEvent());
}

/** Closes the turn successfully: `turn.completed` → `session.waiting`. */
export async function emitTurnCompleted(
  emit: HarnessEmitFn,
  machine: SessionMachine,
  messages: readonly ModelMessage[],
): Promise<SessionMachine> {
  await emit(
    createTurnCompletedEvent({ sequence: machine.sequence, turnId: activeTurnId(machine) }),
    messages,
  );
  await emitSessionWaiting(emit);
  return closeTurn(machine);
}

/** A user decision, never a failure: `turn.cancelled` → `session.waiting`. */
export async function emitTurnCancelled(
  emit: HarnessEmitFn,
  machine: SessionMachine,
): Promise<SessionMachine> {
  await emit(
    createTurnCancelledEvent({ sequence: machine.sequence, turnId: activeTurnId(machine) }),
  );
  await emitSessionWaiting(emit);
  return closeTurn(machine);
}

export interface TurnFailure {
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
}

/**
 * Closes the turn as failed: `step.failed` → `turn.failed`, then
 * `session.waiting` when the session can take another message, or
 * `session.failed` when it cannot.
 */
export async function emitTurnFailed(
  emit: HarnessEmitFn,
  machine: SessionMachine,
  failure: TurnFailure,
  terminal?: { readonly sessionId: string },
): Promise<SessionMachine> {
  const coordinates = eventCoordinates(machine);
  await emit(createStepFailedEvent({ ...failure, ...coordinates }));
  await emit(
    createTurnFailedEvent({
      ...failure,
      sequence: coordinates.sequence,
      turnId: coordinates.turnId,
    }),
  );
  if (terminal === undefined) await emitSessionWaiting(emit);
  else await emit(createSessionFailedEvent({ ...failure, sessionId: terminal.sessionId }));
  return closeTurn(machine);
}
