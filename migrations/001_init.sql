-- Zeep schema (private-balance model). Two assets: dollar notes (micro-USD, 1e-6 USD) and
-- ZEC notes (zatoshis). Each deposit is split between them; services are paid in dollars.
-- Nothing here can spend money or name a user:
-- no IPs, secrets, PINs, recovery phrases, balances or request bodies.
-- Users hold shielded notes; the server sees note commitments, nullifiers and the
-- public cost of each spend, never who spent or what is left.

-- Which network this database belongs to ('testnet' / 'mainnet'). Stamped on the first
-- migrate; every process refuses to start if it doesn't match ZEEP_ENV.
CREATE TABLE meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Note trees: 2^20 leaves each; when one fills, the next opens. Closed trees keep
-- their final root so old notes stay spendable forever.
CREATE TABLE trees (
  id          SERIAL PRIMARY KEY,
  size        INT NOT NULL DEFAULT 0,
  final_root  NUMERIC(78,0),                   -- set when the tree is closed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ
);

CREATE TABLE notes (
  tree_id     INT NOT NULL REFERENCES trees(id),
  leaf_index  INT NOT NULL,
  commitment  NUMERIC(78,0) NOT NULL,          -- Poseidon(d, amount, asset): 0 micro-USD, 1 zats
  enc         TEXT,                            -- client-encrypted note backup (only its owner can read it)
  created_at  DATE NOT NULL DEFAULT CURRENT_DATE,  -- day only: can't be matched to a request's time
  PRIMARY KEY (tree_id, leaf_index)
);

CREATE TABLE roots (
  tree_id     INT NOT NULL REFERENCES trees(id),
  root        NUMERIC(78,0) NOT NULL,
  leaf_count  INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tree_id, root)
);
CREATE INDEX roots_recent_idx ON roots (tree_id, created_at DESC);
CREATE INDEX roots_root_idx ON roots (root);

-- Spent notes. Kept forever: a nullifier must never be accepted twice.
CREATE TABLE nullifiers (
  nullifier   NUMERIC(78,0) PRIMARY KEY,
  created_at  DATE NOT NULL DEFAULT CURRENT_DATE   -- day only, no timestamp
);

