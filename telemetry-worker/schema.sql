-- One row per accepted event. No IP address, no headers: neither is stored (the Worker hashes the address in memory
-- for its per-sender rate limit, and keeps nothing of it).
CREATE TABLE IF NOT EXISTS events (
  received_at INTEGER NOT NULL,   -- server time, ms since epoch
  day         TEXT    NOT NULL,   -- server day, YYYY-MM-DD (UTC)
  event       TEXT    NOT NULL,   -- start | crash | exit | call_failed | slow_call
  install_id  TEXT    NOT NULL,   -- random UUID made on the user's machine
  version     TEXT    NOT NULL,
  os          TEXT    NOT NULL,
  tool        TEXT,
  action      TEXT,
  code        TEXT,
  data        TEXT    NOT NULL    -- the event's other validated fields, as JSON
);
CREATE INDEX IF NOT EXISTS events_day ON events (day);
CREATE INDEX IF NOT EXISTS events_event_code ON events (event, code);

-- One row per UTC day: how many events were offered that day (stored or refused). The Worker refuses a batch, with 429,
-- that takes the day past DAILY_EVENT_CAP (wrangler.toml), so a flood cannot fill D1. Rows older than 90 days are deleted
-- with the events.
CREATE TABLE IF NOT EXISTS daily_counts (
  day     TEXT    PRIMARY KEY,    -- server day, YYYY-MM-DD (UTC)
  events  INTEGER NOT NULL        -- events counted against the cap that day
);
