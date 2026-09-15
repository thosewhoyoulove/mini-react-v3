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
}

/** 当前正在 render 的 Hook 实现表；组件外保持 null，用来识别非法调用。 */
export const ReactCurrentDispatcher: {
  /** renderWithHooks 在调用组件函数的前后设置和清空这一格。 */
  current: Dispatcher | null;
} = {
  current: null,
};
