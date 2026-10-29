import type {
  Comparison,
  LaneRef,
  RepView,
  RunDetail,
  RunListEntry,
  UsageTotals,
} from "@windtunnel/core";
import type { HuntAvailability, HuntEvent, HuntInfo } from "../../src/hunt.ts";

export type { AlignedRow, ChainEventView, Comparison, LaneRef, LaneStep, LaneView, RepView, RequestView, RunDetail, RunListEntry, TableTraceView, UsageTotals } from "@windtunnel/core";
export type { HuntEvent, HuntInfo } from "../../src/hunt.ts";

export interface Status {
  project: { name: string; root: string; repoRoot: string; appSubdir: string };
  hunt: HuntAvailability & { skill: string; running: HuntInfo | null };
  decider: string;
  budget: { tokens: number; usd: number };
  users: string[];
}

export interface Usage {
  budget: { tokens: number; usd: number };
  jobs: UsageTotals[];
}

export interface Decision {
  id: string;
  question: { kind: string; ask: string; options: Record<string, string> };
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "same-origin", headers: { ...(init?.body ? { "content-type": "application/json" } : {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  return body as T;
}

export const api = {
  status: () => call<Status>("/api/status"),
  runs: () => call<RunListEntry[]>("/api/runs?limit=150"),
  run: (id: string) => call<RunDetail>(`/api/runs/${id}`),
  rep: (id: string, n: number) => call<RepView>(`/api/runs/${id}/reps/${n}`),
  compare: (lanes: LaneRef[]) => call<Comparison>(`/api/compare?lanes=${lanes.map((l) => `${l.run}/${l.rep}`).join(",")}`),
  usage: () => call<Usage>("/api/usage"),
  decisions: () => call<Decision[]>("/api/decisions"),
  hunts: () => call<HuntInfo[]>("/api/hunts"),
  hunt: (id: string) => call<{ info: HuntInfo; events: HuntEvent[] }>(`/api/hunts/${id}`),
  startHunt: (prompt: string) => call<HuntInfo>("/api/hunts", { method: "POST", body: JSON.stringify({ prompt }) }),
  stopHunt: (id: string) => call<{ stopping: boolean }>(`/api/hunts/${id}/stop`, { method: "POST", body: "{}" }),
  screen: (id: string, n: number, file: string) => `/api/runs/${id}/reps/${n}/screens/${file}`,
};

export type ServerEvent =
  | { type: "runs"; changed: string[] }
  | { type: "usage" }
  | { type: "hunt"; id: string; info: HuntInfo }
  | { type: "hunt-event"; id: string; event: HuntEvent };
