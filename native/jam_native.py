#!/usr/bin/env python3
"""
Native low-latency jam client for JDH Speak — the "leave the browser's WASAPI floor"
path (goal: less latency than the ~23 ms browser output).

It joins the SAME WebTransport /jam room as the browser mesh, so a native client
(Cristian on his interface) plays together with browser peers (Edu/Franco), and web
spectators still hear everyone through the relay.

Latency win (measured on this box):
  - browser output  ~23 ms  (Chrome WASAPI shared)
  - native WDM-KS    ~10 ms  (kernel streaming, below the WASAPI engine)
  - native ASIO      ~3-5 ms (Focusrite ASIO driver; needs an ASIO build)

Pipeline: mic --(WDM-KS)--> Opus 2.5 ms (PyAV) --> WT datagram --> relay --> peers,
          peers --> Opus decode --> per-sender jitter ring --> mix --(WDM-KS)--> speakers.

Usage:
  python jam_native.py --room test [--in <idx>] [--out <idx>] [--cushion 20] [--list]
  python jam_native.py --list          # list devices + host APIs
"""
import argparse, asyncio, ssl, struct, sys, threading, queue, time
import numpy as np
import sounddevice as sd
import av
from fractions import Fraction
from collections import deque
from aioquic.asyncio.client import connect
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.quic.configuration import QuicConfiguration
from aioquic.h3.connection import H3Connection
from aioquic.h3.events import HeadersReceived, DatagramReceived
from aioquic.quic.events import QuicEvent

SR = 48000
FRAME = 120                # 2.5 ms @ 48 kHz
HOST, PORT, PATH = "jdh.privatedns.org", 40059, "/jam"

# ─────────────────────────── device listing ───────────────────────────
def list_devices():
    ha = sd.query_hostapis()
    print("Host APIs:", [h["name"] for h in ha])
    for i, d in enumerate(sd.query_devices()):
        api = ha[d["hostapi"]]["name"]
        io = ("I" if d["max_input_channels"] else " ") + ("O" if d["max_output_channels"] else " ")
        lo = d["default_low_output_latency"] * 1000 if d["max_output_channels"] else d["default_low_input_latency"] * 1000
        print(f"[{i:2}] {io} {api:20} lowLat={lo:5.1f}ms  {d['name'][:44]}")

def pick_lowlat(kind):
    """Prefer WDM-KS, then WASAPI, for the default-ish device."""
    ha = sd.query_hostapis()
    order = {"Windows WDM-KS": 0, "Windows WASAPI": 1, "Windows DirectSound": 2, "MME": 3}
    best = None
    for i, d in enumerate(sd.query_devices()):
        api = ha[d["hostapi"]]["name"]
        chans = d["max_input_channels"] if kind == "in" else d["max_output_channels"]
        if chans <= 0 or api not in order:
            continue
        lat = d["default_low_input_latency"] if kind == "in" else d["default_low_output_latency"]
        score = (order[api], lat)
        if best is None or score < best[0]:
            best = (score, i)
    return best[1] if best else None

# ─────────────────────────── jitter ring ───────────────────────────
class Ring:
    """Per-sender playout ring: prebuffer to `cushion`, then feed the audio callback.
    On underrun it re-prebuffers (silence meanwhile). Simple + robust for v1."""
    def __init__(self, cushion_ms):
        self.buf = deque()
        self.lock = threading.Lock()
        self.cushion = int(SR * cushion_ms / 1000)
        self.maxlen = self.cushion + int(SR * 0.25)  # safety ceiling
        self.playing = False
    def push(self, samples: np.ndarray):
        with self.lock:
            self.buf.extend(samples.tolist())
            if len(self.buf) >= self.cushion:
                self.playing = True
            while len(self.buf) > self.maxlen:      # drift/overrun guard
                self.buf.popleft()
    def pop(self, n: int) -> np.ndarray:
        with self.lock:
            if not self.playing or len(self.buf) < n:
                if len(self.buf) < n:
                    self.playing = False            # underrun → re-prebuffer
                return np.zeros(n, dtype=np.float32)
            return np.array([self.buf.popleft() for _ in range(n)], dtype=np.float32)

