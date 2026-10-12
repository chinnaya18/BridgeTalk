import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import History from '../pages/History';
import Home from '../pages/Home';
import Lobby from '../pages/Lobby';
import Login from '../pages/Login';
import MeetingEnded from '../pages/MeetingEnded';
import MeetingRoom from '../pages/MeetingRoom';
import SignDetection from '../pages/SignDetection';
import Transcript from '../pages/Transcript';
import { MEETING, installApiStub, renderPage } from './renderPage';

/**
 * Every page renders without throwing.
 *
 * THIS SUITE EXISTS BECAUSE OF A SPECIFIC FAILURE
 * -----------------------------------------------
 * MeetingRoom shipped with eleven use-before-define errors. Each one threw
 * "Cannot access 'X' before initialization" the moment the component rendered,
 * and the meeting screen showed the error boundary instead of the meeting.
 * `vite build` passed, because bundling does not evaluate the module.
 *
 * So the assertion each test makes is the one that was missing: mount the page,
 * and fail if anything throws. The afterEach hook in setup.js additionally fails
 * the test if React logged a render error into console.error, which is how a
 * crash caught by an error boundary would otherwise go unnoticed.
 */
describe('every page renders', () => {
  beforeEach(() => {
    installApiStub();
  });

  it('Login', async () => {
    renderPage(<Login initialMode="login" />, { path: '/login' });
    expect(await screen.findByText('Sign in to BridgeTalk')).toBeTruthy();
  });

  it('Register', async () => {
    renderPage(<Login initialMode="register" />, { path: '/register' });
    expect(await screen.findByText('Create your account')).toBeTruthy();
    // The two register-only fields the specification asks for.
    expect(screen.getByLabelText(/Full name/i)).toBeTruthy();
    expect(screen.getByLabelText(/Confirm password/i)).toBeTruthy();
  });

  it('Home', async () => {
    renderPage(<Home />, { path: '/' });
    expect(await screen.findByRole('button', { name: /New meeting/i })).toBeTruthy();
    // Recent meetings arrive from the stubbed history endpoint.
    expect(await screen.findByText('Project review')).toBeTruthy();
  });

  it('History', async () => {
    renderPage(<History />, { path: '/history' });
    expect(await screen.findByText('Meeting history')).toBeTruthy();
    expect(await screen.findByText('Project review')).toBeTruthy();
  });

  it('Transcript', async () => {
    renderPage(<Transcript />, { path: '/history/:code', entry: '/history/K7Q-2M4' });
    expect(await screen.findByText('good morning')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Download TXT/i })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Download PDF/i })).toBeTruthy();
  });

  it('Lobby', async () => {
    renderPage(<Lobby />, { path: '/lobby/:code', entry: '/lobby/K7Q-2M4' });
    expect(await screen.findByText('Ready to join?')).toBeTruthy();
    expect(
      await screen.findByText(/I will be signing in this meeting/i),
    ).toBeTruthy();
  });

  it('MeetingRoom', async () => {
    renderPage(<MeetingRoom />, { path: '/meeting/:code', entry: '/meeting/K7Q-2M4' });

    // The control bar is the proof the page got all the way through render.
    expect(await screen.findByRole('button', { name: /Turn off microphone/i })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Turn off camera/i })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Hide captions/i })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Leave call/i })).toBeTruthy();
  });

  it('MeetingEnded', async () => {
    renderPage(<MeetingEnded />, { path: '/ended/:code', entry: '/ended/K7Q-2M4' });
    expect(await screen.findByText('You left the meeting')).toBeTruthy();
    expect(
      await screen.findByText(/The transcript of this meeting has been saved/i),
    ).toBeTruthy();
  });

  it('SignDetection', async () => {
    renderPage(<SignDetection />, { path: '/detect' });
    expect(await screen.findByText('Sign recognition check')).toBeTruthy();
  });
});

