import type { Dispatcher } from 'react';
import { ReactCurrentDispatcher } from 'react';
import { Passive } from './fiberFlags';
import type { Fiber } from './fiber';
import { DefaultLane } from './fiberLanes';
import { scheduleUpdateOnFiber } from './scheduleUpdate';

/**
 * 函数组件的 Hook 实现。
 *
 * 每个函数组件 Fiber 用 memoizedState 挂一条单向链表：
 *   fiber.memoizedState → Hook0 → Hook1 → Hook2 → null
 * 组件里第几次调用 useXxx，就对应第几格。没有名字，所以不能写在 if 里。
 *
 * 首次渲染走 mount*（往后接新格）；更新走 update*（顺着 current 链表克隆到 wip）。
 */

type Update<S> = {
  /** 这次更新要应用的值，或 (prev) => next 函数 */
  action: S | ((prev: S) => S);

  /**
   * 指向下一个 Update。
   * 在 hook.queue.pending 里是环形链表：pending 指向最后插入的那条，
   * pending.next 才是最先入队的（最老的）那条。
   */
  next: Update<S>;
};

type UpdateQueue<S> = {
  /** 还没进 render 的更新。pending 指向最后插入的那条，整条是环形链表。 */
  pending: Update<S> | null;

  /** 绑在这个 hook 上的 setState。mount 时创建，之后一直复用。 */
  dispatch: ((action: S | ((prev: S) => S)) => void) | null;
};

type Hook = {
  /** 当前渲染使用的最终 state 值 */
  memoizedState: any;

  /**
   * 基准状态：当存在低优先级 Update 被跳过（Skipped）时，
   * baseState 记录的是被跳过的那个 Update 之前的基础状态。
   * 下一次重新计算（Rebase）时，会从这个 baseState 开始重新推演。
   */
  // baseState: any; 暂时丢弃

  /** 已从 queue.pending 截断移过来的 Update 链表（单向） */
  baseQueue: Update<any> | null;

  /** 接收新更新的队列 */
  queue: UpdateQueue<any> | null;

  /** 指向下一个 Hook（单链表） */
  next: Hook | null;
};

type Effect = {
  /** 是否本轮要跑。HookHasEffect = 要执行 create；0 = deps 没变，跳过。 */
  tag: number;

  /** commit 阶段调用的副作用函数，返回值当作 destroy。 */
  create: () => (() => void) | void;

  /** 上一次 create 返回的清理函数。unmount 或 deps 变化时先跑它。 */
  destroy: (() => void) | undefined;

  /** 依赖数组。和上次 Object.is 逐项比，都相同就不跑。 */
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

/** 正在执行的那个函数组件 Fiber。第一个 Hook 会写成它的 memoizedState（链表头）。 */
let currentlyRenderingFiber: Fiber | null = null;

/** wip 链表上「刚接好的那一格」。下一个 Hook 接到它的 next。 */
let workInProgressHook: Hook | null = null;

/** current 链表上「正在对齐的那一格」。下一个 Hook 从它的 next 取。 */
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

/**
 * 首次渲染：在当前函数组件的 wip Fiber 上，追加一格新 Hook。
 *
 * 只做四步：
 *   1. new 一个空 Hook（next 还是 null）
 *   2. 这是本组件第一个 Hook → 写成 Fiber.memoizedState（链表头），游标也指过去
 *   3. 前面已经有 Hook → 接到当前游标的 next，再把游标挪到新节点
 *   4. 返回当前这格，给 useState / useEffect 往 memoizedState 里填数据
 *
 * 组件里每调一次 Hook，这里就往后接一格。顺序必须固定，下次更新才对得上。
 */
function mountWorkInProgressHook(): Hook {
  const hook: Hook = {
    memoizedState: null,
    baseQueue: null,
    queue: null,
    next: null,
  }; // 1. 先造一格空的，还没接进链表

  if (workInProgressHook == null) {
    currentlyRenderingFiber!.memoizedState = hook; // 2. Fiber 记住第一个 Hook（链表头）
    workInProgressHook = hook; // 游标指到这一格
  } else {
    workInProgressHook.next = hook; // 3. 上一格的 next 接到新 Hook
    workInProgressHook = hook; // 游标挪到新 Hook
  }
  return workInProgressHook; // 4. 把这一格交给 mountState / mountEffect 去填
}

/**
 * 更新：顺着 current 链表取出「对应那一格」，克隆到 wip 链表上。
 *
 * 只做四步：
 *   1. 取 current 上的下一格：第一次从 Fiber.memoizedState 取头，之后走 currentHook.next
 *   2. current 上没有下一格 → 这次 Hook 调用比上次多，直接抛错
 *   3. 克隆一格到 wip（复用 queue，next 先空着），接到 wip 链表尾
 *   4. 返回这格克隆，给 updateState / updateEffect 在上面算新值
 *
 * 两棵树各一条链表：current 只读对齐，wip 才是本轮要 commit 的。
 */
function updateWorkInProgressHook(): Hook {
  let nextCurrentHook: Hook | null = null;
  if (currentHook == null) {
    const current = currentlyRenderingFiber!.alternate;
    nextCurrentHook = current != null ? current.memoizedState : null;
    // 1. 本组件第一个 Hook：从 current 树的链表头取
  } else {
    nextCurrentHook = currentHook.next; // 1. 已经对齐过：current 链表往后走一格
  }

  if (nextCurrentHook == null) {
    throw new Error('Rendered more hooks than during the previous render');
    // 2. current 已经走完，这次却还在调 Hook → 多半是写进了 if
  }

  currentHook = nextCurrentHook; // 记下「current 上正在对齐的那一格」
  const newHook: Hook = {
    memoizedState: currentHook.memoizedState,
    baseQueue: currentHook.baseQueue,
    queue: currentHook.queue,
    next: null,
  }; // 3. 克隆：state / queue 复用，next 先空着，等后面的 Hook 再接

  if (workInProgressHook == null) {
    currentlyRenderingFiber!.memoizedState = newHook; // wip 的链表头
    workInProgressHook = newHook;
  } else {
    workInProgressHook.next = newHook; // 接到 wip 上一格的 next
    workInProgressHook = newHook;
  }
  return workInProgressHook; // 4. 把这格克隆交给 updateState / updateEffect
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

/**
 * 执行函数组件：每次 Hook 调用都会往 wip 链表上接（或克隆）一格。
 *
 * 只做四步：
 *   1. 清空 wip.memoizedState 和两个游标，准备重新建链表
 *   2. 没有 current 链表 → mount dispatcher；有 → update dispatcher
 *   3. 真正跑 Component(props)，里面的 useState / useEffect 会调到上面两个函数
 *   4. 清掉模块级指针，返回 children 给 reconcile
 */
export function renderWithHooks(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: (props: any) => any,
  props: any,
): any {
  currentlyRenderingFiber = workInProgress;
  workInProgress.memoizedState = null; // 1. 丢掉上一轮 wip 链表，本轮从头接
  workInProgress.updateQueue = null;
  workInProgressHook = null;
  currentHook = null;

  ReactCurrentDispatcher.current =
    current == null || current.memoizedState == null
      ? HooksDispatcherOnMount // 2. 第一次：往后接新格
      : HooksDispatcherOnUpdate; // 2. 有 current 链表：按顺序克隆对齐

  const children = Component(props); // 3. 这里才会真正调到 useState / useEffect

  ReactCurrentDispatcher.current = null;
  currentlyRenderingFiber = null;
  workInProgressHook = null;
  currentHook = null; // 4. 组件跑完，模块级指针不能漏到下一个组件
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
