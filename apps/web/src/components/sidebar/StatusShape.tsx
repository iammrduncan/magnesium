// magnesium: the boards' status shapes (goal 05). Each status has its own shape as well
// as its colour, so a row reads the same without colour. Static: nothing here animates.
import { cn } from "~/lib/utils";

export type StatusShapeKind =
  | "approval"
  | "input"
  | "plan"
  | "working"
  | "failed"
  | "done"
  | "monitoring"
  | "idle";

/** The colour for each status, shared by shapes and labels. */
export const STATUS_SHAPE_TONE: Record<StatusShapeKind, string> = {
  approval: "text-warning-foreground",
  input: "text-indigo-600 dark:text-indigo-300",
  plan: "text-violet-600 dark:text-violet-300",
  working: "text-sky-600 dark:text-sky-400",
  failed: "text-red-700 dark:text-red-300",
  done: "text-emerald-700 dark:text-emerald-300",
  monitoring: "text-secondary-label",
  idle: "text-secondary-label/70",
};

export function StatusShape(props: { kind: StatusShapeKind; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className={cn("size-2.5 shrink-0", props.className)}
      fill="currentColor"
      stroke="currentColor"
    >
      {props.kind === "approval" ? (
        <path d="M6 1.5 11 10.5H1Z" strokeWidth="0" />
      ) : props.kind === "input" ? (
        <path d="M6 1 11 6 6 11 1 6Z" strokeWidth="0" />
      ) : props.kind === "plan" ? (
        <rect x="2" y="2" width="8" height="8" rx="1.5" fill="none" strokeWidth="1.6" />
      ) : props.kind === "working" ? (
        <>
          <circle cx="6" cy="6" r="4.2" fill="none" strokeWidth="1.6" />
          <path d="M6 1.8a4.2 4.2 0 0 1 0 8.4Z" strokeWidth="0" />
        </>
      ) : props.kind === "failed" ? (
        <rect x="1.5" y="1.5" width="9" height="9" rx="2" strokeWidth="0" />
      ) : props.kind === "done" ? (
        <circle cx="6" cy="6" r="4.5" strokeWidth="0" />
      ) : (
        <circle
          cx="6"
          cy="6"
          r="4"
          fill="none"
          strokeWidth="1.4"
          strokeDasharray={props.kind === "monitoring" ? "2 1.6" : undefined}
        />
      )}
    </svg>
  );
}
