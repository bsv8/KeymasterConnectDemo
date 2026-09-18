import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "./encoding";
import type {
  AppIdentityProofV1,
  AppRequirement,
} from "./protocol";

const REQUIREMENTS = new Set<AppRequirement>([
  "private-key",
  "storage",
]);
const META_PREFIX = "keymaster-app:";
const ALLOWED_META_NAMES = new Set([
  "keymaster-app:id",
  "keymaster-app:publisher-public-key",
  "keymaster-app:name",
  "keymaster-app:description",
  "keymaster-app:requirement",
  "keymaster-app:identity-signature",
]);
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f\ufffd]/u;

function readMetaValues(documentRef: Document, name: string): string[] {
  const expected = `${META_PREFIX}${name}`.toLowerCase();
  return Array.from(documentRef.querySelectorAll("meta[name]"))
    .filter((element) => (element.getAttribute("name") ?? "").toLowerCase() === expected)
    .map((element) => element.getAttribute("content") ?? "");
}

function rejectUnknownMetaNames(documentRef: Document): void {
  for (const element of Array.from(documentRef.querySelectorAll("meta[name]"))) {
    const name = (element.getAttribute("name") ?? "").toLowerCase();
    if (name.startsWith(META_PREFIX) && !ALLOWED_META_NAMES.has(name)) {
      throw new Error(`unknown app metadata: ${name}`);
    }
  }
}

function requireExactlyOneMeta(documentRef: Document, name: string): string {
  const values = readMetaValues(documentRef, name);
  if (values.length !== 1 || values[0].length === 0 || values[0] !== values[0].trim()) {
    throw new Error(`keymaster-app:${name} meta must appear exactly once`);
  }
  return values[0];
}

function isLowerHex(value: string, length: number): boolean {
  return new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function isValidPublisherPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^(02|03)[0-9a-f]{64}$/.test(value)) return false;
  try {
    return secp256k1.utils.isValidPublicKey(hexToBytes(value));
  } catch {
    return false;
  }
}

/**
 * 从当前文档的入口 meta 读取固定 proof。
 *
 * 设计缘由：运行时只读取并提交打包进当前 HTML 的公开证明，避免 fetch
 * `keymaster.app.json` 或触碰任何 Publisher 私钥；最终信任由 Keymaster 验签。
 * 缺失、重复和未知字段全部立即失败，防止页面在不完整身份下创建 session。
 */
export function readAppIdentityProof(documentRef: Document = document): AppIdentityProofV1 {
  const id = requireExactlyOneMeta(documentRef, "id");
  const publisherPublicKey = requireExactlyOneMeta(
    documentRef,
    "publisher-public-key",
  );
  const name = requireExactlyOneMeta(documentRef, "name");
  const description = requireExactlyOneMeta(documentRef, "description");
  const signature = requireExactlyOneMeta(documentRef, "identity-signature");
  rejectUnknownMetaNames(documentRef);
  if (!isValidPublisherPublicKey(publisherPublicKey)) {
    throw new Error("publisher-public-key must be lowercase compressed secp256k1 hex");
  }
  if (!isLowerHex(signature, 128)) {
    throw new Error("identity-signature must be 64-byte lowercase compact hex");
  }
  if (!ID_PATTERN.test(id)) throw new Error("id has invalid shape");
  if (!name.trim() || [...name].length > 120 || CONTROL_CHAR_PATTERN.test(name)) {
    throw new Error("name has invalid shape");
  }
  if (!description.trim() || [...description].length > 500 || CONTROL_CHAR_PATTERN.test(description)) {
    throw new Error("description has invalid shape");
  }
  const requirements = readMetaValues(documentRef, "requirement");
  if (requirements.some((value) => !REQUIREMENTS.has(value as AppRequirement))) {
    throw new Error("keymaster-app:requirement contains an unknown value");
  }
  const sortedRequirements = [...requirements].sort();
  if (new Set(requirements).size !== requirements.length) {
    throw new Error("keymaster-app:requirement values must be unique");
  }
  if (requirements.some((value, index) => value !== sortedRequirements[index])) {
    throw new Error("keymaster-app:requirement values must be sorted");
  }
  return {
    version: 1,
    publisherPublicKey,
    app: { id, name, description },
    requirements: sortedRequirements as AppRequirement[],
    signature,
  };
}

/** Strict runtime guard used by request builders and tests. */
export function isAppIdentityProof(value: unknown): value is AppIdentityProofV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  if (Object.keys(proof).sort().join(",") !== "app,publisherPublicKey,requirements,signature,version") return false;
  if (
    proof.version !== 1 ||
    !isValidPublisherPublicKey(proof.publisherPublicKey)
  )
    return false;
  if (typeof proof.signature !== "string" || !isLowerHex(proof.signature, 128)) return false;
  if (!Array.isArray(proof.requirements)) return false;
  const requirements = proof.requirements as unknown[];
  if (
    requirements.some(
      (value) =>
        typeof value !== "string" ||
        !REQUIREMENTS.has(value as AppRequirement),
    )
  )
    return false;
  if (
    new Set(requirements).size !== requirements.length ||
    [...requirements].sort().some((value, index) => value !== requirements[index])
  )
    return false;
  if (!proof.app || typeof proof.app !== "object" || Array.isArray(proof.app)) return false;
  const app = proof.app as Record<string, unknown>;
  return (
    Object.keys(app).sort().join(",") === "description,id,name" &&
    typeof app.id === "string" &&
    ID_PATTERN.test(app.id) &&
    typeof app.name === "string" &&
    app.name === app.name.trim() &&
    app.name.length > 0 &&
    [...app.name].length <= 120 &&
    !CONTROL_CHAR_PATTERN.test(app.name) &&
    typeof app.description === "string" &&
    app.description === app.description.trim() &&
    app.description.length > 0 &&
    [...app.description].length <= 500 &&
    !CONTROL_CHAR_PATTERN.test(app.description)
  );
}
