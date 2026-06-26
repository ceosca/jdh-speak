/**
 * Force low-latency Opus params on the P2P voice fmtp.
 * Sets stereo, useinbandfec=1 and minptime=10 for lowest packetization delay,
 * and the voice bitrate (kbps; 128 = original/full). The room-wide quality
 * command renegotiates P2P with the chosen kbps. (SFU voice uses the produce
 * `opusMaxAverageBitrate` flag instead; this munger only touches P2P SDP.)
 */
export function forceOpusParams(sdp: string, kbps = 128): string {
  const lines = sdp.split("\r\n");
  const result: string[] = [];
  const bitrate = (kbps >= 128 ? 128 : kbps) * 1000;

  for (const line of lines) {
    if (line.startsWith("a=fmtp:") && line.includes("minptime")) {
      // This is an Opus fmtp line — force our params
      const colonIdx = line.indexOf(":");
      const spaceIdx = line.indexOf(" ");
      const payloadType = line.substring(colonIdx + 1, spaceIdx);

      const params = new Map<string, string>();
      const paramStr = line.substring(spaceIdx + 1);
      for (const p of paramStr.split(";")) {
        const [k, v] = p.trim().split("=");
        if (k) params.set(k, v ?? "");
      }

      // Force stereo + low-latency params at the chosen bitrate.
      params.set("stereo", "1");
      params.set("sprop-stereo", "1");
      params.set("useinbandfec", "1");
      params.set("maxaveragebitrate", String(bitrate));
      params.set("minptime", "10");
      params.set("ptime", "10");
      params.set("maxplaybackrate", "48000");
      params.set("usedtx", "0");

      const newParams = Array.from(params.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join(";");

      result.push(`a=fmtp:${payloadType} ${newParams}`);
    } else {
      result.push(line);
    }
  }

  return result.join("\r\n");
}
