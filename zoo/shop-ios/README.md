# Bug Zoo shop for iOS

A small SwiftUI client of the [zoo shop](../shop/README.md), the same app as
[`zoo/shop-android`](../shop-android/README.md) for the iPhone: log in, products, cart, pay, and
the order's status until the payment webhook confirms it. The shop runs as it does for the web,
one copy per run; the app reads its address from the `-apiUrl` launch argument, and allows plain
HTTP to this Mac. It keeps an order history on the phone (`shop.sqlite` in Application Support),
which a push from the shop (`event: orders-changed`) brings up to date. `shop://checkout` is
where the payment page sends the user back: it checks out the open cart.

The clean app and the clean shop pass every experiment. The cases are the shop's own bugs, caught
from the iPhone (`from:` points at the shop's case), and two of the app's:

| Case | What goes wrong | Experiment | Rule it breaks |
|---|---|---|---|
| 01-double-submit | The shop: no unique order per cart. A retry after a lost answer makes a second order | `checkout-lost-response` | `one-order-per-cart` |
| 02-lost-response-retry | The shop: a retried checkout charges again | `checkout-lost-response` | `one-charge-per-order` |
| 05-oversell | The shop: stock checked before the order, taken after | `checkout-two-buyers` (two simulators) | `stock-non-negative` |
| c1-stock-row-lock | The shop's control: looks like 05, isn't | every experiment passes | |
| i1-pay-link-twice | The shop's case 01, and `pay()` counts on the disabled button, which the payment page's way back doesn't use | `checkout-link-twice` | `one-order-per-cart` |
| i2-history-refresh | A push refreshes the history: the actor reads it, waits for the shop's list, and writes back what it read, losing the order placed meanwhile | `checkout-order-push` | `history-has-every-confirmed-order` (on the phone) |

The experiments also put the phone through what phones do mid-checkout: `checkout-app-killed`,
`checkout-backgrounded`, `checkout-rotated`, `checkout-offline`, `checkout-double-tap`. The rules
are the shop's (a copy, which `zoo:verify:ios` checks against the shop's) and one on the phone's
own data, `history-has-every-confirmed-order`.

```sh
xcodebuild -downloadPlatform iOS               # once, if Xcode has no iOS simulator runtime
pnpm wt --cwd zoo/shop-ios devices create      # once: simulators windtunnel-iphone-1 and -2
pnpm zoo:verify:ios                            # the clean app and every case, 3 runs each
pnpm wt --cwd zoo/shop-ios run checkout-order-push --patch zoo/shop-ios/cases/i2-history-refresh/bug.patch
pnpm wt --cwd zoo/shop-ios map                 # the app's screens and the shop's routes they call
```

Runs need Xcode with an iOS simulator runtime, and WebDriverAgent's source (`appium-webdriveragent`,
a dev dependency of this repository), which the first run builds. The simulators boot without
Simulator.app and keep running between runs: `pnpm wt --cwd zoo/shop-ios devices stop`.
