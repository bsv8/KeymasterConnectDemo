import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isAppIdentityProof, readAppIdentityProof } from "./appIdentityProof";

class FakeMeta {
  constructor(private name: string, private content: string) {}
  getAttribute(name: string): string | null {
    return name === "content" ? this.content : name === "name" ? this.name : null;
  }
  setAttribute(name: string, value: string): void {
    if (name === "content") this.content = value;
  }
  remove(): void {
    // 测试只需让查询不到该节点；FakeDocument 会在用例中移除引用。
  }
}

class FakeDocument {
  constructor(readonly elements: FakeMeta[]) {}
  querySelectorAll(selector: string): FakeMeta[] {
    const name = selector.match(/name="([^"]+)"/)?.[1];
    return name === undefined
      ? this.elements
      : this.elements.filter((element) => element.getAttribute("name") === name);
  }
  querySelector(selector: string): FakeMeta | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function fixtureDocument(requirements = ["private-key", "storage"]): FakeDocument {
  const metas = [
    ["id", "keymaster-connect-demo"],
    [
      "publisher-public-key",
      "032558368095eb0a4cb07d0dd59a8a5bffdfd19c495a79de280db63b746e228b30",
    ],
    ["name", "Keymaster Connect Demo"],
    ["description", "Fixture description"],
    ...requirements.map((value) => ["requirement", value]),
    ["identity-signature", "ab".repeat(64)],
  ];
  return new FakeDocument(metas.map(([name, content]) => new FakeMeta(`keymaster-app:${name}`, content)));
}

function setMeta(documentRef: FakeDocument, name: string, content: string): void {
  documentRef.elements.find((element) => element.getAttribute("name") === `keymaster-app:${name}`)?.setAttribute("content", content);
}

describe("固定 AppIdentityProof meta", () => {
  it("严格解析 fixture 并保留 exact proof shape", () => {
    const proof = readAppIdentityProof(fixtureDocument() as unknown as Document);
    expect(proof).toEqual({
      version: 1,
      publisherPublicKey:
        "032558368095eb0a4cb07d0dd59a8a5bffdfd19c495a79de280db63b746e228b30",
      app: {
        id: "keymaster-connect-demo",
        name: "Keymaster Connect Demo",
        description: "Fixture description",
      },
      requirements: ["private-key", "storage"],
      signature: "ab".repeat(64),
    });
    expect(isAppIdentityProof(proof)).toBe(true);
  });

  it("拒绝缺失、重复、未排序 requirement 与错误签名", () => {
    expect(() => readAppIdentityProof(fixtureDocument(["storage", "private-key"]) as unknown as Document)).toThrow(/sorted/);
    expect(() => readAppIdentityProof(fixtureDocument(["private-key", "private-key"]) as unknown as Document)).toThrow(/unique/);
    const missingSignature = fixtureDocument();
    missingSignature.elements.splice(
      missingSignature.elements.findIndex(
        (element) => element.getAttribute("name") === "keymaster-app:identity-signature",
      ),
      1,
    );
    expect(() => readAppIdentityProof(missingSignature as unknown as Document)).toThrow(/identity-signature/);
    const badSignature = fixtureDocument();
    badSignature
      .querySelector('meta[name="keymaster-app:identity-signature"]')
      ?.setAttribute("content", "AB".repeat(64));
    expect(() => readAppIdentityProof(badSignature as unknown as Document)).toThrow(/lowercase/);
  });

  it("对齐 Core 的未知 meta、zero requirements、字符串边界和曲线点校验", () => {
    const zeroRequirements = fixtureDocument([]);
    expect(readAppIdentityProof(zeroRequirements as unknown as Document).requirements).toEqual([]);

    const unknownMeta = fixtureDocument();
    unknownMeta.elements.push(new FakeMeta("keymaster-app:unknown", "x"));
    expect(() => readAppIdentityProof(unknownMeta as unknown as Document)).toThrow(/unknown app metadata/);

    const surroundingWhitespace = fixtureDocument();
    setMeta(surroundingWhitespace, "name", " Name");
    expect(() => readAppIdentityProof(surroundingWhitespace as unknown as Document)).toThrow();
    const control = fixtureDocument();
    setMeta(control, "description", "bad\u0000description");
    expect(() => readAppIdentityProof(control as unknown as Document)).toThrow(/description/);
    const replacement = fixtureDocument();
    setMeta(replacement, "name", "bad\ufffdui");
    expect(() => readAppIdentityProof(replacement as unknown as Document)).toThrow(/name/);
    const invalidId = fixtureDocument();
    setMeta(invalidId, "id", "Not Valid");
    expect(() => readAppIdentityProof(invalidId as unknown as Document)).toThrow(/id/);
    const invalidPoint = fixtureDocument();
    setMeta(invalidPoint, "publisher-public-key", "02" + "00".repeat(32));
    expect(() => readAppIdentityProof(invalidPoint as unknown as Document)).toThrow(/publisher/);
    const missingContentDuplicate = fixtureDocument();
    missingContentDuplicate.elements.push(new FakeMeta("keymaster-app:name", ""));
    expect(() => readAppIdentityProof(missingContentDuplicate as unknown as Document)).toThrow(/exactly once/);
  });

  it("生产入口保留真实公钥与固定签名 meta", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    expect(html).toContain(
      'name="keymaster-app:publisher-public-key" content="032558368095eb0a4cb07d0dd59a8a5bffdfd19c495a79de280db63b746e228b30"',
    );
    expect(
      html.match(/name="keymaster-app:identity-signature"/g) ?? [],
    ).toHaveLength(1);
  });
});
