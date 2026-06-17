import { useState, useRef, useEffect, type SyntheticEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Headphones, ArrowRight } from "lucide-react";
import { getInstanceName } from "../lib/branding";
import { m } from "../paraglide/messages.js";

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function Lobby() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillRoom = searchParams.get("room") || "";
  const [roomName, setRoomName] = useState(sanitize(prefillRoom));
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const roomInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prefillRoom) {
      nameInputRef.current?.focus();
    } else {
      roomInputRef.current?.focus();
    }
  }, [prefillRoom]);

  // Reflect this instance's name in the tab title on the lobby (the Room sets
  // its own "<room> · <instance>" title). Keeps it in sync after the Room's
  // cleanup and on SPA navigation back here.
  useEffect(() => {
    document.title = getInstanceName();
  }, []);

  const handleJoin = (e?: SyntheticEvent) => {
    e?.preventDefault();
    const sanitizedRoom = sanitize(roomName.trim());
    const trimmedName = displayName.trim().replace(/[<>"'&]/g, "");

    if (!sanitizedRoom) {
      setError(m.lobby_error_room_required());
      return;
    }
    if (sanitizedRoom.length > 64) {
      setError(m.lobby_error_room_too_long());
      return;
    }
    if (!trimmedName) {
      setError(m.lobby_error_name_required());
      return;
    }
    if (trimmedName.length > 256) {
      setError(m.lobby_error_name_too_long());
      return;
    }

    // Store display name for the Room component
    sessionStorage.setItem("sonicroom:displayName", trimmedName);
    navigate(`/room/${sanitizedRoom}`);
  };

  return (
    <div className="flex min-h-dvh flex-col bg-sonic-900">
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-sonic-600 bg-sonic-800 p-8 shadow-2xl">
          <div className="mb-8 flex items-center justify-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-sonic-accent/20">
              <Headphones className="h-6 w-6 text-sonic-accent" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-sonic-100">
              {getInstanceName()}
            </h1>
          </div>

          <p className="mb-6 text-center text-sm text-sonic-300">{m.lobby_tagline()}</p>

          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label
                htmlFor="room-name"
                className="mb-1.5 block text-sm font-medium text-sonic-200"
              >
                {m.lobby_room_name_label()}
              </label>
              <input
                ref={roomInputRef}
                id="room-name"
                name="room-name"
                type="text"
                value={roomName}
                onChange={(e) => {
                  setRoomName(e.target.value);
                  setError("");
                }}
                placeholder={m.lobby_room_name_placeholder()}
                maxLength={64}
                className="w-full rounded-lg border border-sonic-600 bg-sonic-700 px-4 py-2.5 text-sonic-100 placeholder-sonic-400 transition-colors focus:border-sonic-accent focus:outline-none"
                autoComplete="off"
                aria-describedby={error ? "lobby-error" : undefined}
              />
            </div>

            <div>
              <label
                htmlFor="display-name"
                className="mb-1.5 block text-sm font-medium text-sonic-200"
              >
                {m.lobby_display_name_label()}
              </label>
              <input
                ref={nameInputRef}
                id="display-name"
                name="display-name"
                type="text"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setError("");
                }}
                placeholder={m.lobby_display_name_placeholder()}
                maxLength={256}
                className="w-full rounded-lg border border-sonic-600 bg-sonic-700 px-4 py-2.5 text-sonic-100 placeholder-sonic-400 transition-colors focus:border-sonic-accent focus:outline-none"
                autoComplete="off"
              />
            </div>

            {error && (
              <p id="lobby-error" className="text-sm text-muted" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-sonic-accent px-4 py-2.5 font-medium text-white transition-all hover:bg-sonic-accent/90 hover:shadow-lg hover:shadow-sonic-accent/25 active:scale-[0.98]"
            >
              {m.lobby_join_room()}
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
