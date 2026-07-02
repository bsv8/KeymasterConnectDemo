// src/lib/appViewLaunch.ts
// appView 启动期 / 手工 `connect.launch` 共用的 transport 预备动作
// （施工单 2026-07-02 002 appView manual launch transport 硬切换一次性迭代
// 第 4 / 5.一 / 5.二 / 5.三 / 6.一 / 6.三 / 7.不能怎么做 / 10.1 / 10.2 章）。
//
// 设计缘由：
//   - 抽出这一层的目的不是"做更多抽象"，而是让 React `App.tsx` 内部
//     走单纯调用，并让单测可以**直接**驱动 helper 的失败边界：
//       * `missing_origin` → 不调 client；
//       * `no_opener` → 调 `adoptOpener()` 后由 `no_opener` 立即收口，
//         **不**调 `postReadyToOpener(...)`；
//       * `ready_failed` → `adoptOpener()` 成功后 `postReadyToOpener(...)`
//         返回 `false`，把刚收养的 listener / timer `closeSession()` 掉，
//         返回 `{ ok: false, code: "ready_failed" }` 让调用方走 fail-closed；
//       * happy path → 返回 `{ ok: true, popup }`；调用方拿到 popup 后**只**可以
//         `popup.runRequest(...)`，client 内部运行时已 `connected`，
//         `ensureSession()` 在 `appViewOnly === true` 下会拒绝 `window.open`
//         回退。
//   - 没有任何"launch orchestrator"或"session factory"这种较高层抽象；
//     helper 只做 transport 原子。
//
// 不负责：
//   - 不组装 `connect.launch` request；
//   - 不写 session / 不清 session；
//   - 不 strip URL；
//   - 不发业务 request；
//   - 不自动降级 direct / popup 登录。

import {
  ProtocolTransportError,
  postReadyToOpener
} from "./connectClient";
import type { PopupSessionClient } from "./popupSessionClient";

/**
 * `prepareAppViewTransportOrFail` 的依赖注入选项。
 *
 * `sessionWindowOrigin` 与 `getSessionClient` 分开传入：
 *   - 便于测试直接覆盖两条边界（origin 缺失 vs 错误 / client 异常）；
 *   - 不让 helper 直接接触 React state / ref，避免以后切到 React testing
 *     library 才能跑。
 */
export interface PrepareAppViewTransportOptions {
  /**
   * URL 显式注入的 `sessionWindowOrigin`（launch / appView 链路 transport
   * origin 真值）。null / 空 / 非法 → helper 返回 `{ ok: false,
   * code: "missing_origin" }`。
   */
  sessionWindowOrigin: string | null;
  /**
   * 取得当前页面级 `PopupSessionClient` 单例。
   *
   * 实现上必须是 lazy 单例：helper 内部**不会**缓存 client，每次调用都
   * 重新走 `getSessionClient()`，这与 `App.tsx` 的 `getSessionClient()`
   * 行为一致（页面级 `useRef`）。
   */
  getSessionClient: () => PopupSessionClient;
}

/**
 * helper 失败的三个明确档位：
 *
 *   - `missing_origin` ⇒ `sessionWindowOrigin` 缺失；调用方应该让用户
 *     重新从 Keymaster 拉起（页面上 URL 没带 `sessionWindowOrigin`）；
 *   - `no_opener`     ⇒ `window.opener` 不可用 / `adoptOpener()` 失败；
 *     调用方告诉用户"请从 Keymaster 重新启动"；
 *   - `ready_failed`  ⇒ `adoptOpener()` 成功但 `postReadyToOpener(...)`
 *     返回 `false`；client 内部 listener / timer 已被本 helper
 *     `closeSession()` 收口，调用方不应继续发 `connect.launch`。
 *
 * 不引入第四档："网络错误" / "popup 死亡" 这类 case 都由调用方
 * `popup.runRequest(...)` 内部走 `result_timeout` / `popup_closed` /
 * `appview_session_lost` 收口，本层不背锅。
 */
export type PrepareAppViewTransportFailureCode =
  | "missing_origin"
  | "no_opener"
  | "ready_failed";

export type PrepareAppViewTransportResult =
  | { ok: true; popup: PopupSessionClient }
  | {
      ok: false;
      code: PrepareAppViewTransportFailureCode;
      reason: string;
    };

