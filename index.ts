import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/plugin-runtime";

type AgentMossConfig = {
  enabled?: boolean;
  monitorUrl?: string;
  timeoutMs?: number;
  failClosedOnError?: boolean;
  observeHooks?: boolean;
  auditOnly?: boolean;
};

type ResolvedAgentMossConfig = Required<AgentMossConfig>;

type MonitorToolCallResponse = {
  hookResult?: PluginHookBeforeToolCallResult;
};

const DEFAULT_CONFIG: ResolvedAgentMossConfig = {
  enabled: true,
  monitorUrl: "http://127.0.0.1:19877",
  timeoutMs: 80,
  failClosedOnError: true,
  observeHooks: true,
  auditOnly: false,
};

export default definePluginEntry({
  id: "agentmoss-demo-2",
  name: "AgentMoss Demo 2",
  description:
    "Forwards OpenClaw runtime hook events to AgentMoss Demo 2 and enforces tool-call decisions.",
  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig);
    if (!cfg.enabled) {
      api.logger.info("[AgentMoss Demo 2] disabled by plugin config.");
      return;
    }

    api.logger.info(`[AgentMoss Demo 2] connected to ${cfg.monitorUrl}`);

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (cfg.auditOnly) {
          await checkToolCall(api, cfg, event, ctx);
          return undefined;
        }
        return checkToolCall(api, cfg, event, ctx);
      },
      { priority: 10_000 },
    );

    if (!cfg.observeHooks) {
      return;
    }

    api.on("after_tool_call", (event, ctx) => {
      void postRuntimeEvent(api, cfg, "after_tool_call", "tool_result", "tool", event, ctx);
    });
    api.on("llm_input", (event, ctx) => {
      void postRuntimeEvent(api, cfg, "llm_input", "llm_input", "system", event, ctx);
    });
    api.on("llm_output", (event, ctx) => {
      void postRuntimeEvent(api, cfg, "llm_output", "llm_output", "tool", event, ctx);
    });
    api.on("message_sending", (event, ctx) => {
      void postRuntimeEvent(api, cfg, "message_sending", "message_sending", "tool", event, ctx);
    });
  },
});

async function checkToolCall(
  api: OpenClawPluginApi,
  cfg: ResolvedAgentMossConfig,
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
): Promise<PluginHookBeforeToolCallResult | undefined> {
  const response = await postJson(api, cfg, "/api/tool-call/check", {
    toolName: event.toolName,
    params: event.params,
    runId: event.runId ?? ctx.runId,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    toolCallId: event.toolCallId ?? ctx.toolCallId,
  });

  if (!response.ok) {
    api.logger.warn(`[AgentMoss Demo 2] before_tool_call failed: ${response.error}`);
    if (!cfg.failClosedOnError) {
      return undefined;
    }
    const blockResult: PluginHookBeforeToolCallResult = {
      block: true,
      blockReason: `AgentMoss Demo 2 不可用，已按故障阻断策略拒绝工具调用：${response.error}`,
    };
    return blockResult;
  }

  const responseBody = response.body as MonitorToolCallResponse;

  if (!isBeforeToolCallResult(responseBody.hookResult)) {
    if (!cfg.failClosedOnError) {
      return undefined;
    }
    const blockResult: PluginHookBeforeToolCallResult = {
      block: true,
      blockReason: "AgentMoss Demo 2 返回了无效的工具调用决策，已按故障阻断策略拒绝执行。",
    };
    return blockResult;
  }

  return responseBody.hookResult;
}

async function postRuntimeEvent(
  api: OpenClawPluginApi,
  cfg: ResolvedAgentMossConfig,
  hookName: string,
  eventType: string,
  sourceTrust: "system" | "tool",
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): Promise<void> {
  const response = await postJson(api, cfg, "/api/events", {
    runId: pickString(event.runId) ?? pickString(ctx.runId),
    sessionKey: pickString(ctx.sessionKey),
    agentId: pickString(ctx.agentId),
    hookName,
    eventType,
    sourceTrust,
    payload: event,
  });

  if (!response.ok) {
    api.logger.debug?.(`[AgentMoss Demo 2] observation hook ${hookName} failed: ${response.error}`);
  }
}

async function postJson(
  api: OpenClawPluginApi,
  cfg: ResolvedAgentMossConfig,
  pathname: string,
  body: unknown,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(new URL(pathname, cfg.monitorUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true, body: await response.json() };
  } catch (err) {
    return { ok: false, error: formatError(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveConfig(raw: Record<string, unknown> | undefined): ResolvedAgentMossConfig {
  return {
    enabled: raw?.enabled === undefined ? DEFAULT_CONFIG.enabled : raw.enabled === true,
    monitorUrl:
      typeof raw?.monitorUrl === "string" && raw.monitorUrl.trim()
        ? raw.monitorUrl
        : DEFAULT_CONFIG.monitorUrl,
    timeoutMs:
      typeof raw?.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
        ? Math.max(10, Math.min(5000, raw.timeoutMs))
        : DEFAULT_CONFIG.timeoutMs,
    failClosedOnError:
      raw?.failClosedOnError === undefined
        ? DEFAULT_CONFIG.failClosedOnError
        : raw.failClosedOnError === true,
    observeHooks:
      raw?.observeHooks === undefined ? DEFAULT_CONFIG.observeHooks : raw.observeHooks === true,
    auditOnly: raw?.auditOnly === undefined ? DEFAULT_CONFIG.auditOnly : raw.auditOnly === true,
  };
}

function isBeforeToolCallResult(
  value: unknown,
): value is PluginHookBeforeToolCallResult | undefined {
  if (value === undefined) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as PluginHookBeforeToolCallResult;
  const blockOk = result.block === undefined || typeof result.block === "boolean";
  const paramsOk =
    result.params === undefined || (result.params !== null && typeof result.params === "object");
  const approvalOk =
    result.requireApproval === undefined ||
    (result.requireApproval !== null && typeof result.requireApproval === "object");
  return blockOk && paramsOk && approvalOk;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "AbortError" ? "timeout" : err.message;
  }
  return String(err);
}