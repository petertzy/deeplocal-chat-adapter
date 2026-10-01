/** Never include parser errors or payloads: arguments may contain credentials. */
export function parseToolInput(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Invalid or incomplete tool arguments: expected a JSON object. Retry the request.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid tool arguments: expected a JSON object. Retry the request.');
  }
  return parsed as Record<string, unknown>;
}
