// A turn Edit starts itself on something that happened in the background (a
// removal finished: removal_schedule.ts), not a message of the person's: its
// prompt starts with this, and the chat shows it as Edit's own event (agent.ts
// marks its entry `by: "edit"`), never as a bubble of theirs. A channel's
// end-of-turn check (end_check.ts) sends this alone as its message, what it
// found going as the turn's context, so nothing of it is ever kept in the chat.
export const EDIT_EVENT = "(Edit, background)";
