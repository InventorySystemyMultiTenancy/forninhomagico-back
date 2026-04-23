CREATE TABLE IF NOT EXISTS flavors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  slices_total INTEGER NOT NULL CHECK (slices_total >= 0),
  slices_available INTEGER NOT NULL CHECK (slices_available >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS costs (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  cadence TEXT NOT NULL DEFAULT 'monthly',
  category TEXT NOT NULL DEFAULT 'operational',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_code CHAR(3),
  customer_name TEXT,
  payment_method TEXT NOT NULL DEFAULT 'point',
  status TEXT NOT NULL,
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMP,
  payment_intent_id TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  flavor_id INTEGER NOT NULL REFERENCES flavors(id) ON DELETE RESTRICT,
  qty INTEGER NOT NULL CHECK (qty > 0),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0)
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_ref TEXT,
  receipt_code CHAR(3),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
