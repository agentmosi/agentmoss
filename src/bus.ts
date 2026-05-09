import type { AgentRuntimeEvent, PolicyDecision } from "./types.ts";

export type MonitorMessage =
  | { type: "event"; event: AgentRuntimeEvent }
  | { type: "decision"; decision: PolicyDecision; event: AgentRuntimeEvent }
  | { type: "system"; message: string; count?: number; [key: string]: unknown };

type Listener = (message: MonitorMessage) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(message: MonitorMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }
}
