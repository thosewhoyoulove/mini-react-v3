export type Dispatch<A> = (value: A) => void;

export interface Dispatcher {
  useState: <S>(
    initialState: S | (() => S),
  ) => [S, Dispatch<S | ((prev: S) => S)>];
  useEffect: (create: () => (() => void) | void, deps?: unknown[]) => void;
}

export const ReactCurrentDispatcher: {
  current: Dispatcher | null;
} = {
  current: null,
};
