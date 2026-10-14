/**
 * Thin wrapper around the BridgeTalk REST API.
 *
 * Every network call in the app goes through here, which means the auth header,
 * error shape and base URL are defined in exactly one place. A component that
 * calls `fetch` directly is a bug.
 */

/**
 * Where the API lives.
 *
 * SAME-ORIGIN MODE, AND WHY IT IS NEEDED
 * --------------------------------------
 * An EMPTY `VITE_API_BASE_URL` means "same origin as this page", so requests go
 * to `/api/...` and are served by whatever is hosting the app.
 *
 * That is what makes two-device testing work. `npm run dev:lan` proxies `/api`
 * and `/ws` through Vite, but a hardcoded `http://localhost:8000` defeats the
 * proxy entirely: on the SECOND device `localhost` is that device, not the one
 * running the backend, so every request fails with a connection error and the
 * app looks completely broken.
 *
 * An unset variable still falls back to `http://localhost:8000`, so a plain
 * `npm run dev` is unchanged.
 */
const RAW_API_BASE = import.meta.env.VITE_API_BASE_URL;
const RAW_WS_BASE = import.meta.env.VITE_WS_BASE_URL;

/** `wss://host` behind HTTPS, `ws://host` otherwise. Getting this wrong is a
 *  mixed-content error the browser blocks with no useful message. */
