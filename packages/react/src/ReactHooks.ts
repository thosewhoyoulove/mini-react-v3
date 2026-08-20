import { ReactCurrentDispatcher } from './ReactCurrentDispatcher';
import type { Dispatch } from './ReactCurrentDispatcher';

function resolveDispatcher() {
  const dispatcher = ReactCurrentDispatcher.current;
  if (dispatcher == null) {
    throw new Error(
      'Invalid hook call. Hooks can only be called inside function components.',
    );
  }
  return dispatcher;
}

export function useState<S>(
  initialState: S | (() => S),
): [S, Dispatch<S | ((prev: S) => S)>] {
  return resolveDispatcher().useState(initialState);
}

export function useEffect(
  create: () => (() => void) | void,
  deps?: unknown[],
): void {
  resolveDispatcher().useEffect(create, deps);
}
