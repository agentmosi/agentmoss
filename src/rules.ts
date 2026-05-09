import type {
  PolicyDecision,
  PolicyFinding,
  SafetyRule,
  ToolCallCheckRequest,
} from "./types.ts";
import { redactValue, stringifyForInspection } from "./redaction.ts";
import { getRules } from "./rule-loader.ts";

// ── Field collectors ──

const COMMAND_FIELDS = ["command", "cmd", "shell", "script", "input"];
const PATH_FIELDS = ["path", "file", "filename", "cwd", "target", "source"];
const URL_FIELDS = ["url", "uri", "endpoint", "webhook"];

function collectStringFields(
  value: unknown,
  keys: string[],
  out: string[] = [],
): string[] {
  if (!value || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" &&
      keys.some((candidate) => key.toLowerCase().includes(candidate))
    ) {
      out.push(entry);
    }
    if (entry && typeof entry === "object") {
      collectStringFields(entry, keys, out);
    }
  }
  return out;
}

function collectAllStringValues(
  value: unknown,
  out: string[] = [],
): string[] {
  if (!value || typeof value !== "object") return out;
  for (const entry of Object.values(value)) {
    if (typeof entry === "string") {
      out.push(entry);
    } else if (entry && typeof entry === "object") {
      collectAllStringValues(entry, out);
    }
  }
  return out;
}

// ── Helpers ──

function finding(
  id: string,
  severity: PolicyFinding["severity"],
  score: number,
  message: string,
  evidence?: string,
): PolicyFinding {
  return { id, severity, score, message, evidence };
}

function findScore(action: SafetyRule["action"]): number {
  switch (action) {
    case "block":
      return 95;
    case "require_approval":
      return 60;
    case "warn":
      return 35;
    default:
      return 10;
  }
}

function severityToScore(severity: SafetyRule["severity"]): number {
  switch (severity) {
    case "critical":
      return 40;
    case "warning":
      return 20;
    case "info":
      return 5;
  }
}

// ── Special checkers for paramPatterns with keyword patterns ──

function checkPrivateIP(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    // localhost variations
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0"
    ) {
      return true;
    }
    // RFC 1918 ranges
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
    }
    // Link-local
    if (hostname.startsWith("169.254.")) return true;
  } catch {
    // Not a valid URL, skip
  }
  return false;
}

function checkSecretInQuery(url: string): boolean {
  try {
    const qs = new URL(url).searchParams;
    const secretKeys = [
      "token",
      "api_key",
      "apikey",
      "key",
      "secret",
      "password",
      "passwd",
      "auth",
      "credential",
      "access_token",
      "refresh_token",
    ];
    for (const key of secretKeys) {
      if (qs.has(key)) return true;
    }
  } catch {
    // Not a valid URL
  }
  return false;
}

function checkPlaintext(url: string): boolean {
  return /^https?:\/\//i.test(url) && !url.toLowerCase().startsWith("https://");
}

// ── Built-in secret pattern detection (used by data.secret_like) ──

function checkSecretPattern(text: string): boolean {
  return (
    // API key patterns
    /\b(sk-[a-zA-Z0-9]{20,})\b/.test(text) ||
    /\b(ak-[a-zA-Z0-9]{20,})\b/.test(text) ||
    /\b(rk-[a-zA-Z0-9]{20,})\b/.test(text) ||
    // JWT-like tokens
    /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/.test(
      text,
    ) ||
    // Private key headers
    /-----BEGIN\s.*PRIVATE\sKEY-----/.test(text) ||
    // GitHub tokens
    /\bgh[pousr]_[a-zA-Z0-9]{20,}\b/.test(text) ||
    // Generic secret assignment
    /(secret|token|password|passwd|credential)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(
      text,
    )
  );
}

// ── Scan a text value against a list of regex patterns ──

function matchPatterns(
  text: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const pat of patterns) {
    try {
      if (new RegExp(pat, "i").test(text)) return true;
    } catch {
      // Invalid regex, skip
    }
  }
  return false;
}

// ── Scan a value (recursively) against a list of paramPatterns ──

