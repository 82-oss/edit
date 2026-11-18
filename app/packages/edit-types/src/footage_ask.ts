// A message to a script that may ask for more of the case's footage found on
// YouTube (Sphe, Nov 18: "research and find more footage for this case"):
// the server reads it for that first (writer/finder.ts), where Opus decides
// for sure, and the page shows it as said, not as "Build the script. …", on a
// script not built yet. Cheap, before any Claude turn: an ask to find, search,
// research or get, about footage or the kinds of it.

const ASKS = /\b(find|finding|search|searching|research|look(ing)? (for|up)|dig|hunt|track down|get|grab|pull|source|more|other|additional|extra)\b/iu;
const FOOTAGE = /\b(footage|videos?|clips?|recordings?|bodycam|body cam|body-cam|dashcam|dash cam|courtroom|court|trial|sentencing|interrogation|interview|911|news|hearing|youtube|testimony|verdict|arraignment)\b/iu;

export function mayAskForFootage(text: string): boolean {
  return ASKS.test(text) && FOOTAGE.test(text);
}
