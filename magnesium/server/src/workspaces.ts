// @effect-diagnostics nodeBuiltinImport:off - pure path arithmetic, shared with the fence's rule.
import * as NodePath from "node:path";

/**
 * T3's workspace folders in its state home: projects made by name, worktrees
 * and Scratch. Inside the state home, these are the only places an agent may
 * work; its other folders (userdata/, backups/, profiles/, and any added later)
 * hold the server's own files and secrets (D46). `magnesium-fence` and the
 * container wrapper apply the same rule, so it holds at every level.
 */
export const WORKSPACE_ROOTS: ReadonlyArray<string> = ["projects", "worktrees", "scratch"];

/**
 * Why an agent may not work in `cwd`, or null when it may. Both paths are
 * resolved (symlinks followed) by the caller.
 */
export const workspaceRefusal = (stateHome: string, cwd: string): string | null => {
  const relative = NodePath.relative(stateHome, cwd);
  if (
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  ) {
    return null;
  }
  const first = relative.split(NodePath.sep)[0] ?? "";
  if (WORKSPACE_ROOTS.includes(first)) return null;
  return (
    `This thread's folder, ${cwd}, is inside Magnesium's own folder (${stateHome}), ` +
    `where agents may work only in projects/, worktrees/ and scratch/. ` +
    `Move the project into one of those, or out of ${stateHome}.`
  );
};
