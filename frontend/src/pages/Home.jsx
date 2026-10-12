import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import {
  Avatar,
  Dialog,
  EmptyState,
  ErrorState,
  Icon,
  Menu,
  MenuItem,
  SkeletonRow,
  Spinner,
  TextField,
  TopBar,
  useToast,
} from '../components/ui';
import { ApiError, meetings as meetingsApi } from '../services/api';
import { formatDateTime, formatDuration, parseMeetingCode } from '../utils/formatters';

const RECENT_LIMIT = 5;

/**
 * The landing page: start a meeting, join one by code, or open a recent
 * transcript.
 *
 * WHY "CREATE FOR LATER" AND "INSTANT MEETING" ARE THE SAME CALL
 * -------------------------------------------------------------
 * Both POST /api/meetings. The only difference is what happens next: an
 * instant meeting navigates straight to the lobby, while "for later" shows the
 * code and link so it can be sent to someone. Making them one request keeps a
 * single definition of what a meeting is, and means a code shared ahead of
 * time is identical to one created on the spot.
 */
export default function Home() {
  const navigate = useNavigate();
  const toast = useToast();

  const [recent, setRecent] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(null);

  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdMeeting, setCreatedMeeting] = useState(null);

  const [joinInput, setJoinInput] = useState('');
  const [joinError, setJoinError] = useState(null);
  const [joining, setJoining] = useState(false);

  const copyTimerRef = useRef(null);
  const [copied, setCopied] = useState(false);

  const loadRecent = useCallback(async () => {
    setLoadError(null);
    try {
      const rows = await meetingsApi.history();
      setRecent(rows);
    } catch (cause) {
      setLoadError(cause?.message ?? 'Could not load your meetings');
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  async function createMeeting({ joinNow }) {
    setNewMenuOpen(false);
    setCreating(true);
    try {
      const meeting = await meetingsApi.create('BridgeTalk meeting');
      if (joinNow) {
        navigate(`/lobby/${meeting.code}`);
      } else {
        setCreatedMeeting(meeting);
      }
    } catch (cause) {
      toast.show(cause?.message ?? 'Could not create a meeting', { icon: 'error' });
    } finally {
      setCreating(false);
    }
  }

  /**
   * Resolve the code before navigating.
   *
   * Going straight to `/lobby/<code>` would work for a valid code, but an
   * invalid one would show a broken lobby — camera already requested — instead
   * of an inline error on this page, which is what the specification asks for.
   * One GET is cheap and keeps the failure where the user typed.
   */
  async function handleJoin() {
    const code = parseMeetingCode(joinInput);
    if (!code) {
      setJoinError('Check your meeting code or link and try again');
      return;
    }

    setJoinError(null);
    setJoining(true);
    try {
      await meetingsApi.get(code);
      navigate(`/lobby/${code}`);
    } catch (cause) {
      setJoinError(
        cause instanceof ApiError && cause.status === 404
          ? "That meeting code does not exist. Check it and try again."
          : (cause?.message ?? 'Could not check that code'),
      );
    } finally {
      setJoining(false);
    }
  }

  function copyLink(code) {
    const link = `${window.location.origin}/lobby/${code}`;
    navigator.clipboard
      ?.writeText(link)
      .then(() => {
        setCopied(true);
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => toast.show('Could not copy the link', { icon: 'error' }));
  }

  return (
    <div className="min-h-screen bg-light-bg">
      <TopBar />

      <main className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        {/* lg: two columns. Below 900px the grid collapses to one, which is
            the responsive rule the specification sets for two-column pages. */}
        <div className="grid items-center gap-12 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:gap-16 lg:py-20">
          {/* ---------------- left: the pitch and the actions -------------- */}
          <section>
            <h1 className="text-3xl font-normal leading-tight text-light-text sm:text-display">
              Conversations that work both ways
            </h1>
            <p className="mt-5 max-w-xl text-base text-light-muted">
              BridgeTalk turns sign language into live captions for hearing
              participants, and speech into live captions for deaf participants —
              in the same video call.
            </p>

            <div className="mt-9 flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="relative">
                <button
                  type="button"
                  id="new-meeting-trigger"
                  onClick={() => setNewMenuOpen((open) => !open)}
                  disabled={creating}
                  aria-haspopup="menu"
                  aria-expanded={newMenuOpen}
                  className="btn-primary h-12 w-full px-6 sm:w-auto"
                >
                  {creating ? (
                    <Spinner size={18} className="border-white/40 border-t-white" />
                  ) : (
                    <Icon name="videocam" size={20} />
                  )}
                  New meeting
                </button>

                <Menu
                  open={newMenuOpen}
                  onClose={() => setNewMenuOpen(false)}
                  align="left"
                  labelledBy="new-meeting-trigger"
                  className="min-w-[300px]"
                >
                  <MenuItem
                    icon="add"
                    onClick={() => createMeeting({ joinNow: false })}
                    description="Get a code and link to share now, join later"
                  >
                    Create a meeting for later
                  </MenuItem>
                  <MenuItem
                    icon="bolt"
                    onClick={() => createMeeting({ joinNow: true })}
                    description="Check your camera and microphone, then join"
                  >
                    Start an instant meeting
                  </MenuItem>
                </Menu>
              </div>

              <div className="flex-1">
                <div className="flex items-start gap-2">
                  <TextField
                    label="Enter a code or link"
                    icon="keyboard"
                    value={joinInput}
                    onChange={(value) => {
                      setJoinInput(value);
                      setJoinError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') handleJoin();
                    }}
                    error={joinError}
                    className="min-w-0 flex-1"
                  />
                  {/* Disabled until there is text, per the specification. */}
                  <button
                    type="button"
                    onClick={handleJoin}
                    disabled={joinInput.trim().length === 0 || joining}
                    className="btn-text mt-2 h-12 shrink-0 font-medium"
                  >
                    {joining ? <Spinner size={16} /> : null}
                    Join
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* ---------------- right: recent meetings ----------------------- */}
          <section aria-labelledby="recent-heading" className="min-w-0">
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <h2 id="recent-heading" className="text-base font-medium text-light-text">
                Recent meetings
              </h2>
              {recent?.length ? (
                <Link to="/history" className="text-sm font-medium text-light-blue hover:underline">
                  See all
                </Link>
              ) : null}
            </div>

            {recent === null ? (
              <div className="flex flex-col gap-3">
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </div>
            ) : loadError ? (
              <ErrorState
                title="Could not load your meetings"
                body={loadError}
                onRetry={loadRecent}
              />
            ) : recent.length === 0 ? (
              <EmptyState
                icon="video_library"
                title="Your meetings and transcripts will appear here"
                body="Start a meeting, and BridgeTalk will save its captions so you can read them afterwards."
              />
            ) : (
              <ul className="flex flex-col gap-3">
                {recent.slice(0, RECENT_LIMIT).map((meeting) => (
                  <li key={meeting.id}>
                    <RecentMeetingCard meeting={meeting} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>

      {/* "Create a meeting for later" — the code and link, with a copy button */}
      <Dialog
        open={Boolean(createdMeeting)}
        onClose={() => {
          setCreatedMeeting(null);
          setCopied(false);
          loadRecent();
        }}
        title="Here is the link to your meeting"
        description="Copy it and send it to the people you want to meet with. Save it so you can use it later, too."
        footer={
          <>
            <button
              type="button"
              className="btn-text"
              onClick={() => {
                setCreatedMeeting(null);
                setCopied(false);
                loadRecent();
              }}
            >
              Close
            </button>
            <Link to={`/lobby/${createdMeeting?.code ?? ''}`} className="btn-primary">
              Join now
            </Link>
          </>
        }
      >
        <div className="flex items-center justify-between gap-3 rounded-card bg-light-surface px-4 py-3">
          <span className="min-w-0 break-all font-mono text-sm text-light-text">
            {window.location.origin}/lobby/{createdMeeting?.code}
          </span>
          <button
            type="button"
            onClick={() => copyLink(createdMeeting.code)}
            aria-label="Copy joining link"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-light-blue
                       transition-colors hover:bg-light-blue/[.08]"
          >
            <Icon name={copied ? 'check' : 'content_copy'} size={20} />
          </button>
        </div>
        <p aria-live="polite" className="mt-2 h-4 text-xs text-light-muted">
          {copied ? 'Link copied' : ''}
        </p>
        <p className="mt-3 text-sm text-light-muted">
          Meeting code:{' '}
          <span className="font-medium text-light-text">{createdMeeting?.code}</span>
        </p>
      </Dialog>
    </div>
  );
}

/**
 * One recent meeting.
 *
 * The whole card is NOT a link. The card contains a "View transcript" link, and
 * nesting an <a> inside an <a> is invalid HTML that browsers resolve
 * unpredictably — so here the card is a plain container and the link is the one
 * interactive element. The History page, whose rows have no inner link, makes
 * the whole row clickable instead.
 */
function RecentMeetingCard({ meeting }) {
  const duration = formatDuration(meeting.started_at, meeting.ended_at);
  const participants = meeting.participants ?? [];
  // The SERVER's COUNT(DISTINCT user_id), including the host — not
  // `participants.length`. The attendance table was append-only, so a
  // participant who reconnected three times used to be counted three times.
  // The avatars below are capped, so the count and the faces are shown
  // together with a "+N" for the overflow.
  const participantCount = meeting.participant_count ?? participants.length;

  return (
    <div className="card p-4 transition-shadow hover:shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-light-text">{meeting.title}</p>
          <p className="mt-0.5 text-xs text-light-muted">
            {formatDateTime(meeting.created_at)}
            {duration ? ` · ${duration}` : meeting.is_active ? ' · In progress' : ''}
          </p>
        </div>
        {meeting.is_interview_mode ? (
          <span className="shrink-0 rounded-full bg-light-surface px-2 py-0.5 text-[11px] font-medium text-light-muted">
            Interview
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        {/* Overlapping avatars, newest behind. Cap at four plus a count, or a
            meeting with eight people pushes the link off the card. */}
        <div className="flex items-center">
          {participants.slice(0, 4).map((participant, index) => (
            <span
              key={participant.id}
              className="-ml-1.5 rounded-full ring-2 ring-light-bg first:ml-0"
              style={{ zIndex: 4 - index }}
            >
              <Avatar name={participant.user?.name ?? ''} size={26} />
            </span>
          ))}
          {participantCount > 4 ? (
            <span className="ml-1.5 text-xs text-light-muted">
              +{participantCount - 4}
            </span>
          ) : null}
          {participantCount === 0 ? (
            <span className="text-xs text-light-muted">No one joined</span>
          ) : (
            <span className="ml-2 text-xs text-light-muted">
              {participantCount} {participantCount === 1 ? 'participant' : 'participants'}
            </span>
          )}
        </div>

        <Link
          to={`/history/${meeting.code}`}
          className="shrink-0 text-sm font-medium text-light-blue hover:underline"
        >
          View transcript
        </Link>
      </div>
    </div>
  );
}
