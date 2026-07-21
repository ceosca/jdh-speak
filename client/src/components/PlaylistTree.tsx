import { useMemo, useState } from "react";
import { Folder, FolderOpen, FileMusic } from "lucide-react";

// A folder-aware view of the playlist. When a folder pick has subfolders, the
// flat track list is grouped into a keyboard-navigable tree: Right expands a
// folder (or steps into it), Left collapses (or steps out to the parent),
// Up/Down move through the visible rows, Enter/Space play a file. Playback order
// is unchanged — a file's `trackIndex` maps back to the flat playlist.

export interface PlaylistTrack {
  name: string;
  objectUrl: string;
  path?: string;
}

type TreeNode =
  | { kind: "folder"; id: string; name: string; level: number; children: TreeNode[] }
  | { kind: "file"; id: string; name: string; level: number; trackIndex: number };

interface VisibleRow {
  id: string;
  kind: "folder" | "file";
  name: string;
  level: number;
  expanded?: boolean; // folders only
  hasChildren: boolean;
  trackIndex?: number; // files only
  parentId: string | null;
}

// Build a nested tree from each track's folder-relative path.
function buildTree(tracks: PlaylistTrack[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const folders = new Map<string, Extract<TreeNode, { kind: "folder" }>>();
  tracks.forEach((track, index) => {
    const segments = (track.path || track.name).split("/").filter(Boolean);
    const fileName = segments.pop() ?? track.name;
    let siblings = roots;
    let accum = "";
    let level = 1;
    for (const seg of segments) {
      accum = accum ? `${accum}/${seg}` : seg;
      let folder = folders.get(accum);
      if (!folder) {
        folder = { kind: "folder", id: `folder:${accum}`, name: seg, level, children: [] };
        folders.set(accum, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
      level++;
    }
    siblings.push({ kind: "file", id: `file:${index}`, name: fileName, level, trackIndex: index });
  });
  // Folders first, then files, each alphabetically (folder picks arrive sorted by
  // path, but this keeps subfolders grouped ahead of loose files).
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name, "es", { sensitivity: "base" });
    });
    for (const n of nodes) if (n.kind === "folder") sortNodes(n.children);
  };
  sortNodes(roots);
  return roots;
}

// Ancestor folder ids of a given track, so we can reveal the playing track.
function ancestorFolderIds(tracks: PlaylistTrack[], trackIndex: number): string[] {
  const track = tracks[trackIndex];
  if (!track) return [];
  const segments = (track.path || track.name).split("/").filter(Boolean);
  segments.pop(); // drop the file name
  const ids: string[] = [];
  let accum = "";
  for (const seg of segments) {
    accum = accum ? `${accum}/${seg}` : seg;
    ids.push(`folder:${accum}`);
  }
  return ids;
}

// Depth-first list of the rows currently visible (children shown only under
// expanded folders), carrying each row's parent for Left-arrow "go to parent".
function flattenVisible(nodes: TreeNode[], expanded: Set<string>): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (list: TreeNode[], parentId: string | null) => {
    for (const node of list) {
      if (node.kind === "folder") {
        const isExpanded = expanded.has(node.id);
        out.push({
          id: node.id,
          kind: "folder",
          name: node.name,
          level: node.level,
          expanded: isExpanded,
          hasChildren: node.children.length > 0,
          parentId,
        });
        if (isExpanded) walk(node.children, node.id);
      } else {
        out.push({
          id: node.id,
          kind: "file",
          name: node.name,
          level: node.level,
          hasChildren: false,
          trackIndex: node.trackIndex,
          parentId,
        });
      }
    }
  };
  walk(nodes, null);
  return out;
}

export function PlaylistTree({
  tracks,
  playlistIndex,
  onPlayTrack,
  label,
}: {
  tracks: PlaylistTrack[];
  playlistIndex: number;
  onPlayTrack: (index: number) => void;
  label: string;
}) {
  const tree = useMemo(() => buildTree(tracks), [tracks]);
  // Start with the playing track's folders open so it's visible.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(ancestorFolderIds(tracks, playlistIndex)),
  );
  const rows = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);

  const playingId = `file:${playlistIndex}`;
  const [activeId, setActiveId] = useState<string>(playingId);
  // Keep the cursor on a visible row (e.g. after a collapse hid it).
  const activeIndex = Math.max(
    0,
    rows.findIndex((r) => r.id === activeId),
  );
  const active = rows[activeIndex];

  const setExpandedFor = (id: string, open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const moveTo = (index: number) => {
    const row = rows[index];
    if (row) setActiveId(row.id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (!active) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        moveTo(Math.min(rows.length - 1, activeIndex + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        moveTo(Math.max(0, activeIndex - 1));
        break;
      case "ArrowRight":
        e.preventDefault();
        e.stopPropagation();
        if (active.kind === "folder") {
          if (!active.expanded) setExpandedFor(active.id, true);
          else moveTo(activeIndex + 1); // already open → step to first child
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        e.stopPropagation();
        if (active.kind === "folder" && active.expanded) {
          setExpandedFor(active.id, false);
        } else if (active.parentId) {
          setActiveId(active.parentId); // step out to the parent folder
        }
        break;
      case "Home":
        e.preventDefault();
        e.stopPropagation();
        moveTo(0);
        break;
      case "End":
        e.preventDefault();
        e.stopPropagation();
        moveTo(rows.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        e.stopPropagation();
        if (active.kind === "file" && active.trackIndex != null) onPlayTrack(active.trackIndex);
        else if (active.kind === "folder") setExpandedFor(active.id, !active.expanded);
        break;
      default:
        break;
    }
  };

  return (
    <ul
      role="tree"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={active?.id}
      onKeyDown={onKeyDown}
      className="mt-1.5 max-h-40 overflow-y-auto rounded-lg border border-sonic-600 bg-sonic-900/40 p-1 focus:outline-none focus:ring-2 focus:ring-sonic-accent"
    >
      {rows.map((row) => {
        const isPlaying = row.kind === "file" && row.trackIndex === playlistIndex;
        const isCursor = row.id === active?.id;
        return (
          <li
            key={row.id}
            id={row.id}
            role="treeitem"
            aria-level={row.level}
            aria-expanded={row.kind === "folder" ? row.expanded : undefined}
            aria-selected={isPlaying}
            style={{ paddingLeft: `${(row.level - 1) * 14 + 6}px` }}
            className={`flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs ${
              isPlaying ? "bg-sonic-700 text-sonic-100" : "text-sonic-300 hover:bg-sonic-700/60"
            } ${isCursor ? "ring-1 ring-inset ring-sonic-accent" : ""}`}
            onClick={() => {
              setActiveId(row.id);
              if (row.kind === "file" && row.trackIndex != null) onPlayTrack(row.trackIndex);
              else if (row.kind === "folder") setExpandedFor(row.id, !row.expanded);
            }}
          >
            {row.kind === "folder" ? (
              row.expanded ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )
            ) : (
              <FileMusic className="h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate" title={row.name}>
              {row.name}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
