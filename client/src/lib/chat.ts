// Chat formatting + client-side spam guard. The format string here is the
// single source of truth for how a message reads in BOTH the visible list and
// the ARIA announcement, so they never drift apart.
import { chat_announcement, chat_just_now } from "../paraglide/messages.js";
import { getLocale } from "./i18n";

export const CHAT_RATE_LIMIT = 5; // messages...
export const CHAT_RATE_WINDOW_MS = 10_000; // ...per this window (mirrors server)
export const CHAT_TEXT_MAX = 2000;

export interface ChatMessage {
  id: string;
  sender: string;
  text: string;
  ts: number; // epoch ms
}

// One RelativeTimeFormat per active locale (constructing them isn't free, and
// the locale can change at runtime via the language picker).
const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
function rtf(): Intl.RelativeTimeFormat {
  const locale = getLocale();
  let f = rtfCache.get(locale);
  if (!f) {
    f = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    rtfCache.set(locale, f);
  }
  return f;
}

// "just now" / "5 minutes ago" / "2 hours ago" / "3 days ago", localized. Past
// timestamps yield "… ago"; the rare clock-skewed future yields "in …".
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diffSec = Math.round((ts - now) / 1000); // negative = in the past
  if (Math.abs(diffSec) < 30) return chat_just_now();
  const mins = Math.round(diffSec / 60);
  if (Math.abs(mins) < 60) return rtf().format(mins, "minute");
  const hours = Math.round(diffSec / 3600);
  if (Math.abs(hours) < 24) return rtf().format(hours, "hour");
  return rtf().format(Math.round(diffSec / 86400), "day");
}

// e.g. "Alice: see you in 5 sent 2 minutes ago" — used verbatim by the message
// list and the screen-reader announcement, so both stay in lockstep.
export function formatMessage(m: ChatMessage, now: number = Date.now()): string {
  return chat_announcement({ sender: m.sender, text: m.text, time: relativeTime(m.ts, now) });
}

// Single-sender sliding-window limiter for instant local feedback (the server
// enforces the same budget authoritatively). Blocked attempts don't count, so
// the sender recovers once the window clears — matching the server.
export class RateLimiter {
  private hits: number[] = [];

  constructor(
    private readonly limit = CHAT_RATE_LIMIT,
    private readonly windowMs = CHAT_RATE_WINDOW_MS,
  ) {}

  tryConsume(now: number = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
}
