-- Migration 0003: independent visitor identity for analytics.
-- A session (session_id) expires after 30 min of inactivity (rotated client-side);
-- a visitor (visitor_id) is the long-lived per-browser identity. Previously the
-- dashboard conflated the two by using a permanent id as the session id.
ALTER TABLE analytics_events ADD COLUMN visitor_id TEXT;
CREATE INDEX IF NOT EXISTS idx_analytics_visitor ON analytics_events(visitor_id);
