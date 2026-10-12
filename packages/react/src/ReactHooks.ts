import {
  ReactCurrentBatchConfig,
  ReactCurrentDispatcher,
} from './ReactCurrentDispatcher';
import type { Dispatch } from './ReactCurrentDispatcher';
import {
  REACT_CONTEXT_TYPE,
  REACT_FORWARD_REF_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_MEMO_TYPE,
  REACT_SUSPENSE_TYPE,
} from 'shared';

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

/** 返回跨渲染稳定的 { current }。 */
export function useRef<T>(initialValue: T): { current: T } {
  return resolveDispatcher().useRef(initialValue);
}

/** 用 reducer 计算下一状态。dispatch 的身份在更新之间保持稳定。 */
export function useReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialArg: S,
  init?: (initialArg: S) => S,
): [S, Dispatch<A>] {
  return resolveDispatcher().useReducer(reducer, initialArg, init);
}

/** deps 逐项相等时复用上一轮的值。 */
export function useMemo<T>(create: () => T, deps?: unknown[]): T {
  return resolveDispatcher().useMemo(create, deps);
}

/** deps 逐项相等时复用上一轮的函数。 */
export function useCallback<T extends (...args: never[]) => unknown>(
  callback: T,
  deps?: unknown[],
): T {
  return resolveDispatcher().useCallback(callback, deps);
}

/** 读取最近的 Provider；没有 Provider 时用 defaultValue。 */
export function useContext<T>(context: { _currentValue: T }): T {
  return resolveDispatcher().useContext(context);
}

/**
 * 把回调里的 setState 标成 TransitionLane。
 * 更高优更新到来时，进行中的 transition WIP 会被丢掉。
 */
export function startTransition(scope: () => void): void {
  const previous = ReactCurrentBatchConfig.transition;
  ReactCurrentBatchConfig.transition = {}; // 1. dispatch 看到非 null 就改走低优
  try {
    scope(); // 2. 回调里的 setState 入队
  } finally {
    ReactCurrentBatchConfig.transition = previous; // 3. 离开回调后恢复普通 setState
  }
}

/** 不创建 DOM 的父节点。子 Fiber 仍按 key/type 参与 Diff。 */
export const Fragment = REACT_FRAGMENT_TYPE;

/** 子树抛出 thenable 时，Commit 改提交 fallback。 */
export const Suspense = {
  $$typeof: REACT_SUSPENSE_TYPE,
};

/**
 * 渲染抛错时，reconciler 沿 return 找到它，改提交 fallback。
 * 不是 Class，也没有生命周期；标记只给 beginWork 认边界。
 */
export function ErrorBoundary(props: {
  fallback: any;
  children?: any;
}): any {
  return props.children;
}
(ErrorBoundary as { isErrorBoundary?: boolean }).isErrorBoundary = true;

/** Context 对象。Provider 是带 _context 的函数，beginWork 据此选择 tag。 */
export function createContext<T>(defaultValue: T): {
  $$typeof: symbol;
  _currentValue: T;
  Provider: (props: { value: T; children?: any }) => any;
} {
  const context = {
    $$typeof: REACT_CONTEXT_TYPE,
    _currentValue: defaultValue,
    Provider: null as unknown as (props: { value: T; children?: any }) => any,
  };
  function Provider(props: { value: T; children?: any }) {
    return props.children;
  }
  (Provider as { _context?: typeof context })._context = context;
  context.Provider = Provider;
  return context;
}

/** props 浅比较（或自定义 compare）通过时跳过内部组件。 */
export function memo<T extends (props: any, ref?: any) => any>(
  type: T,
  compare?: (prev: any, next: any) => boolean,
): { $$typeof: symbol; type: T; compare: typeof compare } {
  return {
    $$typeof: REACT_MEMO_TYPE,
    type,
    compare,
  };
}

/** 把元素上的 ref 交给渲染函数的第二个参数。 */
export function forwardRef<P>(
  render: (props: P, ref: any) => any,
): { $$typeof: symbol; render: typeof render } {
  return {
    $$typeof: REACT_FORWARD_REF_TYPE,
    render,
  };
}
