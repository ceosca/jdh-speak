// The display name of this JDH Speak instance — shown as the app title in the
// lobby heading and the browser tab. Operators rebrand a deployment by setting
// INSTANCE_NAME in their .env; the server injects it into the served index.html
// as `window.__JDH_SPEAK_CONFIG__` (see server/src/index.ts), so a pre-built
// static client is rebranded at runtime with no rebuild. Falls back to the
// default in dev (Vite serves the raw HTML, so the global is absent) or if unset.
export const DEFAULT_INSTANCE_NAME = "JDH Speak";

interface InstanceConfig {
  instanceName?: string;
}

declare global {
  interface Window {
    __JDH_SPEAK_CONFIG__?: InstanceConfig;
  }
}

export function getInstanceName(): string {
  const name =
    typeof window !== "undefined" ? window.__JDH_SPEAK_CONFIG__?.instanceName?.trim() : "";
  return name || DEFAULT_INSTANCE_NAME;
}
