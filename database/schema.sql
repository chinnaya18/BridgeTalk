-- ===========================================================================
-- BridgeTalk — database schema (MySQL 8.x / 9.x)
--
-- Run it from a terminal:
--     mysql -u root -p < database/schema.sql
--
-- Or in MySQL Workbench:
--     File → Open SQL Script… → pick this file → click the lightning bolt.
--
-- This script is idempotent: every statement uses IF NOT EXISTS, so running it
-- twice is harmless and never destroys data.
--
-- NOTE: this file is the authoritative, human-readable schema. The SQLAlchemy
-- models in backend/app/models/ mirror it exactly. If you change one, change
-- the other — backend/tests/test_schema_parity.py fails if they drift.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Database and application user
-- ---------------------------------------------------------------------------
-- utf8mb4 is the real Unicode character set in MySQL. The older `utf8` alias
-- stores at most 3 bytes per character and cannot hold emoji or many
-- non-Latin scripts — a genuine problem for a multilingual accessibility tool.
CREATE DATABASE IF NOT EXISTS bridgetalk
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

-- A dedicated least-privilege user. The application never connects as root:
-- if the API were ever compromised, the blast radius is this one database
-- rather than the whole MySQL server.
--
-- Replace 'CHANGE_ME' with a real password, then put the SAME password in
-- DATABASE_URL inside .env (which is gitignored).
CREATE USER IF NOT EXISTS 'bridgetalk'@'localhost' IDENTIFIED BY 'CHANGE_ME';
GRANT SELECT, INSERT, UPDATE, DELETE ON bridgetalk.* TO 'bridgetalk'@'localhost';
FLUSH PRIVILEGES;

