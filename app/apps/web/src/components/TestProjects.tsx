// Test projects on Home (dev_projects.ts): a project a coding agent, a script
// or a trial made is hidden, on every build, with no switch to show them
// (Sphe, Nov 14: "I shouldn't see them"). One brought forth when asked for
// (`shown`) is listed, marked Test, and can be promoted from its ⋯.

import { BadgeCheck } from "lucide-react";

import { useEditor } from "../lib/store";
import type { ProjectSummary } from "../lib/types";
import type { MenuItem } from "./ContextMenu";

/** Whether Home lists it: every project but a test one not brought forth. */
export function isListed(summary: { dev?: boolean; shown?: boolean } | null | undefined): boolean {
  return summary?.dev !== true || summary.shown === true;
}

/** The small mark beside a test project's name. */
export function TestBadge() {
  return (
    <span title="A test project. Promote it from its ⋯ if it’s real work." className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] border border-warning/40 bg-warning-soft px-1.5 text-[11px] leading-none font-semibold tracking-[0.02em] text-warning">
      Test
    </span>
  );
}

/** A test project's ⋯ item: promoted to an ordinary project, its mark gone. */
export function promoteItem(project: ProjectSummary, onChanged: () => void): MenuItem[] {
  if (project.dev !== true) return [];
  const promote = async () => {
    try {
      const answer = await fetch(`/api/projects/${project.id}/promote`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const given = (await answer.json().catch(() => ({}))) as { error?: unknown };
      if (!answer.ok) throw new Error(typeof given.error === "string" ? given.error : `${answer.status}`);
      useEditor.getState().toast(`“${project.name}” is a real project now`, "info");
    } catch (error) {
      useEditor.getState().toastError(error, `promote “${project.name}”`);
    }
    onChanged();
  };
  return [{ label: "Promote to real project", icon: <BadgeCheck size={14} />, onSelect: () => void promote() }];
}
