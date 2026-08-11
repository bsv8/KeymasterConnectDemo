import { bytesToHex, bytesToText } from "./encoding";
import { STORAGE_MAX_PAYLOAD_BYTES, type StorageGetResult } from "./protocol";

export async function readSmallObjectFile(file: File): Promise<ArrayBuffer> {
  if (file.size > STORAGE_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `File exceeds ${STORAGE_MAX_PAYLOAD_BYTES} bytes; use multipart upload instead`,
    );
  }
  return file.arrayBuffer();
}

export function storageDownloadMetadata(
  result: Pick<StorageGetResult, "path" | "contentType" | "content">,
): { filename: string; mime: string } {
  return {
    filename: result.path.split("/").pop() || "download",
    mime:
      result.contentType || result.content.mime || "application/octet-stream",
  };
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
export function sanitizeStorageValue(value: unknown): unknown {
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
  if (Array.isArray(value)) return value.map(sanitizeStorageValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitizeStorageValue(v)]),
    );
  return value;
}
export function sliceMultipartPart(
  file: File,
  partNumber: number,
  partSize: number,
): Promise<ArrayBuffer> {
  if (
    !Number.isSafeInteger(partNumber) ||
    partNumber < 1 ||
    !Number.isSafeInteger(partSize) ||
    partSize < 1
  )
    return Promise.reject(new Error("Invalid multipart range"));
  if (partNumber - 1 > Math.floor(Number.MAX_SAFE_INTEGER / partSize))
    return Promise.reject(new Error("Multipart range overflow"));
  const start = (partNumber - 1) * partSize;
  if (start >= file.size)
    return Promise.reject(new Error("Part exceeds file size"));
  return file.slice(start, Math.min(start + partSize, file.size)).arrayBuffer();
}
