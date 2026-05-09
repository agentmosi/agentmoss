import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEventId, now } from "./ids.ts";
import type {
  AgentRuntimeEvent,
  EvidenceChain,
  EvidenceNode,
  GraphEdge,
  GraphNode,
  MonitorStats,
  RunSummary,
  TraceGraph,
} from "./types.ts";

export class TraceStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.#migrate();
  }

  // ── Schema ──

  #migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'unknown',
        session_key TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'active',
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        event_count INTEGER DEFAULT 0,
        risk_count INTEGER DEFAULT 0,
        block_count INTEGER DEFAULT 0,
        approval_count INTEGER DEFAULT 0,
        max_risk_score INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        session_key TEXT,
        agent_id TEXT,
        hook_name TEXT,
        event_type TEXT NOT NULL,
        source_trust TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        redacted_payload TEXT NOT NULL,
        risk_score INTEGER NOT NULL DEFAULT 0,
        decision TEXT,
        reason TEXT,
        tool_name TEXT,
        tool_call_id TEXT,
        parent_event_ids TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, ts);
      CREATE INDEX IF NOT EXISTS idx_events_risk ON events(risk_score DESC);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_decision ON events(decision);

      CREATE TABLE IF NOT EXISTS graph_nodes (
        node_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        node_type TEXT NOT NULL,
        label TEXT NOT NULL,
        event_id TEXT REFERENCES events(event_id),
        metadata TEXT NOT NULL DEFAULT '{}',
        risk_score INTEGER DEFAULT 0,
        decision TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_graph_nodes_run ON graph_nodes(run_id);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_event ON graph_nodes(event_id);

      CREATE TABLE IF NOT EXISTS graph_edges (
        edge_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        source_id TEXT NOT NULL REFERENCES graph_nodes(node_id),
        target_id TEXT NOT NULL REFERENCES graph_nodes(node_id),
        edge_type TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_graph_edges_run ON graph_edges(run_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);

      CREATE TABLE IF NOT EXISTS policy_decisions (
        decision_id TEXT PRIMARY KEY,
        event_id TEXT REFERENCES events(event_id),
        run_id TEXT NOT NULL,
        rule_id TEXT,
        severity TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_policy_decisions_run ON policy_decisions(run_id);

      CREATE TABLE IF NOT EXISTS evidence_chains (
        chain_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        root_event_id TEXT NOT NULL,
        chain_data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_chains_run ON evidence_chains(run_id);
    `);
  }

  // ── Events ──

  insert(event: AgentRuntimeEvent): AgentRuntimeEvent {
    this.ensureRun(event.runId, event.sessionKey, event.agentId);
    this.db
      .prepare(`
        INSERT INTO events (
          event_id, ts, run_id, session_key, agent_id, hook_name, event_type,
          source_trust, payload_digest, redacted_payload, risk_score, decision,
          reason, tool_name, tool_call_id, parent_event_ids
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.eventId,
        event.ts,
        event.runId,
        event.sessionKey ?? null,
        event.agentId ?? null,
        event.hookName ?? null,
        event.eventType,
        event.sourceTrust,
        event.payloadDigest,
        JSON.stringify(event.redactedPayload),
        event.riskScore,
        event.decision ?? null,
        event.reason ?? null,
        event.toolName ?? null,
        event.toolCallId ?? null,
        JSON.stringify(event.parentEventIds),
      );
    this.#updateRunStats(event);
    return event;
  }

  getEvent(eventId: string): AgentRuntimeEvent | undefined {
    const row = this.db
      .prepare("SELECT * FROM events WHERE event_id = ?")
      .get(eventId) as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  list(limit = 200, runId?: string): AgentRuntimeEvent[] {
    if (runId) {
      const rows = this.db
        .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY ts DESC LIMIT ?")
        .all(runId, Math.max(1, Math.min(limit, 1000))) as EventRow[];
      return rows.map(rowToEvent);
    }
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY ts DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 1000))) as EventRow[];
    return rows.map(rowToEvent);
  }

  latestHighRisk(limit = 20): AgentRuntimeEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE risk_score >= 70 OR decision = 'block' ORDER BY ts DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 100))) as EventRow[];
    return rows.map(rowToEvent);
  }

  eventsByRun(runId: string, limit = 500): AgentRuntimeEvent[] {
    return this.list(limit, runId);
  }

  // ── Runs ──

  ensureRun(runId: string, sessionKey?: string, agentId?: string): void {
    const existing = this.db
      .prepare("SELECT run_id FROM runs WHERE run_id = ?")
      .get(runId);
    if (existing) return;
    this.db
      .prepare(`
        INSERT INTO runs (run_id, agent_id, session_key, status, start_time)
        VALUES (?, ?, ?, 'active', ?)
      `)
      .run(runId, agentId ?? "unknown", sessionKey ?? "unknown", now());
  }

  updateRunStatus(runId: string, status: string, endTime?: number): void {
    this.db
      .prepare("UPDATE runs SET status = ?, end_time = ? WHERE run_id = ?")
      .run(status, endTime ?? now(), runId);
  }

  #updateRunStats(event: AgentRuntimeEvent): void {
    this.ensureRun(event.runId, event.sessionKey, event.agentId);

    const hasRisk = event.riskScore >= 70 || event.decision === "block" || event.decision === "require_approval";
    const isBlock = event.decision === "block";
    const isApproval = event.decision === "require_approval";

    if (hasRisk || isBlock || isApproval) {
      this.db
        .prepare(`
          UPDATE runs SET
            event_count = event_count + 1,
            risk_count = risk_count + ?,
            block_count = block_count + ?,
            approval_count = approval_count + ?,
            max_risk_score = MAX(max_risk_score, ?)
          WHERE run_id = ?
        `)
        .run(
          hasRisk ? 1 : 0,
          isBlock ? 1 : 0,
          isApproval ? 1 : 0,
          event.riskScore,
          event.runId,
        );
    } else {
      this.db
        .prepare("UPDATE runs SET event_count = event_count + 1 WHERE run_id = ?")
        .run(event.runId);
    }
  }

  listRuns(limit = 50): RunSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM runs ORDER BY start_time DESC LIMIT ?")
      .all(limit) as RunRow[];
    return rows.map(r => this.#enrichRunSummary(rowToRunSummary(r)));
  }

  getRun(runId: string): RunSummary | undefined {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as RunRow | undefined;
    return row ? this.#enrichRunSummary(rowToRunSummary(row)) : undefined;
  }

  #enrichRunSummary(run: RunSummary): RunSummary {
    if (!run.label) {
      run.label = this.#computeRunLabel(run);
    }
    return run;
  }

  #computeRunLabel(run: RunSummary): string {
    // Look for the first user message or first tool call in this run
    const firstEvent = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? AND event_type IN ('message_received', 'tool_call', 'llm_input') ORDER BY ts ASC LIMIT 1")
      .get(run.runId) as EventRow | undefined;

    if (firstEvent) {
      const payload = JSON.parse(firstEvent.redacted_payload ?? "{}");
      if (typeof payload === "string" && payload.trim()) {
        return payload.trim().substring(0, 40);
      }
      if (payload?.message && typeof payload.message === "string") {
        return payload.message.substring(0, 40);
      }
      if (payload?.userMessage && typeof payload.userMessage === "string") {
        return payload.userMessage.substring(0, 40);
      }
      if (payload?.command && typeof payload.command === "string") {
        return `命令: ${payload.command.substring(0, 34)}`;
      }
      if (firstEvent.event_type === "tool_call" && firstEvent.tool_name) {
        return `调用: ${firstEvent.tool_name}`;
      }
      if (firstEvent.event_type === "message_received") {
        return "用户消息";
      }
    }

    // Fallback: use agent + time
    const date = new Date(run.startTime);
    const timeStr = date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return `${run.agentId} · ${timeStr}`;
  }

  // ── Graph ──

  insertGraphNode(
    runId: string,
    nodeType: GraphNode["nodeType"],
    label: string,
    eventId?: string,
    metadata: Record<string, unknown> = {},
    riskScore = 0,
    decision?: GraphNode["decision"],
  ): GraphNode {
    const node: GraphNode = {
      nodeId: createEventId("gn"),
      nodeType,
      label,
      eventId,
      metadata,
      riskScore,
      decision,
      createdAt: now(),
    };
    this.db
      .prepare(`
        INSERT INTO graph_nodes (node_id, run_id, node_type, label, event_id, metadata, risk_score, decision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(node.nodeId, runId, node.nodeType, node.label, node.eventId ?? null, JSON.stringify(node.metadata), node.riskScore, node.decision ?? null, node.createdAt);
    return node;
  }

  insertGraphEdge(
    runId: string,
    sourceId: string,
    targetId: string,
    edgeType: GraphEdge["edgeType"],
    metadata: Record<string, unknown> = {},
  ): GraphEdge {
    const edge: GraphEdge = {
      edgeId: createEventId("ge"),
      sourceId,
      targetId,
      edgeType,
      metadata,
    };
    this.db
      .prepare(`
        INSERT INTO graph_edges (edge_id, run_id, source_id, target_id, edge_type, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(edge.edgeId, runId, edge.sourceId, edge.targetId, edge.edgeType, JSON.stringify(edge.metadata), now());
    return edge;
  }

  graphNodes(runId: string): GraphNode[] {
    const rows = this.db
      .prepare("SELECT * FROM graph_nodes WHERE run_id = ? ORDER BY created_at")
      .all(runId) as GraphNodeRow[];
    return rows.map(rowToGraphNode);
  }

  graphEdges(runId: string): GraphEdge[] {
    const rows = this.db
      .prepare("SELECT * FROM graph_edges WHERE run_id = ? ORDER BY created_at")
      .all(runId) as GraphEdgeRow[];
    return rows.map(rowToGraphEdge);
  }

  graph(runId: string, limit = 200): TraceGraph {
    const events = this.eventsByRun(runId, limit).reverse();
    const eventSet = new Set(events.map((e) => e.eventId));
    const nodeTypeMap: Record<string, GraphNode["nodeType"]> = {
      llm_input: "LLMInput",
      llm_output: "LLMOutput",
      tool_call: "ToolCall",
      tool_result: "ToolResult",
      file_read: "ToolCall",
      file_write: "ToolCall",
      network_request: "ToolCall",
      message_received: "MessageReceive",
      message_sending: "MessageSend",
      policy_decision: "PolicyDecision",
      alert: "RiskFlag",
      run_start: "RunStart",
      run_end: "RunEnd",
      session_start: "SessionStart",
      session_end: "SessionEnd",
      prompt_build: "LLMInput",
    };
    const nodes: GraphNode[] = events.map((e) => ({
      nodeId: e.eventId,
      nodeType: nodeTypeMap[e.eventType] ?? "DataNode",
      label: e.toolName ? `${e.toolName}:${e.eventType}` : `${e.eventType}:${e.riskScore}`,
      eventId: e.eventId,
      metadata: {},
      riskScore: e.riskScore,
      decision: e.decision,
      createdAt: e.ts,
    }));
    const edges: GraphEdge[] = events.flatMap((e) =>
      e.parentEventIds
        .filter((pid) => eventSet.has(pid))
        .map((pid, idx) => ({
          edgeId: `${pid}->${e.eventId}:${idx}`,
          sourceId: pid,
          targetId: e.eventId,
          edgeType: inferEdgeType(e.eventType, e.decision),
          metadata: {},
        })),
    );
    return { runId, nodes, edges };
  }

  // ── Evidence Chain ──

  generateEvidenceChain(runId: string, rootEventId: string): EvidenceChain | null {
    const rootEvent = this.getEvent(rootEventId);
    if (!rootEvent) return null;

    // Build event index for this run
    const allEvents = this.eventsByRun(runId, 1000).reverse();
    const eventMap = new Map(allEvents.map((e) => [e.eventId, e]));

    // BFS forward: find events causally downstream of rootEventId
    const visited = new Set<string>();
    const queue = [rootEventId];
    const evidenceNodes: EvidenceNode[] = [];

    while (queue.length > 0 && evidenceNodes.length < 50) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const event = eventMap.get(currentId);
      if (!event) continue;

      evidenceNodes.push(eventToEvidenceNode(event));

      // Follow forward: find events that have currentId as parent
      for (const e of allEvents) {
        if (!visited.has(e.eventId) && e.parentEventIds.includes(currentId)) {
          queue.push(e.eventId);
        }
      }
    }

    // Also do reverse BFS from root to find upstream events
    const reverseQueue = [rootEventId];
    const upstreamVisited = new Set<string>();
    const upstreamNodes: EvidenceNode[] = [];

    while (reverseQueue.length > 0 && upstreamNodes.length < 30) {
      const currentId = reverseQueue.shift()!;
      if (upstreamVisited.has(currentId)) continue;
      upstreamVisited.add(currentId);

      const event = eventMap.get(currentId);
      if (!event) continue;

      if (currentId !== rootEventId) {
        upstreamNodes.push(eventToEvidenceNode(event));
      }

      for (const pid of event.parentEventIds) {
        if (!upstreamVisited.has(pid) && eventMap.has(pid)) {
          reverseQueue.push(pid);
        }
      }
    }

    // Merge: upstream (chronological) + root + downstream
    const merged: EvidenceNode[] = [
      ...upstreamNodes.reverse(),
      eventToEvidenceNode(rootEvent),
      ...evidenceNodes.filter((n) => n.eventId !== rootEventId),
    ];

    const chain: EvidenceChain = {
      chainId: createEventId("chain"),
      runId,
      rootEventId,
      evidenceNodes: merged,
      createdAt: now(),
    };

    // Persist
    this.db
      .prepare("INSERT INTO evidence_chains (chain_id, run_id, root_event_id, chain_data, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(chain.chainId, chain.runId, chain.rootEventId, JSON.stringify(chain.evidenceNodes), chain.createdAt);

    return chain;
  }

  getEvidenceChain(chainId: string): EvidenceChain | undefined {
    const row = this.db
      .prepare("SELECT * FROM evidence_chains WHERE chain_id = ?")
      .get(chainId) as EvidenceChainRow | undefined;
    if (!row) return undefined;
    return {
      chainId: row.chain_id,
      runId: row.run_id,
      rootEventId: row.root_event_id,
      evidenceNodes: JSON.parse(row.chain_data),
      createdAt: row.created_at,
    };
  }

  listEvidenceChains(runId: string): EvidenceChain[] {
    const rows = this.db
      .prepare("SELECT * FROM evidence_chains WHERE run_id = ? ORDER BY created_at DESC")
      .all(runId) as EvidenceChainRow[];
    return rows.map((r) => ({
      chainId: r.chain_id,
      runId: r.run_id,
      rootEventId: r.root_event_id,
      evidenceNodes: JSON.parse(r.chain_data),
      createdAt: r.created_at,
    }));
  }

  // ── Stats ──

  stats(): MonitorStats {
    const totalEvents = (
      this.db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }
    ).c;
    const totalRuns = (
      this.db.prepare("SELECT COUNT(*) as c FROM runs").get() as { c: number }
    ).c;
    const activeRuns = (
      this.db.prepare("SELECT COUNT(*) as c FROM runs WHERE status = 'active'").get() as { c: number }
    ).c;
    const totalBlocked = (
      this.db.prepare("SELECT COUNT(*) as c FROM events WHERE decision = 'block'").get() as { c: number }
    ).c;
    const totalApproval = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM events WHERE decision = 'require_approval'")
        .get() as { c: number }
    ).c;
    const highRiskEvents = (
      this.db.prepare("SELECT COUNT(*) as c FROM events WHERE risk_score >= 70").get() as { c: number }
    ).c;

    // Top blocked tools
    const topBlockedTools = (
      this.db
        .prepare(`
          SELECT COALESCE(tool_name, 'unknown') as tool, COUNT(*) as count
          FROM events WHERE decision = 'block' AND tool_name IS NOT NULL
          GROUP BY tool_name ORDER BY count DESC LIMIT 10
        `)
        .all() as Array<{ tool: string; count: number }>
    ).map((r) => ({ tool: r.tool, count: r.count }));

    // Events by type
    const eventsByTypeRaw = this.db
      .prepare("SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type ORDER BY count DESC")
      .all() as Array<{ event_type: string; count: number }>;
    const eventsByType: Record<string, number> = {};
    for (const row of eventsByTypeRaw) {
      eventsByType[row.event_type] = row.count;
    }

    // Average latency (approximate: use gap between successive events)
    const avgLatencyMs = 0; // Placeholder — would need dedicated latency tracking

    return {
      totalEvents,
      totalRuns,
      activeRuns,
      totalBlocked,
      totalApproval,
      highRiskEvents,
      topBlockedTools,
      eventsByType,
      avgLatencyMs,
    };
  }

  // ── Clear All Demo Data ──

  clearAll(): { runs: number; events: number; graphNodes: number; graphEdges: number; policyDecisions: number; evidenceChains: number } {
    // Delete in FK-safe order: children first, parents last
    const policyDecisions = (this.db.prepare("DELETE FROM policy_decisions").run() as { changes: number }).changes;
    const evidenceChains = (this.db.prepare("DELETE FROM evidence_chains").run() as { changes: number }).changes;
    const graphEdges = (this.db.prepare("DELETE FROM graph_edges").run() as { changes: number }).changes;
    const graphNodes = (this.db.prepare("DELETE FROM graph_nodes").run() as { changes: number }).changes;
    const events = (this.db.prepare("DELETE FROM events").run() as { changes: number }).changes;
    const runs = (this.db.prepare("DELETE FROM runs").run() as { changes: number }).changes;
    return { runs, events, graphNodes, graphEdges, policyDecisions, evidenceChains };
  }

  // ── Policy Decisions ──

  insertPolicyDecision(
    eventId: string,
    runId: string,
    ruleId: string,
    severity: string,
    action: string,
    reason: string,
  ): void {
    this.db
      .prepare(`
        INSERT INTO policy_decisions (decision_id, event_id, run_id, rule_id, severity, action, reason, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(createEventId("dec"), eventId, runId, ruleId, severity, action, reason, now());
  }
}

// ── Row Types ──

type EventRow = {
  event_id: string;
  ts: number;
  run_id: string;
  session_key: string | null;
  agent_id: string | null;
  hook_name: string | null;
  event_type: AgentRuntimeEvent["eventType"];
  source_trust: AgentRuntimeEvent["sourceTrust"];
  payload_digest: string;
  redacted_payload: string;
  risk_score: number;
  decision: AgentRuntimeEvent["decision"] | null;
  reason: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  parent_event_ids: string;
};

type RunRow = {
  run_id: string;
  agent_id: string;
  session_key: string;
  status: string;
  start_time: number;
  end_time: number | null;
  event_count: number;
  risk_count: number;
  block_count: number;
  approval_count: number;
  max_risk_score: number;
};

type GraphNodeRow = {
  node_id: string;
  run_id: string;
  node_type: string;
  label: string;
  event_id: string | null;
  metadata: string;
  risk_score: number;
  decision: string | null;
  created_at: number;
};

type GraphEdgeRow = {
  edge_id: string;
  run_id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  metadata: string;
  created_at: number;
};

type EvidenceChainRow = {
  chain_id: string;
  run_id: string;
  root_event_id: string;
  chain_data: string;
  created_at: number;
};

// ── Row Converters ──

function rowToEvent(row: EventRow): AgentRuntimeEvent {
  return {
    eventId: row.event_id,
    ts: row.ts,
    runId: row.run_id,
    sessionKey: row.session_key ?? undefined,
    agentId: row.agent_id ?? undefined,
    hookName: row.hook_name ?? undefined,
    eventType: row.event_type,
    sourceTrust: row.source_trust,
    payloadDigest: row.payload_digest,
    redactedPayload: JSON.parse(row.redacted_payload),
    riskScore: row.risk_score,
    decision: row.decision ?? undefined,
    reason: row.reason ?? undefined,
    toolName: row.tool_name ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    parentEventIds: JSON.parse(row.parent_event_ids),
  };
}

function rowToRunSummary(row: RunRow): RunSummary {
  return {
    runId: row.run_id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    status: row.status as RunSummary["status"],
    startTime: row.start_time,
    endTime: row.end_time,
    eventCount: row.event_count,
    riskCount: row.risk_count,
    blockCount: row.block_count,
    approvalCount: row.approval_count,
    maxRiskScore: row.max_risk_score,
  };
}

function rowToGraphNode(row: GraphNodeRow): GraphNode {
  return {
    nodeId: row.node_id,
    nodeType: row.node_type as GraphNode["nodeType"],
    label: row.label,
    eventId: row.event_id ?? undefined,
    metadata: JSON.parse(row.metadata),
    riskScore: row.risk_score,
    decision: (row.decision as GraphNode["decision"]) ?? undefined,
    createdAt: row.created_at,
  };
}

function rowToGraphEdge(row: GraphEdgeRow): GraphEdge {
  return {
    edgeId: row.edge_id,
    sourceId: row.source_id,
    targetId: row.target_id,
    edgeType: row.edge_type as GraphEdge["edgeType"],
    metadata: JSON.parse(row.metadata),
  };
}

function inferEdgeType(
  eventType: AgentRuntimeEvent["eventType"],
  decision?: AgentRuntimeEvent["decision"],
): GraphEdge["edgeType"] {
  if (decision === "block") return "MITIGATES";
  if (eventType === "tool_call" || eventType === "policy_decision") return "CAUSED_BY";
  if (eventType === "file_read" || eventType === "file_write" || eventType === "network_request") return "MODIFIES";
  if (eventType === "message_sending") return "CONTAINS";
  return "NEXT";
}

function eventToEvidenceNode(event: AgentRuntimeEvent): EvidenceNode {
  // Detect sensitive data in redacted payload
  const payloadStr = JSON.stringify(event.redactedPayload);
  const sensitiveData: string[] = [];
  if (/\[redacted\]/.test(payloadStr)) {
    sensitiveData.push("redacted_field_detected");
  }
  if (/(sk-|ghp_|xox[a-z]-)/i.test(payloadStr)) {
    sensitiveData.push("api_key_pattern");
  }

  let riskLevel: "info" | "warning" | "critical" = "info";
  if (event.riskScore >= 85) riskLevel = "critical";
  else if (event.riskScore >= 50) riskLevel = "warning";

  const hooksZh: Record<string, string> = {
    before_tool_call: "工具调用前",
    after_tool_call: "工具调用后",
    llm_input: "模型输入",
    llm_output: "模型输出",
    message_sending: "发送消息",
    message_received: "收到消息",
    before_prompt_build: "构建提示词",
  };

  const hookDesc = hooksZh[event.hookName ?? ""] ?? event.hookName ?? event.eventType;
  const toolDesc = event.toolName ? ` (${event.toolName})` : "";

  return {
    eventId: event.eventId,
    timestamp: event.ts,
    hookName: event.hookName ?? event.eventType,
    eventType: event.eventType,
    toolName: event.toolName,
    summary: `${hookDesc}${toolDesc} · ${event.reason ?? ""} · 风险 ${event.riskScore}`,
    riskLevel,
    riskScore: event.riskScore,
    sensitiveData: sensitiveData.length > 0 ? sensitiveData : undefined,
  };
}