describe('the meeting room honours the lobby', () => {
  beforeEach(() => {
    installApiStub();
  });

  /**
   * Device choices are read from sessionStorage, not the URL.
   *
   * Reported problem 6 was a raw deviceId in the join link. The lobby was moved
   * to sessionStorage, but the meeting room was still reading
   * `searchParams.get('camera')` — which is now always null, so every meeting
   * silently used the system default camera and the lobby's picker did nothing.
   */
  it('requests the camera and microphone chosen in the lobby', async () => {
    sessionStorage.setItem(
      'bridgetalk.devices',
      JSON.stringify({ micId: 'mic-1', cameraId: 'cam-1', willSign: true }),
    );

    renderPage(<MeetingRoom />, { path: '/meeting/:code', entry: '/meeting/K7Q-2M4' });
    await screen.findByRole('button', { name: /Leave call/i });

    await waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
    });

    const constraints = navigator.mediaDevices.getUserMedia.mock.calls[0][0];
    expect(constraints.video.deviceId).toEqual({ exact: 'cam-1' });
    expect(constraints.audio.deviceId).toEqual({ exact: 'mic-1' });
    // Echo cancellation is not optional: speech recognition runs on this
    // microphone, so the remote voice coming back would be transcribed as if
    // this user had said it.
    expect(constraints.audio.echoCancellation).toBe(true);
    expect(constraints.audio.noiseSuppression).toBe(true);
  });

  /**
   * Sign recognition is opt-in, and the lobby checkbox is what opts in.
   *
   * It defaulted to true for everyone, which is why a hearing participant's
   * resting hands were being recognised as signs ("M at 71%").
   */
  it('starts with sign recognition off unless the lobby asked for it', async () => {
    renderPage(<MeetingRoom />, { path: '/meeting/:code', entry: '/meeting/K7Q-2M4' });
    expect(
      await screen.findByRole('button', { name: /Turn on sign recognition/i }),
    ).toBeTruthy();
  });

  it('starts with sign recognition on when the lobby asked for it', async () => {
    sessionStorage.setItem('bridgetalk.devices', JSON.stringify({ willSign: true }));

    renderPage(<MeetingRoom />, { path: '/meeting/:code', entry: '/meeting/K7Q-2M4' });
    expect(
      await screen.findByRole('button', { name: /Turn off sign recognition/i }),
    ).toBeTruthy();
  });

  /** Captions are on by default for everyone, per the specification. */
  it('shows captions by default', async () => {
    renderPage(<MeetingRoom />, { path: '/meeting/:code', entry: '/meeting/K7Q-2M4' });
    expect(await screen.findByRole('button', { name: /Hide captions/i })).toBeTruthy();
    expect(await screen.findByLabelText('Live captions')).toBeTruthy();
  });
});

