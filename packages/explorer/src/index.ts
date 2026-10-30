// Wind Tunnel explorer: the app map (static index + live crawl), the free sweep, affected experiments,
// the Decider and what it decides: selector repair and failure sorting.
export { type AffectedEntry, findAffected, formatAffected, formatAffectedRun } from "./affected.ts";
export { crawl, crawlDrillDown, type CrawledPage, type CrawlResult, formatCrawl, formatSweep, readCrawl, type SweepFinding } from "./crawl.ts";
export {
  type Answer,
  Decider,
  DecisionStore,
  formatDecision,
  Jev,
  type LevelOne,
  MuseSpark,
  type PendingDecision,
  type Question,
} from "./decider.ts";
export { type AppMap, buildAppMap, formatAppMap, formatEffects, type PageInfo, type RouteInfo } from "./map.ts";
export { findInSource, parseLocator, rankCandidates, replaceInSource, similarity } from "./repair.ts";
export { findNextRoutes, type RouteFile } from "./routes.ts";
export { formatTable, readSchema, readSqliteSchema, seedSchema, type TableInfo } from "./schema.ts";
export { findTauriApp, type TauriApp, type TauriCommand } from "./tauri.ts";
export { type Effect, parseSql, SourceIndex, type SqlEffect } from "./source.ts";
export { afterTriage, answerDecision, controlOf, type FailureLabel, formatTriage, sortFailures, type TriageEntry } from "./triage.ts";
