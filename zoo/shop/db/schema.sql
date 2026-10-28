CREATE TABLE users (
  id            serial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL
);

CREATE TABLE sessions (
  id         text PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE products (
  id          serial PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents > 0),
  stock       integer NOT NULL,
  version     integer NOT NULL DEFAULT 1
);

CREATE TABLE carts (
  id         serial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users (id),
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A user has at most one open cart.
CREATE UNIQUE INDEX carts_one_open_per_user ON carts (user_id) WHERE status = 'open';

CREATE TABLE cart_items (
  cart_id    integer NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products (id),
  quantity   integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE orders (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users (id),
  cart_id     integer NOT NULL UNIQUE REFERENCES carts (id),
  total_cents integer NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'paid', 'failed')),
  charge_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  paid_at     timestamptz
);

CREATE TABLE order_items (
  order_id         integer NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id       integer NOT NULL REFERENCES products (id),
  quantity         integer NOT NULL,
  unit_price_cents integer NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE payments (
  id           serial PRIMARY KEY,
  order_id     integer NOT NULL REFERENCES orders (id),
  charge_id    text NOT NULL,
  amount_cents integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Payment provider events already handled (webhooks can arrive more than once).
CREATE TABLE webhook_events (
  id          text PRIMARY KEY,
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
