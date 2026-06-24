import { decode } from "cbor-x";
import { bytesToBase64, bytesToHex } from "./encoding";

export function decodeCborBytes(input: ArrayBuffer | Uint8Array): unknown {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return decode(bytes);
}

export function toDisplayValue(value: unknown): DisplayValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return {
      $type: "bytes",
      byteLength: value.byteLength,
      hex: bytesToHex(value),
      base64: bytesToBase64(value)
    };
  }
  if (value instanceof ArrayBuffer) {
    return toDisplayValue(new Uint8Array(value));
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toDisplayValue(entry));
  }
  if (value && typeof value === "object") {
    const output: Record<string, DisplayValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = toDisplayValue(entry);
    }
    return output;
  }
  return String(value);
}

export function prettyCborValue(value: unknown): string {
  return JSON.stringify(toDisplayValue(value), null, 2);
}

export type DisplayValue =
  | null
  | string
  | number
  | boolean
  | DisplayValue[]
  | {
      [key: string]: DisplayValue;
    };

