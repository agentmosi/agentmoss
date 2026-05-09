const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-...[redacted]"],
  [/\bghp_[A-Za-z0-9_]{20,}\b/g, "ghp_...[redacted]"],
  [/\b(xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "xox...[redacted]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email:redacted]"],
  [/\b1[3-9]\d{9}\b/g, "[phone:redacted]"],
  [/\b\d{15}(\d{2}[0-9Xx])?\b/g, "[id:redacted]"]
];

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/token|secret|password|cookie|api[_-]?key/i.test(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = redactValue(entry);
      }
    }
    return output;
  }
  return value;
}

export function stringifyForInspection(value: unknown): string {
  return JSON.stringify(value ?? "", null, 0).slice(0, 20000);
}
