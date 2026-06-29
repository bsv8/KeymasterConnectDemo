// src/lib/sessionCache.ts
// demo 自己维护的最小 connect session 本地缓存。
//
// 设计缘由（施工单 2026-06-29 002 硬切换 5.4 / 4.5）：
//   - 只存 demo 自己需要的最小字段：`connectSessionId` + `targetOrigin` +
//     最近一次 ownerPublicKeyHex（仅用于 UI 默认值，不参与协议判定）。
//   - **不**存 unlock runtime；**不**存任何 Keymaster 敏感材料；
//     **不**存 claims 完整快照。
//   - demo 刷新后可以拿这个 sessionId 去点 `connect.resume`；resume 失败
//     时 demo **不**自动清库重登。
//   - 不存时 demo 仍能正常跑：所有表单都允许 sessionId 为空，让用户手动
//     走 connect.login / connect.resume。
//
// localStorage 失败 / 不存在时所有操作返回 null / 静默 no-op；不在 demo
// 内部抛错。

const STORAGE_KEY = "keymaster-connect-demo.sessionId";
const ORIGIN_KEY = "keymaster-connect-demo.targetOrigin";
const OWNER_KEY = "keymaster-connect-demo.ownerPublicKeyHex";

function safeStorage(): Storage | null {
  try {
    if (typeof globalThis === "undefined") return null;
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    if (!candidate) return null;
    // 探针写入：避免后续 setItem 直接抛。
    const probeKey = "__keymaster_probe__";
    candidate.setItem(probeKey, "1");
    candidate.removeItem(probeKey);
    return candidate;
  } catch {
    return null;
  }
}

export interface CachedSessionHint {
  connectSessionId: string;
  targetOrigin: string;
  ownerPublicKeyHex: string;
}

/**
 * 读出最近一次成功的 session 提示（page load 时一次性调用）。
 * 任意字段缺失都返回 null；调用方应容忍 null 并展示"未连接"。
 */
export function readCachedSessionHint(): CachedSessionHint | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const connectSessionId = storage.getItem(STORAGE_KEY);
    const targetOrigin = storage.getItem(ORIGIN_KEY);
    const ownerPublicKeyHex = storage.getItem(OWNER_KEY);
    if (!connectSessionId || !targetOrigin) return null;
    return {
      connectSessionId,
      targetOrigin,
      ownerPublicKeyHex: ownerPublicKeyHex ?? ""
    };
  } catch {
    return null;
  }
}

/**
 * 写入最近一次成功 session。
 * 字段为空时调用方应避免写入；本函数不做完整性校验，由调用方承担。
 */
export function writeCachedSessionHint(input: {
  connectSessionId: string;
  targetOrigin: string;
  ownerPublicKeyHex?: string;
}): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, input.connectSessionId);
    storage.setItem(ORIGIN_KEY, input.targetOrigin);
    if (input.ownerPublicKeyHex) {
      storage.setItem(OWNER_KEY, input.ownerPublicKeyHex);
    } else {
      storage.removeItem(OWNER_KEY);
    }
  } catch {
    // localStorage 配额 / 隐私模式：静默忽略，不阻塞 demo。
  }
}

/**
 * 清空本地缓存。`connect.logout` 成功时调用方可以主动清，避免旧 sessionId
 * 误带进下一次手动 `connect.resume`。
 */
export function clearCachedSessionHint(): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
    storage.removeItem(ORIGIN_KEY);
    storage.removeItem(OWNER_KEY);
  } catch {
    // ignore
  }
}