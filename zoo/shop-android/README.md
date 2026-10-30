# Bug Zoo shop for Android

A small Kotlin + Jetpack Compose client of the [zoo shop](../shop/README.md): log in, products,
cart, pay, and the order's status until the payment webhook confirms it. The shop runs as it does
for the web, one copy per run; the phone reaches it at the `apiUrl` launch extra, and its debug
build allows plain HTTP to this machine. The app's state is in a ViewModel, so turning the phone
or leaving the app keeps it; the login is kept with the app's data, so a restart stays logged in.

The clean app and the clean shop pass every experiment. The cases are the shop's own bugs, caught
from the phone (`from:` points at the shop's case), and one of the phone's:

| Case | What goes wrong | Experiment | Rule it breaks |
|---|---|---|---|
| 01-double-submit | The shop: no unique order per cart. A retry after a lost answer makes a second order | `checkout-lost-response` | `one-order-per-cart` |
| 02-lost-response-retry | The shop: a retried checkout charges again | `checkout-lost-response` | `one-charge-per-order` |
| 05-oversell | The shop: stock checked before the order, taken after | `checkout-two-buyers` (two phones) | `stock-non-negative` |
| c1-stock-row-lock | The shop's control: looks like 05, isn't | every experiment passes | |
| p1-double-tap | The shop's case 01, and "Pay now" stays enabled while paying | `checkout-double-tap` | `one-order-per-cart` |

The experiments also put the phone through what phones do mid-checkout: `checkout-app-killed`,
`checkout-backgrounded`, `checkout-rotated`, `checkout-offline`. The rules are the shop's
(`.windtunnel/rules.yaml` links to them).

```sh
windtunnel devices create                       # once: the windtunnel-34 emulator (AVD)
pnpm zoo:verify:android                         # the clean app and every case, 3 runs each
pnpm wt --cwd zoo/shop-android run checkout-double-tap --patch zoo/shop-android/cases/p1-double-tap/bug.patch
pnpm wt --cwd zoo/shop-android map              # the phone's screens and the shop's routes they call
```

Runs need the Android SDK (Android Studio's), a JDK 17+ for Gradle, and Appium with its
UiAutomator2 driver (dev dependencies of this repository). The emulators run headless, from a
snapshot made on first use, and keep running between runs: `windtunnel devices stop`. The first
build downloads the Gradle libraries; later versions reuse the APK unless the app's own code
changed.
