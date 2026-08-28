import { useCallback, useEffect, useId, useState } from "react";
import { useRoomStore } from "../stores/room";
import { canSelectSpeaker, canSelectElementSink } from "../lib/audio-devices";
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

  const secondaryEnabled = useRoomStore((s) => s.secondaryEnabled);
  const secondaryDeviceId = useRoomStore((s) => s.secondaryDeviceId);
  const secondaryMonitor = useRoomStore((s) => s.secondaryMonitor);
  const setSecondaryEnabled = useRoomStore((s) => s.setSecondaryEnabled);
  const setSecondaryDeviceId = useRoomStore((s) => s.setSecondaryDeviceId);
  const setSecondaryMonitor = useRoomStore((s) => s.setSecondaryMonitor);

  const shareMonitor = useRoomStore((s) => s.shareMonitor);
  const jamMode = useRoomStore((s) => s.jamMode);
  const networkMonitor = useRoomStore((s) => s.networkMonitor);
  const setShareMonitor = useRoomStore((s) => s.setShareMonitor);
  const setJamMode = useRoomStore((s) => s.setJamMode);
  const setNetworkMonitor = useRoomStore((s) => s.setNetworkMonitor);
  const netMonitorDeviceId = useRoomStore((s) => s.netMonitorDeviceId);
  const setNetMonitorDeviceId = useRoomStore((s) => s.setNetMonitorDeviceId);
  const jamBufferMinMs = useRoomStore((s) => s.jamBufferMinMs);
  const setJamBufferMinMs = useRoomStore((s) => s.setJamBufferMinMs);
  const metronomeBpm = useRoomStore((s) => s.metronomeBpm);
  const metronomeRunning = useRoomStore((s) => s.metronomeRunning);
  const metronomeSyncMs = useRoomStore((s) => s.metronomeSyncMs);

  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const micSelectId = useId();
  const micHintId = useId();
  const speakerSelectId = useId();
  const secondaryCheckId = useId();
  const secondaryHintId = useId();
  const secondarySelectId = useId();
  const secondaryMonitorId = useId();
  const shareMonitorId = useId();
  const shareMonitorHintId = useId();
  const jamModeId = useId();
  const jamModeHintId = useId();
  const jamBufMinId = useId();
  const jamBufHintId = useId();
  const jamBufMinDescId = useId();
  const jamBufLiveId = useId();
  const metroHintId = useId();
  const metroBpmId = useId();
  const netMonitorId = useId();
  const netMonitorHintId = useId();
  const netMonitorSelectId = useId();

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

  // Live jitter-buffer readout (the actual buffered ms / drops the jam playout is
  // running at) so the sliders can be tuned by ear+eye. Polled from the shared stat the
  // buffers publish; only while jam is on.
  // Live MEASURED receive latency (window.__rxLatencyMs — the NetEQ jitter-buffer delay
  // averaged across peers, from getStats). Shown so the slider's effect is VISIBLE: move
  // it and watch the number. If it doesn't move, the buffer is already at the network's
  // jitter floor (can't go lower without cutting) — not a bug, physics.
  const [rxLatency, setRxLatency] = useState<number | null>(null);
  useEffect(() => {
    if (!jamMode) {
      setRxLatency(null);
      return;
    }
    const id = window.setInterval(() => {
      const v = (window as unknown as { __rxLatencyMs?: number }).__rxLatencyMs;
      setRxLatency(typeof v === "number" ? v : null);
    }, 1000);
    return () => window.clearInterval(id);
  }, [jamMode]);

  // MEASURED latency (from getStats), ALWAYS shown so the jam-vs-normal comparison is a
  // number you can read at a glance — no console. rx = NetEQ receive buffer; rtt = the
  // round-trip to peers (P2P direct). Compare these in jam vs normal.
  const [rxMs, setRxMs] = useState<number | null>(null);
  const [txRtt, setTxRtt] = useState<number | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      const w = window as unknown as { __rxLatencyMs?: number | null; __txRttMs?: number | null };
      setRxMs(typeof w.__rxLatencyMs === "number" ? w.__rxLatencyMs : null);
      setTxRtt(typeof w.__txRttMs === "number" ? w.__txRttMs : null);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

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

      <div>
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            id={secondaryCheckId}
            checked={secondaryEnabled}
            onChange={(e) => setSecondaryEnabled(e.target.checked)}
            aria-describedby={secondaryHintId}
            className="mt-0.5 shrink-0 accent-sonic-accent"
          />
          <label htmlFor={secondaryCheckId} className="text-xs font-medium text-sonic-300 cursor-pointer">
            {m.settings_secondary_label()}
          </label>
        </div>
        <p id={secondaryHintId} className="mt-1 text-xs text-sonic-400">
          {m.settings_secondary_hint()}
        </p>
      </div>

      {secondaryEnabled && (
        <>
          <div>
            <label htmlFor={secondarySelectId} className="mb-1 block text-xs font-medium text-sonic-300">
              {m.settings_secondary_device_label()}
            </label>
            <select
              id={secondarySelectId}
              value={mics.some((d) => d.deviceId === secondaryDeviceId) ? secondaryDeviceId : ""}
              onChange={(e) => setSecondaryDeviceId(e.target.value)}
              onFocus={() => void refresh()}
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

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={secondaryMonitorId}
              checked={secondaryMonitor}
              onChange={(e) => setSecondaryMonitor(e.target.checked)}
              className="shrink-0 accent-sonic-accent"
            />
            <label htmlFor={secondaryMonitorId} className="text-xs font-medium text-sonic-300 cursor-pointer">
              {m.settings_secondary_monitor_label()}
            </label>
          </div>
        </>
      )}

      <div>
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            id={shareMonitorId}
            checked={shareMonitor}
            onChange={(e) => setShareMonitor(e.target.checked)}
            aria-describedby={shareMonitorHintId}
            className="mt-0.5 shrink-0 accent-sonic-accent"
          />
          <label htmlFor={shareMonitorId} className="text-xs font-medium text-sonic-300 cursor-pointer">
            {m.settings_share_monitor_label()}
          </label>
        </div>
        <p id={shareMonitorHintId} className="mt-1 text-xs text-sonic-400">
          {m.settings_share_monitor_hint()}
        </p>
      </div>

      {/* Jam mode: minimise latency for playing instruments together (unprocessed
          capture + tiny jitter buffer). ROOM-WIDE: toggling it broadcasts to the
          whole room (all-or-nobody) via onJamToggle; falls back to the local flag
          before a call is joined. */}
      <div>
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            id={jamModeId}
            checked={jamMode}
            onChange={(e) =>
              (useRoomStore.getState().onJamToggle ?? setJamMode)(e.target.checked)
            }
            aria-describedby={jamModeHintId}
            className="mt-0.5 shrink-0 accent-sonic-accent"
          />
          <label htmlFor={jamModeId} className="text-xs font-medium text-sonic-300 cursor-pointer">
            {m.settings_jam_label()}
          </label>
        </div>
        <p id={jamModeHintId} className="mt-1 text-xs text-sonic-400">
          {m.settings_jam_hint()}
        </p>
        {/* MEASURED latency, shown whenever there are peers — read it in jam vs normal to
            compare with a number, not by ear. */}
        {(rxMs !== null || txRtt !== null) && (
          <p className="mt-2 rounded-md bg-sonic-800/50 px-2 py-1 text-xs tabular-nums text-sonic-300">
            {m.settings_jam_measured({
              rx: rxMs === null ? "—" : String(rxMs),
              rtt: txRtt === null ? "—" : String(txRtt),
            })}
          </p>
        )}

        {/* ONE Jamulus-style fader: the jitter cushion. Clock drift is now cancelled by
            resampling inside the buffer (no growing delay, no dropped-frame clicks), so
            the old "max" ceiling is gone — this slider is purely the jitter reserve.
            Live, per-user, no rebuild. Only shown while jam is on. */}
        {jamMode && (
          <div
            role="group"
            aria-labelledby={jamBufHintId}
            className="mt-3 rounded-lg border border-sonic-600 bg-sonic-800/40 p-2.5"
          >
            <p id={jamBufHintId} className="mb-2 text-xs text-sonic-400">
              {m.settings_jam_buffer_hint()}
            </p>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor={jamBufMinId} className="text-xs font-medium text-sonic-300">
                  {m.settings_jam_buffer_label()}
                </label>
                <span className="text-xs tabular-nums text-sonic-200">{jamBufferMinMs} ms</span>
              </div>
              <input
                type="range"
                id={jamBufMinId}
                min={0}
                max={100}
                step={1}
                value={jamBufferMinMs}
                onChange={(e) => setJamBufferMinMs(Number(e.target.value))}
                aria-describedby={jamBufMinDescId}
                aria-valuetext={`${jamBufferMinMs} ms`}
                className="w-full accent-sonic-accent"
              />
              <p id={jamBufMinDescId} className="mt-1 text-xs text-sonic-400">
                {m.settings_jam_buffer_desc()}
              </p>
            </div>
            {/* Live MEASURED receive latency (real getStats number). Move the slider and
                watch it: if it drops, the slider is working; if it's stuck, you're at the
                network's jitter floor and it can't go lower without cutting. NOT an
                aria-live region (updates every second → would flood a screen reader). */}
            {rxLatency != null && (
              <p id={jamBufLiveId} className="mt-2 text-xs tabular-nums text-sonic-400">
                {m.settings_jam_buffer_live({ latency: rxLatency })}
              </p>
            )}
          </div>
        )}

        {/* Shared metronome — the common reference locked to the server clock, so the
            beat lands at the same server-instant for everyone while the instrument audio
            stays P2P (min latency). Room-wide (like jam). Shown only while jam is on. */}
        {jamMode && (
          <div
            role="group"
            aria-labelledby={metroHintId}
            className="mt-3 rounded-lg border border-sonic-600 bg-sonic-800/40 p-2.5"
          >
            <p id={metroHintId} className="mb-2 text-xs text-sonic-400">
              {m.settings_metronome_hint()}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  useRoomStore.getState().onSetMetronome?.({ running: !metronomeRunning })
                }
                aria-pressed={metronomeRunning}
                className="rounded-lg bg-sonic-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90"
              >
                {metronomeRunning ? m.settings_metronome_stop() : m.settings_metronome_start()}
              </button>
              <label htmlFor={metroBpmId} className="text-xs font-medium text-sonic-300">
                {m.settings_metronome_bpm()}
              </label>
              <input
                id={metroBpmId}
                type="number"
                min={20}
                max={300}
                step={1}
                value={metronomeBpm}
                onChange={(e) =>
                  useRoomStore.getState().onSetMetronome?.({
                    bpm: Math.max(20, Math.min(300, Number(e.target.value) || 100)),
                  })
                }
                className="w-16 rounded-lg border border-sonic-600 bg-sonic-700 px-2 py-1 text-sm text-sonic-100 focus:border-sonic-accent focus:outline-none"
              />
            </div>
            <p className="mt-1 text-xs text-sonic-400">
              {metronomeSyncMs >= 0
                ? m.settings_metronome_sync({ ms: metronomeSyncMs })
                : m.settings_metronome_syncing()}
            </p>
          </div>
        )}
      </div>

      {/* Network monitoring: hear your own return via the server (Jamulus-style
          timing reference). SFU-only. */}
      <div>
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            id={netMonitorId}
            checked={networkMonitor}
            onChange={(e) => setNetworkMonitor(e.target.checked)}
            aria-describedby={netMonitorHintId}
            className="mt-0.5 shrink-0 accent-sonic-accent"
          />
          <label htmlFor={netMonitorId} className="text-xs font-medium text-sonic-300 cursor-pointer">
            {m.settings_net_monitor_label()}
          </label>
        </div>
        <p id={netMonitorHintId} className="mt-1 text-xs text-sonic-400">
          {m.settings_net_monitor_hint()}
        </p>
        {/* Dedicated output card for the return: play it on a SECOND device (e.g.
            headphones) while your primary card keeps the regular sound (your local
            piano). Only when the monitor is on and the browser supports per-element
            sinks. */}
        {networkMonitor && canSelectElementSink() && (
          <div className="mt-2">
            <label
              htmlFor={netMonitorSelectId}
              className="mb-1 block text-xs font-medium text-sonic-300"
            >
              {m.settings_net_monitor_device_label()}
            </label>
            <select
              id={netMonitorSelectId}
              value={
                speakers.some((d) => d.deviceId === netMonitorDeviceId) ? netMonitorDeviceId : ""
              }
              onChange={(e) => setNetMonitorDeviceId(e.target.value)}
              onFocus={() => void refresh()}
              className={selectClass}
            >
              <option value="">{m.settings_net_monitor_device_same()}</option>
              {speakers.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || m.settings_speaker_fallback({ n: i + 1 })}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

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
