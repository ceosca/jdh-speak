import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
// Side-effect import first: applies any ?lang= override before anything reads
// the locale (the store's initializer calls getLocale() at module load).
import "./lib/i18n";
import { useRoomStore } from "./stores/room";
import { Lobby } from "./components/Lobby";
import { Room } from "./components/Room";
import "./index.css";

function App() {
  // Subscribe to the active locale so changing language re-renders the whole
  // tree in place — every m.*() re-evaluates — WITHOUT remounting, so an active
  // call survives a mid-session language switch.
  useRoomStore((s) => s.locale);
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Lobby />} />
        <Route path="/room/:roomName" element={<Room />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
