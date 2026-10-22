-- ===========================================================================
-- 004 — Interview Mode removals
--
-- Two additions, both needed for the rule "leave the meeting screen twice and
-- the host's settings remove you".
--
--   1. transcripts.source gains 'system'. Interview Mode warnings and removals
--      are written into the transcript so it accounts for what HAPPENED, not
--      only for what was said. They are attributed to the participant they
--      concern, and the text is written by the SERVER — never by a client.
--
--   2. meeting_participants.removed_at. Distinct from `left_at`, which only
--      means "not here now". A removed participant may not rejoin, and
--      join_meeting refuses them while this is set. Keeping it separate means
--      an ordinary departure is never mistaken for a removal.
--
-- Run once:
--     mysql -u root -p bridgetalk < database/migrations/004_interview_removal.sql
--
-- Idempotent: the enum change is a no-op if already applied, and the column is
-- guarded through information_schema because MySQL has no
-- ADD COLUMN IF NOT EXISTS.
-- ===========================================================================

USE bridgetalk;

-- ---------------------------------------------------------------------------
-- 1. Widen the source enum. Existing rows are untouched: MODIFY only extends
--    the permitted set, and 'sign'/'speech' keep their meaning and position.
-- ---------------------------------------------------------------------------
ALTER TABLE transcripts
  MODIFY COLUMN source ENUM('sign','speech','system') NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. removed_at, guarded so the script can be re-run.
-- ---------------------------------------------------------------------------
SET @have_col := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'meeting_participants'
    AND COLUMN_NAME  = 'removed_at'
);

SET @ddl := IF(
  @have_col = 0,
  'ALTER TABLE meeting_participants ADD COLUMN removed_at DATETIME NULL AFTER left_at',
  'SELECT "meeting_participants.removed_at already exists" AS note'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 3. Verify
-- ---------------------------------------------------------------------------
SELECT COLUMN_TYPE AS transcripts_source_enum
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transcripts' AND COLUMN_NAME = 'source';

SELECT COUNT(*) AS removed_at_present
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'meeting_participants' AND COLUMN_NAME = 'removed_at';
