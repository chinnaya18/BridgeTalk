import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';

import { Icon, Logo, Spinner } from '../components/ui';
import { meetings as meetingsApi } from '../services/api';

/**
 * Where you land after leaving a meeting.
 *
 * WHY IT RE-FETCHES THE MEETING INSTEAD OF TRUSTING WHAT IT WAS TOLD
 * -----------------------------------------------------------------
 * The meeting room navigates here with `state: { endedByHost }`, which covers
 * the case where this user pressed "End meeting for everyone". It does not
 * cover the one that matters more: the host ended the meeting while this user
 * was in it, so this user merely "left" as far as their own click was
 * concerned.
 *
 * Getting that wrong shows "Rejoin" on a meeting that no longer exists, and
 * the button then fails. So the page asks the server whether the meeting is
 * still active, and navigation state is only the opening guess.
 */
export default function MeetingEnded() {
  const { code } = useParams();
  const location = useLocation();

  const hintedEndedByHost = Boolean(location.state?.endedByHost);
  // Removal is not the same as leaving, and the page must not offer Rejoin for
  // it — the server refuses, so a button that looked available would simply
  // fail.
  const wasRemoved = Boolean(location.state?.removed);
  const removalReason = location.state?.reason ?? null;

  const [meeting, setMeeting] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    meetingsApi
      .get(code)
      .then((found) => {
        if (!cancelled) setMeeting(found);
      })
      .catch(() => {
        // A deleted or unreachable meeting is not an error worth showing here:
        // the user has already left, and the page's job is to offer them a way
        // onward. Rejoin is simply withheld.
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  const isOver = hintedEndedByHost || (meeting ? !meeting.is_active : false);
  // A removed participant may not rejoin, whatever the meeting's state.
  const canRejoin = !wasRemoved && !checking && meeting?.is_active === true;

  return (
    <main className="grid min-h-screen place-items-center bg-light-bg p-6">
      <div className="w-full max-w-md text-center">
        <div className="mb-8 flex justify-center">
          <Logo to="/" />
        </div>

        <h1 className="text-2xl font-normal text-light-text">
          {wasRemoved
            ? 'You were removed from this interview'
            : isOver
              ? 'The meeting has ended'
              : 'You left the meeting'}
        </h1>

        {wasRemoved ? (
          <p
            role="alert"
            className="mx-auto mt-3 max-w-sm rounded-card border border-light-danger/30
                       bg-light-danger/[.06] p-3 text-sm text-light-text"
          >
            {removalReason
              ?? 'You were removed for leaving the meeting screen more than once.'}
            {' '}
            This was recorded in the meeting transcript. Only the host can
            readmit you.
          </p>
        ) : null}

        {meeting ? (
          <p className="mt-2 text-sm text-light-muted">
            {meeting.title} · {code}
            {/* The SERVER's COUNT(DISTINCT user_id), the same number Home,
                History and the transcript header show. Deriving it from
                `participants.length` here is how four surfaces came to
                disagree: the attendance table was append-only, so a
                reconnecting participant was counted once per reconnection. */}
            {meeting.participant_count ? (
              <>
                {' · '}
                {meeting.participant_count}{' '}
                {meeting.participant_count === 1 ? 'participant' : 'participants'}
              </>
            ) : null}
          </p>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {checking ? (
            <span className="flex h-10 items-center gap-2 text-sm text-light-muted">
              <Spinner size={16} />
              Checking the meeting…
            </span>
          ) : canRejoin ? (
            <Link to={`/lobby/${code}`} className="btn-outlined">
              <Icon name="refresh" size={18} />
              Rejoin
            </Link>
          ) : null}

          <Link to="/" className="btn-primary">
            Return to home screen
          </Link>
        </div>

        <div className="card mt-10 p-5 text-left">
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-light-surface text-light-blue"
            >
              <Icon name="description" size={20} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-light-text">
                The transcript of this meeting has been saved
              </p>
              <p className="mt-1 text-sm text-light-muted">
                Every caption, from both sign language and speech, with who said
                it and when.
              </p>
              <Link to={`/history/${code}`} className="btn-outlined mt-3">
                View transcript
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
