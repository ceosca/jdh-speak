// Local audio-folder picking via the File System Access API.
//
// `<input webkitdirectory>` makes Chrome show an "Upload N files to this site?"
// confirmation. `showDirectoryPicker()` doesn't — the user picks a folder and we
// read it directly — so we prefer it and only fall back to the input when the
// API is missing (Firefox/Safari). We recurse into subfolders and return the
// audio files ordered by relative path (folder order, subfolders included).

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac", "m4b"]);

export function isAudioFile(name: string, type = ""): boolean {
  if (type.startsWith("audio/")) return true;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.has(ext);
}

// Minimal File System Access API typings (not present in every lib.dom version).
interface FsHandle {
  kind: "file" | "directory";
  name: string;
}
interface FsFileHandle extends FsHandle {
  kind: "file";
  getFile(): Promise<File>;
}
interface FsDirHandle extends FsHandle {
  kind: "directory";
  values(): AsyncIterableIterator<FsHandle>;
}
type DirPicker = (opts?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FsDirHandle>;

export function supportsDirectoryPicker(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker === "function";
}

// Pick a folder and gather its audio files (recursively), ordered by relative
// path. Returns:
//   - File[]  — the ordered audio files (possibly empty if the folder has none)
//   - null    — the File System Access API isn't available (caller should fall
//               back to a <input webkitdirectory> picker)
//   - []      — the user cancelled the picker (caller should do nothing)
export async function pickFolderAudioFiles(): Promise<File[] | null> {
  const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
  if (typeof picker !== "function") return null;

  let dir: FsDirHandle;
  try {
    dir = await picker({ id: "jdh-speak-music", mode: "read" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return [];
    throw err;
  }

  const collected: { path: string; file: File }[] = [];
  const walk = async (handle: FsDirHandle, prefix: string): Promise<void> => {
    for await (const entry of handle.values()) {
      if (entry.kind === "file") {
        if (isAudioFile(entry.name)) {
          collected.push({ path: prefix + entry.name, file: await (entry as FsFileHandle).getFile() });
        }
      } else {
        await walk(entry as FsDirHandle, `${prefix}${entry.name}/`);
      }
    }
  };
  await walk(dir, "");

  collected.sort((a, b) => a.path.localeCompare(b.path));
  return collected.map((c) => c.file);
}