USE bridgetalk;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(120)  NOT NULL,
  email         VARCHAR(255)  NOT NULL,
  -- A bcrypt hash, never a password. 60 chars today; sized for a future
  -- switch to argon2 without a migration.
  password_hash VARCHAR(255)  NOT NULL,
  -- Selects which side of the meeting UI the user gets. It is a UI hint, not
  -- a permission boundary — both roles may use both translation directions.
  role          ENUM('deaf','hearing') NOT NULL DEFAULT 'hearing',
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- The UNIQUE constraint is the real guarantee that two accounts cannot
  -- share an email. An application-level check alone loses to a race between
  -- two simultaneous registrations.
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- meetings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meetings (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  -- Short, human-typable join code, e.g. 'K7Q-2M4'. Every join looks a
  -- meeting up by this column, never by id, so it is indexed and unique.
  code              VARCHAR(16)  NOT NULL,
  title             VARCHAR(200) NOT NULL,
  host_id           INT          NOT NULL,
  is_interview_mode BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Interview mode can be switched on during a meeting, not only chosen at
  -- creation. A focus event from before this timestamp is not a violation.
  interview_mode_started_at DATETIME NULL,
  -- Set when the first participant joins, not at creation time: a meeting
  -- created on Monday for Friday must not report a Monday start.
  started_at        DATETIME     NULL,
  -- NULL while the meeting is live. This is exactly the filter the history
  -- endpoint uses to separate active meetings from finished ones.
  ended_at          DATETIME     NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_meetings_code (code),
  KEY ix_meetings_host (host_id),

  -- ON DELETE CASCADE: deleting a user removes the meetings they hosted,
  -- rather than leaving rows pointing at a user id that no longer exists.
  CONSTRAINT fk_meetings_host
    FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- meeting_participants
-- ---------------------------------------------------------------------------
-- ONE ROW PER (meeting, user). This was an append-only log, so a participant
-- who reconnected appeared several times — and the participant count shown on
-- Home and History was a ROW count, not a count of people. On the development
-- database that was 207 rows for 72 distinct pairs, including a meeting showing
-- seventeen participants for one user.
--
-- The trade is stated plainly: collapsing to one row discards HOW MANY times
-- someone reconnected. That was never displayed anywhere, while the wrong count
-- was displayed in four places. `joined_at` keeps the earliest arrival and
-- `left_at` is NULL while they are present.
--
-- See database/migrations/003_unique_participant.sql for the merge applied to
-- existing data.
CREATE TABLE IF NOT EXISTS meeting_participants (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  meeting_id INT      NOT NULL,
  user_id    INT      NOT NULL,
  joined_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at    DATETIME NULL,
  -- Set when the host's Interview Mode rules remove somebody. Distinct from
  -- `left_at`, which merely means "not here now": a removed participant may
  -- NOT rejoin, and the join endpoint refuses them while this is set.
  removed_at DATETIME NULL,

  KEY ix_participants_meeting (meeting_id),
  KEY ix_participants_user (user_id),
  -- "Is this user currently in this meeting?" filters on both columns at
  -- once, so a composite index serves it in one lookup.
  KEY ix_participant_meeting_user (meeting_id, user_id),
  -- UNIQUE, not an ordinary index. The application upserts on join, but this
  -- is the real guarantee: an application-level check alone loses a race
  -- between two simultaneous joins from the same user (two tabs, or a retry).
  UNIQUE KEY uq_participant_meeting_user (meeting_id, user_id),

  CONSTRAINT fk_participants_meeting
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_participants_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- transcripts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transcripts (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  meeting_id INT   NOT NULL,
  user_id    INT   NOT NULL,
  -- One utterance, one row. The producing client generates this and keeps it
  -- stable for the whole utterance, so the UNIQUE index below makes a
  -- duplicate write impossible rather than merely unlikely.
  --
  -- Captions used to be broadcast carrying the whole ACCUMULATED sentence,
  -- with one row per emitted word, so a three-word utterance stored three rows
  -- reading "a", "a b", "a b c". This column is what stopped that.
  segment_id VARCHAR(64) NULL,
  -- Which of the two translation directions produced this line. Keeping them
  -- distinguishable is what lets the transcript panel label speakers, and
  -- what allows sign accuracy to be reported separately from speech accuracy.
  -- 'system' is not a translation direction: it is the meeting recording
  -- itself. Interview Mode warnings and removals are written as system lines
  -- so the transcript accounts for what HAPPENED, not only what was said.
  source     ENUM('sign','speech','system') NOT NULL,
  content    TEXT  NOT NULL,
  -- NULL for speech lines. The Web Speech API reports a confidence value, but
  -- it is not comparable to our model's softmax probability, so averaging the
  -- two would produce a meaningless number.
  confidence FLOAT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY ix_transcripts_meeting (meeting_id),
  KEY ix_transcripts_user (user_id),
  -- Every read is "meeting X's lines in time order", so index the pair.
  KEY ix_transcript_meeting_created (meeting_id, created_at),
  -- UNIQUE, not an ordinary index: a client retry or a reconnect replaying its
  -- tail must collide instead of inserting a second copy. NULLs are exempt
  -- from UNIQUE in MySQL, so rows predating this column do not conflict.
  UNIQUE KEY uq_transcript_segment (meeting_id, segment_id),

  CONSTRAINT fk_transcripts_meeting
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_transcripts_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- focus_events
-- ---------------------------------------------------------------------------
-- Interview Mode. These three event types are genuinely everything the browser
-- will tell us: it cannot see a second monitor, a phone, or another person in
-- the room. This is a deterrent, not proctoring — see the README.
CREATE TABLE IF NOT EXISTS focus_events (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  meeting_id INT NOT NULL,
  user_id    INT NOT NULL,
  event_type ENUM('blur','hidden','return') NOT NULL,
  -- Set on 'return' rows only: the first moment the duration is known.
  -- A 300ms notification steal and a two-minute absence must be
  -- distinguishable, or the host's log is not worth reading.
  duration_away_ms INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY ix_focus_meeting (meeting_id),
  KEY ix_focus_user (user_id),
  -- The host's violation view counts events per participant.
  KEY ix_focus_meeting_user (meeting_id, user_id),

  CONSTRAINT fk_focus_meeting
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_focus_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
