// magnesium: the folder rows of the sidebar's active section (goal 05, Home and Session boards).
// They sit in upstream's sortable list as structure: they move with the rows
// during a drag but are never picked up.
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlignJustifyIcon, ChevronRightIcon, FolderIcon, Rows2Icon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { animateSidebarLayoutChanges } from "../Sidebar.logic";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { FolderRollup } from "./sidebarFolders";
import { useSidebarShellStore } from "./sidebarShellStore";
import { STATUS_SHAPE_TONE, StatusShape } from "./StatusShape";

function SortableStructureRow(props: {
  id: string;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: props.id,
    disabled: { draggable: true },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

const headingClassName =
  "text-2xs font-medium tracking-wider text-sidebar-muted-foreground/70 uppercase";

/** "Projects", with the comfy and compact switch, as on the boards. */
export function SidebarProjectsHeading(props: { id: string }) {
  const density = useSidebarShellStore((state) => state.density);
  const setDensity = useSidebarShellStore((state) => state.setDensity);
  return (
    <SortableStructureRow
      id={props.id}
      className="mt-2 flex h-8 items-center justify-between px-2"
      data-testid="sidebar-projects-header"
    >
      <span className={headingClassName}>Projects</span>
      <ToggleGroup
        aria-label="Sidebar density"
        variant="segmented"
        value={[density]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "comfy" || next === "compact") setDensity(next);
        }}
      >
        <Toggle aria-label="Comfy rows" value="comfy">
          <Rows2Icon className="size-3.5" />
        </Toggle>
        <Toggle aria-label="Compact rows" value="compact">
          <AlignJustifyIcon className="size-3.5" />
        </Toggle>
      </ToggleGroup>
    </SortableStructureRow>
  );
}

/** "Threads": the threads that belong to no project. */
export function SidebarThreadsHeading(props: { id: string }) {
  return (
    <SortableStructureRow
      id={props.id}
      className="mt-3 flex h-7 items-center px-2"
      data-testid="sidebar-threads-header"
    >
      <span className={headingClassName}>Threads</span>
    </SortableStructureRow>
  );
}

export function FolderRollupLabel(props: { rollup: FolderRollup }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
        STATUS_SHAPE_TONE[props.rollup.kind],
      )}
    >
      <StatusShape kind={props.rollup.kind} />
      {props.rollup.label}
    </span>
  );
}

/**
 * A project folder. The chevron opens and closes it; the name opens the
 * project (its first thread until goal 15 builds the project page). The
 * roll-up names the most urgent status inside.
 */
export const SidebarFolderRow = memo(function SidebarFolderRow(props: {
  id: string;
  folder: string;
  name: string;
  /** Where the project lives, shown when another folder has the same name. */
  machine: string | null;
  open: boolean;
  rollup: FolderRollup | null;
  onSetOpen: (folder: string, open: boolean) => void;
  onOpenProject: (folder: string) => void;
}) {
  return (
    <SortableStructureRow id={props.id} data-testid="sidebar-folder">
      <div className="group/folder flex h-8 items-center gap-1 rounded-md pr-2 text-sm hover:bg-sidebar-row-hover">
        <button
          type="button"
          aria-expanded={props.open}
          aria-label={props.open ? `Collapse ${props.name}` : `Expand ${props.name}`}
          onClick={() => props.onSetOpen(props.folder, !props.open)}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground/70 hover:text-sidebar-foreground"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", props.open && "rotate-90")}
          />
        </button>
        <button
          type="button"
          onClick={() => props.onOpenProject(props.folder)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-sidebar-foreground"
        >
          <FolderIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
          <span className="min-w-0 truncate font-medium">{props.name}</span>
          {props.machine ? (
            <span className="min-w-0 truncate text-xs text-sidebar-muted-foreground/70">
              {props.machine}
            </span>
          ) : null}
          <span aria-hidden className="flex-1" />
        </button>
        {props.rollup ? <FolderRollupLabel rollup={props.rollup} /> : null}
      </div>
    </SortableStructureRow>
  );
});

/**
 * Closes an open folder. "All N threads" scopes the sidebar to the project,
 * settled and snoozed threads included, until goal 15 builds the project page;
 * while scoped it reads "All projects" and lifts the scope.
 */
export const SidebarFolderMoreRow = memo(function SidebarFolderMoreRow(props: {
  id: string;
  folder: string;
  threadCount: number;
  scoped: boolean;
  onShowAll: (folder: string) => void;
  onShowAllProjects: () => void;
}) {
  const linkClassName =
    "flex h-7 w-full cursor-pointer items-center rounded-md pl-9 text-left text-xs text-sidebar-muted-foreground/70 hover:bg-sidebar-row-hover hover:text-sidebar-foreground";
  return (
    <SortableStructureRow id={props.id} data-testid="sidebar-folder-more">
      {props.scoped ? (
        <button type="button" onClick={props.onShowAllProjects} className={linkClassName}>
          All projects
        </button>
      ) : props.threadCount > 0 ? (
        <button
          type="button"
          onClick={() => props.onShowAll(props.folder)}
          className={linkClassName}
        >
          All {props.threadCount} {props.threadCount === 1 ? "thread" : "threads"}
        </button>
      ) : (
        <div className="flex h-7 items-center pl-9 text-xs text-sidebar-muted-foreground/50">
          No threads yet
        </div>
      )}
    </SortableStructureRow>
  );
});
