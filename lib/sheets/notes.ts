// Notes are append-only; each entry is prefixed "[<slug> @ <ISO>]\n"
// (docs/sheets-schema.md). Lives outside the route file because Next route
// modules may only export HTTP handlers and route config.
export function appendNote(existing: string, actor: string, at: string, text: string): string {
  const entry = `[${actor} @ ${at}]\n${text}`;
  return existing ? `${existing}\n\n${entry}` : entry;
}
