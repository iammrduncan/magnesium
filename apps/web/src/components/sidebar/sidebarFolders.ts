// magnesium: project folders over the sidebar's active rows (goal 05, Home and Session boards).
// Upstream's inbox stays one flat sortable list; folders are extra rows in its
// active section, so drag, undo and search work as they did.
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
  type SidebarListItem,
} from "../Sidebar.logic";

type RollupThread = Parameters<typeof resolveSidebarThreadStatus>[0] &
  Parameters<typeof resolveThreadStatusPill>[0]["thread"];

export type FolderRollupKind = "approval" | "input" | "plan" | "failed" | "working";

export interface FolderRollup {
  readonly kind: FolderRollupKind;
  readonly label: string;
}

/**
 * The most urgent status among a folder's threads, as the board's collapsed
 * folders show it: Approval, then Input, Plan ready, Failed, and how many are
 * working. Null when nothing in the folder needs a look.
 */
export function resolveFolderRollup(threads: Iterable<RollupThread>): FolderRollup | null {
  let approval = false;
  let input = false;
  let plan = false;
  let failed = false;
  let working = 0;
  for (const thread of threads) {
    const status = resolveSidebarThreadStatus(thread);
    if (status === "approval") approval = true;
    else if (status === "input") input = true;
    else if (status === "failed") failed = true;
    else if (status === "working") working += 1;
    if (!plan && resolveThreadStatusPill({ thread })?.label === "Plan Ready") plan = true;
  }
  if (approval) return { kind: "approval", label: "Approval" };
  if (input) return { kind: "input", label: "Input" };
  if (plan) return { kind: "plan", label: "Plan ready" };
  if (failed) return { kind: "failed", label: "Failed" };
  if (working > 0) return { kind: "working", label: `${working} working` };
  return null;
}

interface FolderGroup {
  readonly projectKey: string;
  readonly memberProjects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}

const memberKey = (environmentId: EnvironmentId, projectId: ProjectId) =>
  `${environmentId}:${projectId}`;

/**
 * Each project's folder, by `environmentId:projectId`. A group that holds a
 * machine's Scratch project ("No project") has no folder: its threads are the
 * board's standalone threads.
 */
export function folderByProjectMember(
  groups: ReadonlyArray<FolderGroup>,
  scratchRootFor: (environmentId: EnvironmentId) => string | null,
  isScratch: (project: { readonly workspaceRoot: string }, root: string | null) => boolean,
): ReadonlyMap<string, string | null> {
  const folders = new Map<string, string | null>();
  for (const group of groups) {
    const scratch = group.memberProjects.some((project) =>
      isScratch(project, scratchRootFor(project.environmentId)),
    );
    for (const project of group.memberProjects) {
      folders.set(memberKey(project.environmentId, project.id), scratch ? null : group.projectKey);
    }
  }
  return folders;
}

export function folderOfThread(
  folders: ReadonlyMap<string, string | null>,
  thread: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): string | null {
  return folders.get(memberKey(thread.environmentId, thread.projectId)) ?? null;
}

/**
 * The active section's layout: the Projects heading, each folder with its
 * active threads and its "All threads" row when open, then the Threads heading
 * and the standalone threads. `visible` is the threads in that order, without
 * those in closed folders, for keyboard order and jump hints. A thread whose
 * folder is not listed (a project the client has not loaded yet) shows as
 * standalone rather than disappearing.
 */
export function layoutActiveFolders<Row>(input: {
  readonly folders: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<Row>;
  readonly keyOf: (row: Row) => string;
  readonly folderOf: (row: Row) => string | null;
  readonly isOpen: (folder: string) => boolean;
}): { readonly items: SidebarListItem[]; readonly visible: Row[] } {
  const listed = new Set(input.folders);
  const rowsByFolder = new Map<string, Row[]>();
  const standalone: Row[] = [];
  for (const row of input.rows) {
    const folder = input.folderOf(row);
    if (folder === null || !listed.has(folder)) {
      standalone.push(row);
      continue;
    }
    const rows = rowsByFolder.get(folder);
    if (rows) rows.push(row);
    else rowsByFolder.set(folder, [row]);
  }
  const items: SidebarListItem[] = [];
  const visible: Row[] = [];
  const push = (row: Row, folder: string | null) => {
    items.push({ kind: "thread", key: input.keyOf(row), section: "active", folder });
    visible.push(row);
  };
  if (input.folders.length > 0) items.push({ kind: "marker", marker: "projects-header" });
  for (const folder of input.folders) {
    items.push({ kind: "folder", folder });
    if (!input.isOpen(folder)) continue;
    for (const row of rowsByFolder.get(folder) ?? []) push(row, folder);
    items.push({ kind: "folder-more", folder });
  }
  if (standalone.length > 0) {
    items.push({ kind: "marker", marker: "threads-header" });
    for (const row of standalone) push(row, null);
  }
  return { items, visible };
}
