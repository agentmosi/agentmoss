/*
 * Example OpenClaw extension wiring.
 *
 * This file is intentionally not imported by the standalone demo server. Copy
 * the pattern into an OpenClaw extension when you want runtime enforcement.
 */

type OpenClawPluginApiLike = {
  on: (
    hookName: "before_tool_call" | "after_tool_call" | "llm_input" | "llm_output" | "message_sending",
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown> | unknown,
    options?: { priority?: number },
  ) => void;
};

export function registerAgentMonitorHooks(api: OpenClawPluginApiLike, monitorBaseUrl = "http://127.0.0.1:19876") {
  api.on(
    "before_tool_call",
    async (event, ctx) => {
      const response = await fetch(`${monitorBaseUrl}/api/tool-call/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolName: event.toolName,
          params: event.params,
          runId: event.runId ?? ctx.runId,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          parentEventIds: [],
        }),
      });

      if (!response.ok) {
        return {
          block: true,
          blockReason: `AgentMonitor unavailable: ${response.status}`,
        };
      }

      const body = (await response.json()) as {
        hookResult?: Record<string, unknown>;
      };
      return body.hookResult ?? {};
    },
    { priority: 10_000 },
  );

  for (const hookName of ["after_tool_call", "llm_input", "llm_output", "message_sending"] as const) {
    api.on(hookName, async (event, ctx) => {
      await fetch(`${monitorBaseUrl}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: event.runId ?? ctx.runId,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          hookName,
          eventType: hookName === "after_tool_call" ? "tool_result" : hookName,
          sourceTrust: hookName === "llm_input" ? "system" : "tool",
          payload: event,
        }),
      }).catch(() => undefined);
    });
  }
}
