import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { followFile } from "./follow-file.js";

function collector() {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  let ended = false;
  out.on("end", () => (ended = true));
  return { out, bytes: () => Buffer.concat(chunks), ended: () => ended };
}

describe("followFile", () => {
  it("streams a growing file until the writer is done, across the final rename", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "follow-"));
    const part = path.join(dir, "mix.ogg.part");
    const fin = path.join(dir, "mix.ogg");
    await writeFile(part, Buffer.from("AAAA"));
    let done = false;
    const c = collector();
    const p = followFile({
      partPath: part,
      finalPath: fin,
      isDone: () => done,
      out: c.out,
      aborted: () => false,
      pollMs: 5,
    });
    for (const chunk of ["BBBB", "CCCC", "DDDD"]) {
      await new Promise((r) => setTimeout(r, 15));
      await appendFile(part, chunk);
    }
    await rename(part, fin);
    await appendFile(fin, "EEEE"); // written just before "done" (same inode)
    done = true;
    const n = await p;
    await new Promise((r) => setImmediate(r));
    assert.equal(c.bytes().toString(), "AAAABBBBCCCCDDDDEEEE");
    assert.equal(n, 20);
    assert.equal(c.ended(), true);
    await rm(dir, { recursive: true, force: true });
  });

  it("opens the final file if the rename already happened", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "follow-"));
    const fin = path.join(dir, "mix.ogg");
    await writeFile(fin, Buffer.from("done-already"));
    const c = collector();
    await followFile({
      partPath: path.join(dir, "mix.ogg.part"),
      finalPath: fin,
      isDone: () => true,
      out: c.out,
      aborted: () => false,
    });
    assert.equal(c.bytes().toString(), "done-already");
    await rm(dir, { recursive: true, force: true });
  });

  it("stops when the client aborts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "follow-"));
    const part = path.join(dir, "mix.ogg.part");
    await writeFile(part, Buffer.from("x"));
    let aborted = false;
    const c = collector();
    const p = followFile({
      partPath: part,
      finalPath: path.join(dir, "mix.ogg"),
      isDone: () => false,
      out: c.out,
      aborted: () => aborted,
      pollMs: 5,
    });
    await new Promise((r) => setTimeout(r, 30));
    aborted = true;
    await p; // must return, not hang
    await rm(dir, { recursive: true, force: true });
  });
});
