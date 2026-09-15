import { ReactCurrentDispatcher } from './ReactCurrentDispatcher';
import type { Dispatch } from './ReactCurrentDispatcher';

/**
 * Hooks 的公共入口。
 *
 * 这些函数不保存状态。真正的 Hook 数据挂在函数组件 Fiber.memoizedState 的
 * 单向链表上；这里通过 ReactCurrentDispatcher 转发到本轮 mount/update 实现。
 */

/** 取得当前 dispatcher；组件函数之外调用时给出明确错误。 */
function resolveDispatcher() {
  const dispatcher = ReactCurrentDispatcher.current;
  if (dispatcher == null) {
    throw new Error(
      'Invalid hook call. Hooks can only be called inside function components.',
    );
  }
  return dispatcher;
}

/** 声明一格有状态 Hook，并返回当前值与稳定的 dispatch。 */
export function useState<S>(
  initialState: S | (() => S),
): [S, Dispatch<S | ((prev: S) => S)>] {
  return resolveDispatcher().useState(initialState);
}

/** 声明绘制后执行的 Passive Effect。 */
export function useEffect(
  create: () => (() => void) | void,
  deps?: unknown[],
): void {
  resolveDispatcher().useEffect(create, deps);
}

/** 声明 DOM Mutation 后、浏览器绘制前同步执行的 Layout Effect。 */
export function useLayoutEffect(
  create: () => (() => void) | void,
  deps?: unknown[],
): void {
  resolveDispatcher().useLayoutEffect(create, deps);
}
