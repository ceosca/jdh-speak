import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTvChannels } from "./tv-channels.js";

describe("parseTvChannels", () => {
  it("keeps well-formed channels", () => {
    const raw = JSON.stringify([
      { nombre: "TELEFE", categoria: "Argentina", url: "https://x/y.mpd", key: "aa:bb" },
    ]);
    const out = parseTvChannels(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0].nombre, "TELEFE");
    assert.equal(out[0].key, "aa:bb");
  });

  it("drops malformed entries, non-arrays, and returns [] on bad JSON", () => {
    assert.deepEqual(parseTvChannels("{}"), []);
    assert.deepEqual(parseTvChannels("not json"), []);
    const raw = JSON.stringify([
      { nombre: "OK", categoria: "C", url: "u", key: "k" },
      { nombre: "missing key", categoria: "C", url: "u" },
      42,
      null,
    ]);
    assert.equal(parseTvChannels(raw).length, 1);
  });
});
