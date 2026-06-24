import type { BinaryField } from "./protocol";

export function makeBinaryField(bytes: ArrayBuffer | ArrayBufferView, mime?: string): BinaryField {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const copy = new Uint8Array(view);
  const field: BinaryField = {
    $type: "binary",
    bytes: copy.buffer
  };
  if (mime) {
    field.mime = mime;
  }
  return field;
}

export function isBinaryField(value: unknown): value is BinaryField {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as BinaryField).$type === "binary" &&
    (value as BinaryField).bytes instanceof ArrayBuffer &&
    ((value as BinaryField).mime === undefined || typeof (value as BinaryField).mime === "string")
  );
}

export function assertBinaryField(value: unknown, name = "value"): BinaryField {
  if (!isBinaryField(value)) {
    throw new Error(`${name} must be a BinaryField`);
  }
  return value;
}

export function binaryFieldToBytes(value: BinaryField): Uint8Array {
  return new Uint8Array(value.bytes.slice(0));
}

export function bytesToBinaryField(bytes: ArrayBuffer | ArrayBufferView, mime?: string): BinaryField {
  return makeBinaryField(bytes, mime);
}

export function cloneBinaryField(field: BinaryField): BinaryField {
  return makeBinaryField(new Uint8Array(field.bytes), field.mime);
}
