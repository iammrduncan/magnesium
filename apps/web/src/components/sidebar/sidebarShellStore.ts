// magnesium: the sidebar's density and open folders, remembered per device (goal 05).
// Folders start collapsed, as on the boards; only the ones you open are stored.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

export type SidebarDensity = "comfy" | "compact";

interface SidebarShellState {
  readonly density: SidebarDensity;
  readonly openFolders: Readonly<Record<string, true>>;
  readonly setDensity: (density: SidebarDensity) => void;
  readonly setFolderOpen: (folder: string, open: boolean) => void;
}

export const useSidebarShellStore = create<SidebarShellState>()(
  persist(
    (set) => ({
      density: "comfy",
      openFolders: {},
      setDensity: (density) => set({ density }),
      setFolderOpen: (folder, open) =>
        set((state) => {
          if (open === (state.openFolders[folder] === true)) return state;
          const openFolders = { ...state.openFolders };
          if (open) openFolders[folder] = true;
          else delete openFolders[folder];
          return { openFolders };
        }),
    }),
    {
      name: "magnesium:sidebar-shell:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ density: state.density, openFolders: state.openFolders }),
    },
  ),
);
