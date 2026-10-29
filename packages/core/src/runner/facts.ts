import type { TestUser } from "../flow-api.ts";
import type { PageFact, RequestFact, RunFacts } from "../rules.ts";
import type { RequestRecord } from "./network.ts";
import type { StepRecord } from "./rep.ts";

/** A run's requests and what its pages said, as rows for `windtunnel_requests` and `windtunnel_pages`. */
export function runFacts(requests: RequestRecord[], steps: StepRecord[], users: Record<string, TestUser>): RunFacts {
  const person = (name: string | undefined) => ({ user_name: name ?? null, user_email: (name && users[name]?.email) || null });
  // The user a tab ran as during a step: its own, unless the flow logged in as someone else.
  const userAt = (tab: string, step: string | undefined, at: number) => {
    const record = steps.findLast((s) => s.tab === tab && s.step === step && s.start <= at) ?? steps.findLast((s) => s.tab === tab && s.start <= at);
    return record?.as ?? tab.split("#")[0];
  };

  const requestRows = requests.map((r): RequestFact => {
    const [path = r.url, query] = r.url.split("?", 2);
    return {
      id: r.id,
      tab: r.tab,
      ...person(r.user ?? userAt(r.tab, r.step, r.start)),
      step: r.step ?? null,
      method: r.method,
      path,
      query: query ?? null,
      status: r.status ?? null,
      failure: r.failure ?? null,
      reached_app: r.sent !== null,
      at_ms: Math.round(r.start),
      harness: r.harness?.length ? r.harness.join("; ") : null,
    };
  });

  const pageRows = steps.flatMap((s): PageFact[] =>
    s.seen
      ? [
          {
            tab: s.tab,
            ...person(s.as ?? s.tab.split("#")[0]),
            step: s.step,
            attempt: s.attempt ?? null,
            at_ms: Math.round(s.end),
            path: s.seen.path.split("?")[0]!,
            text: s.seen.text,
          },
        ]
      : [],
  );
  return { requests: requestRows, pages: pageRows };
}
