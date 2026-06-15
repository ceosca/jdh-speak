/**
 * Force low-latency Opus params on the P2P voice fmtp.
 * Always sets useinbandfec=1 and minptime=10 for lowest packetization delay.
 * `hifi` picks the per-user voice quality: false (default) → mono 64 kbps,
 * true → stereo 128 kbps. (SFU voice uses the produce `opusStereo` /
 * `opusMaxAverageBitrate` flags instead; this munger only touches P2P SDP.)
 */
export function forceOpusParams(sdp: string, hifi = false): string {
  const lines = sdp.split("\r\n");
  const result: string[] = [];

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

      // Force low-latency params; stereo/bitrate follow the per-user `hifi` flag.
      params.set("stereo", hifi ? "1" : "0");
      params.set("sprop-stereo", hifi ? "1" : "0");
      params.set("useinbandfec", "1");
      params.set("maxaveragebitrate", hifi ? "128000" : "64000");
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
