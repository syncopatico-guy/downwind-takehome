-- Record which effort level each question was routed to.
--
-- Without this the routing is unfalsifiable: the whole point is that most
-- questions are cheap lookups and routing them down saves most of the budget,
-- and that claim needs the spend broken out by level to hold up.
ALTER TABLE ask_log ADD COLUMN IF NOT EXISTS effort text;
ALTER TABLE ask_log ADD COLUMN IF NOT EXISTS effort_reason text;
