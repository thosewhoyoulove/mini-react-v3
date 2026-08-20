import type { Dispatcher } from 'react';
import { ReactCurrentDispatcher } from 'react';
import { Passive } from './fiberFlags';
import type { Fiber } from './fiber';
import { DefaultLane } from './fiberLanes';
import { scheduleUpdateOnFiber } from './scheduleUpdate';

type Update<S> = {
  action: S | ((prev: S) => S);
  next: Update<S>;
};

type UpdateQueue<S> = {
  pending: Update<S> | null;
  dispatch: ((action: S | ((prev: S) => S)) => void) | null;
};

type Hook = {
  memoizedState: any;
  /** 已从 pending 挪过来、但可能还没 commit 的更新。render 被丢弃时留在 current 上，下次从根重启才能重放。 */
  baseQueue: Update<any> | null;
  queue: UpdateQueue<any> | null;
  next: Hook | null;
};

type Effect = {
  tag: number;
  create: () => (() => void) | void;
  destroy: (() => void) | undefined;
  deps: unknown[] | undefined;
};

const HookHasEffect = 1;

function isEffect(value: unknown): value is Effect {
  return (
    typeof value === 'object' &&
    value != null &&
    'create' in value &&
    'deps' in value &&
    'tag' in value
  );
}

let currentlyRenderingFiber: Fiber | null = null;
let workInProgressHook: Hook | null = null;
let currentHook: Hook | null = null;

function areHookInputsEqual(
  nextDeps: unknown[] | undefined,
  prevDeps: unknown[] | undefined,
): boolean {
  if (prevDeps == null || nextDeps == null) {
    return false;
  }
  if (nextDeps.length !== prevDeps.length) {
    return false;
  }
  for (let i = 0; i < prevDeps.length; i++) {
    if (!Object.is(nextDeps[i], prevDeps[i])) {
      return false;
    }
  }
  return true;
}

function mountWorkInProgressHook(): Hook {
  const hook: Hook = {
    memoizedState: null,
    baseQueue: null,
    queue: null,
    next: null,
  };
  if (workInProgressHook == null) {
    currentlyRenderingFiber!.memoizedState = workInProgressHook = hook;
  } else {
    workInProgressHook = workInProgressHook.next = hook;
  }
  return workInProgressHook;
}

function updateWorkInProgressHook(): Hook {
  let nextCurrentHook: Hook | null = null;
  if (currentHook == null) {
    const current = currentlyRenderingFiber!.alternate;
    nextCurrentHook = current != null ? current.memoizedState : null;
  } else {
    nextCurrentHook = currentHook.next;
  }

  if (nextCurrentHook == null) {
    throw new Error('Rendered more hooks than during the previous render');
  }

  currentHook = nextCurrentHook;
  const newHook: Hook = {
    memoizedState: currentHook.memoizedState,
    baseQueue: currentHook.baseQueue,
    queue: currentHook.queue,
    next: null,
  };
  if (workInProgressHook == null) {
    currentlyRenderingFiber!.memoizedState = workInProgressHook = newHook;
  } else {
    workInProgressHook = workInProgressHook.next = newHook;
  }
  return workInProgressHook;
}

function dispatchSetState(
  fiber: Fiber,
  queue: UpdateQueue<any>,
  action: any,
): void {
  const update = {
    action,
    next: null as unknown as Update<any>,
  };
  const pending = queue.pending;
  if (pending == null) {
    update.next = update;
  } else {
    update.next = pending.next;
    pending.next = update;
  }
  queue.pending = update;
  // 用户 setState 走 DefaultLane：可切片。root.render 才是 SyncLane。
  scheduleUpdateOnFiber(fiber, DefaultLane);
}

function mountState<S>(
  initialState: S | (() => S),
): [S, (action: S | ((prev: S) => S)) => void] {
  const hook = mountWorkInProgressHook();
  const memoizedState =
    typeof initialState === 'function'
      ? (initialState as () => S)()
      : initialState;
  hook.memoizedState = memoizedState;
  const queue: UpdateQueue<S> = {
    pending: null,
    dispatch: null,
  };
  hook.queue = queue;
  const fiber = currentlyRenderingFiber!;
  const dispatch = ((action: S | ((prev: S) => S)) => {
    dispatchSetState(fiber, queue, action);
  }) as (action: S | ((prev: S) => S)) => void;
  queue.dispatch = dispatch;
  return [hook.memoizedState, dispatch];
}

