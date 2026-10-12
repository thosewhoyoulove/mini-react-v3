/**
 * React 公共 Hook API 与 reconciler 内部实现之间的可变接缝。
 *
 * renderWithHooks 执行组件前把 current 切到 mount 或 update dispatcher；
 * `useState()` 本身只从这里转发，因此 react 包不需要反向依赖 reconciler。
 */

/** setState 一类派发函数：接收一个 action，不要求返回值。 */
export type Dispatch<A> = (value: A) => void;

export interface Dispatcher {
  /** 当前 render 对应的 mountState 或 updateState。 */
  useState: <S>(
    initialState: S | (() => S),
  ) => [S, Dispatch<S | ((prev: S) => S)>];
  /** 当前 render 对应的 mountEffect 或 updateEffect。 */
  useEffect: (create: () => (() => void) | void, deps?: unknown[]) => void;

  /** 当前 render 对应的 mountLayoutEffect 或 updateLayoutEffect。 */
  useLayoutEffect: (
    create: () => (() => void) | void,
    deps?: unknown[],
  ) => void;

  /** 返回同一个 { current } 对象，更新时不替换。 */
  useRef: <T>(initialValue: T) => { current: T };

  /** 与 useState 共用更新队列，重放时走 reducer(state, action)。 */
  useReducer: <S, A>(
    reducer: (state: S, action: A) => S,
    initialArg: S,
    init?: (initialArg: S) => S,
  ) => [S, Dispatch<A>];

  /** deps 不变时返回上一轮的计算结果。 */
  useMemo: <T>(create: () => T, deps?: unknown[]) => T;

  /** deps 不变时返回上一轮的函数身份。 */
  useCallback: <T extends (...args: never[]) => unknown>(
    callback: T,
    deps?: unknown[],
  ) => T;

  /** 读取 Provider 当前值，并把依赖记到正在渲染的 Fiber 上。 */
  useContext: <T>(context: { _currentValue: T }) => T;
}

/**
 * startTransition 把这里设成非 null，dispatch 就改走 TransitionLane。
 * 组件函数之外保持 transition = null，普通 setState 仍是 DefaultLane。
 */
export const ReactCurrentBatchConfig: {
  /** 非 null 表示当前调用栈在 startTransition 里面。 */
  transition: object | null;
} = {
  transition: null,
};

/** 当前正在 render 的 Hook 实现表；组件外保持 null，用来识别非法调用。 */
export const ReactCurrentDispatcher: {
  /** renderWithHooks 在调用组件函数的前后设置和清空这一格。 */
  current: Dispatcher | null;
} = {
  current: null,
};
