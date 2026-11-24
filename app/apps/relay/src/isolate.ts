// Music removal's limits (index.ts `isolate`): ElevenLabs' Voice Isolator bills
// by the minute, so the relay takes one exact format and reads the length from
// the file itself rather than trusting what a client says.

/** ElevenLabs refuses anything shorter ("below the minimum of 4.6 seconds"): refused here, before any budget is held. */
export const ISOLATE_MIN_SECONDS = 4.6;
/** One request: 10 minutes. Workers hold the body in memory while it's sent on. */
export const ISOLATE_MAX_SECONDS = 600;
/** At $0.12 a minute: at most $14.40 a day per connection and $28.80 for the team. */
export const ISOLATE_DAILY_SECONDS_PER_CLIENT = 2 * 3600;
export const ISOLATE_DAILY_SECONDS_TOTAL = 4 * 3600;

const HEADER = 44;
const RATE = 44100;
const BYTES_PER_SECOND = RATE * 2;
export const ISOLATE_MAX_BYTES = HEADER + ISOLATE_MAX_SECONDS * BYTES_PER_SECOND;

const tag = (view: DataView, at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

/** The seconds in a plain 44.1 kHz, mono, 16-bit WAV; null for anything else. */
export function wavSeconds(file: Uint8Array): number | null {
  if (file.byteLength <= HEADER || file.byteLength > ISOLATE_MAX_BYTES) return null;
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (tag(view, 0) !== "RIFF" || tag(view, 8) !== "WAVE" || tag(view, 12) !== "fmt " || tag(view, 36) !== "data") return null;
  if (view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1) return null;
  if (view.getUint32(24, true) !== RATE || view.getUint16(34, true) !== 16) return null;
  const bytes = file.byteLength - HEADER;
  if (view.getUint32(40, true) !== bytes || bytes % 2 !== 0) return null;
  return bytes / BYTES_PER_SECOND;
}
