const SCRIPT_UNSAFE_CHARACTERS = /[<>&\u2028\u2029]/g;

const SCRIPT_SAFE_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/** Serialize JSON for use as the text content of an HTML script element. */
export function serializeJsonLd(value: unknown): string {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    throw new TypeError("JSON-LD value must be JSON-serializable");
  }

  return serialized.replace(
    SCRIPT_UNSAFE_CHARACTERS,
    (character) => SCRIPT_SAFE_ESCAPES[character],
  );
}
