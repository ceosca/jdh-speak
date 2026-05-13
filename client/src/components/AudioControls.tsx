import { Mic, MicOff, LogOut } from "lucide-react";
import { useRoomStore } from "../stores/room";

interface AudioControlsProps {
  onToggleMute: () => void;
  onLeave: () => void;
}

export function AudioControls({ onToggleMute, onLeave }: AudioControlsProps) {
  const isMuted = useRoomStore((s) => s.isMuted);

  return (
    <div
      className="flex items-center justify-center gap-3 rounded-2xl border border-sonic-600 bg-sonic-800 p-3"
      role="toolbar"
      aria-label="Audio controls"
    >
      <button
        onClick={onToggleMute}
        className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
          isMuted
            ? "bg-muted/20 text-muted hover:bg-muted/30"
            : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
        }`}
        aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={isMuted}
        title="Toggle Mute (M)"
      >
        {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
      </button>

      <div className="h-8 w-px bg-sonic-600" role="separator" />

      <button
        onClick={onLeave}
        className="flex h-11 items-center gap-2 rounded-full bg-muted/20 px-4 text-muted transition-all hover:bg-muted/30"
        aria-label="Leave room"
      >
        <LogOut className="h-4 w-4" />
        <span className="text-sm font-medium">Leave</span>
      </button>
    </div>
  );
}
