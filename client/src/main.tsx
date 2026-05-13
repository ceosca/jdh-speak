import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Lobby } from "./components/Lobby";
import { Room } from "./components/Room";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Lobby />} />
        <Route path="/room/:roomName" element={<Room />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
