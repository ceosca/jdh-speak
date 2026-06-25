import { useCallback, useEffect, useId, useState } from "react";
import { useRoomStore } from "../stores/room";
import { canSelectSpeaker } from "../lib/audio-devices";
import { m } from "../paraglide/messages.js";

// Mic/speaker pickers. This component only reads/writes the store — the
// consumers react to the change: the lobby's MicPreview restarts its preview
// on the new mic and re-sinks its context, and useMediasoup re-acquires the
// in-call mic / re-sinks the shared context. So the same control works in the
// lobby and mid-call, and the choice (localStorage-backed) carries between.
export function DeviceSettings() {
  const micDeviceId = useRoomStore((s) => s.micDeviceId);
  const speakerDeviceId = useRoomStore((s) => s.speakerDeviceId);
  const setMicDeviceId = useRoomStore((s) => s.setMicDeviceId);
  const setSpeakerDeviceId = useRoomStore((s) => s.setSpeakerDeviceId);

  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const micSelectId = useId();
  const micHintId = useId();
  const speakerSelectId = useId();

  const refresh = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      // Pre-permission entries come back with empty ids/labels — drop them;
      // the explicit "Default" option covers that case.
      setMics(devices.filter((d) => d.kind === "audioinput" && d.deviceId));
      setSpeakers(devices.filter((d) => d.kind === "audiooutput" && d.deviceId));
    } catch {
      // enumerateDevices unavailable — leave the lists empty (Default only).
    }
  }, []);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  }, [refresh]);

  // A stored device that's gone (unplugged) renders as Default; the media
  // constraints use `ideal`, so capture falls back to the default device too.
  const micValue = mics.some((d) => d.deviceId === micDeviceId) ? micDeviceId : "";
  const speakerValue = speakers.some((d) => d.deviceId === speakerDeviceId) ? speakerDeviceId : "";

  const selectClass =
    "w-full rounded-lg border border-sonic-600 bg-sonic-700 px-2.5 py-1.5 text-sm text-sonic-100 transition-colors focus:border-sonic-accent focus:outline-none";

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={micSelectId} className="mb-1 block text-xs font-medium text-sonic-300">
          {m.settings_mic_label()}
        </label>
        <select
          id={micSelectId}
          value={micValue}
          onChange={(e) => setMicDeviceId(e.target.value)}
          onFocus={() => void refresh()}
          aria-describedby={mics.length === 0 ? micHintId : undefined}
          className={selectClass}
        >
          <option value="">{m.settings_default_device()}</option>
          {mics.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || m.settings_mic_fallback({ n: i + 1 })}
            </option>
          ))}
        </select>
      </div>

      {canSelectSpeaker() && (
        <div>
          <label
            htmlFor={speakerSelectId}
            className="mb-1 block text-xs font-medium text-sonic-300"
          >
            {m.settings_speaker_label()}
          </label>
          <select
            id={speakerSelectId}
            value={speakerValue}
            onChange={(e) => setSpeakerDeviceId(e.target.value)}
            onFocus={() => void refresh()}
            className={selectClass}
          >
            <option value="">{m.settings_default_device()}</option>
            {speakers.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || m.settings_speaker_fallback({ n: i + 1 })}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Browsers hide device names until mic permission is granted (e.g. in
          the lobby before the first test) — explain the bare lists. Tied to the
          mic select via aria-describedby (only while it's shown). */}
      {mics.length === 0 && (
        <p id={micHintId} className="text-xs text-sonic-400">
          {m.settings_labels_hint()}
        </p>
      )}
    </div>
  );
}