describe('Bug 2 — the caption area shows only other people', () => {
  beforeEach(() => {
    installApiStub();
  });

  /**
   * Pushes a caption event through the REAL socket path: the fake WebSocket
   * delivers it, useSignSocket parses it, useCaptionStore applies it, and
   * CaptionRail renders it. Nothing is stubbed between the wire and the DOM.
   */
  // A distinct segment id per call. Deriving it from the text (its length, say)
  // is a trap: two different phrases of the same length would collide and the
  // store would correctly REPLACE one with the other, which looks like a
  // grouping bug but is the protocol working.
  let segmentCounter = 0;

  async function deliverCaption({ speakerId, speakerName, source, text, segmentId }) {
    // Read the class off globalThis rather than importing setup.js: that is the
    // exact class the app constructed, with no chance of a second module
    // instance owning a different `instances` array.
    const sockets = globalThis.WebSocket.instances ?? [];
    const socket = await waitFor(() => {
      const found = sockets.find((s) => s.url.includes('/ws/predict'));
      expect(found, 'no /ws/predict socket was opened').toBeTruthy();
      return found;
    });

    await act(async () => {
      socket.emit({
        type: 'caption',
        meeting_code: 'K7Q-2M4',
        segment_id: segmentId ?? `seg-${speakerId}-${(segmentCounter += 1)}`,
        speaker: { id: speakerId, name: speakerName },
        source,
        text,
        is_final: true,
        confidence: null,
        timestamp: new Date().toISOString(),
      });
    });
  }

  it("shows the other participant's caption but not your own", async () => {
    // installApiStub signs us in as user id 1.
    renderPage(<MeetingRoom />, { path: '/meeting/:code', entry: '/meeting/K7Q-2M4' });
    await screen.findByRole('button', { name: /Leave call/i });

    await deliverCaption({
      speakerId: 2,
      speakerName: 'Thamizhthilaga S D S',
      source: 'sign',
      text: 'good morning from the other side',
    });
    expect(await screen.findByText(/good morning from the other side/)).toBeTruthy();

    await deliverCaption({
      speakerId: 1,
      speakerName: 'Swarna Rathna A',
      source: 'speech',
      text: 'these are my own words',
    });

    // The caption area must not echo your own words back at you.
    const area = screen.getByLabelText('Live captions');
    expect(area.textContent).toContain('good morning from the other side');
    expect(area.textContent).not.toContain('these are my own words');
  });

  it('merges consecutive captions from one speaker into a single block', async () => {
    renderPage(<MeetingRoom />, { path: '/meeting/:code', entry: '/meeting/K7Q-2M4' });
    await screen.findByRole('button', { name: /Leave call/i });

    await deliverCaption({ speakerId: 2, speakerName: 'Thamizh', source: 'speech', text: 'first part' });
    await deliverCaption({ speakerId: 2, speakerName: 'Thamizh', source: 'speech', text: 'second bit' });

    const area = screen.getByLabelText('Live captions');
    // One block: the speaker's name appears once, and both texts are present.
    expect(area.textContent).toContain('first part');
    expect(area.textContent).toContain('second bit');
    expect(area.querySelectorAll('article')).toHaveLength(1);
  });
});