# ─────────────────────────── WT client ───────────────────────────
class JamWT(QuicConnectionProtocol):
    def __init__(self, *a, room="test", on_audio=None, **k):
        super().__init__(*a, **k)
        self._http = H3Connection(self._quic, enable_webtransport=True)
        self.room = room
        self.on_audio = on_audio
        self.session_id = None
        self.my_id = None
        self.connected = asyncio.Event()

    def open_session(self):
        sid = self._quic.get_next_available_stream_id(is_unidirectional=False)
        self._http.send_headers(sid, [
            (b":method", b"CONNECT"), (b":protocol", b"webtransport"),
            (b":scheme", b"https"), (b":authority", f"{HOST}:{PORT}".encode()),
            (b":path", PATH.encode()), (b"origin", f"https://{HOST}".encode()),
        ])
        self.session_id = sid
        self.transmit()

    def send(self, data: bytes):
        if self.session_id is not None:
            self._http.send_datagram(self.session_id, data)
            self.transmit()

    def quic_event_received(self, event: QuicEvent):
        for ev in self._http.handle_event(event):
            if isinstance(ev, HeadersReceived):
                if dict(ev.headers).get(b":status") == b"200":
                    self.send(b"\x00" + self.room.encode())      # hello
            elif isinstance(ev, DatagramReceived):
                d = ev.data
                if not d:
                    continue
                if d[0] == 0x00 and len(d) >= 3:
                    self.my_id = struct.unpack_from("<H", d, 1)[0]
                    print(f"[wt] joined room '{self.room}' as mesh id {self.my_id}")
                    self.connected.set()
                elif d[0] == 0x01 and len(d) > 4 and self.on_audio:
                    self.on_audio(d)

