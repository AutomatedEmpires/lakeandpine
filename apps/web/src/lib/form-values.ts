const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export function formValue(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

export function formUuid(formData: FormData, key: string): string {
  const result = formValue(formData, key);
  if (!UUID_PATTERN.test(result)) throw new Error(`Invalid ${key}`);
  return result;
}

export function boundedDecimalValue(
  formData: FormData,
  key: string,
  options: { min: number; max: number; decimals?: number },
): number {
  const raw = formValue(formData, key);
  const decimals = options.decimals ?? 0;
  const fraction = raw.split(".")[1] ?? "";
  const result = Number(raw);
  if (
    !DECIMAL_PATTERN.test(raw) ||
    fraction.length > decimals ||
    !Number.isFinite(result) ||
    result < options.min ||
    result > options.max
  ) {
    throw new Error(`Invalid ${key}`);
  }
  return result;
}

export function boundedCurrencyCents(
  formData: FormData,
  key: string,
  options: { minCents: number; maxCents: number },
): number {
  const raw = formValue(formData, key);
  boundedDecimalValue(formData, key, {
    min: options.minCents / 100,
    max: options.maxCents / 100,
    decimals: 2,
  });

  const sign = raw.startsWith("-") ? -1 : 1;
  const unsigned = raw.replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
  const result = sign * cents;
  if (
    !Number.isSafeInteger(result) ||
    result < options.minCents ||
    result > options.maxCents
  ) {
    throw new Error(`Invalid ${key}`);
  }
  return result;
}
