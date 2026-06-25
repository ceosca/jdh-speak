import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
// Side-effect import: pins <html lang="es"> before anything reads the locale.
import "./lib/i18n";
import { Room } from "./components/Room";
import "./index.css";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* The base domain joins the main room; "/<roomName>" joins that room.
            People invent a private room just by sharing a URL like /myroom. */}
        <Route path="/" element={<Room />} />
        <Route path="/:roomName" element={<Room />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
