export type SourceTrust = "system" | "user" | "external" | "tool" | "memory";

export type EventType =
  | "llm_input"
  | "llm_output"
  | "tool_call"
  | "tool_result"
  | "file_read"
  | "file_write"
  | "network_request"
  | "message_received"
  | "message_sending"
  | "policy_decision"
  | "alert"
  | "run_start"
  | "run_end"
  | "session_start"
  | "session_end"
  | "prompt_build";

export type DecisionAction = "allow" | "block" | "require_approval";
export type RiskSeverity = "info" | "warning" | "critical";
export type RunStatus = "active" | "completed" | "aborted";

// ── Runtime Event ──

export type AgentRuntimeEvent = {
  eventId: string;
  ts: number;
  runId: string;
  sessionKey?: string;
  agentId?: string;
  hookName?: string;
  eventType: EventType;
  sourceTrust: SourceTrust;
  payloadDigest: string;
  redactedPayload: unknown;
  riskScore: number;
  decision?: DecisionAction;
  reason?: string;
  toolName?: string;
  toolCallId?: string;
  parentEventIds: string[];
};

// ── Policy ──

export type PolicyFinding = {
  id: string;
  severity: RiskSeverity;
  score: number;
  message: string;
  evidence?: string;
};

export type PolicyDecision = {
  action: DecisionAction;
  riskScore: number;
  reason: string;
  findings: PolicyFinding[];
  durationMs: number;
};

export type ToolCallCheckRequest = {
  toolName: string;
  params?: Record<string, unknown>;
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  parentEventIds?: string[];
  toolCallId?: string;
};

// ── Run Management ──

export type RunSummary = {
  runId: string;
  agentId: string;
  sessionKey: string;
  label?: string;
  status: RunStatus;
  startTime: number;
  endTime: number | null;
  eventCount: number;
  riskCount: number;
  blockCount: number;
  approvalCount: number;
  maxRiskScore: number;
};

// ── Behavior Graph ──

export type GraphNodeType =
  | "RunStart"
  | "RunEnd"
  | "SessionStart"
  | "SessionEnd"
  | "ToolCall"
  | "ToolResult"
  | "LLMInput"
  | "LLMOutput"
  | "MessageSend"
  | "MessageReceive"
  | "PolicyDecision"
  | "DataNode"
  | "RiskFlag";

export type GraphEdgeType =
  | "NEXT"
  | "CAUSED_BY"
  | "REFERENCES"
  | "MODIFIES"
  | "GENERATES"
  | "CONTAINS"
  | "MITIGATES";

export type GraphNode = {
  nodeId: string;
  nodeType: GraphNodeType;
  label: string;
  eventId?: string;
  metadata: Record<string, unknown>;
  riskScore: number;
  decision?: DecisionAction;
  createdAt: number;
};

export type GraphEdge = {
  edgeId: string;
  sourceId: string;
  targetId: string;
  edgeType: GraphEdgeType;
  metadata: Record<string, unknown>;
};

export type TraceGraph = {
  runId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

// ── Evidence Chain ──

export type EvidenceNode = {
  eventId: string;
  timestamp: number;
  hookName: string;
  eventType: EventType;
  toolName?: string;
  summary: string;
  riskLevel: RiskSeverity;
  riskScore: number;
  sensitiveData?: string[];
};

export type EvidenceChain = {
  chainId: string;
  runId: string;
  rootEventId: string;
  evidenceNodes: EvidenceNode[];
  createdAt: number;
};

// ── Stats ──

export type MonitorStats = {
  totalEvents: number;
  totalRuns: number;
  activeRuns: number;
  totalBlocked: number;
  totalApproval: number;
  highRiskEvents: number;
  topBlockedTools: Array<{ tool: string; count: number }>;
  eventsByType: Record<string, number>;
  avgLatencyMs: number;
};

// ── Rule ──

export type SafetyRule = {
  id: string;
  name: string;
  description: string;
  severity: RiskSeverity;
  category: "malicious_tool_call" | "prompt_injection" | "malicious_output" | "data_leakage";
  enabled: boolean;
  priority: number;
  match: {
    toolNames?: string[];
    paramPatterns?: Array<{ field: string; pattern: string }>;
    commandPatterns?: string[];
    pathPatterns?: string[];
  };
  action: DecisionAction | "warn" | "log_only";
  actionReason: string;
};