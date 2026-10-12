-- ===========================================================================
-- 003 — one attendance row per (meeting, user)
--
-- THE BUG THIS FIXES
-- ------------------
-- `meeting_participants` was an append-only log: every `POST /join` inserted a
-- new row, so a participant who reconnected appeared several times. The
-- participant count shown on Home and History was `len(participants)` — a ROW
-- count, not a count of people. On the development database that was 207 rows
-- for 72 distinct (meeting, user) pairs, including one meeting showing
-- seventeen participants for a single user.
--
-- WHAT IS LOST, STATED PLAINLY
-- ----------------------------
-- The original design was deliberate: a log keeps the history of
-- disconnections. Collapsing to one row per person discards how MANY times
-- someone reconnected. That is the trade this migration makes, and the
-- information was never shown anywhere — while the wrong count was shown in
-- four places.
--
-- What is KEPT for each person: their EARLIEST joined_at, and a left_at that is
-- NULL if any of their rows was still open (they are present) or the LATEST
-- left_at otherwise (the last time they left).
--
-- Run it once:
--     mysql -u root -p bridgetalk < database/migrations/003_unique_participant.sql
--
-- Idempotent: re-running it merges nothing and skips the index if it exists.
-- ===========================================================================

USE bridgetalk;

-- ---------------------------------------------------------------------------
-- 1. Merge the surviving row's timestamps BEFORE deleting its duplicates.
-- ---------------------------------------------------------------------------
-- A derived table is used rather than correlating directly on
-- meeting_participants, because MySQL refuses to UPDATE a table while selecting
-- from it in a subquery ("You can't specify target table ... for update").
UPDATE meeting_participants AS target
JOIN (
  SELECT
    meeting_id,
    user_id,
    MIN(id)        AS keep_id,
    MIN(joined_at) AS first_joined,
    -- NULL if ANY row is still open: the person is in the meeting now, and
    -- the merged row must say so. Otherwise the latest departure.
    CASE WHEN SUM(left_at IS NULL) > 0 THEN NULL ELSE MAX(left_at) END AS merged_left
  FROM meeting_participants
  GROUP BY meeting_id, user_id
) AS merged
  ON target.id = merged.keep_id
SET target.joined_at = merged.first_joined,
    target.left_at   = merged.merged_left;

-- ---------------------------------------------------------------------------
-- 2. Delete every row that is not the survivor for its (meeting, user).
-- ---------------------------------------------------------------------------
DELETE target
FROM meeting_participants AS target
JOIN (
  SELECT meeting_id, user_id, MIN(id) AS keep_id
  FROM meeting_participants
  GROUP BY meeting_id, user_id
) AS survivors
  ON target.meeting_id = survivors.meeting_id
 AND target.user_id    = survivors.user_id
WHERE target.id <> survivors.keep_id;

-- ---------------------------------------------------------------------------
-- 3. Add the UNIQUE constraint, so the duplicates cannot come back.
-- ---------------------------------------------------------------------------
-- The application upserts on join, but the constraint is the real guarantee:
-- an application-level check alone loses a race between two simultaneous
-- joins from the same user (two tabs, or a retry).
--
-- MySQL has no `ADD UNIQUE KEY IF NOT EXISTS`, so this is guarded by checking
-- information_schema and running the DDL through a prepared statement. That
-- keeps the script re-runnable.
SET @exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'meeting_participants'
    AND INDEX_NAME   = 'uq_participant_meeting_user'
);

SET @ddl := IF(
  @exists = 0,
  'ALTER TABLE meeting_participants
     ADD UNIQUE KEY uq_participant_meeting_user (meeting_id, user_id)',
  'SELECT "uq_participant_meeting_user already exists" AS note'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 4. Verify
-- ---------------------------------------------------------------------------
SELECT
  COUNT(*)                                         AS total_rows,
  COUNT(DISTINCT meeting_id, user_id)               AS distinct_pairs,
  COUNT(*) - COUNT(DISTINCT meeting_id, user_id)    AS duplicates_remaining
FROM meeting_participants;
