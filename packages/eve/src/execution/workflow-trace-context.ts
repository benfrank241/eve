import type { SessionMachine } from "#harness/session-machine.js";
import type { ExecutionInstrumentation } from "#instrumentation/runtime.js";
import type { RuntimeTraceContext } from "#protocol/message.js";

/** Prepares native tracing for workflow-owned preambles emitted outside the tool loop. */
export async function prepareWorkflowPreambleTrace(input: {
  readonly machine: SessionMachine;
  readonly instrumentation: ExecutionInstrumentation | undefined;
}): Promise<RuntimeTraceContext | undefined> {
  return await input.instrumentation?.preparePreamble({
    sequence: input.machine.sequence,
    sessionStarted: input.machine.started,
    turnId: `turn_${input.machine.sequence}`,
  });
}
