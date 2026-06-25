// Mark this tab as an active "media" session (like a music player) so the
// browser/OS is much more reluctant to suspend its audio in the background —
// notably Android Chrome with the screen off or after switching apps. It's a
// standard, feature-detected web API: a no-op where unsupported (and harmless on
// iOS/desktop, which already background audio well). It never pauses the live
// call — the play/pause/stop handlers are deliberate no-ops so an OS media
// control can't cut your audio.

export function activateMediaSession(title: string, artist: string): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  try {
    if (typeof MediaMetadata !== "undefined") {
      ms.metadata = new MediaMetadata({
        title,
        artist,
        artwork: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
      });
    }
    ms.playbackState = "playing";
    // Show OS media controls but keep the live call running regardless.
    const noop = () => {};
    for (const action of ["play", "pause", "stop"] as const) {
      try {
        ms.setActionHandler(action, noop);
      } catch {
        // Some actions aren't supported on every platform — ignore.
      }
    }
  } catch {
    // MediaSession quirks vary by browser; failing here must never break a call.
  }
}

export function deactivateMediaSession(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  try {
    ms.playbackState = "none";
    ms.metadata = null;
    for (const action of ["play", "pause", "stop"] as const) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}
