export type DiscoveryVariant = "h1" | "v1" | "v2";

export function isDiscoveryVariant(value: unknown): value is DiscoveryVariant {
  return value === "h1" || value === "v1" || value === "v2";
}

/** Escape HTML-significant characters while preserving the parsed JSON value. */
export function serializeInlineJson(value: unknown) {
  return (JSON.stringify(value) ?? "null").replace(/[<>&\u2028\u2029]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}
