# Wind Tunnel for Mac

A native SwiftUI app over Wind Tunnel's local API. It holds no logic of its own: it starts the
local bridge (`windtunnel view --json`) for a project and shows what the web viewer shows, in
native views, live.

```sh
pnpm mac:build          # apps/mac/build.sh: release build → apps/mac/build/Wind Tunnel.app
pnpm mac:open           # the same, then opens it
```

Needs macOS 15+ and Xcode 16+ (Swift 6.2) to build. To run it needs Node 22.18+ and the
`windtunnel` CLI, either installed (`npx windtunnel-cli install`) or this checkout: the app looks
for `windtunnel` on your login shell's PATH, then for the checkout it was built from. A path in
Settings overrides both. It finds Node 22.18+ on that PATH, in nvm's folder or in Homebrew's.

## What's in it

| | |
|---|---|
| **First run** | two screens. Choose the app's folder (or drop it on the window); then its code, read by `windtunnel scan` before anything is set up: the handlers that could leave data wrong when requests overlap, each pattern in a sentence, beside what to do next: open it, or have your agent write `windtunnel.config.yaml` (`/windtunnel:init`) while the folder is watched for it. The Mac is checked meanwhile (`windtunnel install --dry-run --json`) and speaks up only when something's missing, with **Set Up** to run the install steps it lists. A folder with no config opened any other way lands on the second screen |
| **Overview** | the project at a glance: experiments holding, and how that moved run by run; the failing ones first, with the rule each broke, what the experiment does, its recent runs, and whether it just broke or keeps breaking; the ones holding; which rules break most. A new project shows its next step instead: a hunt, or the first run |
| **Runs** | every run, grouped by batch, failures first with the rule they broke and held runs folded; filtered by outcome or name. A run opens on the answer: the rule that broke, in words, with its rows, where the run first went another way than one that held, and which tab to look at next. Then its repetitions and orderings, the rules' SQL; a **race** timeline (each tab and the webhooks on one time axis), the runs side by side step by step, the trace chain per table, database changes, requests, the app log |
| **Experiments** | each experiment, its source and history; **Run** with a repeat count, with the CLI's output live |
| **Hunt** | send an agent to break the app (below), and follow everything it runs |
| **Usage** | tokens Wind Tunnel's tools returned to the agent, its small decisions, hunt costs |
| Menu bar | what's running, the newest results, Run all |

Runs show up as they start, whoever starts them: this app, `windtunnel run`, or an agent
calling `windtunnel_run` in its own terminal. Notifications come when a run or a hunt ends while
the app is in the background.

## Hunting with Claude 5

No Meta key is needed. Two ways, both with the same hunt skill:

- **Claude Code** (your own login): *Open in Claude Code* opens your Claude Code in a new
  terminal in the app's folder with `/windtunnel:hunt <area>` typed, not sent. It runs on your
  plan when you press Enter. The app follows along: each experiment the agent runs appears
  under *Activity* and in Runs as it starts and finishes. This needs the plugin in Claude Code
  (`windtunnel install --hosts claude`).
- **Claude API** (an Anthropic API key): add a key in the Hunt page or Settings; it is kept
  in the keychain and given only to the bridge's environment. The hunt then runs in the app,
  streaming each step: `claude -p --bare` with your choice of Opus 5.5, Sonnet 5.5 or
  Haiku 5.5 and a spending cap. `--bare` means Claude Code reads only that key, never your
  Claude login. See [`docs/viewer.md`](../../docs/viewer.md#claude-code-as-a-hunt-host).

Muse Code (the Meta key) is the third host, on when the bridge is started from the Muse shell.

## How it's built

```
Sources/WindTunnel/
  App/        the app, its state (AppModel: bridge, event stream, actions), snapshot mode
  Bridge/     Toolchain (login-shell PATH, Node, the CLI), Bridge (child process, API, events), Keychain
  Model/      the API's shapes, formatting
  App/        also Setup: the first-run state (the CLI's install report, the folder inspected and watched)
  Design/     Theme (backdrop, sections, buttons, tab strip, meters), Ascii (spinner, live dot, the mark),
              Glow (a corner light: a slowly drifting mesh gradient in the hue under film grain)
  Views/      Shell (window, top bar, sidebar, welcome), SetupView (first run),
              Overview, Runs, RunDetail, Timeline, Evidence (trace, database, network, log),
              Experiments, Hunt, Usage
```

The look is quiet glass, dark or light (Settings → Appearance: System, Light or Dark): the window
shows the desktop through it, blurred and tinted. Every colour in `Theme` has a dark and a light
value, chosen by the appearance it's drawn in; on light the hue and the outcome colours go deeper
so they read. Content sits straight on it in sections split by hairlines, not boxed in cards,
with small corners. One hue, a cool blue, for the brand, for what's live and for what holds; red
and amber only where something failed or is flaky, and passing runs stay grey so failures are
what you see. SF Pro for the interface, SF Mono only for data (rules, SQL, logs). Details live in
tooltips.

No illustrations: what the screens show is the user's own project, its code on the first run and
its runs after. The one ornament is a soft light in a corner of the start and first-run screens,
a mesh gradient in the hue drifting very slowly under film grain, so it never bands or looks flat.

For working on the views:

```sh
T=40 .build/debug/WindTunnel --snapshot glow /tmp/g.png 1200 760  # render a view to PNG (glow at time T, parts, icon)
open "build/Wind Tunnel.app" --args --project <app folder> --pane runs --run <run id> --tab timeline
open "build/Wind Tunnel.app" --args --welcome --appearance light   # light, dark or system (saved as the setting)
open "build/Wind Tunnel.app" --args --setup read --folder <app folder>  # a first-run screen: app, read, or mac (the checks)
```
