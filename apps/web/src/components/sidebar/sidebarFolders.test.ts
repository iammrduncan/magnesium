// magnesium: project folders over the sidebar's active rows (goal 05)
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { DEFAULT_RUNTIME_MODE } from "../../types";
import {
  folderByProjectMember,
  folderOfThread,
  layoutActiveFolders,
  resolveFolderRollup,
} from "./sidebarFolders";

const session = (status: "running" | "ready" | "error") => ({
  threadId: ThreadId.make("thread-1"),
  status,
  providerName: "Codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: DEFAULT_RUNTIME_MODE,
  activeTurnId: status === "running" ? ("turn-1" as never) : null,
  lastError: null,
  updatedAt: "2026-10-15T10:00:00.000Z",
});

const idle = {
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default" as const,
  latestTurn: null,
  session: session("ready"),
};
const working = { ...idle, session: session("running") };
const failed = { ...idle, session: session("error") };
const approval = { ...working, hasPendingApprovals: true };
const input = { ...idle, hasPendingUserInput: true };
const planReady = {
  ...idle,
  interactionMode: "plan" as const,
  hasActionableProposedPlan: true,
  latestTurn: {
    turnId: "turn-1" as never,
    state: "completed" as const,
    assistantMessageId: null,
    requestedAt: "2026-10-15T10:00:00.000Z",
    startedAt: "2026-10-15T10:00:00.000Z",
    completedAt: "2026-10-15T10:05:00.000Z",
  },
};

describe("resolveFolderRollup", () => {
  it("names the most urgent status: approval, input, plan ready, failed, then working", () => {
    expect(resolveFolderRollup([working, input, approval])).toEqual({
      kind: "approval",
      label: "Approval",
    });
    expect(resolveFolderRollup([working, planReady, input])).toEqual({
      kind: "input",
      label: "Input",
    });
    expect(resolveFolderRollup([failed, planReady, working])).toEqual({
      kind: "plan",
      label: "Plan ready",
    });
    expect(resolveFolderRollup([working, failed])).toEqual({ kind: "failed", label: "Failed" });
  });

  it("counts working threads, and says nothing when the folder is quiet", () => {
    expect(resolveFolderRollup([working, idle, working])).toEqual({
      kind: "working",
      label: "2 working",
    });
    expect(resolveFolderRollup([idle, idle])).toBeNull();
    expect(resolveFolderRollup([])).toBeNull();
  });
});

describe("folderByProjectMember", () => {
  const gpu = EnvironmentId.make("gpu-host");
  const cpu = EnvironmentId.make("cpu-host");
  const groups = [
    {
      projectKey: "infra",
      memberProjects: [
        { environmentId: gpu, id: ProjectId.make("infra-gpu"), workspaceRoot: "/srv/infra" },
        { environmentId: cpu, id: ProjectId.make("infra-cpu"), workspaceRoot: "/home/infra" },
      ],
    },
    {
      projectKey: "scratch",
      memberProjects: [
        { environmentId: cpu, id: ProjectId.make("scratch-cpu"), workspaceRoot: "/scratch" },
      ],
    },
  ];
  const folders = folderByProjectMember(
    groups,
    (environmentId) => (environmentId === cpu ? "/scratch" : null),
    (project, root) => root !== null && project.workspaceRoot === root,
  );

  it("puts one project's threads from every machine in one folder", () => {
    expect(
      folderOfThread(folders, { environmentId: gpu, projectId: ProjectId.make("infra-gpu") }),
    ).toBe("infra");
    expect(
      folderOfThread(folders, { environmentId: cpu, projectId: ProjectId.make("infra-cpu") }),
    ).toBe("infra");
  });

  it("leaves Scratch and unknown projects without a folder, as standalone threads", () => {
    expect(
      folderOfThread(folders, { environmentId: cpu, projectId: ProjectId.make("scratch-cpu") }),
    ).toBeNull();
    expect(
      folderOfThread(folders, { environmentId: cpu, projectId: ProjectId.make("unknown") }),
    ).toBeNull();
  });
});

describe("layoutActiveFolders", () => {
  const rows = [
    { key: "env:a1", folder: "a" },
    { key: "env:s1", folder: null },
    { key: "env:b1", folder: "b" },
    { key: "env:a2", folder: "a" },
    { key: "env:x1", folder: "not-loaded" },
  ];
  const layout = (open: ReadonlySet<string>) =>
    layoutActiveFolders({
      folders: ["a", "b"],
      rows,
      keyOf: (row) => row.key,
      folderOf: (row) => row.folder,
      isOpen: (folder) => open.has(folder),
    });

  it("shows closed folders alone, then the standalone threads", () => {
    const { items, visible } = layout(new Set());
    expect(items).toEqual([
      { kind: "marker", marker: "projects-header" },
      { kind: "folder", folder: "a" },
      { kind: "folder", folder: "b" },
      { kind: "marker", marker: "threads-header" },
      { kind: "thread", key: "env:s1", section: "active", folder: null },
      { kind: "thread", key: "env:x1", section: "active", folder: null },
    ]);
    expect(visible.map((row) => row.key)).toEqual(["env:s1", "env:x1"]);
  });

  it("lists an open folder's threads in order, then its All threads row", () => {
    const { items, visible } = layout(new Set(["a"]));
    expect(items.slice(0, 6)).toEqual([
      { kind: "marker", marker: "projects-header" },
      { kind: "folder", folder: "a" },
      { kind: "thread", key: "env:a1", section: "active", folder: "a" },
      { kind: "thread", key: "env:a2", section: "active", folder: "a" },
      { kind: "folder-more", folder: "a" },
      { kind: "folder", folder: "b" },
    ]);
    expect(visible.map((row) => row.key)).toEqual(["env:a1", "env:a2", "env:s1", "env:x1"]);
  });

  it("drops the headings it has nothing under", () => {
    const { items } = layoutActiveFolders({
      folders: [],
      rows: [],
      keyOf: (row: { key: string }) => row.key,
      folderOf: () => null,
      isOpen: () => true,
    });
    expect(items).toEqual([]);
  });
});