function matchParamPatterns(
  params: Record<string, unknown> | undefined,
  patterns: SafetyRule["match"]["paramPatterns"],
): string | null {
  if (!params || !patterns || patterns.length === 0) return null;

  // Collect all string values in params, tagged with their field name
  const allValues: Array<{ field: string; value: string }> = [];

  function walk(obj: unknown, parentKey: string) {
    if (!obj || typeof obj !== "object") return;
    for (const [key, val] of Object.entries(obj)) {
      const fullKey = parentKey ? `${parentKey}.${key}` : key;
      if (typeof val === "string") {
        allValues.push({ field: fullKey, value: val });
      } else if (val && typeof val === "object") {
        walk(val, fullKey);
      }
    }
  }
  walk(params, "");

  for (const pp of patterns) {
    if (!pp.pattern) continue;

    // Handle special keyword patterns
    if (pp.pattern === "private_ip") {
      for (const { field, value } of allValues) {
        if (
          pp.field === "*" ||
          field.toLowerCase().includes(pp.field.toLowerCase())
        ) {
          if (checkPrivateIP(value)) return value;
        }
      }
      continue;
    }

    if (pp.pattern === "secret_in_query") {
      for (const { field, value } of allValues) {
        if (
          pp.field === "*" ||
          field.toLowerCase().includes(pp.field.toLowerCase())
        ) {
          if (checkSecretInQuery(value)) return value;
        }
      }
      continue;
    }

    if (pp.pattern === "plaintext") {
      for (const { field, value } of allValues) {
        if (
          pp.field === "*" ||
          field.toLowerCase().includes(pp.field.toLowerCase())
        ) {
          if (checkPlaintext(value)) return value;
        }
      }
      continue;
    }

    // Regular regex pattern
    try {
      const regex = new RegExp(pp.pattern, "i");
      for (const { field, value } of allValues) {
        if (
          pp.field === "*" ||
          field.toLowerCase().includes(pp.field.toLowerCase())
        ) {
          if (regex.test(value)) return value;
        }
      }
    } catch {
      // Invalid regex
    }
  }

  return null;
}

// ── Main evaluation ──

export function evaluateToolCall(
  request: ToolCallCheckRequest,
): PolicyDecision {
  const start = performance.now();
  const rules = getRules();
  const enabledRules = rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority);

  // Collect inspectable texts from the request
  const commandTexts: string[] = [
    request.toolName,
    ...collectStringFields(request.params, COMMAND_FIELDS),
  ];
  const pathTexts: string[] = collectStringFields(request.params, PATH_FIELDS);
  const urlTexts: string[] = collectStringFields(request.params, URL_FIELDS);
  const allParamTexts: string[] = collectAllStringValues(request.params);

  const findings: PolicyFinding[] = [];
  let maxRiskScore = 0;
  let worstAction: PolicyDecision["action"] = "allow";

  for (const rule of enabledRules) {
    let matched = false;
    let evidence: string | undefined;

    // 1. Tool name filtering
    const toolMatch =
      !rule.match.toolNames ||
      rule.match.toolNames.length === 0 ||
      rule.match.toolNames.some(
        (tn) => tn.toLowerCase() === request.toolName.toLowerCase(),
      );

    if (!toolMatch) continue;

    // 2. Command patterns
    if (rule.match.commandPatterns && rule.match.commandPatterns.length > 0) {
      if (rule.match.toolNames && rule.match.toolNames.length > 0) {
        // Only check command patterns if toolNames matched
        for (const text of commandTexts) {
          if (!text.trim()) continue;
          if (matchPatterns(text, rule.match.commandPatterns)) {
            matched = true;
            evidence = text.trim().slice(0, 200);
            break;
          }
        }
      }
    }

    // 3. Path patterns
    if (!matched && rule.match.pathPatterns && rule.match.pathPatterns.length > 0) {
      if (
        !rule.match.toolNames ||
        rule.match.toolNames.length === 0 ||
        rule.match.toolNames.some(
          (tn) => tn.toLowerCase() === request.toolName.toLowerCase(),
        )
      ) {
        for (const text of pathTexts) {
          if (!text.trim()) continue;
          if (matchPatterns(text, rule.match.pathPatterns)) {
            matched = true;
            evidence = text.trim().slice(0, 200);
            break;
          }
        }
      }
    }

    // 4. Param patterns
    if (!matched && rule.match.paramPatterns && rule.match.paramPatterns.length > 0) {
      const ev = matchParamPatterns(
        request.params,
        rule.match.paramPatterns,
      );
      if (ev !== null) {
        matched = true;
        evidence = ev.slice(0, 200);
      }
    }

    // 5. Special handling for data.secret_like — scans all param values
    if (!matched && rule.id === "data.secret_like") {
      for (const text of allParamTexts) {
        if (!text.trim()) continue;
        if (checkSecretPattern(text)) {
          matched = true;
          evidence = text.trim().slice(0, 200);
          break;
        }
      }
    }

    if (!matched) continue;

    // Create finding
    const riskScore = findScore(rule.action) + severityToScore(rule.severity);
    findings.push(
      finding(rule.id, rule.severity, Math.min(riskScore, 100), rule.actionReason, evidence),
    );

    if (riskScore > maxRiskScore) maxRiskScore = riskScore;

    // Determine worst action
    if (rule.action === "block") {
      worstAction = "block";
    } else if (rule.action === "require_approval" && worstAction !== "block") {
      worstAction = "require_approval";
    }
  }

  const durationMs = performance.now() - start;
  const reason =
    findings.length > 0
      ? findings
          .map((f) => `[${f.id}] ${f.message}`)
          .join("; ")
      : "未命中任何安全规则，允许执行。";

  return {
    action: worstAction,
    riskScore: maxRiskScore,
    reason,
    findings,
    durationMs,
  };
}