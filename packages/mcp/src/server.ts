import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ConfigError,
  drillDown,
  formatProof,
  formatResults,
  loadExperiments,
  prove,
  writeProofBranch,
} from "@windtunnel/core";
import { buildAppMap, findAffected, formatAffectedRun, formatAppMap, readSchema } from "@windtunnel/explorer";
import { z } from "zod";
import { Workspace } from "./workspace.ts";

export const SERVER_NAME = "windtunnel";
const VERSION = "0.0.0";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type Progress = (done: number, total: number | undefined, message: string) => void;

/** The Wind Tunnel MCP server: six tools over one project. */
export function createServer(workspace: Workspace): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });

  server.registerTool(
    "windtunnel_map",
    {
      description:
        "Map of the app built from its code, no model involved: each API handler's database and network steps in order with risky patterns flagged (!), pages with their buttons and fields, the database schema, and existing flows, rules and experiments. Read it before writing experiments.",
      inputSchema: { focus: z.string().optional().describe("Only routes and pages whose path or file contains this") },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ focus }) => {
      const runner = await workspace.open();
      const schema = await runner.branches.withSeedCopy({}, readSchema).catch(() => undefined);
      const map = await buildAppMap(runner.project, { schema });
      return formatAppMap(map, { focus }) + (schema ? "" : "\n(database schema unavailable: run windtunnel_validate to see why)");
    }),
  );

  server.registerTool(
    "windtunnel_validate",
    {
      description:
        "Check windtunnel.config.yaml, flows and experiments without running them, and run every rule's SQL on the seed data (each must return no rows there).",
      inputSchema: { experiments: z.array(z.string()).optional().describe("Experiment ids (default: all)") },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ experiments: ids }) => {
      const runner = await workspace.open();
      const experiments = await loadExperiments(runner.project, ids ?? []);
      const { rules, warnings } = await runner.validate(experiments);
      const problems = await runner.checkRulesOnSeed(rules);
      if (problems.length) throw new ConfigError(problems.join("\n"));
      return [`ok: ${experiments.length} experiment(s), ${rules.length} rule(s) hold on the seed data`, ...warnings.map((w) => `warning: ${w}`)].join("\n");
    }),
  );

  server.registerTool(
    "windtunnel_run",
    {
      description:
        "Run experiments, each run in its own copy of the app and database, in parallel. Returns pass/fail/flaky per experiment with the rules broken and a run id for windtunnel_evidence. Default: every experiment on the working tree.",
      inputSchema: {
        experiments: z.array(z.string()).optional().describe("Experiment ids (default: all)"),
        affected: z.boolean().optional().describe("Only experiments whose code changed since their last result; reuse the others"),
        repeat: z.number().int().min(1).max(50).optional().describe("Runs per ordering (default: each experiment's repeat)"),
        ref: z.string().optional().describe("Git ref to test instead of the working tree"),
        patch: z.string().optional().describe("Unified diff (or path to one) applied on top"),
      },
    },
    tool(async ({ experiments: ids, affected, repeat, ref, patch }, progress) => {
      const runner = await workspace.open();
      const all = await loadExperiments(runner.project, ids ?? []);
      if (all.length === 0) throw new ConfigError("no experiments yet: write one in .windtunnel/experiments/");
      if (affected && (ref || patch)) throw new ConfigError("affected works on the working tree only (no ref or patch)");
      const statuses = affected ? await findAffected(runner, all, { repeat }) : undefined;
      const experiments = statuses ? all.filter((e) => statuses.find((s) => s.experiment === e.id)?.status !== "cached") : all;
      let done = 0;
      const total = experiments.reduce((n, e) => n + (repeat ?? e.repeat), 0);
      const results = experiments.length === 0 ? [] : await runner.run(experiments, {
        version: await workspace.versionSpec({ ref, patch }),
        repeat,
        onRep: (r) => progress(++done, total, `${r.experiment} #${r.rep} ${r.outcome}`),
      });
      const failing = results.filter((r) => r.outcome !== "pass");
      return [
        statuses ? formatAffectedRun(statuses, results, runner.project.root) : formatResults(results, runner.project.root),
        failing.length ? `\nEvidence: windtunnel_evidence handle=<run> (e.g. ${failing[0]!.runId})` : "",
      ].join("");
    }),
  );

  server.registerTool(
    "windtunnel_evidence",
    {
      description:
        "Evidence for a run in about 2k tokens: broken rule rows, step timeline with what the harness did, key requests and their handlers, database changes, and the first difference from a passing run. Drill down with a handle such as <run>/1/diff:orders.",
      inputSchema: { handle: z.string().describe("Run id, or <run>/<n>/<part> with part steps|requests|diff|diff:<table>|rule:<id>|log|console|webhooks") },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ handle }) => {
      const runner = await workspace.open();
      return drillDown(runner.store, handle.trim(), {
        rules: await workspace.rules(),
        handlerFor: await workspace.handlerResolver().catch(() => undefined),
        source: runner.project,
      });
    }),
  );

  server.registerTool(
    "windtunnel_branch",
    {
      description:
        "Start, list or stop an isolated copy of the app (code version + its own database copy + app process + mock payments) to try things by hand, e.g. with curl or psql.",
      inputSchema: {
        action: z.enum(["start", "list", "stop"]),
        id: z.string().optional().describe("Branch id (stop)"),
        ref: z.string().optional().describe("Git ref (start; default: working tree)"),
        patch: z.string().optional().describe("Unified diff or path to one (start)"),
      },
    },
    tool(async ({ action, id, ref, patch }) => {
      const runner = await workspace.open();
      if (action === "list") {
        const live = [...workspace.branches.values()];
        return live.length ? live.map((b) => `${b.id}  ${b.baseUrl}  version ${b.version.id}`).join("\n") : "no branches running";
      }
      if (action === "stop") {
        const ids = id ? [id] : [...workspace.branches.keys()];
        for (const key of ids) {
          const branch = workspace.branches.get(key);
          if (!branch) throw new ConfigError(`no running branch ${key}`);
          await branch.stop();
          workspace.branches.delete(key);
        }
        return `stopped ${ids.length} branch(es)`;
      }
      const branch = await runner.branches.create(await workspace.versionSpec({ ref, patch }));
      workspace.branches.set(branch.id, branch);
      return [
        `branch    ${branch.id} (stop with action "stop")`,
        `version   ${branch.version.id} (${branch.version.label})`,
        `app       ${branch.baseUrl}`,
        `database  ${branch.database.url}`,
        ...(branch.payments ? [`payments  ${branch.payments.url}`] : []),
        `logs      ${branch.logDir}`,
      ].join("\n");
    }),
  );

  server.registerTool(
    "windtunnel_prove",
    {
      description:
        "Prove a fix: the experiments must fail on the base code every time, pass with the fix every time in every ordering, fail again on the base code, and no other experiment may get worse. The fix is the working tree unless a patch is given.",
      inputSchema: {
        experiments: z.array(z.string()).min(1).describe("Experiments that reproduce the bug"),
        base: z.string().optional().describe("Git ref with the bug (default: HEAD)"),
        patch: z.string().optional().describe("The fix as a unified diff or path to one, applied on the base (default: the working tree)"),
        repeat: z.number().int().min(1).max(50).optional().describe("Runs per ordering (default: at least 5)"),
        branch: z.string().optional().describe("When proven, create this git branch: fix + regression experiments + evidence file (working tree untouched)"),
        message: z.string().optional().describe("Commit message for the branch (default: generated)"),
      },
    },
    tool(async ({ experiments: ids, base, patch, repeat, branch, message }) => {
      const runner = await workspace.open();
      const all = await loadExperiments(runner.project);
      const targets = await loadExperiments(runner.project, ids);
      const proof = await prove(runner, {
        experiments: targets,
        base: { ref: base ?? "HEAD" },
        fix: patch ? await workspace.versionSpec({ ref: base ?? "HEAD", patch }) : {},
        repeat,
        regression: all.filter((e) => !ids.includes(e.id)),
        reuse: !!branch,
      });
      if (!branch) return formatProof(proof);
      if (proof.verdict !== "proven") return `${formatProof(proof)}\n\nNo branch created: the fix is not proven.`;
      const created = await writeProofBranch(runner, proof, {
        name: branch,
        parent: base ?? "HEAD",
        experiments: targets,
        rules: await workspace.rules(),
        handlerFor: await workspace.handlerResolver().catch(() => undefined),
        message,
      });
      return [
        formatProof(proof),
        "",
        `Branch ${created.name} created (${created.commit.slice(0, 12)}) with the fix and: ${created.added.join(", ")}`,
        created.remote
          ? `Ask the user before pushing (git push -u ${created.remote} ${created.name}). PR text: ${created.evidenceCopy}`
          : `The repository has no git remote. PR text: ${created.evidenceCopy}`,
      ].join("\n");
    }),
  );

  return server;
}

/** Wraps a handler: text result, errors as tool errors, progress when the client asked for it. */
function tool<A>(fn: (args: A, progress: Progress) => Promise<string>) {
  return async (args: A, extra: { _meta?: { progressToken?: string | number }; sendNotification: (n: never) => Promise<void> }): Promise<ToolResult> => {
    const token = extra._meta?.progressToken;
    const progress: Progress = (done, total, message) => {
      if (token === undefined) return;
      void extra
        .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: done, total, message } } as never)
        .catch(() => undefined);
    };
    try {
      return { content: [{ type: "text", text: await fn(args, progress) }] };
    } catch (err) {
      const message = err instanceof ConfigError ? err.message : ((err as Error).message ?? String(err));
      return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
    }
  };
}

/** Serves over stdin/stdout until the client disconnects. */
export async function serveStdio(cwd: string): Promise<void> {
  // stdout carries the protocol: anything else printed there would corrupt it.
  console.log = console.info = (...args: unknown[]) => console.error(...args);
  const workspace = new Workspace(cwd);
  const server = createServer(workspace);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  const shutdown = async () => {
    await workspace.close().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  await server.connect(transport);
  await closed;
  await workspace.close();
}
