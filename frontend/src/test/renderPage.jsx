import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';

import { ToastProvider } from '../components/ui';
import { AuthProvider } from '../context/AuthContext';

/**
 * Mount one page at one route, with the providers it expects.
 *
 * MemoryRouter rather than BrowserRouter: no real history, and `initialEntries`
 * is how a test puts a `:code` parameter in the URL.
 *
 * The real AuthProvider is used, not a fake one. It calls /api/auth/me on mount,
 * which the fetch stub answers — so the test exercises the same loading →
 * authenticated transition the browser does, including the guard that used to
 * flash the login screen on every reload.
 */
export function renderPage(element, { path = '/', entry = path } = {}) {
  return render(
    <AuthProvider>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path={path} element={element} />
            {/* Catches a navigation away, so a redirect does not blow up on a
                missing route and look like a render failure. */}
            <Route path="*" element={<div data-testid="elsewhere" />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </AuthProvider>,
  );
}

const USER = {
  id: 1,
  name: 'Swarna Rathna A',
  email: 'swarna@example.com',
  role: 'deaf',
  created_at: '2026-10-01T09:00:00',
};

const MEETING = {
  id: 7,
  code: 'K7Q-2M4',
  title: 'Project review',
  host: USER,
  is_interview_mode: false,
  interview_mode_started_at: null,
  started_at: '2026-10-04T09:00:00',
  ended_at: null,
  created_at: '2026-10-04T08:55:00',
  is_active: true,
  participants: [
    { id: 1, user: USER, joined_at: '2026-10-04T09:00:00', left_at: null },
    {
      id: 2,
      user: { ...USER, id: 2, name: 'Thamizhthilaga S D S', email: 't@example.com', role: 'hearing' },
      joined_at: '2026-10-04T09:01:00',
      left_at: null,
    },
  ],
  caption_count: 2,
  // The server's COUNT(DISTINCT user_id), including the host.
  participant_count: 2,
};

const TRANSCRIPT = [
  {
    id: 1,
    meeting_id: 7,
    user_id: 1,
    user_name: 'Swarna Rathna A',
    segment_id: 'sign-1',
    source: 'sign',
    content: 'good morning',
    confidence: 0.91,
    created_at: '2026-10-04T09:02:00',
  },
  {
    id: 2,
    meeting_id: 7,
    user_id: 2,
    user_name: 'Thamizhthilaga S D S',
    segment_id: 'speech-1',
    source: 'speech',
    content: 'good morning, shall we start?',
    confidence: null,
    created_at: '2026-10-04T09:02:30',
  },
];

/**
 * Answer every API call this app makes, with correctly shaped data.
 *
 * Routed by URL rather than by call order, so a page that makes its requests in
 * a different order — or makes an extra one — still gets sensible answers
 * instead of another endpoint's payload.
 *
 * An unrecognised path REJECTS rather than returning an empty object. A silent
 * `{}` is how a test ends up passing against a page reading fields that do not
 * exist.
 */
export function installApiStub({ user = USER, meeting = MEETING, transcript = TRANSCRIPT } = {}) {
  const json = (body, status = 200) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
      text: async () => JSON.stringify(body),
      blob: async () => new Blob([JSON.stringify(body)]),
    });

  localStorage.setItem('bridgetalk.token', 'test-token');

  const fetchStub = vi.fn((input) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? '');

    if (url.includes('/api/auth/me')) return json(user);
    if (url.includes('/api/meetings/history')) return json([meeting]);
    if (url.match(/\/api\/meetings\/[^/]+\/join$/)) {
      return json({ meeting, is_first_participant: true });
    }
    if (url.match(/\/api\/meetings\/[^/]+\/focus-events$/)) {
      return json({ meeting_id: meeting.id, total_events: 0, away_count: 0, events: [], by_participant: [] });
    }
    if (url.match(/\/api\/meetings\/[^/]+$/)) return json(meeting);
    if (url.match(/\/api\/transcripts\/\d+$/)) return json(transcript);
    if (url.includes('/health')) return json({ status: 'ok' });

    return Promise.reject(new Error(`unstubbed request: ${url}`));
  });

  vi.stubGlobal('fetch', fetchStub);
  return { fetchStub, user, meeting, transcript };
}

export { MEETING, TRANSCRIPT, USER };
