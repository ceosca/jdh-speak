import { useEffect, useRef } from "react";
import { Check, X, DoorOpen } from "lucide-react";
import { useRoomStore } from "../stores/room";
import { m } from "../paraglide/messages.js";

// Knock-to-join modal (participant side). Shown to people already in a public
// room while someone is waiting to be let in: one Allow/Deny per requester, plus
// Allow all / Deny all when several are queued. role="alert" so a screen reader
// announces it the moment it appears, and the panel auto-focuses so keyboard/SR
// users land on it (and can Tab straight to the buttons). The looping knock cue
// is driven from the hook, not here.
export function JoinRequests({
  onDecide,
}: {
  onDecide: (requestId: string, allow: boolean) => void;
}) {
  const requests = useRoomStore((s) => s.joinRequests);
  const panelRef = useRef<HTMLDivElement>(null);
  const appeared = requests.length > 0;

  // Focus the panel when the modal first appears (not on every list change, so
  // a second knock while you're mid-decision doesn't yank focus around).
  useEffect(() => {
    if (appeared) panelRef.current?.focus();
  }, [appeared]);

  if (!appeared) return null;

  const allowAll = () => requests.forEach((r) => onDecide(r.id, true));
  const denyAll = () => requests.forEach((r) => onDecide(r.id, false));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        ref={panelRef}
        role="alert"
        aria-labelledby="join-requests-heading"
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-sonic-600 bg-sonic-800 p-5 shadow-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-sonic-accent/60"
      >
        <h2
          id="join-requests-heading"
          className="mb-4 flex items-center gap-2 text-base font-semibold text-sonic-100"
        >
          <DoorOpen className="h-5 w-5 shrink-0 text-sonic-accent" aria-hidden="true" />
          {requests.length === 1
            ? m.join_requests_title_one({ name: requests[0].displayName })
            : m.join_requests_title_many({ count: requests.length })}
        </h2>

        <ul className="mb-4 space-y-2">
          {requests.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-3 rounded-lg bg-sonic-700/50 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-sonic-100">
                {r.displayName}
              </span>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => onDecide(r.id, true)}
                  aria-label={m.join_requests_allow_name({ name: r.displayName })}
                  className="flex items-center gap-1 rounded-md bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-green-500"
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  {m.join_requests_allow()}
                </button>
                <button
                  onClick={() => onDecide(r.id, false)}
                  aria-label={m.join_requests_deny_name({ name: r.displayName })}
                  className="flex items-center gap-1 rounded-md bg-sonic-600 px-2.5 py-1.5 text-xs font-medium text-sonic-100 hover:bg-red-600 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  {m.join_requests_deny()}
                </button>
              </div>
            </li>
          ))}
        </ul>

        {requests.length > 1 && (
          <div className="flex justify-end gap-2 border-t border-sonic-600 pt-3">
            <button
              onClick={allowAll}
              className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-500"
            >
              {m.join_requests_allow_all()}
            </button>
            <button
              onClick={denyAll}
              className="rounded-md bg-sonic-600 px-3 py-1.5 text-sm font-medium text-sonic-100 hover:bg-red-600 hover:text-white"
            >
              {m.join_requests_deny_all()}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
