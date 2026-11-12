-- One row per accepted event. No IP address, no headers: the Worker never reads them.
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
