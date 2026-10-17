-- Queue index redesign, found with EXPLAIN on the worker's claim query.
--
-- Before: WHERE status IN ('pending','retrying') AND next_attempt_at <= ?
--         ORDER BY priority DESC, next_attempt_at ... FOR UPDATE SKIP LOCKED
--   EXPLAIN: type=index (full index scan) + "Using filesort". With FOR UPDATE, InnoDB locks
--   every row it reads before sorting, so one worker could lock the whole backlog and the
--   others would skip all of it: parallel workers stop helping.
--
-- After: next_attempt_at is NULL whenever no attempt is scheduled (sending, delivered,
-- failed, dead). The worker claims per priority:
--         WHERE priority = ? AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?
--   EXPLAIN: type=range on idx_due, no filesort. Rows come out of the index already in
--   order, and only the claimed batch is locked. Finished rows (NULL) are never scanned.

ALTER TABLE deliveries
  MODIFY next_attempt_at DATETIME(3) NULL,
  DROP INDEX idx_due,
  ADD INDEX idx_due (priority, next_attempt_at);

UPDATE deliveries SET next_attempt_at = NULL WHERE status NOT IN ('pending', 'retrying');
