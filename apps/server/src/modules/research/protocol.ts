import type { ActivityLevel, Settings } from "@multbot/shared";
import type { ModuleHealth } from "../../core/module.js";

/** Messages between the main thread and the research worker. */

export type ResearchMethod = "runDiscovery" | "runBacktest" | "analogues" | "labelNow" | "clusters" | "monitorNow" | "learnNow" | "runEvolution";

export type ToWorker =
  | { type: "settings"; settings: Settings }
  | { type: "request"; id: number; method: ResearchMethod; params: Record<string, unknown> }
  | { type: "stop" };

export type FromWorker =
  | { type: "ready" }
  | { type: "activity"; level: ActivityLevel; category: string; message: string; data?: Record<string, unknown> }
  | { type: "strategies-changed" }
  | { type: "health"; modules: ModuleHealth[] }
  | { type: "response"; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: "stopped" };
