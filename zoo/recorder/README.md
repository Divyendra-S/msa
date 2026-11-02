# Recorder (Bug Zoo)

A Swift package that copies a screen recorder's pipeline without any UI:

- A fake capture device delivers frames on its own dispatch queue.
- The `Recorder` actor appends each frame to a take, and Stop finishes the take.
- A `TakeWriter` writes the take: frames, then an index that counts them. A take is a `.partial`
  file until it is finished.
- An `Exporter` converts a take to a preset (`full` or `half`), passing each frame to an encoder
  through a scratch file.

Wind Tunnel tests it with `app.kind: mac`. Its probe points
([`swift/WindTunnelProbe`](../../swift/WindTunnelProbe/README.md)) are where a run steps in:

- `frame.compress`: before a frame is compressed.
- `writer.finish`: a section around finishing a take.
- `export.encode`: before the encoder reads a frame back.

The scenarios are XCTest methods in `Tests/RecorderScenarios`:

- `testRecordAndStop`: start, record frames from the capture queue, press Stop while frames are
  still coming in.
- `testTwoExports`: record a short take, then export it at both presets at once.

## Rules

`.windtunnel/rules.yaml`. The `check:` rules read the run's folder with `checks/takes.mjs`.

| Rule | Breaks when |
|---|---|
| `takes-are-whole` | A take or export doesn't open: a cut-short frame, an index that miscounts, bytes after the end |
| `no-open-takes` | A `.partial` file is left: a take that was never finished |
| `exports-match-their-take` | An export's frames aren't its take's frames converted at its preset |
| `no-data-races` | ThreadSanitizer reports a data race (`sanitizer: thread`) |

## Experiments

| Experiment | Pressure |
|---|---|
| `record-and-stop` | None: the scenario as a user would run it. With ThreadSanitizer, this is where races show |
| `stop-while-compressing` | The first frame takes 300 ms to compress; Stop is pressed meanwhile |
| `cancel-while-saving` | The task that pressed Stop is cancelled as it starts to finish the take |
| `compress-fails` | The first frame fails to compress |
| `two-exports-at-once` | Both exports are held as they hand their first frame to the encoder, then released in every order |

## Cases

Each case is a `bug.patch` on this clean recorder:

| Case | Bug | Breaks |
|---|---|---|
| `01-stop-while-compressing` | The writer writes a frame's header, then awaits compression. Stop finishes the take in that gap | `takes-are-whole` |
| `02-shared-export-file` | Every export passes its frames to the encoder through one `export.scratch` | `exports-match-their-take` |
| `03-cancel-while-saving` | Finishing waits in the cancelled task, throws, and never indexes or closes the take | `no-open-takes` |
| `04-unlocked-capture-count` | The capture queue counts frames without the lock the recorder reads them under | `no-data-races` |

Case 04 needs ThreadSanitizer. On macOS 26.4 and later that means Xcode 26.4 or newer; where
ThreadSanitizer can't run, `pnpm zoo:verify:mac` says so, skips case 04, and runs the rest
without it.

```sh
pnpm zoo:verify:mac                        # from the repo root
cd zoo/recorder && windtunnel run          # every experiment on the working tree
swift build --build-tests && swift test    # the scenarios as plain tests, with no run around them
```
