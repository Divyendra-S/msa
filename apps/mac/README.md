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
| **Overview** | the project at a glance: experiments holding, failing and flaky; what needs attention; which rules break most; every batch of runs over time |
| **Runs** | every run, grouped by batch, filtered by outcome or name; a run's repetitions and orderings, the first divergence from a passing run, the broken rules with their SQL and rows; a **race** timeline (each tab and the webhooks on one time axis), the runs side by side step by step, the trace chain per table, database changes, requests, the app log |
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
  Design/     Theme (the glass backdrop, cards, capsule buttons, segmented control, meters),
              Ascii (spinner, scramble text, live dot, the mark), AsciiArt (characters drawn
              like a shader: the orb in its stream of air, the radar)
  Views/      Shell (window, header, sidebar, status line, welcome), Overview, Runs, RunDetail,
              Timeline, Evidence (trace, database, network, log), Experiments, Hunt, Usage
```

The look is dark glass: the window shows the desktop through it, blurred and tinted ink, with a
faint wash of lavender and aqua; content sits on it in translucent cards with lit hairline edges.
SF Pro for the interface, SF Mono only for data (rules, SQL, logs). On macOS 26 the sidebar and
the floating controls are Liquid Glass.

The ASCII is drawn like a shader: every cell of a monospaced grid samples a scene for a glyph
and a brightness, a gradient colours the field, and the brightest cells are lit white. The orb is
a sphere shaded with ordered dithering, turning slowly, with smoke lines of potential flow bending
round it and rolling up into a vortex street behind; the hunt page has a radar whose afterglow is
dithered dots. It steps at about 20 frames a second and holds still with Reduce Motion.

For working on the views:

```sh
.build/debug/WindTunnel --snapshot orb /tmp/orb.png 1000 640   # render a view to PNG (orb, scan, parts, icon)
open "build/Wind Tunnel.app" --args --project <app folder> --pane runs --run <run id> --tab timeline
open "build/Wind Tunnel.app" --args --welcome
```
