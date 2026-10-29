# Wind Tunnel

Real-world failure experiments for web apps, run by the coding agent you already use (Muse
Code, Claude Code or Codex): double clicks, lost responses, duplicate webhooks and races,
against your real backend and database. The agent finds the bug, writes the experiment that
reproduces it, and proves its fix.

```sh
npx windtunnel-cli install
```

sets up the agents it finds on this computer and checks Docker, Postgres and the Playwright
browser. Then, in your app's folder, ask your agent for `/windtunnel:init` (Claude Code, Codex)
or the `windtunnel-init` skill (Muse Code).

Needs Node 22.18 or newer, git, and Postgres (Docker is the easy way). Next.js + Postgres apps
for now. Documentation: https://github.com/Divyendra-S/msa