-- Deposits: each intent gets a fresh diversified address from the receive account, so
-- any wallet can pay any amount without a memo.
CREATE TABLE deposit_addresses (
  diversifier_index  BIGINT PRIMARY KEY,
  address            TEXT NOT NULL UNIQUE,
  intent_id          TEXT UNIQUE,                -- NULL while free
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE deposit_intents (
  id             TEXT PRIMARY KEY,                -- 64 hex, derived from the user's seed; bearer secret
  d              NUMERIC(78,0) NOT NULL,          -- dollar note owner tag Poseidon(pk, rho_usd)
  d_zec          NUMERIC(78,0) NOT NULL,          -- ZEC note owner tag Poseidon(pk, rho_zec)
  address        TEXT NOT NULL UNIQUE,
  expected_zats  BIGINT,                          -- what the user typed (display only)
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'credited', 'expired')),
  tree_id        INT,                             -- both notes land in the same tree
  leaf_index     INT,                             -- the dollar note
  zec_leaf_index INT,                             -- the ZEC note
  amount_zats    BIGINT,                          -- ZEC received
  zec_kept_zats  BIGINT,                          -- the ZEC note (ZEC_SHARE_BPS of it)
  converted_zats BIGINT,                          -- the rest, converted to dollars
  zec_usd        NUMERIC(18,6),                   -- price used to credit it
  value_micro_usd BIGINT,                         -- value of converted_zats before fees
  fee_micro_usd  BIGINT,                          -- conversion fee on converted_zats
  rebate_micro_usd BIGINT NOT NULL DEFAULT 0,     -- first deposit of the day: network fee back
  credited_micro_usd BIGINT,                      -- dollar note = value − fee + rebate
  rebate_eligible BOOLEAN NOT NULL DEFAULT false,  -- first deposit of the day (daily tag proof)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE deposits (
  id            BIGSERIAL PRIMARY KEY,
  txid_hash     TEXT NOT NULL UNIQUE,            -- SHA-256(txid:output_index)
  intent_id     TEXT NOT NULL REFERENCES deposit_intents(id),
  amount_zats   BIGINT NOT NULL,
  block_height  INT NOT NULL,
  -- confirmed: waiting for the activator; credited: became the intent's note;
  -- unclaimed: arrived after the intent was credited, claimable with a new intent
  status        TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'credited', 'unclaimed', 'claimed')),
  claimed_by    TEXT REFERENCES deposit_intents(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deposits_pending_idx ON deposits (created_at) WHERE status = 'confirmed';

-- Unconfirmed sightings so the UI can show "confirming (1/3)".
CREATE TABLE deposit_sightings (
  intent_id      TEXT NOT NULL REFERENCES deposit_intents(id),
  txid_hash      TEXT NOT NULL,
  amount_zats    BIGINT NOT NULL,
  confirmations  INT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (intent_id, txid_hash)
);

CREATE TABLE withdrawals (
  id               UUID PRIMARY KEY,               -- chosen by the client, bound into the proof
  zec_zats         BIGINT NOT NULL DEFAULT 0,      -- taken from the user's ZEC notes (paid as is)
  gross_micro_usd  BIGINT NOT NULL DEFAULT 0,      -- taken from the user's dollar notes
  fee_micro_usd    BIGINT NOT NULL DEFAULT 0,      -- conversion fee on the dollars
  convert_micro_usd BIGINT NOT NULL DEFAULT 0,     -- dollars converted back to ZEC (0: ZEC only)
  network_fee_zats BIGINT NOT NULL DEFAULT 0,      -- payout network fees charged to the user
  network_fee_paid_by TEXT NOT NULL DEFAULT 'user' CHECK (network_fee_paid_by IN ('user', 'zeep')),
  zec_received     BIGINT,                         -- ZEC the dollar conversion produced (shielded on arrival)
  transparent      BOOLEAN NOT NULL DEFAULT false, -- payout to a t-address (amount + recipient public)
  payout_addr_enc  TEXT,                           -- AES-256-GCM; NULLed once both tranches confirm
  status           TEXT NOT NULL DEFAULT 'converting' CHECK (status IN ('converting', 'scheduled', 'paying', 'done', 'failed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbound sends from the reserve wallet: withdrawal tranches and ZEC → Tempo conversions.
CREATE TABLE payouts (
  id             BIGSERIAL PRIMARY KEY,
  kind           TEXT NOT NULL DEFAULT 'withdrawal' CHECK (kind IN ('withdrawal', 'conversion')),
  withdrawal_id  UUID REFERENCES withdrawals(id),
  tranche        SMALLINT CHECK (tranche IN (1, 2)),
  dest_address   TEXT,                             -- conversions only (public NEAR Intents deposit address)
  amount_zats    BIGINT NOT NULL CHECK (amount_zats > 0),
  scheduled_at   TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('scheduled', 'sending', 'sent', 'confirmed', 'failed', 'stuck')),
  txid           TEXT,
  attempts       INT NOT NULL DEFAULT 0,
  last_error     TEXT,
  sent_at        TIMESTAMPTZ,
  confirmed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (withdrawal_id, tranche)
);
CREATE INDEX payouts_due_idx ON payouts (scheduled_at) WHERE status = 'scheduled';

-- ZEC <-> USDC.e (Tempo) conversions for the MPP float.
--   to_tempo: ZEC (reserve) -> NEAR Intents -> USDC on Base -> Relay -> USDC.e on Tempo
--   to_zec:   USDC.e on Tempo -> Relay -> USDC on Base -> NEAR Intents -> ZEC (reserve t-addr, then shielded)
CREATE TABLE conversions (
  id               BIGSERIAL PRIMARY KEY,
  direction        TEXT NOT NULL CHECK (direction IN ('to_tempo', 'to_zec')),
  reason           TEXT NOT NULL,                  -- surplus (dollar half of deposits, refills) | withdrawal
  step             TEXT NOT NULL,                  -- see src/treasury/float.ts (*_starting / paying_base: money in flight)
  zec_zats         BIGINT,                         -- ZEC sent (to_tempo) or received (to_zec)
  usdc_units       BIGINT,                         -- USDC (6 dp) received (to_tempo) or sent (to_zec)
  usdc_out         BIGINT,                         -- USDC the Relay bridge delivers (exact input minus its fee)
  zec_usd          NUMERIC(18,6) NOT NULL,         -- price when started
  oneclick_deposit TEXT,
  payout_id        BIGINT REFERENCES payouts(id),
  withdrawal_id    UUID REFERENCES withdrawals(id), -- to_zec for one withdrawal
  relay_request    TEXT,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conversions_open_idx ON conversions (direction) WHERE step NOT IN ('done', 'failed');

-- Treasury float state (single row), refreshed by the treasury worker.
CREATE TABLE float_state (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tempo_usdc      BIGINT NOT NULL DEFAULT 0,       -- USDC.e on Tempo (6 dp)
  base_usdc       BIGINT NOT NULL DEFAULT 0,       -- USDC on Base, in transit
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO float_state (id) VALUES (1);

-- One tag per user per day per purpose (1 withdrawal, 2 deposit rebate). Tags are
-- Poseidon(sk, day, purpose): unlinkable across days, so this only enforces "first one free".
CREATE TABLE daily_tags (
  day      INT NOT NULL,
  purpose  SMALLINT NOT NULL,
  tag      NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (day, purpose, tag)
);

-- The books, as daily totals only (never one row per request).
-- Units are micro-USD except the zec_* and *_zats kinds (zatoshis).
--   dollars owed = deposit + usd_from_zec + compensation − service − withdrawal
--   ZEC owed     = zec_deposit − zec_to_usd − zec_withdrawal
--   profit = margin + conversion_fee + network_fee − subsidy − conversion_cost
CREATE TABLE books_daily (
  day     DATE NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('deposit', 'service', 'compensation', 'withdrawal', 'usd_from_zec',
                                        'zec_deposit', 'zec_withdrawal', 'zec_to_usd',
                                        'margin', 'conversion_fee', 'network_fee', 'subsidy', 'conversion_cost',
                                        'to_tempo_zats', 'to_zec_zats')),
  amount  NUMERIC(30,0) NOT NULL DEFAULT 0,
  count   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

CREATE TABLE upstream_daily (
  day       DATE NOT NULL,
  service   TEXT NOT NULL,
  calls     INT NOT NULL DEFAULT 0,
  cost_usd  NUMERIC(18,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (day, service)
);

CREATE TABLE inboxes (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  provider_ref  TEXT NOT NULL,
  address       TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL
);

-- Encrypted per-user storage (chat history, settings, inbox ids) for multi-device restore.
-- vault_id and the auth hash come from the user's seed; blobs are encrypted client-side.
CREATE TABLE vaults (
  id          TEXT PRIMARY KEY,                    -- 64 hex
  auth_hash   TEXT NOT NULL,                       -- SHA-256 of the client's vault auth token
  created_at  DATE NOT NULL DEFAULT CURRENT_DATE
);
CREATE TABLE vault_items (
  vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL,
  blob        TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,                         -- set when the user turns on 30-day auto-delete
  PRIMARY KEY (vault_id, item_id)
);
CREATE INDEX vault_items_expiry_idx ON vault_items (expires_at) WHERE expires_at IS NOT NULL;

-- Light client (CHAIN_BACKEND=lightclient): the reserve wallet's SQLite file, saved by the
-- wallet dyno after every change and restored on boot. Holds no keys (the seed is a config
-- var), but does hold the reserve's transaction history: treat it as private.
CREATE TABLE wallet_store (
  network         TEXT PRIMARY KEY,               -- 'testnet' / 'mainnet'
  data            BYTEA NOT NULL,
  scanned_height  INT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_state (
  id                     SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  chain_height           INT,
  scanned_height         INT,
  reserve_balance_zats   BIGINT,
  reserve_spendable_zats BIGINT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO wallet_state (id) VALUES (1);

-- Dev chain backend only (CHAIN_BACKEND=dev).
CREATE TABLE dev_incoming (
  txid          TEXT NOT NULL,
  output_index  INT NOT NULL DEFAULT 0,
  to_address    TEXT NOT NULL,
  height        INT NOT NULL,
  amount_zats   BIGINT NOT NULL,
  PRIMARY KEY (txid, output_index)
);
-- Dev / mock rails: simulated Tempo float (USDC 6 dp).
CREATE TABLE dev_rails (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tempo_usdc  BIGINT NOT NULL DEFAULT 0
);
INSERT INTO dev_rails (id) VALUES (1);
CREATE TABLE dev_outgoing (
  txid         TEXT PRIMARY KEY,
  to_address   TEXT NOT NULL,
  amount_zats  BIGINT NOT NULL,
  height       INT NOT NULL
);
