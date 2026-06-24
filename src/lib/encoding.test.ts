import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, parseBinaryInput, textToBytes, bytesToText } from "./encoding";

describe("encoding", () => {
  it("round-trips text, hex, and base64", () => {
    const bytes = textToBytes("hello");
    expect(bytesToText(bytes)).toBe("hello");
    const hex = bytesToHex(bytes);
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
    const base64 = bytesToBase64(bytes);
    expect(bytesToHex(base64ToBytes(base64))).toBe(hex);
    expect(bytesToHex(parseBinaryInput(hex))).toBe(hex);
    expect(bytesToHex(parseBinaryInput(base64))).toBe(hex);
  });

  it("rejects invalid hex and base64", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => parseBinaryInput("!!not-b64!!")).toThrow();
  });
});

