import { describe, expect, it } from "vite-plus/test";

import { workspaceRefusal } from "./workspaces.ts";

describe("workspaceRefusal", () => {
  const home = "/home/me/.magnesium";

  it("lets agents work in T3's workspaces in the state home, and anywhere outside it", () => {
    for (const cwd of [
      `${home}/projects/app`,
      `${home}/projects`,
      `${home}/worktrees/repo/branch`,
      `${home}/scratch/today`,
      "/home/me/code/app",
      "/home/me/.magnesium-other/x",
      "/home/me",
    ]) {
      expect(workspaceRefusal(home, cwd), cwd).toBeNull();
    }
  });

  it("refuses every other folder of the state home, and the state home itself", () => {
    for (const cwd of [
      home,
      `${home}/backups/2026-10-15`,
      `${home}/userdata`,
      `${home}/profiles/scratch-a`,
      `${home}/caches`,
      `${home}/projectsx`,
      `${home}/new-folder/projects`,
    ]) {
      expect(workspaceRefusal(home, cwd), cwd).toContain(
        "agents may work only in projects/, worktrees/ and scratch/",
      );
    }
  });
});
