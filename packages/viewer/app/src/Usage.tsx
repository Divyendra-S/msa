import { useState } from "react";
import type { Status, Usage } from "./api.ts";
import { ago, kilo, usd } from "./util.ts";

/** What Wind Tunnel added to the agent's context and what its Level 1 decisions cost, per job. */
export function UsageMeter({ usage, status }: { usage: Usage; status: Status }) {
  const [open, setOpen] = useState(false);
  const job = usage.jobs[0];
  const { budget } = usage;
  const share = job ? Math.min(1, job.tokens / budget.tokens) : 0;
  const spend = job ? Math.min(1, job.usd / Math.max(budget.usd, 1e-9)) : 0;
  return (
    <div className="usage">
      <button type="button" className="meter" onClick={() => setOpen(!open)} aria-expanded={open} title="Tool output added to the agent's context in the latest job, against the budget">
        <span className="meter-label">{job ? `${kilo(job.tokens)} / ${kilo(budget.tokens)} tokens` : "no usage yet"}</span>
        <span className="meter-track">
          <span className={`meter-fill ${share > 0.9 ? "bad" : share > 0.6 ? "warn" : ""}`} style={{ width: `${share * 100}%` }} />
        </span>
        {job && (job.usd > 0 || job.decisions.spark + job.decisions.jev > 0) && (
          <span className="meter-usd" title="Level 1 decisions (Muse Spark or Jev), against the budget">
            {usd(job.usd)} / {usd(budget.usd)}
            <span className="meter-track thin">
              <span className={`meter-fill ${spend > 0.9 ? "bad" : ""}`} style={{ width: `${spend * 100}%` }} />
            </span>
          </span>
        )}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Usage by job">
          <p className="small">
            Per job (one agent session with the MCP server, a hunt, or a day of CLI use). Tokens are tool output Wind Tunnel returned to the agent, estimated at 4
            characters each; Level 1 is <b>{status.decider}</b>.
          </p>
          <table className="rows">
            <thead>
              <tr>
                <th>job</th>
                <th>tool outputs</th>
                <th>tokens</th>
                <th>largest</th>
                <th>decisions</th>
                <th>Level 1</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {usage.jobs.map((j) => (
                <tr key={j.job}>
                  <td className="mono">{j.job}</td>
                  <td>{j.toolCalls}</td>
                  <td className={j.tokens > budget.tokens ? "bad-text" : ""}>{kilo(j.tokens)}</td>
                  <td>{kilo(j.maxTokens)}</td>
                  <td className="small">
                    {[
                      j.decisions.rules && `${j.decisions.rules} rules`,
                      j.decisions.spark && `${j.decisions.spark} Spark`,
                      j.decisions.jev && `${j.decisions.jev} Jev`,
                      j.decisions.agent && `${j.decisions.agent} agent`,
                    ]
                      .filter(Boolean)
                      .join(", ") || "–"}
                  </td>
                  <td>{j.usd ? usd(j.usd) : "–"}</td>
                  <td className="muted small">{ago(j.last)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
