# Bug Zoo shop

A small online shop: Next.js (App Router) and Postgres, with a mock payment provider that
charges cards and sends payment webhooks, like a real one.

## Run it

```sh
pnpm install --ignore-workspace
node scripts/local.mjs                          # fresh database, mock payments, the app on http://127.0.0.1:3001
node scripts/local.mjs --exec "node check.mjs"  # start everything, run one command against it, stop
```

`scripts/local.mjs` builds the app, creates a database with the seed data, starts the payment
provider on the app's port + 1000 and the app, and drops the database when it stops. With
`--exec` the command gets `BASE_URL`, `DATABASE_URL` and `PAYMENT_API_URL`, and the script
exits with the command's exit code. Use `--port` (default `$PORT`, else 3001) to run more than
one copy. It needs Postgres at `$ADMIN_DATABASE_URL` (default
`postgres://postgres:postgres@127.0.0.1:55432/postgres`).

## Users

Password `test` for all of them.

| User | |
|---|---|
| `alice@example.test` | buyer |
| `bob@example.test` | buyer |
| `sam@example.test` | staff: edits products at `/admin/products` |

## Layout

| | |
|---|---|
| `app/` | pages (`/`, `/cart`, `/orders`, `/orders/[id]`, `/login`, `/admin/products`) and API routes (`app/api/…`) |
| `components/` | client components: add to cart, pay, order status, product form |
| `lib/` | database, sessions, cart and payment provider helpers |
| `db/schema.sql` | the schema; `scripts/db-setup.mjs` loads it with the seed data |
| `test/` | database constraint tests: `DATABASE_URL=… pnpm test` |

Checkout: the cart page's **Pay now** sends `POST /api/orders`, which turns the cart into an
order and charges it. The payment provider then calls `POST /api/webhooks/payment`, which
records the payment and marks the order paid. The order page polls `GET /api/orders/[id]`
until then.
