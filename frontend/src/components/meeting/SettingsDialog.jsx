import { useState } from 'react';

import Dialog from '../ui/Dialog';
import { CAPTION_SIZES, ENGINES, LANGUAGES } from './engines';
import Icon from '../ui/Icon';
import Select from '../ui/Select';

/**
 * Settings, in three tabs: Audio and video, Captions, Sign recognition.
 *
 * EVERY CHANGE APPLIES IMMEDIATELY. THERE IS NO SAVE BUTTON.
 * ---------------------------------------------------------
 * These are settings you change *because something is wrong right now* — the
 * wrong microphone, captions too small to read, the wrong recognition model.
 * Making the user confirm would mean the fix arrives one click later than it
 * could, and a dialog with a Cancel button implies the previous state can be
 * restored, which is not true of a device switch that has already renegotiated
 * the call.
 *
 * THE SIGN RECOGNITION TAB REPORTS WHAT IS REALLY LOADED
 * -----------------------------------------------------
 * Class counts and accuracy come from the server's own model metadata, over the
 * socket's `connected` message. They are not written into the UI as constants,
 * because a hardcoded "92%" beside a model that failed to load, or beside a
 * differently trained one, is a lie told by the interface. A model that is not
 * loaded says so, and its option is disabled.
 */

const TABS = [
  { id: 'av', label: 'Audio and video', icon: 'tune' },
  { id: 'captions', label: 'Captions', icon: 'closed_caption' },
  { id: 'sign', label: 'Sign recognition', icon: 'sign_language' },
];

