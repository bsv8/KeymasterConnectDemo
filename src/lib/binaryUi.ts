import { bytesToHex, bytesToText } from "./encoding";
const MAX_BINARY_BYTES = 16 * 1024 * 1024;

export async function readSmallObjectFile(file: File): Promise<ArrayBuffer> {
  if (file.size > MAX_BINARY_BYTES) {
    throw new Error(
      `File exceeds ${MAX_BINARY_BYTES} bytes`,
    );
  }
  return file.arrayBuffer();
}

export function binarySummary(bytes: ArrayBuffer, mime?: string) {
  const view = new Uint8Array(bytes);
  const preview = view.slice(0, 256);
  return {
    byteLength: view.byteLength,
    mime,
    previewHex: bytesToHex(preview),
    previewText: bytesToText(preview),
  };
}
export function sanitizeBinaryValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return binarySummary(value);
  if (value instanceof Uint8Array)
    return binarySummary(
      value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      ) as ArrayBuffer,
    );
  if (value && typeof value === "object" && "$type" in value) {
    const record = value as {
      $type?: unknown;
      bytes?: unknown;
      mime?: unknown;
    };
    if (record.$type === "binary" && record.bytes instanceof ArrayBuffer)
      return binarySummary(
        record.bytes,
        typeof record.mime === "string" ? record.mime : undefined,
      );
  }
  if (Array.isArray(value)) return value.map(sanitizeBinaryValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitizeBinaryValue(v)]),
    );
  return value;
}
