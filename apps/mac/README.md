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
| **Overview** | the project at a glance: experiments holding and failing; what needs attention, and whether it just broke or keeps breaking; which rules break most; each experiment's recent runs as a strip |
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
  Design/     Theme (backdrop, sections, buttons, tab strip, meters), Ascii (spinner, live dot,
              the mark), AsciiArt (characters drawn like a shader: air through the tunnel)
  Views/      Shell (window, top bar, sidebar, welcome), Overview, Runs, RunDetail,
              Timeline, Evidence (trace, database, network, log), Experiments, Hunt, Usage
```

The look is quiet glass: the window shows the desktop through it, blurred and tinted ink. Content
sits straight on it in sections split by hairlines, not boxed in cards, with small corners. One
hue, a cool blue, for the brand, for what's live and for what holds; red and amber only where
something failed or is flaky, and passing runs stay grey so failures are what you see. SF Pro for
the interface, SF Mono only for data (rules, SQL, logs). Details live in tooltips.

The ASCII is drawn like a shader: every cell of a monospaced grid samples a scene for a glyph
and a brightness, the field is coloured through the hue, and the brightest cells are lit white.
The one scene is a wind tunnel's test section seen from the side: smoke lines squeeze through
the narrow throat and speed up, then spread out behind it and start to waver, with puffs
travelling down each line and dust drifting between them. Flat stretches pick a low, middle or
high stroke (`_ - ¯`) for where the line crosses the cell, so curves read smooth. On the hunt
page a sensor sweeps along it. It steps at about 20 frames a second and holds still with Reduce
Motion.

For working on the views:

```sh
.build/debug/WindTunnel --snapshot tunnel /tmp/t.png 1000 640  # render a view to PNG (tunnel, probe, parts, icon)
open "build/Wind Tunnel.app" --args --project <app folder> --pane runs --run <run id> --tab timeline
open "build/Wind Tunnel.app" --args --welcome
```