function mergeCircularQueues<S>(baseQueue: Update<S>, pending: Update<S>): Update<S> {
  const baseFirst = baseQueue.next;
  const pendingFirst = pending.next;
  baseQueue.next = pendingFirst;
  pending.next = baseFirst;
  return pending;
}

function updateState<S>(
  _initialState: S | (() => S),
): [S, (action: S | ((prev: S) => S)) => void] {
  const hook = updateWorkInProgressHook();
  const queue = hook.queue as UpdateQueue<S>;
  const pending = queue.pending;
  let baseQueue = currentHook!.baseQueue as Update<S> | null;

  if (pending != null) {
    if (baseQueue != null) {
      baseQueue = mergeCircularQueues(baseQueue, pending);
    } else {
      baseQueue = pending;
    }
    // 写回 current：这次 render 如果被切片重启丢掉，下次还能从这里重放。
    currentHook!.baseQueue = baseQueue;
    queue.pending = null;
  }

  if (baseQueue != null) {
    const first = baseQueue.next;
    let newState = currentHook!.memoizedState as S;
    let update = first;
    do {
      const action = update.action;
      newState =
        typeof action === 'function'
          ? (action as (prev: S) => S)(newState)
          : action;
      update = update.next;
    } while (update !== first);
    hook.memoizedState = newState;
    hook.baseQueue = null;
    return [newState, queue.dispatch!];
  }

  return [hook.memoizedState as S, queue.dispatch!];
}

function mountEffect(
  create: () => (() => void) | void,
  deps: unknown[] | undefined,
): void {
  const hook = mountWorkInProgressHook();
  currentlyRenderingFiber!.flags |= Passive;
  hook.memoizedState = {
    tag: HookHasEffect,
    create,
    destroy: undefined,
    deps,
  } satisfies Effect;
}

function updateEffect(
  create: () => (() => void) | void,
  deps: unknown[] | undefined,
): void {
  const hook = updateWorkInProgressHook();
  const prev = hook.memoizedState as Effect;
  if (areHookInputsEqual(deps, prev.deps)) {
    hook.memoizedState = {
      tag: 0,
      create,
      destroy: prev.destroy,
      deps,
    } satisfies Effect;
    return;
  }
  currentlyRenderingFiber!.flags |= Passive;
  hook.memoizedState = {
    tag: HookHasEffect,
    create,
    destroy: prev.destroy,
    deps,
  } satisfies Effect;
}

const HooksDispatcherOnMount: Dispatcher = {
  useState: mountState as Dispatcher['useState'],
  useEffect: mountEffect,
};

const HooksDispatcherOnUpdate: Dispatcher = {
  useState: updateState as Dispatcher['useState'],
  useEffect: updateEffect,
};

export function renderWithHooks(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: (props: any) => any,
  props: any,
): any {
  currentlyRenderingFiber = workInProgress;
  workInProgress.memoizedState = null;
  workInProgress.updateQueue = null;
  workInProgressHook = null;
  currentHook = null;

  ReactCurrentDispatcher.current =
    current == null || current.memoizedState == null
      ? HooksDispatcherOnMount
      : HooksDispatcherOnUpdate;

  const children = Component(props);

  ReactCurrentDispatcher.current = null;
  currentlyRenderingFiber = null;
  workInProgressHook = null;
  currentHook = null;
  return children;
}

export function commitHookEffectListUnmount(
  fiber: Fiber,
  force: boolean,
): void {
  let hook: Hook | null = fiber.memoizedState;
  while (hook != null) {
    const value = hook.memoizedState;
    if (isEffect(value) && typeof value.destroy === 'function') {
      if (force || (value.tag & HookHasEffect) !== 0) {
        value.destroy();
        value.destroy = undefined;
      }
    }
    hook = hook.next;
  }
}

export function commitHookEffectListMount(fiber: Fiber): void {
  let hook: Hook | null = fiber.memoizedState;
  while (hook != null) {
    const value = hook.memoizedState;
    if (
      isEffect(value) &&
      typeof value.create === 'function' &&
      (value.tag & HookHasEffect) !== 0
    ) {
      const destroy = value.create();
      value.destroy = typeof destroy === 'function' ? destroy : undefined;
    }
    hook = hook.next;
  }
}
