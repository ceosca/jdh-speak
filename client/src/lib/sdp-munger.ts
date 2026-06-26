/**
 * Force low-latency Opus params on the P2P voice fmtp, and cap the audio
 * bandwidth to the chosen bitrate (kbps; 128 = original/full).
 *
 * For the bitrate to actually take effect we set TWO things:
 *  - the Opus `maxaveragebitrate` fmtp param, and
 *  - a `b=AS:<kbps>` bandwidth line on the audio m-section — browsers honour the
 *    b=AS cap on the encoder far more reliably than maxaveragebitrate alone.
 * At 128 (original) we add no cap. (SFU voice uses the produce
 * `opusMaxAverageBitrate` flag instead; this munger only touches P2P SDP.)
 */
export function forceOpusParams(sdp: string, kbps = 128): string {
  const lines = sdp.split("\r\n");
  const result: string[] = [];
  const capped = kbps >= 128 ? 128 : kbps;
  const bitrate = capped * 1000;
  let inAudio = false;

  for (const line of lines) {
    if (line.startsWith("m=")) {
      inAudio = line.startsWith("m=audio");
      result.push(line);
      continue;
    }

    // Drop any existing bandwidth line in the audio section — we re-add our own
    // (or none, at original quality) so a re-negotiation isn't stuck at an old cap.
    if (inAudio && (line.startsWith("b=AS:") || line.startsWith("b=TIAS:"))) {
      continue;
    }

    // Put our bandwidth cap right after the connection line in the audio section.
    if (inAudio && line.startsWith("c=")) {
      result.push(line);
      if (capped < 128) result.push(`b=AS:${capped}`);
      continue;
    }

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