function sameOriginWebSocketBase() {
  if (typeof window === 'undefined') return 'ws://localhost:8000';
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}`;
}

// `''` is a deliberate value, not a missing one, so `??` is not enough here.
const API_BASE_URL =
  RAW_API_BASE === '' ? '' : (RAW_API_BASE ?? 'http://localhost:8000');
const WS_BASE_URL =
  RAW_WS_BASE === '' ? sameOriginWebSocketBase() : (RAW_WS_BASE ?? 'ws://localhost:8000');

const TOKEN_KEY = 'bridgetalk.token';

/**
 * An API error carrying the HTTP status, so callers can distinguish
 * "wrong password" (401) from "the server is down" (no status at all).
 */
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// --- token storage ---------------------------------------------------------
// localStorage rather than an httpOnly cookie is a deliberate, documented
// trade-off. httpOnly cookies resist XSS, which localStorage does not; but they
// need CSRF protection and cannot be read by the WebSocket URL builder, which
// needs the raw token as a query parameter. For a locally-hosted academic
// project the simpler path is the right one, and this comment is here so the
// choice is visible rather than accidental.

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Perform an authenticated request and parse the response.
 *
 * @param {string} path e.g. '/api/auth/me'
 * @param {object} options fetch options; `body` is JSON-encoded automatically
 */
async function request(path, options = {}) {
  const { body, headers = {}, ...rest } = options;
  const token = getToken();

  const finalHeaders = { ...headers };
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (token) finalHeaders.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...rest,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // fetch only rejects for network-level failures. Saying "cannot reach the
    // server" is far more useful than the browser's bare "Failed to fetch".
    throw new ApiError(
      `Cannot reach the BridgeTalk API at ${API_BASE_URL}. Is the backend running?`,
      0,
      null,
    );
  }

  if (response.status === 204) return null;

  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    // FastAPI returns {detail: "..."} for HTTPException and {detail: [...]}
    // for validation errors. Flatten both into one readable string.
    let message = `Request failed (${response.status})`;
    if (payload && typeof payload === 'object' && payload.detail) {
      message = Array.isArray(payload.detail)
        ? payload.detail.map((item) => item.msg ?? String(item)).join('; ')
        : String(payload.detail);
    }
    throw new ApiError(message, response.status, payload);
  }

  return payload;
}

// --- auth ------------------------------------------------------------------

export const auth = {
  register: (payload) => request('/api/auth/register', { method: 'POST', body: payload }),
  login: (email, password) =>
    request('/api/auth/login/json', { method: 'POST', body: { email, password } }),
  me: () => request('/api/auth/me'),
};

// --- meetings --------------------------------------------------------------

export const meetings = {
  create: (title, isInterviewMode = false) =>
    request('/api/meetings', {
      method: 'POST',
      body: { title, is_interview_mode: isInterviewMode },
    }),
  get: (code) => request(`/api/meetings/${encodeURIComponent(code)}`),
  join: (code) => request(`/api/meetings/${encodeURIComponent(code)}/join`, { method: 'POST' }),
  leave: (code) => request(`/api/meetings/${encodeURIComponent(code)}/leave`, { method: 'POST' }),
  end: (code) => request(`/api/meetings/${encodeURIComponent(code)}/end`, { method: 'POST' }),
  /**
   * Meetings the caller hosted or attended, newest first.
   *
   * `query` searches titles AND saved caption text server-side. It has to be
   * the server's job: the caption text is not in the browser, and fetching
   * every transcript to grep it locally would download a whole meeting history
   * to answer one keystroke.
   */
  history: (query = '') =>
    request(
      query.trim()
        ? `/api/meetings/history?q=${encodeURIComponent(query.trim())}`
        : '/api/meetings/history',
    ),
  logFocusEvent: (code, eventType, durationMs = null) =>
    request(`/api/meetings/${encodeURIComponent(code)}/focus-events`, {
      method: 'POST',
      body: { event_type: eventType, duration_away_ms: durationMs },
    }),
  focusEvents: (code) => request(`/api/meetings/${encodeURIComponent(code)}/focus-events`),

  /** Host-only: switch Interview Mode on or off during a meeting. */
  setInterviewMode: (code, enabled) =>
    request(`/api/meetings/${encodeURIComponent(code)}/interview-mode`, {
      method: 'PATCH',
      body: { enabled },
    }),
};

// --- transcripts -----------------------------------------------------------

export const transcripts = {
  append: ({ meetingId, source, content, confidence = null }) =>
    request('/api/transcripts', {
      method: 'POST',
      body: { meeting_id: meetingId, source, content, confidence },
    }),
  list: (meetingId) => request(`/api/transcripts/${meetingId}`),

  // Kept for the API-docs route and for tests. Note that opening this URL
  // directly in a browser returns 401: a plain navigation cannot carry the
  // Authorization header. Use `download` below for anything user-facing.
  exportUrl: (meetingId) => `${API_BASE_URL}/api/transcripts/${meetingId}/export`,

  /**
   * Download the transcript as a .txt file.
   *
   * WHY THIS IS NOT JUST AN <a href>
   * --------------------------------
   * The export endpoint is member-only and authenticated by a bearer token.
   * A plain link triggers a browser navigation, and a navigation cannot set
   * request headers — so the server sees no token and answers 401. That was
   * exactly the bug this replaced: the button looked right and produced an
   * authentication error instead of a file.
   *
   * So we fetch it properly, turn the response into a Blob, and click a
   * temporary anchor pointed at an object URL. That is the standard way to
   * save an authenticated file from JavaScript.
   *
   * The filename comes from the server's Content-Disposition header when it is
   * present, so the name stays owned by whoever generates the file rather than
   * being duplicated — and drifting — on both sides.
   */
  /**
   * Download the transcript. `format` is 'txt' or 'pdf'.
   *
   * Both go through the same authenticated-fetch-to-Blob path, because both
   * endpoints are member-only and a plain <a href> cannot carry the token.
   */
  download: async (meetingId, format = 'txt') => {
    const token = getToken();

    const suffix = format === 'pdf' ? '/export.pdf' : '/export';
    const response = await fetch(
      `${API_BASE_URL}/api/transcripts/${meetingId}${suffix}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );

    if (!response.ok) {
      throw new ApiError(
        response.status === 403
          ? 'You are not a participant in this meeting.'
          : `Could not download the transcript (HTTP ${response.status})`,
        response.status,
        null,
      );
    }

    const disposition = response.headers.get('Content-Disposition') ?? '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : `bridgetalk-transcript-${meetingId}.${format}`;

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    // Revoking frees the blob. Without it the file stays in memory for the
    // lifetime of the tab, which in a long meeting means every download the
    // user ever made is still held.
    URL.revokeObjectURL(objectUrl);

    return filename;
  },
};

// --- system ----------------------------------------------------------------

export const system = {
  health: () => request('/health'),
};

/**
 * Build the URL for the sign-inference WebSocket.
 *
 * The token goes in the query string because the browser WebSocket constructor
 * accepts only a URL — there is no way to set an Authorization header on it.
 */
export function buildPredictSocketUrl(meetingCode) {
  const token = getToken();
  return `${WS_BASE_URL}/ws/predict/${encodeURIComponent(meetingCode)}?token=${encodeURIComponent(
    token ?? '',
  )}`;
}

/**
 * Build the URL for the Whisper transcription WebSocket.
 *
 * Separate from the inference socket on purpose: this one carries binary AUDIO
 * upstream, has a completely different message contract, and only exists when
 * the Whisper provider is selected. Multiplexing audio onto the socket that
 * carries landmarks and captions would mean a transcription failure could take
 * sign recognition down with it.
 */
export function buildTranscribeSocketUrl(meetingCode) {
  const token = getToken();
  return `${WS_BASE_URL}/ws/transcribe/${encodeURIComponent(
    meetingCode,
  )}?token=${encodeURIComponent(token ?? '')}`;
}

export { API_BASE_URL, WS_BASE_URL };
