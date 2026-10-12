import { useRef, useState } from 'react';

import { useClock } from '../../hooks/useClock';
import { formatClockTime } from '../../utils/formatters';
import Icon from '../ui/Icon';
import IconButton from '../ui/IconButton';
import { Menu, MenuDivider, MenuItem } from '../ui/Menu';

/**
 * The 80px bar at the bottom of the meeting, in three zones.
 *
 * Left: the time and the meeting code. Centre: the six round buttons and the
 * leave pill. Right: the three buttons that open the side panels.
 *
 * WHY THE CENTRE IS ABSOLUTELY POSITIONED
 * ---------------------------------------
 * The three zones are not equal widths — the left shows a clock and a code, the
 * right three icons — so a flexbox `justify-between` would leave the centre
 * group off-centre, and it would SHIFT as the code or the clock changed width.
 * The controls are the thing the eye returns to, so they are pinned to the true
 * centre of the bar and the side zones are laid out around them.
 *
 * On a narrow screen the pinning is dropped and the bar becomes a simple
 * centred row, because at that width there is no room for three zones and the
 * controls matter more than the clock.
 */
export default function ControlBar({
  micOn,
  cameraOn,
  captionsOn,
  signOn,
  signAvailable,
  signModelsKnown,
  isPresenting,
  someoneElseIsPresenting,
  openPanel,
  isHost,
  interviewOn,
  meetingCode,
  onToggleMic,
  onToggleCamera,
  onToggleCaptions,
  onToggleSign,
  onPresent,
  onOpenPanel,
  onOpenSettings,
  onToggleFullscreen,
  onStartInterviewMode,
  canLeave = true,
  onLeave,
  onEndForEveryone,
}) {
  const now = useClock();
  const [moreOpen, setMoreOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const barRef = useRef(null);

  return (
    <footer
      ref={barRef}
      className="on-dark relative flex h-controlbar shrink-0 items-center justify-center
                 gap-2 bg-dark-bg px-4 sm:justify-between"
    >
      {/* ------------------------------- left ---------------------------- */}
      <div className="hidden items-center gap-3 text-sm text-dark-muted sm:flex">
        <span>{formatClockTime(now)}</span>
        <span aria-hidden="true" className="text-dark-surface">|</span>
        <span className="font-mono">{meetingCode}</span>
      </div>

      {/* ------------------------------ centre --------------------------- */}
      <div className="flex items-center gap-2 sm:absolute sm:left-1/2 sm:-translate-x-1/2">
        <IconButton
          icon={micOn ? 'mic' : 'mic_off'}
          label={micOn ? 'Turn off microphone' : 'Turn on microphone'}
          shortcut="Ctrl+D"
          onClick={onToggleMic}
          danger={!micOn}
        />
        <IconButton
          icon={cameraOn ? 'videocam' : 'videocam_off'}
          label={cameraOn ? 'Turn off camera' : 'Turn on camera'}
          shortcut="Ctrl+E"
          onClick={onToggleCamera}
          danger={!cameraOn}
        />
        <IconButton
          icon="closed_caption"
          label={captionsOn ? 'Hide captions' : 'Show captions'}
          shortcut="C"
          onClick={onToggleCaptions}
          active={captionsOn}
        />
        <IconButton
          icon="sign_language"
          // THREE states, not two. "Not loaded" and "not yet known" are
          // different things, and conflating them meant the button accused the
          // server of having no model during the fraction of a second before
          // the socket had reported — which is alarming and untrue.
          label={
            !cameraOn
              ? 'Turn on your camera to sign'
              : !signModelsKnown
                ? 'Connecting to sign recognition…'
                : !signAvailable
                  ? 'No sign recognition model is loaded'
                  : signOn
                    ? 'Turn off sign recognition'
                    : 'Turn on sign recognition'
          }
          onClick={onToggleSign}
          active={signOn}
          // Disabled with an explanatory tooltip rather than hidden: a signer
          // whose camera is off needs to know the button exists and why it
          // cannot be used.
          disabled={!cameraOn || !signAvailable}
        />
        <IconButton
          icon={isPresenting ? 'cancel_presentation' : 'present_to_all'}
          label={
            isPresenting
              ? 'Stop presenting'
              : someoneElseIsPresenting
                ? 'Take over presenting'
                : 'Present your screen'
          }
          onClick={onPresent}
          active={isPresenting}
        />

        <div className="relative">
          <IconButton
            icon="more_vert"
            label="More options"
            onClick={() => setMoreOpen((open) => !open)}
            active={moreOpen}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
          />
          <Menu
            open={moreOpen}
            onClose={() => setMoreOpen(false)}
            className="bottom-full mb-3 min-w-[260px]"
          >
            <MenuItem icon="settings" onClick={() => { setMoreOpen(false); onOpenSettings(); }}>
              Settings
            </MenuItem>
            <MenuItem icon="fullscreen" onClick={() => { setMoreOpen(false); onToggleFullscreen(); }}>
              Full screen
            </MenuItem>
            {isHost ? (
              <>
                <MenuDivider />
                {/* ONE-WAY. Once on it cannot be switched off: an interview
                    that can be un-invigilated mid-session is not an interview,
                    and a candidate who saw the mode turn off would reasonably
                    assume the recording had stopped. Ending the meeting is the
                    only way to finish it, and the server enforces this too. */}
                <MenuItem
                  icon="policy"
                  disabled={interviewOn}
                  onClick={() => { setMoreOpen(false); onStartInterviewMode(); }}
                  description={
                    interviewOn
                      ? 'Already on. End the meeting to finish the interview.'
                      : 'Records when people leave the meeting tab. Cannot be undone.'
                  }
                >
                  {interviewOn ? 'Interview mode is on' : 'Turn on interview mode'}
                </MenuItem>
              </>
            ) : null}
          </Menu>
        </div>

        {/* Leave. The host gets a choice, because "end for everyone" is
            destructive and must never be one click away from "leave". */}
        {/* Leave. The host gets a choice, because "end for everyone" is
            destructive and must never be one click away from "leave".

            During an interview the PARTICIPANT cannot leave at all: ending the
            meeting is the host's decision, and it is the only thing that
            releases the keyboard lock and fullscreen. The button is disabled
            with an explanation rather than hidden, so the candidate can see
            why. */}
        <div className="group relative ml-1 inline-flex">
          <button
            type="button"
            onClick={() => (isHost ? setLeaveOpen((open) => !open) : onLeave())}
            disabled={!canLeave}
            aria-label={canLeave ? 'Leave call' : 'Only the host can end this interview'}
            aria-haspopup={isHost ? 'menu' : undefined}
            aria-expanded={isHost ? leaveOpen : undefined}
            className="grid h-12 place-items-center rounded-full bg-dark-danger px-6
                       text-white transition hover:brightness-110
                       disabled:cursor-not-allowed disabled:opacity-40
                       disabled:hover:brightness-100"
          >
            <Icon name="call_end" size={24} />
          </button>

          {!canLeave ? (
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2
                         -translate-x-1/2 whitespace-nowrap rounded bg-[#202124] px-2
                         py-1 text-xs font-medium text-white opacity-0 shadow-menu
                         transition-opacity group-hover:opacity-100
                         group-focus-within:opacity-100"
            >
              Only the host can end this interview
            </span>
          ) : null}

          {isHost ? (
            <Menu
              open={leaveOpen}
              onClose={() => setLeaveOpen(false)}
              className="bottom-full mb-3 min-w-[260px]"
            >
              {/* Hidden during an interview: the host leaving without ending
                  it would leave the candidate locked in fullscreen with no way
                  out, which is the one state this feature must never reach. */}
              {interviewOn ? null : (
                <MenuItem icon="logout" onClick={() => { setLeaveOpen(false); onLeave(); }}>
                  Just leave the meeting
                </MenuItem>
              )}
              <MenuItem
                icon="call_end"
                destructive
                onClick={() => { setLeaveOpen(false); onEndForEveryone(); }}
                description={
                  interviewOn
                    ? 'This ends the interview and releases the candidate. Nobody will be able to rejoin.'
                    : 'Nobody will be able to rejoin'
                }
              >
                End meeting for everyone
              </MenuItem>
            </Menu>
          ) : null}
        </div>
      </div>

      {/* ------------------------------ right ---------------------------- */}
      <div className="hidden items-center gap-1 sm:flex">
        <IconButton
          icon="info"
          label="Meeting details"
          size={44}
          iconSize={22}
          active={openPanel === 'details'}
          onClick={() => onOpenPanel('details')}
        />
        <IconButton
          icon="group"
          label="People"
          size={44}
          iconSize={22}
          active={openPanel === 'people'}
          onClick={() => onOpenPanel('people')}
        />
        <IconButton
          icon="description"
          label="Transcript"
          size={44}
          iconSize={22}
          active={openPanel === 'transcript'}
          onClick={() => onOpenPanel('transcript')}
        />
      </div>
    </footer>
  );
}
