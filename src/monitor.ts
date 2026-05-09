import { createEventId, digestPayload, now } from "./ids.ts";
import { redactValue } from "./redaction.ts";
import { evaluateToolCall } from "./rules.ts";
import type {
  AgentRuntimeEvent,
  EventType,
  SourceTrust,
  ToolCallCheckRequest,
} from "./types.ts";

export function createRuntimeEvent(input: {
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  hookName?: string;
  eventType: EventType;
  sourceTrust?: SourceTrust;
  payload: unknown;
  riskScore?: number;
  decision?: AgentRuntimeEvent["decision"];
  reason?: string;
  toolName?: string;
  toolCallId?: string;
  parentEventIds?: string[];
}): AgentRuntimeEvent {
  return {
    eventId: createEventId(),
    ts: now(),
    runId: input.runId || "unknown-run",
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    hookName: input.hookName,
    eventType: input.eventType,
    sourceTrust: input.sourceTrust ?? "system",
    payloadDigest: digestPayload(input.payload),
    redactedPayload: redactValue(input.payload),
    riskScore: input.riskScore ?? 0,
    decision: input.decision,
    reason: input.reason,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    parentEventIds: input.parentEventIds ?? [],
  };
}

export function checkToolCall(request: ToolCallCheckRequest): {
  decision: ReturnType<typeof evaluateToolCall>;
  event: AgentRuntimeEvent;
} {
  const decision = evaluateToolCall(request);
  const event = createRuntimeEvent({
    runId: request.runId,
    sessionKey: request.sessionKey,
    agentId: request.agentId,
    hookName: "before_tool_call",
    eventType: "tool_call",
    sourceTrust: "tool",
    payload: {
      toolName: request.toolName,
      params: request.params ?? {},
      findings: decision.findings,
    },
    riskScore: decision.riskScore,
    decision: decision.action,
    reason: decision.reason,
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    parentEventIds: request.parentEventIds,
  });
  return { decision, event };
}