describe('Bug 3 — interview mode reaches the participant', () => {
  beforeEach(() => {
    installApiStub();
  });

  function predictSocket() {
    const sockets = globalThis.WebSocket.instances ?? [];
    return sockets.find((s) => s.url.includes('/ws/predict'));
  }

  /**
   * THE BUG 3 SYMPTOM, end to end.
   *
   * The state used to reach only the host, so the participant never saw this
   * dialog and no enforcement ever started. installApiStub signs us in as user
   * id 1 and the stubbed meeting's host is also id 1 — so for this test the
   * meeting is re-stubbed with a DIFFERENT host, making us the participant.
   */
  it('shows the blocking dialog when the host switches it on mid-meeting', async () => {
    const otherHost = {
      id: 99, name: 'Dr R Manavalan', email: 'guide@example.com',
      role: 'hearing', created_at: '2026-10-01T09:00:00',
    };
    installApiStub({ meeting: { ...MEETING, host: otherHost, is_interview_mode: false } });

    renderPage(<MeetingRoom />, { path: '/meeting/:code', entry: '/meeting/K7Q-2M4' });
    await screen.findByRole('button', { name: /Leave call/i });

    // Not shown yet.
    expect(screen.queryByText(/The host has turned on interview mode/i)).toBeNull();

    const socket = await waitFor(() => {
      const found = predictSocket();
      expect(found).toBeTruthy();
      return found;
    });

    await act(async () => {
      socket.emit({
        type: 'interview-mode',
        meeting_code: 'K7Q-2M4',
        is_interview_mode: true,
        interview_mode_started_at: new Date().toISOString(),
        host: { id: 99, name: 'Dr R Manavalan' },
      });
    });

    // The wording the brief specifies, and the one button.
    expect(
      await screen.findByText(/The host has turned on interview mode/i),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Continue in full screen/i }),
    ).toBeTruthy();
  });

  it('shows the dialog from the handshake, so reloading is not an escape', async () => {
    const otherHost = {
      id: 99, name: 'Dr R Manavalan', email: 'guide@example.com',
      role: 'hearing', created_at: '2026-10-01T09:00:00',
    };
    // The meeting already has the mode on when this client loads it.
    installApiStub({
      meeting: {
        ...MEETING,
        host: otherHost,
        is_interview_mode: true,
        interview_mode_started_at: '2026-10-12T09:00:00',
      },
    });

    renderPage(<MeetingRoom />, { path: '/meeting/:code', entry: '/meeting/K7Q-2M4' });

    expect(
      await screen.findByText(/The host has turned on interview mode/i),
    ).toBeTruthy();
  });

  it("the participant's Leave button is disabled during an interview", async () => {
    const otherHost = {
      id: 99, name: 'Dr R Manavalan', email: 'guide@example.com',
      role: 'hearing', created_at: '2026-10-01T09:00:00',
    };
    installApiStub({
      meeting: {
        ...MEETING,
        host: otherHost,
        is_interview_mode: true,
        interview_mode_started_at: '2026-10-12T09:00:00',
      },
    });

    renderPage(<MeetingRoom />, { path: '/meeting/:code', entry: '/meeting/K7Q-2M4' });

    const leave = await screen.findByRole('button', {
      name: /Only the host can end this interview/i,
    });
    expect(leave.disabled).toBe(true);
  });

  it('the host can still leave, and is not shown the dialog', async () => {
    // Default stub: we ARE the host (id 1).
    installApiStub({ meeting: { ...MEETING, is_interview_mode: true } });

    renderPage(<MeetingRoom />, { path: '/meeting/:code', entry: '/meeting/K7Q-2M4' });

    const leave = await screen.findByRole('button', { name: /Leave call/i });
    expect(leave.disabled).toBe(false);
    expect(screen.queryByText(/The host has turned on interview mode/i)).toBeNull();
  });
});

describe('Bug 4 — the participant count comes from the server', () => {
  /**
   * The count used to be `participants.length`, and the attendance table was
   * append-only — so a participant who reconnected three times was reported as
   * three participants. The fix computes COUNT(DISTINCT user_id) server-side
   * and every surface reads that one field.
   *
   * These stubs deliberately give a participants array SHORTER than
   * participant_count. If a surface still derived the number from the array it
   * would show the wrong one, so this proves the field is what is read.
   */
  const soloList = [MEETING.participants[0]];

  it('History shows the server count, not the length of the array', async () => {
    installApiStub({
      meeting: { ...MEETING, participants: soloList, participant_count: 4 },
    });

    renderPage(<History />, { path: '/history' });

    expect(await screen.findByText('4 participants')).toBeTruthy();
    expect(screen.queryByText('1 participant')).toBeNull();
  });

  it('Home shows the server count', async () => {
    installApiStub({
      meeting: { ...MEETING, participants: soloList, participant_count: 3 },
    });

    renderPage(<Home />, { path: '/' });
    await screen.findByText('Project review');

    expect(await screen.findByText(/3 participants/)).toBeTruthy();
  });

  it('the meeting-ended page shows the server count', async () => {
    installApiStub({
      meeting: { ...MEETING, participants: soloList, participant_count: 2 },
    });

    renderPage(<MeetingEnded />, { path: '/ended/:code', entry: '/ended/K7Q-2M4' });

    expect(await screen.findByText(/2 participants/)).toBeTruthy();
  });

  it('falls back to the array length when the server sends no count', async () => {
    // Defensive: an older backend, or a cached response.
    const { participant_count: _omitted, ...withoutCount } = MEETING;
    installApiStub({ meeting: { ...withoutCount, participants: MEETING.participants } });

    renderPage(<History />, { path: '/history' });
    expect(await screen.findByText('2 participants')).toBeTruthy();
  });
});
