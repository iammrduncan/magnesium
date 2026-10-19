// magnesium: tabs with an underline, as the Profiles board draws its sections (goal 34)
"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "~/lib/utils";

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      className={cn("flex min-w-0 flex-col gap-3", className)}
      data-slot="tabs"
      {...props}
    />
  );
}

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      className={cn(
        "flex min-w-0 items-end gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]",
        className,
      )}
      data-slot="tabs-list"
      {...props}
    />
  );
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "-mb-px inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-3 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-active:border-foreground data-active:font-medium data-active:text-foreground data-disabled:pointer-events-none data-disabled:opacity-64",
        className,
      )}
      data-slot="tabs-tab"
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn("flex min-w-0 flex-col gap-3 outline-none", className)}
      data-slot="tabs-panel"
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsPanel, TabsTab };
