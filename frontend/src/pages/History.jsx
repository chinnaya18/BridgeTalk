import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  Avatar,
  EmptyState,
  ErrorState,
  Icon,
  SkeletonRow,
  TextField,
  TopBar,
} from '../components/ui';
import { meetings as meetingsApi } from '../services/api';
import { formatDateTime, formatDuration } from '../utils/formatters';

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Every meeting the user took part in, searchable.
 *
 * SEARCH IS SERVER-SIDE AND DEBOUNCED; PAGING IS CLIENT-SIDE
 * ---------------------------------------------------------
 * Those are opposite choices, for a reason in each case.
 *
 * Search has to be on the server: it covers caption TEXT as well as titles,
 * and the captions are not in the browser. Fetching every transcript to grep
 * locally would download a user's whole history to answer one keystroke. It is
 * debounced by 300 ms so typing "dataset" is one request, not seven.
 *
 * Paging is in the browser: the result set is one user's own meetings, which is
 * tens of rows, not thousands. "Load more" reveals the next ten already in
 * memory. That keeps the list responsive and avoids an offset/limit API whose
 * only consumer would be a page that does not need it. If this ever had to
 * serve a user with thousands of meetings, the honest fix is cursor paging on
 * the endpoint, not a bigger page size here.
 */
export default function History() {
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [rows, setRows] = useState(null); // null = first load
  const [error, setError] = useState(null);
  const [searching, setSearching] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);

  // Identifies the newest request so a slow earlier one cannot overwrite it.
  // Without this, typing then deleting can leave the filtered result on screen
  // because the unfiltered response happened to land first.
  const requestIdRef = useRef(0);

  const load = useCallback(async (searchText) => {
    const id = requestIdRef.current + 1;
    requestIdRef.current = id;

    setSearching(true);
    setError(null);
    try {
      const result = await meetingsApi.history(searchText);
      if (requestIdRef.current !== id) return;
      setRows(result);
      setVisible(PAGE_SIZE);
    } catch (cause) {
      if (requestIdRef.current !== id) return;
      setError(cause?.message ?? 'Could not load your meeting history');
      setRows([]);
    } finally {
      if (requestIdRef.current === id) setSearching(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => load(query), query ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  const shown = rows?.slice(0, visible) ?? [];
  const hasMore = (rows?.length ?? 0) > visible;

  return (
    <div className="min-h-screen bg-light-bg">
      <TopBar />

      <main className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
        <div className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-normal text-light-text">Meeting history</h1>
          <div className="relative w-full sm:w-80">
            <TextField
              label="Search meetings and captions"
              icon="search"
              value={query}
              onChange={setQuery}
            />
            {searching && query ? (
              <span className="absolute right-3 top-5">
                <Icon name="progress_activity" size={18} className="animate-spin text-light-muted" />
              </span>
            ) : null}
          </div>
        </div>

        {rows === null ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 5 }, (_, index) => (
              <SkeletonRow key={index} />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            title="Could not load your meeting history"
            body={error}
            onRetry={() => load(query)}
          />
        ) : rows.length === 0 ? (
          query ? (
            <EmptyState
              icon="search_off"
              title="No meetings match that search"
              body={`Nothing in your meeting titles or captions contains “${query}”.`}
              actionLabel="Clear search"
              onAction={() => setQuery('')}
            />
          ) : (
            <EmptyState
              icon="video_library"
              title="You have not taken part in any meetings yet"
              body="Start or join a meeting, and its transcript will be saved here."
              actionLabel="Go to home"
              actionTo="/"
            />
          )
        ) : (
          <>
            <p className="mb-3 text-sm text-light-muted" aria-live="polite">
              {rows.length} {rows.length === 1 ? 'meeting' : 'meetings'}
              {query ? ' matching your search' : ''}
            </p>

            <ul className="flex flex-col gap-3">
              {shown.map((meeting) => (
                <li key={meeting.id}>
                  <HistoryRow
                    meeting={meeting}
                    onOpen={() => navigate(`/history/${meeting.code}`)}
                  />
                </li>
              ))}
            </ul>

            {hasMore ? (
              <div className="mt-6 grid place-items-center">
                <button
                  type="button"
                  onClick={() => setVisible((count) => count + PAGE_SIZE)}
                  className="btn-outlined"
                >
                  Load more
                </button>
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

/**
 * One meeting.
 *
 * The whole row is clickable, which the specification asks for. It is a <div>
 * with a click handler plus explicit keyboard handling rather than a <button>,
 * because a button cannot legally contain the "View transcript" button inside
 * it — nested interactive elements are invalid and browsers disagree about
 * which one receives the click.
 *
 * So: role="link", tabIndex 0, and Enter/Space both activate, which is what a
 * native control would give for free. The inner button stops propagation so it
 * does not fire the row's handler as well.
 */
function HistoryRow({ meeting, onOpen }) {
  const duration = formatDuration(meeting.started_at, meeting.ended_at);
  const participants = meeting.participants ?? [];
  // The SERVER's COUNT(DISTINCT user_id), including the host. See Home.jsx.
  const participantCount = meeting.participant_count ?? participants.length;
  const captionCount = meeting.caption_count ?? 0;

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      aria-label={`${meeting.title}, ${formatDateTime(meeting.created_at)}. View transcript.`}
      className="card cursor-pointer p-4 transition-shadow hover:shadow-sm focus-visible:shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-medium text-light-text">{meeting.title}</h2>
            {meeting.is_interview_mode ? (
              <span className="shrink-0 rounded-full bg-light-blue/[.12] px-2 py-0.5 text-[11px] font-medium text-light-blue">
                Interview mode
              </span>
            ) : null}
            {meeting.is_active ? (
              <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800">
                In progress
              </span>
            ) : null}
          </div>

          <p className="mt-1 text-sm text-light-muted">
            {formatDateTime(meeting.created_at)}
            {duration ? ` · ${duration}` : ''}
            {` · ${captionCount} ${captionCount === 1 ? 'caption' : 'captions'}`}
          </p>

          <div className="mt-2.5 flex items-center gap-2">
            {participantCount > 0 ? (
              <>
                <div className="flex items-center">
                  {participants.slice(0, 5).map((participant, index) => (
                    <span
                      key={participant.id}
                      className="-ml-1.5 rounded-full ring-2 ring-light-bg first:ml-0"
                      style={{ zIndex: 5 - index }}
                    >
                      <Avatar name={participant.user?.name ?? ''} size={26} />
                    </span>
                  ))}
                </div>
                <span className="text-xs text-light-muted">
                  {/* The avatars are capped at five; the count is the real
                      total, so an overflow is shown explicitly rather than the
                      number silently disagreeing with the faces. */}
                  {participantCount > 5 ? (
                    <>
                      +{participantCount - 5} ·{' '}
                      {participantCount} participants
                    </>
                  ) : participantCount === 1 ? (
                    participants[0]?.user?.name ?? '1 participant'
                  ) : (
                    `${participantCount} participants`
                  )}
                </span>
              </>
            ) : (
              <span className="text-xs text-light-muted">Nobody joined this meeting</span>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="btn-outlined shrink-0"
        >
          <Icon name="description" size={18} />
          View transcript
        </button>
      </div>
    </div>
  );
}