/**
 * appView 启动期 / 手工 `connect.launch` 共用的 transport 预备动作
 * （**只**做 transport 原子）。
 *
 * 步骤按顺序：
 *
 *   1. 校验 `sessionWindowOrigin` 存在；缺失 → 立即 `{ ok: false,
 *      code: "missing_origin" }`；
 *   2. 取得 `PopupSessionClient` 单例；先 `closeSession()` 清掉可能错开
 *      的旧 popup 句柄（§7.3）——`closeSession()` 对 popup 是 opener 的
 *      情况**不**调 `popup.close()`，不会误关 Keymaster Session Window；
 *   3. `await popup.adoptOpener()`；失败（`no_opener` 等）→ `{ ok: false,
 *      code: "no_opener" }`，**不**调 `postReadyToOpener(...)`；
 *   4. `postReadyToOpener(sessionWindowOrigin)`；返回 `false` →
 *      `popup.closeSession()` 收口刚收养的 listener / timer 防 zombie
 *      session，返回 `{ ok: false, code: "ready_failed" }`；
 *   5. 全部成功 → `{ ok: true, popup }`，调用方拿到 popup 后**只**可以
 *      `popup.runRequest(...)`，client 内部运行时已 `connected`。
 *
 * 注意：本 helper 不会**主动**运行 `connect.launch` request；它只产出
 * "准备好发 request 的 popup"。这是为了：
 *   - 不让 helper 与 `PopupSessionClient.runRequest(...)` 之间产生新的
 *     抽象层；
 *   - 让"手工 launch 与自动 launch 共用"这一条真值在调用方一侧就成立：
 *     双方都先 helper，**再**发 launch request。
 */
export async function prepareAppViewTransportOrFail(
  opts: PrepareAppViewTransportOptions
): Promise<PrepareAppViewTransportResult> {
  // launch 真值 = URL 显式注入的 sessionWindowOrigin。
  // null / undefined / 空字符串 / 纯空白串一律算缺失；这是为了把
  // `readSessionWindowOriginFromUrl(...)` 之外的非法输入也兜住：
  // 调用方若自己拼 origin，必须自己 trim 后再传，否则会落到这里被
  // 归一化为 missing_origin。
  const rawTarget = opts.sessionWindowOrigin;
  const target =
    typeof rawTarget === "string" && rawTarget.trim().length > 0
      ? rawTarget.trim()
      : null;
  if (!target) {
    return {
      ok: false,
      code: "missing_origin",
      reason:
        "sessionWindowOrigin is missing or invalid in the launch URL; " +
        "cannot launch in appView mode. appView does not fall back to " +
        "targetOrigin or a default origin."
    };
  }
  const popup = opts.getSessionClient();
  // §7.3：手工 launch 时若页面之前因任何原因错开过一扇 protocol popup，
  // 必须先 `closeSession()` 清掉旧句柄，再重新 `adoptOpener()`，避免
  // 混着"旧 popup 句柄 + 新 opener 意图"跑下去。closeSession() 对 popup
  // 是 opener 的情况只清本端引用 / listener / timer，不调
  // `popup.close()`，不会误关 Keymaster Session Window。
  try {
    popup.closeSession();
  } catch {
    // best-effort
  }
  // 1) 收养 opener（不复用 → fail-closed）。
  try {
    await popup.adoptOpener();
  } catch (err) {
    if (err instanceof ProtocolTransportError && err.code === "no_opener") {
      return {
        ok: false,
        code: "no_opener",
        reason:
          "No reusable Session Window opener is available. Please relaunch from Keymaster."
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "no_opener",
      reason: `Failed to adopt opener: ${message}`
    };
  }
  // 2) 向 opener 发顶层 `ready`：appView child listener 就绪的唯一信号。
  //    发完 ready 之后**才**发 connect.launch；这是协议层的固定顺序。
  const readySent = postReadyToOpener(target);
  if (!readySent) {
    // 把刚收养的 listener / timer 收敛掉；客户端内部已经 `connected`，
    // 若放任不回 `closeSession()` 又**不**发 request，会留下一个挂着
    // opener 句柄的 zombie session，下一次 `ensureSession()` 直接复用。
    try {
      popup.closeSession();
    } catch {
      // best-effort
    }
    return {
      ok: false,
      code: "ready_failed",
      reason: "Failed to send top-level ready to Session Window opener."
    };
  }
  return { ok: true, popup };
}
