import { readFile, access } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SafetyRule } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type RuleSet = {
  filePath: string;
  version: string;
  description: string;
  rules: SafetyRule[];
  loadedAt: number;
};

let currentRuleSet: RuleSet | null = null;
let watcher: ReturnType<typeof watch> | null = null;
const onChangeCallbacks: Array<(rules: SafetyRule[]) => void> = [];

function resolvePolicyPath(customPath?: string): string {
  if (customPath) return path.resolve(customPath);
  return path.resolve(__dirname, "..", "policy", "safety-rules.json");
}

export async function loadRules(customPath?: string): Promise<SafetyRule[]> {
  const filePath = resolvePolicyPath(customPath);
  const raw = await readFile(filePath, "utf-8");
  const doc = JSON.parse(raw);

  const rules: SafetyRule[] = (doc.rules ?? []).map((rawRule: Record<string, unknown>) => {
    const rule: SafetyRule = {
      id: String(rawRule.id ?? ""),
      name: String(rawRule.name ?? rawRule.id ?? ""),
      description: String(rawRule.description ?? ""),
      severity: (["critical", "warning", "info"].includes(rawRule.severity as string)
        ? rawRule.severity
        : "warning") as SafetyRule["severity"],
      category: (["malicious_tool_call", "prompt_injection", "malicious_output", "data_leakage"].includes(
        rawRule.category as string,
      )
        ? rawRule.category
        : "malicious_tool_call") as SafetyRule["category"],
      enabled: rawRule.enabled !== false,
      priority: Number(rawRule.priority ?? 50),
      match: (() => {
        const m = (rawRule.match ?? {}) as Record<string, unknown>;
        return {
          toolNames: Array.isArray(m.toolNames) ? (m.toolNames as string[]) : undefined,
          paramPatterns: Array.isArray(m.paramPatterns)
            ? (m.paramPatterns as Array<Record<string, unknown>>).map((pp) => ({
                field: String(pp.field ?? "*"),
                pattern: String(pp.pattern ?? ""),
              }))
            : undefined,
          commandPatterns: Array.isArray(m.commandPatterns) ? (m.commandPatterns as string[]) : undefined,
          pathPatterns: Array.isArray(m.pathPatterns) ? (m.pathPatterns as string[]) : undefined,
        };
      })(),
      action: (["block", "require_approval", "warn", "log_only"].includes(rawRule.action as string)
        ? rawRule.action
        : "warn") as SafetyRule["action"],
      actionReason: String(rawRule.actionReason ?? rawRule.description ?? ""),
    };
    return rule;
  });

  currentRuleSet = {
    filePath,
    version: String(doc.version ?? "0.0.0"),
    description: String(doc.description ?? ""),
    rules,
    loadedAt: Date.now(),
  };

  return rules;
}

export function getRules(): SafetyRule[] {
  return currentRuleSet?.rules ?? [];
}

export function getRuleSet(): RuleSet | null {
  return currentRuleSet;
}

/**
 * Start watching the rule file for changes. When a change is detected,
 * the file is re-read and callbacks are invoked with the new rule set.
 * Returns a function to stop watching.
 */
export async function watchRules(customPath?: string): Promise<() => void> {
  const filePath = resolvePolicyPath(customPath);

  // Ensure the file exists before watching
  try {
    await access(filePath);
  } catch {
    throw new Error(`Rule file not found: ${filePath}`);
  }

  // Initial load
  await loadRules(customPath);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  watcher = watch(filePath, (eventType) => {
    if (eventType !== "change") return;

    // Debounce: some editors write multiple times in quick succession
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const rules = await loadRules(customPath);
        console.log(`[RuleLoader] Rules reloaded (${rules.length} rules, v${currentRuleSet?.version})`);
        for (const cb of onChangeCallbacks) {
          try {
            cb(rules);
          } catch (err) {
            console.error("[RuleLoader] onChange callback error:", err);
          }
        }
      } catch (err) {
        console.error("[RuleLoader] Failed to reload rules on change:", err);
      }
    }, 300);
  });

  return () => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  };
}

/**
 * Register a callback to be invoked whenever rules are reloaded.
 */
export function onRulesChange(callback: (rules: SafetyRule[]) => void): () => void {
  onChangeCallbacks.push(callback);
  return () => {
    const idx = onChangeCallbacks.indexOf(callback);
    if (idx >= 0) onChangeCallbacks.splice(idx, 1);
  };
}