export default function SettingsDialog({
  open,
  onClose,
  preferences,
  onChange,
  microphones,
  speakers,
  cameras,
  micId,
  speakerId,
  cameraId,
  onMicChange,
  onSpeakerChange,
  onCameraChange,
  modelInfo,
  islModelInfo,
  dynamicModelInfo,
  speechState,
  speechEngineActive,
}) {
  const [tab, setTab] = useState('av');

  // Labels carry the language the LOADED model was actually trained on, from
  // its own metadata, rather than a hardcoded string. predictor.describe()
  // exposes `language` for exactly this reason: a toggle must not read "ASL"
  // while an ISL model is loaded. The fallback in each case is the language that
  // slot is configured for, used only when nothing is loaded to ask.
  const modes = [
    {
      value: 'dynamic',
      label: `Words (${dynamicModelInfo?.language ?? 'ISL'})`,
      info: dynamicModelInfo,
      note: 'Whole-word signs. The mode a fluent signer will use.',
    },
    {
      value: 'isl',
      label: `${islModelInfo?.language ?? 'ISL'} letters`,
      info: islModelInfo,
      note: 'Two-handed Indian Sign Language fingerspelling.',
    },
    {
      value: 'static',
      label: `${modelInfo?.language ?? 'ASL'} letters`,
      info: modelInfo,
      note: 'One-handed American Sign Language fingerspelling.',
    },
  ];

  return (
    <Dialog open={open} onClose={onClose} title="Settings" width="max-w-xl">
      <div role="tablist" aria-label="Settings sections" className="-mt-2 flex gap-1 border-b border-light-border">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors
              ${tab === item.id
                ? 'border-light-blue text-light-blue'
                : 'border-transparent text-light-muted hover:text-light-text'}`}
          >
            <Icon name={item.icon} size={18} />
            <span className="hidden sm:inline">{item.label}</span>
          </button>
        ))}
      </div>

      <div className="pt-5">
        {/* ------------------------- audio and video --------------------- */}
        {tab === 'av' ? (
          <div className="flex flex-col gap-4">
            <Select
              label="Microphone"
              icon="mic"
              value={micId}
              onChange={onMicChange}
              options={toOptions(microphones, 'Microphone')}
            />
            {speakers.length > 0 ? (
              <Select
                label="Speaker"
                icon="volume_up"
                value={speakerId}
                onChange={onSpeakerChange}
                options={toOptions(speakers, 'Speaker')}
              />
            ) : (
              <p className="text-xs text-light-muted">
                This browser does not let a web page choose the speaker. Change
                the output device in your operating system&apos;s sound settings.
              </p>
            )}
            <Select
              label="Camera"
              icon="videocam"
              value={cameraId}
              onChange={onCameraChange}
              options={toOptions(cameras, 'Camera')}
            />
            <p className="text-xs text-light-muted">
              Changing a device restarts that track and swaps it into the call,
              so the other person sees it resume without reconnecting.
            </p>
          </div>
        ) : null}

        {/* ----------------------------- captions ------------------------ */}
        {tab === 'captions' ? (
          <div className="flex flex-col gap-4">
            <Select
              label="Speech recognition engine"
              value={preferences.speechEngine}
              onChange={(value) => onChange({ speechEngine: value })}
              options={ENGINES}
              hint={
                preferences.speechEngine === 'auto'
                  ? 'Uses your browser when it supports speech recognition, and the server otherwise.'
                  : preferences.speechEngine === 'webspeech'
                    ? 'Word-by-word captions as you speak. Needs Chrome or Edge.'
                    : 'Runs on the server. More accurate, but only produces text when you pause.'
              }
            />

            <Select
              label="Spoken language"
              value={preferences.speechLanguage}
              onChange={(value) => onChange({ speechLanguage: value })}
              options={LANGUAGES}
            />

            <div>
              <span className="mb-1.5 block text-xs font-medium text-light-muted">
                Caption size
              </span>
              <div role="radiogroup" aria-label="Caption size" className="flex gap-2">
                {CAPTION_SIZES.map((size) => (
                  <button
                    key={size.value}
                    type="button"
                    role="radio"
                    aria-checked={preferences.captionSize === size.value}
                    onClick={() => onChange({ captionSize: size.value })}
                    className={`h-9 flex-1 rounded-full border text-sm font-medium transition-colors
                      ${preferences.captionSize === size.value
                        ? 'border-light-blue bg-light-blue/[.12] text-light-blue'
                        : 'border-light-border text-light-muted hover:bg-light-surface'}`}
                  >
                    {size.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Honest reporting of what the engine is actually doing, because
                "I spoke and nothing happened" is the bug this product gets. */}
            <dl className="rounded-card bg-light-surface p-3 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-light-muted">Engine in use</dt>
                <dd className="font-medium text-light-text">
                  {speechEngineActive ?? 'not started'}
                </dd>
              </div>
              <div className="mt-1 flex justify-between gap-3">
                <dt className="text-light-muted">State</dt>
                <dd className="font-medium text-light-text">{speechState ?? 'idle'}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        {/* ------------------------- sign recognition -------------------- */}
        {tab === 'sign' ? (
          <div className="flex flex-col gap-4">
            <div>
              <span className="mb-1.5 block text-xs font-medium text-light-muted">
                Recognition mode
              </span>
              <div role="radiogroup" aria-label="Recognition mode" className="flex flex-col gap-2">
                {modes.map((mode) => {
                  const loaded = mode.info?.loaded;
                  const selected = preferences.recognitionMode === mode.value;
                  return (
                    <button
                      key={mode.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={!loaded}
                      onClick={() => onChange({ recognitionMode: mode.value })}
                      className={`rounded-card border p-3 text-left transition-colors
                        disabled:cursor-not-allowed disabled:opacity-50
                        ${selected
                          ? 'border-light-blue bg-light-blue/[.06]'
                          : 'border-light-border hover:bg-light-surface'}`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-light-text">{mode.label}</span>
                        {loaded ? (
                          <span className="text-xs text-light-muted">
                            {mode.info.classes ?? '—'} classes
                          </span>
                        ) : (
                          <span className="text-xs text-light-danger">Not loaded</span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-light-muted">{mode.note}</span>
                      <ModelAccuracy info={mode.info} />
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={preferences.showHandOverlay}
                onChange={(event) => onChange({ showHandOverlay: event.target.checked })}
                className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-light-blue"
              />
              <span>
                <span className="block text-sm text-light-text">Show hand overlay</span>
                <span className="mt-0.5 block text-xs text-light-muted">
                  Draws the tracked hand skeleton on your own tile. Only you see
                  it.
                </span>
              </span>
            </label>

            <p className="rounded-card bg-light-surface p-3 text-xs leading-relaxed text-light-muted">
              Hand tracking runs in your browser. Only 21 coordinates per hand
              are sent to produce captions — your video never leaves this device.
            </p>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * The model's measured accuracy, or an explicit statement that there is none.
 *
 * THE NUMBER IS LABELLED "VALIDATION", BECAUSE THAT IS WHAT IT IS
 * --------------------------------------------------------------
 * `predictor.describe()` returns `val_accuracy`, read from the training run's
 * metrics. Calling it "test accuracy" in the interface would overstate it: the
 * validation split is what early stopping and threshold choices were made
 * against, so it is optimistic by construction. The honest figures for the one
 * trained-and-evaluated model live in PROGRESS.md, measured on a held-out test
 * split the model never saw.
 *
 * "No accuracy recorded" is printed rather than the line being hidden, because
 * some of these slots are pipeline-complete but untrained, and a blank space
 * invites the reader to assume the number is simply somewhere else.
 */
function ModelAccuracy({ info }) {
  if (!info?.loaded) return null;

  const accuracy = info.val_accuracy ?? null;
  if (accuracy == null) {
    return (
      <span className="mt-1 block text-xs text-light-muted">
        No accuracy recorded for this model.
      </span>
    );
  }

  const percent = accuracy <= 1 ? accuracy * 100 : accuracy;
  return (
    <span className="mt-1 block text-xs text-light-muted">
      {percent.toFixed(1)}% validation accuracy
      {info.signer_disjoint === false ? ', signers not held out' : ''}.
    </span>
  );
}

function toOptions(devices, kind) {
  return (devices ?? []).map((device, index) => ({
    value: device.deviceId,
    label: device.label || `${kind} ${index + 1}`,
  }));
}