# ─────────────────────────── engine ───────────────────────────
class Engine:
    def __init__(self, room, cushion_ms):
        self.room = room
        self.cushion_ms = cushion_ms
        self.capture_q = queue.Queue(maxsize=200)   # mic PCM (float32 mono) → sender
        self.rings = {}                              # senderId -> Ring
        self.rings_lock = threading.Lock()
        self.decoders = {}                           # senderId -> av decoder
        self.wt = None
        self.loop = None
        self.seq = 0
        self.stats = {"sent": 0, "recv": 0}
        self.rtts = deque(maxlen=400)
        # Opus encoder (mono, 2.5 ms, low delay)
        self.enc = av.CodecContext.create("libopus", "w")
        self.enc.sample_rate = SR; self.enc.layout = "mono"; self.enc.format = "s16"
        self.enc.options = {"frame_duration": "2.5", "application": "lowdelay", "vbr": "off"}
        self.enc.open()
        self.enc_pts = 0

    # audio callback (PortAudio realtime thread)
    def audio_cb(self, indata, outdata, frames, tinfo, status):
        # capture: mono float32
        mono = indata[:, 0].copy() if indata.ndim > 1 else indata.copy()
        try:
            self.capture_q.put_nowait(mono)
        except queue.Full:
            pass
        # playout: mix every sender's ring
        mix = np.zeros(frames, dtype=np.float32)
        with self.rings_lock:
            rings = list(self.rings.values())
        for r in rings:
            mix += r.pop(frames)
        np.clip(mix, -1.0, 1.0, out=mix)
        if outdata.ndim > 1:
            outdata[:] = mix[:, None]
        else:
            outdata[:] = mix

    # encode worker thread: mic PCM → Opus → WT datagram
    def encode_worker(self):
        from av.audio.frame import AudioFrame
        while True:
            mono = self.capture_q.get()
            if mono is None:
                break
            pcm = np.clip(mono * 32767, -32768, 32767).astype("int16")
            fr = AudioFrame(format="s16", layout="mono", samples=len(pcm))
            fr.sample_rate = SR; fr.pts = self.enc_pts; fr.time_base = Fraction(1, SR)
            self.enc_pts += len(pcm)
            fr.planes[0].update(pcm.tobytes())
            for pkt in self.enc.encode(fr):
                opus = bytes(pkt)
                # [0x01][idLen=0][ch=1][seq:4][sendTime:8][opus]
                hdr = b"\x01" + bytes([0]) + bytes([1]) + struct.pack("<I", self.seq) + struct.pack("<d", time.time() * 1000)
                self.seq = (self.seq + 1) & 0xFFFFFFFF
                dg = hdr + opus
                if self.wt and self.loop:
                    self.loop.call_soon_threadsafe(self.wt.send, dg)
                    self.stats["sent"] += 1

    # WT receive callback (loop thread): decode + push to sender ring
    def on_audio(self, d: bytes):
        sender = struct.unpack_from("<H", d, 1)[0]
        idlen = d[3]
        # RTT on self-echo: sendTime is embedded at offset 5+idlen (after ch byte).
        if self.wt and sender == self.wt.my_id:
            try:
                # [ch:1][seq:4] precede sendTime → offset 4+idlen+1+4 = 9+idlen
                st = struct.unpack_from("<d", d, 9 + idlen)[0]
                self.rtts.append(time.time() * 1000 - st)
            except Exception:
                pass
        ch = d[4 + idlen]
        opus_off = 4 + idlen + 1 + 12
        if len(d) <= opus_off:
            return
        payload = d[opus_off:]
        dec = self.decoders.get(sender)
        if dec is None:
            dec = av.CodecContext.create("libopus", "r")
            dec.sample_rate = SR; dec.layout = "mono" if ch == 1 else "stereo"; dec.format = "s16"
            dec.open()
            self.decoders[sender] = dec
        try:
            pkt = av.packet.Packet(payload)
            for fr in dec.decode(pkt):
                arr = fr.to_ndarray()  # shape (channels, samples) s16
                mono = arr[0].astype(np.float32) / 32768.0
                with self.rings_lock:
                    r = self.rings.get(sender)
                    if r is None:
                        r = Ring(self.cushion_ms); self.rings[sender] = r
                r.push(mono)
                self.stats["recv"] += 1
        except Exception:
            pass

    def synth_capture(self):
        """Realtime synthetic mic (no audio device): a 440 Hz tone in 2.5 ms frames."""
        n = 0
        while True:
            t = (np.arange(FRAME) + n) / SR
            self.capture_q.put(np.sin(2 * np.pi * 440 * t).astype(np.float32) * 0.2)
            n += FRAME
            time.sleep(FRAME / SR)

    async def run(self, dev_in, dev_out, test=False):
        self.loop = asyncio.get_running_loop()
        cfg = QuicConfiguration(is_client=True, alpn_protocols=["h3"], max_datagram_frame_size=65536)
        cfg.verify_mode = ssl.CERT_NONE
        threading.Thread(target=self.encode_worker, daemon=True).start()
        stream = None
        if test:
            threading.Thread(target=self.synth_capture, daemon=True).start()
        else:
            stream = sd.Stream(samplerate=SR, blocksize=FRAME, dtype="float32",
                               channels=1, device=(dev_in, dev_out), latency="low",
                               callback=self.audio_cb)
        async with connect(HOST, PORT, configuration=cfg,
                           create_protocol=lambda *a, **k: JamWT(*a, room=self.room, on_audio=self.on_audio, **k)) as client:
            self.wt = client
            client.open_session()
            await asyncio.wait_for(client.connected.wait(), 8)
            if stream is not None:
                li, lo = stream.latency
                stream.start()
                print(f"[audio] stream started — in {li*1000:.1f} ms / out {lo*1000:.1f} ms "
                      f"(browser output ~23 ms). Playing. Ctrl+C to stop.")
            else:
                print("[test] synthetic capture; measuring native relay round-trip (self-echo).")
            t0 = time.time()
            try:
                while True:
                    await asyncio.sleep(2)
                    dt = time.time() - t0
                    rtt = f"{np.mean(self.rtts):.1f}ms(min {np.min(self.rtts):.1f})" if self.rtts else "-"
                    print(f"[stat] sent={self.stats['sent']} recv={self.stats['recv']} "
                          f"peers={len(self.rings)} RTT={rtt}  ({dt:.0f}s)")
            except (KeyboardInterrupt, asyncio.CancelledError):
                pass
            finally:
                if stream is not None:
                    stream.stop(); stream.close()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--room", default="test")
    ap.add_argument("--in", dest="din", type=int, default=None)
    ap.add_argument("--out", dest="dout", type=int, default=None)
    ap.add_argument("--cushion", type=float, default=20.0)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--test", action="store_true", help="no audio device: synthetic capture + RTT")
    a = ap.parse_args()
    if a.list:
        list_devices(); return
    if a.test:
        eng = Engine(a.room, a.cushion)
        try:
            asyncio.run(eng.run(None, None, test=True))
        except KeyboardInterrupt:
            pass
        return
    din = a.din if a.din is not None else pick_lowlat("in")
    dout = a.dout if a.dout is not None else pick_lowlat("out")
    ha = sd.query_hostapis()
    di, do = sd.query_devices(din), sd.query_devices(dout)
    print(f"[dev] IN  [{din}] {ha[di['hostapi']]['name']} :: {di['name']}")
    print(f"[dev] OUT [{dout}] {ha[do['hostapi']]['name']} :: {do['name']}")
    eng = Engine(a.room, a.cushion)
    try:
        asyncio.run(eng.run(din, dout))
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
