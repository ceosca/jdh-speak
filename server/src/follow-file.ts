import { open, type FileHandle } from "node:fs/promises";

// Stream a file that is still being WRITTEN (the pre-rendered mixed download while its
// ffmpeg is running) to `out`, following it as it grows — like `tail -f` — until the
// writer is done, then flush whatever remains and end. Lets a download that starts
// before the pre-render has finished receive the SAME bytes without spawning a second,
// competing mix. The writer renames `partPath` → `finalPath` when it completes; an open
// descriptor survives the rename (same inode), and if the rename already happened before
// we opened, we open `finalPath` instead.
export interface FollowSink {
  write(chunk: Buffer): boolean;
  once(event: "drain" | "close", cb: () => void): unknown;
  end(): void;
}

export interface FollowOptions {
  partPath: string;
  finalPath: string;
  // True once the writer has finished (successfully or not).
  isDone: () => boolean;
  out: FollowSink;
  // Set when the client went away — stop reading.
  aborted: () => boolean;
  pollMs?: number;
  chunkBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

async function openEither(a: string, b: string): Promise<FileHandle> {
  try {
    return await open(a, "r");
  } catch {
    return await open(b, "r");
  }
}

export async function followFile(opts: FollowOptions): Promise<number> {
  const pollMs = opts.pollMs ?? 250;
  const chunk = Buffer.allocUnsafe(opts.chunkBytes ?? 64 * 1024);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fh = await openEither(opts.partPath, opts.finalPath);
  let pos = 0;
  try {
    for (;;) {
      if (opts.aborted()) return pos;
      // Check "done" BEFORE reading: if it was already done, the read below sees every
      // byte ever written, so an empty read then really means the end.
      const doneBeforeRead = opts.isDone();
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (bytesRead > 0) {
        pos += bytesRead;
        const ok = opts.out.write(Buffer.from(chunk.subarray(0, bytesRead)));
        if (!ok) {
          // Wait for the socket to drain — or to close (client gone), never forever.
          await new Promise<void>((r) => {
            opts.out.once("drain", () => r());
            opts.out.once("close", () => r());
          });
        }
        continue;
      }
      if (doneBeforeRead) break;
      await sleep(pollMs);
    }
  } finally {
    await fh.close().catch(() => {});
  }
  opts.out.end();
  return pos;
}
