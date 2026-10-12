import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import {
  Avatar,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  Select,
  SubPageTopBar,
  TextField,
  useToast,
} from '../components/ui';
import { useAuth } from '../context/AuthContext';
import {
  ApiError,
  meetings as meetingsApi,
  transcripts as transcriptsApi,
} from '../services/api';
import {
  formatDateTime,
  formatDuration,
  formatElapsed,
  formatTimeWithSeconds,
} from '../utils/formatters';

const SOURCE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'sign', label: 'Sign' },
  { value: 'speech', label: 'Speech' },
];

/** Consecutive entries from one speaker group under a single name. */
const GROUP_GAP_MS = 60_000;

/**
 * One meeting's saved captions, with the exports.
 *
 * ACCESS CONTROL IS THE SERVER'S, NOT THIS PAGE'S
 * -----------------------------------------------
 * The specification says only participants may open this page. That rule is
 * enforced by `GET /api/transcripts/{id}`, which returns 403 to a non-member.
 * This page's job is to turn that 403 into a sentence rather than a stack
 * trace. A check in the browser would be decoration: anyone can call the API
 * directly, so a client-side guard protects nothing and invites the real one
 * to be forgotten.
 */
export default function Transcript() {
  const { code } = useParams();
  const { user } = useAuth();
  const toast = useToast();

  const [meeting, setMeeting] = useState(null);
  const [lines, setLines] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [forbidden, setForbidden] = useState(false);

  const [sourceFilter, setSourceFilter] = useState('all');
  const [speakerFilter, setSpeakerFilter] = useState('all');
  const [query, setQuery] = useState('');

  const [violations, setViolations] = useState(null);
  const [violationsOpen, setViolationsOpen] = useState(false);

  const [downloading, setDownloading] = useState(null); // 'txt' | 'pdf' | null
  const liveRef = useRef(null);

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    try {
      const found = await meetingsApi.get(code);
      setMeeting(found);
      const rows = await transcriptsApi.list(found.id);
      setLines(rows);
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) {
        setForbidden(true);
      } else {
        setError(cause?.message ?? 'Could not load this transcript');
      }
      setLines([]);
    }
  }, [code]);

  useEffect(() => {
    load();
  }, [load]);

  const isHost = Boolean(meeting?.host?.id && user?.id && meeting.host.id === user.id);

  // The interview-mode log is host-only AND only for meetings where the mode
  // was actually used, so it is fetched separately and its absence is normal.
  useEffect(() => {
    if (!isHost || !meeting?.is_interview_mode) return;
    meetingsApi
      .focusEvents(code)
      .then((summary) => setViolations(summary))
      .catch(() => setViolations(null));
  }, [isHost, meeting?.is_interview_mode, code]);

  const speakers = useMemo(() => {
    const names = new Map();
    (lines ?? []).forEach((line) => {
      if (!names.has(line.user_id)) names.set(line.user_id, line.user_name);
    });
    return [...names.entries()].map(([id, name]) => ({ value: String(id), label: name }));
  }, [lines]);

  const filtered = useMemo(() => {
    if (!lines) return null;
    const needle = query.trim().toLowerCase();

    return lines.filter((line) => {
      if (sourceFilter !== 'all' && line.source !== sourceFilter) return false;
      if (speakerFilter !== 'all' && String(line.user_id) !== speakerFilter) return false;
      if (needle && !line.content.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [lines, sourceFilter, speakerFilter, query]);

  /**
   * Group consecutive entries from the same speaker.
   *
   * Grouping runs on the FILTERED list, not the raw one. Grouping first and
   * filtering after would leave a group header naming a speaker whose every
   * line had just been filtered out.
   */
  const groups = useMemo(() => {
    if (!filtered) return null;
    const result = [];
    filtered.forEach((line) => {
      const last = result[result.length - 1];
      const sameSpeaker = last?.userId === line.user_id;
      const closeInTime =
        last && new Date(line.created_at) - new Date(last.lastAt) < GROUP_GAP_MS;

      if (sameSpeaker && closeInTime) {
        last.lines.push(line);
        last.lastAt = line.created_at;
      } else {
        result.push({
          key: `${line.user_id}-${line.id}`,
          userId: line.user_id,
          userName: line.user_name,
          startedAt: line.created_at,
          lastAt: line.created_at,
          lines: [line],
        });
      }
    });
    return result;
  }, [filtered]);

  async function handleDownload(format) {
    if (!meeting) return;
    setDownloading(format);
    try {
      const filename = await transcriptsApi.download(meeting.id, format);
      toast.show(`Saved ${filename}`, { icon: 'download_done' });
    } catch (cause) {
      toast.show(cause?.message ?? `Could not download the ${format.toUpperCase()}`, {
        icon: 'error',
      });
    } finally {
      setDownloading(null);
    }
  }

  // ---------------------------------------------------------------- states --

  if (forbidden) {
    return (
      <div className="min-h-screen bg-light-bg">
        <SubPageTopBar backTo="/history" backLabel="Back to history" title="Transcript" />
        <main className="mx-auto max-w-transcript px-4 py-16 sm:px-6">
          <EmptyState
            icon="lock"
            title="You do not have access to this transcript"
            body="Only people who took part in a meeting can read its transcript."
            actionLabel="Back to history"
            actionTo="/history"
          />
        </main>
      </div>
    );
  }

  const duration = formatDuration(meeting?.started_at, meeting?.ended_at);

  return (
    <div className="min-h-screen bg-light-bg">
      <SubPageTopBar
        backTo="/history"
        backLabel="Back to history"
        title={meeting?.title ?? 'Transcript'}
      />

      <main className="mx-auto max-w-transcript px-4 pb-20 sm:px-6">
        {/* ------------------------------- header ------------------------- */}
        <header className="flex flex-wrap items-start justify-between gap-4 py-6">
          <div className="min-w-0">
            <dl className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-light-muted">
              <div>
                <dt className="sr-only">Date</dt>
                <dd>{meeting ? formatDateTime(meeting.created_at) : '—'}</dd>
              </div>
              {meeting?.started_at ? (
                <>
                  <span aria-hidden="true">·</span>
                  <div>
                    <dt className="sr-only">Started</dt>
                    <dd>
                      {formatTimeWithSeconds(meeting.started_at)}
                      {meeting.ended_at ? ` – ${formatTimeWithSeconds(meeting.ended_at)}` : ''}
                    </dd>
                  </div>
                </>
              ) : null}
              {duration ? (
                <>
                  <span aria-hidden="true">·</span>
                  <div>
                    <dt className="sr-only">Duration</dt>
                    <dd>{duration}</dd>
                  </div>
                </>
              ) : null}
              <span aria-hidden="true">·</span>
              <div>
                <dt className="sr-only">Meeting code</dt>
                <dd className="font-mono">{code}</dd>
              </div>
            </dl>

            {meeting?.participants?.length ? (
              <div className="mt-3 flex items-center gap-2">
                <div className="flex items-center">
                  {meeting.participants.slice(0, 6).map((participant, index) => (
                    <span
                      key={participant.id}
                      className="-ml-1.5 rounded-full ring-2 ring-light-bg first:ml-0"
                      style={{ zIndex: 6 - index }}
                    >
                      <Avatar name={participant.user?.name ?? ''} size={26} />
                    </span>
                  ))}
                </div>
                <span className="text-xs text-light-muted">
                  {/* Names when they fit, otherwise the SERVER's count — the
                      same `participant_count` Home and History show, so the
                      four surfaces cannot disagree. */}
                  {(meeting.participant_count ?? meeting.participants.length) > 6
                    ? `${meeting.participant_count} participants`
                    : meeting.participants
                        .map((p) => p.user?.name)
                        .filter(Boolean)
                        .join(', ')}
                </span>
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => handleDownload('txt')}
              disabled={!meeting || downloading !== null}
              className="btn-outlined"
            >
              <Icon name={downloading === 'txt' ? 'progress_activity' : 'download'} size={18}
                    className={downloading === 'txt' ? 'animate-spin' : ''} />
              Download TXT
            </button>
            <button
              type="button"
              onClick={() => handleDownload('pdf')}
              disabled={!meeting || downloading !== null}
              className="btn-outlined"
            >
              <Icon name={downloading === 'pdf' ? 'progress_activity' : 'picture_as_pdf'} size={18}
                    className={downloading === 'pdf' ? 'animate-spin' : ''} />
              Download PDF
            </button>
          </div>
        </header>

        {/* ------------------------------- tools -------------------------- */}
        {lines?.length ? (
          <div className="flex flex-wrap items-end gap-3 border-y border-light-border py-4">
            <div
              role="group"
              aria-label="Filter by source"
              className="flex items-center gap-1.5"
            >
              {SOURCE_FILTERS.map((chip) => {
                const selected = sourceFilter === chip.value;
                return (
                  <button
                    key={chip.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSourceFilter(chip.value)}
                    className={`h-8 rounded-full border px-3 text-sm font-medium transition-colors
                      ${selected
                        ? 'border-light-blue bg-light-blue/[.12] text-light-blue'
                        : 'border-light-border text-light-muted hover:bg-light-surface'}`}
                  >
                    {chip.label}
                  </button>
                );
              })}
            </div>

            {speakers.length > 1 ? (
              <Select
                label="Participant"
                value={speakerFilter}
                onChange={setSpeakerFilter}
                options={[{ value: 'all', label: 'Everyone' }, ...speakers]}
                className="w-44"
              />
            ) : null}

            <div className="min-w-[200px] flex-1">
              <TextField label="Search this transcript" icon="search" value={query} onChange={setQuery} />
            </div>
          </div>
        ) : null}

        {/* ------------------------------- body --------------------------- */}
        {lines === null ? (
          <LoadingState message="Loading transcript…" />
        ) : error ? (
          <ErrorState title="Could not load this transcript" body={error} onRetry={load} />
        ) : lines.length === 0 ? (
          <EmptyState
            icon="voice_over_off"
            title="No captions were saved for this meeting"
            body="Captions are saved as they are finalised. A meeting where nobody signed or spoke has an empty transcript."
            actionLabel="Back to history"
            actionTo="/history"
          />
        ) : groups.length === 0 ? (
          <EmptyState
            icon="search_off"
            title="Nothing matches these filters"
            body="Try a different search, or clear the filters."
            actionLabel="Clear filters"
            onAction={() => {
              setQuery('');
              setSourceFilter('all');
              setSpeakerFilter('all');
            }}
          />
        ) : (
          <>
            <p ref={liveRef} aria-live="polite" className="py-4 text-sm text-light-muted">
              {filtered.length} of {lines.length}{' '}
              {lines.length === 1 ? 'caption' : 'captions'}
            </p>

            <ol className="flex flex-col gap-5 pb-8">
              {groups.map((group) => (
                <li key={group.key} className="flex gap-3">
                  <Avatar name={group.userName} size={32} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium text-light-text">{group.userName}</span>
                      <span className="text-xs text-light-muted">
                        {formatTimeWithSeconds(group.startedAt)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-col gap-1.5">
                      {group.lines.map((line) => (
                        <p key={line.id} className="flex items-start gap-2 text-[15px] leading-relaxed text-light-text">
                          <SourceBadge source={line.source} />
                          <span className="min-w-0">
                            <Highlight text={line.content} needle={query} />
                          </span>
                        </p>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}

        {/* --------------------- interview mode log (host only) ----------- */}
        {isHost && meeting?.is_interview_mode ? (
          <section className="mt-6 rounded-card border border-light-border">
            <button
              type="button"
              onClick={() => setViolationsOpen((open) => !open)}
              aria-expanded={violationsOpen}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-light-text">
                <Icon name="policy" size={20} className="text-light-muted" />
                Interview mode log
                {violations?.events?.length ? (
                  <span className="rounded-full bg-light-surface px-2 py-0.5 text-xs text-light-muted">
                    {violations.events.length}
                  </span>
                ) : null}
              </span>
              <Icon name={violationsOpen ? 'expand_less' : 'expand_more'} size={20} className="text-light-muted" />
            </button>

            {violationsOpen ? (
              <div className="border-t border-light-border px-4 py-3">
                {violations === null ? (
                  <p className="text-sm text-light-muted">Loading the log…</p>
                ) : !violations.events?.length ? (
                  <p className="text-sm text-light-muted">
                    No one left the meeting tab while interview mode was on.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-light-border">
                    {violations.events.map((event) => (
                      <li key={event.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <span className="min-w-0 truncate text-light-text">
                          {event.user_name ?? `User ${event.user_id}`}
                        </span>
                        <span className="shrink-0 text-light-muted">
                          {event.event_type?.replace(/_/g, ' ')}
                        </span>
                        <span className="shrink-0 text-light-muted">
                          {formatTimeWithSeconds(event.created_at)}
                        </span>
                        <span className="w-16 shrink-0 text-right text-light-muted">
                          {/* `duration_away_ms`, which is what FocusEventPublic
                              actually calls it — not `duration_ms`. */}
                          {event.duration_away_ms != null
                            ? formatElapsed(Math.round(event.duration_away_ms / 1000))
                            : '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-xs text-light-muted">
                  Interview mode records tab switches and window blur only. It
                  cannot detect a second device or another person in the room,
                  and is a deterrent rather than proctoring.
                </p>
              </div>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}

function SourceBadge({ source }) {
  const isSign = source === 'sign';
  return (
    <span
      className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium
        ${isSign ? 'bg-light-blue/[.12] text-light-blue' : 'bg-light-surface text-light-muted'}`}
    >
      <Icon name={isSign ? 'sign_language' : 'mic'} size={13} />
      {isSign ? 'Sign' : 'Speech'}
    </span>
  );
}

/**
 * Highlight every occurrence of the search text.
 *
 * The needle is escaped before it reaches the RegExp. Without that, typing "("
 * throws SyntaxError: Unterminated group and takes the page down — a crash a
 * user can cause by typing a bracket into a search box.
 */
function Highlight({ text, needle }) {
  const trimmed = needle.trim();
  if (!trimmed) return text;

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));

  return parts.map((part, index) =>
    part.toLowerCase() === trimmed.toLowerCase() ? (
      <mark key={index} className="search-hit">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
