import { describe, expect, it } from "vitest";
import {
  buildStorageListRequest,
  buildStoragePutRequest,
  buildStorageGetRequest,
  buildStorageDeleteRequest,
  buildStorageDirectoryCreateRequest,
  buildStorageDirectoryDeleteRequest,
} from "./requestBuilders";
import {
  binarySummary,
  readSmallObjectFile,
  sanitizeStorageValue,
  storageDownloadMetadata,
} from "./storageUi";
import { STORAGE_MAX_PAYLOAD_BYTES } from "./protocol";

const sid = "s";
const bin = { $type: "binary" as const, bytes: new ArrayBuffer(1) };
describe("storage builders", () => {
  it("uses get response path and MIME metadata for downloads", () => {
    const result = {
      path: "server/actual.bin",
      content: {
        $type: "binary" as const,
        bytes: new ArrayBuffer(1),
        mime: "application/octet-stream",
      },
      contentType: "text/custom",
    };
    expect(storageDownloadMetadata(result)).toEqual({
      filename: "actual.bin",
      mime: "text/custom",
    });
    expect(
      storageDownloadMetadata({
        ...result,
        contentType: undefined,
      }),
    ).toMatchObject({ mime: "application/octet-stream" });
  });

  it("rejects oversized small-object files before reading them", async () => {
    let reads = 0;
    const oversized = {
      size: STORAGE_MAX_PAYLOAD_BYTES + 1,
      arrayBuffer: async () => {
        reads += 1;
        return new ArrayBuffer(0);
      },
    } as unknown as File;
    await expect(readSmallObjectFile(oversized)).rejects.toThrow(
      /File exceeds/,
    );
    expect(reads).toBe(0);

    let boundaryReads = 0;
    const boundary = {
      size: STORAGE_MAX_PAYLOAD_BYTES,
      arrayBuffer: async () => {
        boundaryReads += 1;
        return new ArrayBuffer(1);
      },
    } as unknown as File;
    await expect(readSmallObjectFile(boundary)).resolves.toEqual(
      new ArrayBuffer(1),
    );
    expect(boundaryReads).toBe(1);
  });

  it("projects list and validates limits/cursor", () => {
    expect(
      buildStorageListRequest({
        connectSessionId: sid,
        prefix: "a/",
        limit: 10,
      }).params.prefix,
    ).toBe("a");
    expect(() =>
      buildStorageListRequest({ connectSessionId: sid, limit: 0 }),
    ).toThrow();
    expect(() =>
      buildStorageListRequest({ connectSessionId: sid, cursor: "" }),
    ).toThrow();
  });
  it("rejects unsafe paths and ranges", () => {
    for (const path of ["/a", "a//b", "a/../b", "a/\uFF0Fb"])
      expect(() =>
        buildStorageGetRequest({ connectSessionId: sid, path }),
      ).toThrow();
    expect(() =>
      buildStorageGetRequest({ connectSessionId: sid, path: "a", length: 0 }),
    ).toThrow();
    expect(() =>
      buildStorageGetRequest({
        connectSessionId: sid,
        path: "a",
        offset: Number.MAX_SAFE_INTEGER,
        length: 2,
      }),
    ).toThrow();
  });

  it("sanitizes binary values to bounded previews", () => {
    const s = binarySummary(new Uint8Array(300).buffer);
    expect(s.byteLength).toBe(300);
    expect(s.previewHex.length).toBe(512);
    const raw = sanitizeStorageValue(new Uint8Array([1, 2]).buffer);
    expect(JSON.stringify(raw)).not.toContain("ArrayBuffer");
    const out = sanitizeStorageValue({
      content: { $type: "binary", bytes: new Uint8Array(300).buffer },
    }) as { content: { byteLength: number; previewHex: string } };
    expect(out.content.byteLength).toBe(300);
    expect(out.content.previewHex.length).toBe(512);
  });

});
