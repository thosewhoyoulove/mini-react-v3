import {
  ContextProvider,
  ForwardRef,
  Fragment,
  FunctionComponent,
  HostComponent,
  HostRoot,
  HostText,
  MemoComponent,
  SuspenseComponent,
  createWorkInProgress,
  type Fiber,
} from './fiber';
import { DidCapture, Ref } from './fiberFlags';
import {
  includesSomeLane,
  type Lanes,
} from './fiberLanes';
import { reconcileChildren } from './childFiber';
import { hasContextChanged, renderWithHooks } from './hooks';

/**
 * Render 阶段的「向下」半程。workLoop.performUnitOfWork 对每个 Fiber 先调这里。
 *
 * 职责只有一件：给当前 wip 接上 child 链表，返回「下一个要处理的节点」。
 *
 *   beginWork(wip)  →  接上 child  →  返回 child（深度优先往下）
 *        ↑                              ↓
 *        └── completeWork ←── 返回 null（叶子 / bailout）
 *
 * 能跳过时不再调用函数组件：lanes、childLanes 都和本轮 renderLanes 无交集，
 * props 浅比较相同，context 依赖也没过期。子树里还有 lane 时父函数必须重跑。
 */

/** Provider push 的一帧。complete 或 unwind 时按 Fiber 对上再弹出。 */
type ProviderFrame = {
  /** 这次 push 对应的 Provider Fiber。 */
  fiber: Fiber;

  /** 被改写 _currentValue 的 context。 */
  context: { _currentValue: any };

  /** push 之前的值，pop 时写回去。 */
  prev: any;
};

/** 当前 render 里尚未 pop 的 Provider。栈顶是最内层。 */
const providerStack: ProviderFrame[] = [];

/**
 * 进入 Provider：先记住旧值，再让子树的 useContext 读到新 value。
 */
export function pushProvider(
  fiber: Fiber,
  context: { _currentValue: any },
  nextValue: any,
): void {
  providerStack.push({
    fiber,
    context,
    prev: context._currentValue,
  });
  context._currentValue = nextValue;
}

/** 离开这个 Provider Fiber 时恢复外层 value。对不上栈顶就不动。 */
export function popProvider(fiber: Fiber): void {
  const top = providerStack[providerStack.length - 1];
  if (top == null || top.fiber !== fiber) {
    return;
  }
  providerStack.pop();
  top.context._currentValue = top.prev;
}

/**
 * 渲染抛错或挂起后，边界以上的 Provider 还要留着，边界内部的先弹出。
 */
export function popProvidersAbove(boundary: Fiber): void {
  while (providerStack.length > 0) {
    const top = providerStack[providerStack.length - 1];
    if (top.fiber === boundary || !isInside(top.fiber, boundary)) {
      return;
    }
    popProvider(top.fiber);
  }
}

/** fiber 顺着 return 能不能走到 ancestor。 */
function isInside(fiber: Fiber, ancestor: Fiber): boolean {
  let parent = fiber.return;
  while (parent != null) {
    if (parent === ancestor) {
      return true;
    }
    parent = parent.return;
  }
  return false;
}

/** 函数上带 isErrorBoundary 时，unwind 会停在这里并改渲染 fallback。 */
export function isErrorBoundaryFiber(fiber: Fiber): boolean {
  const type = fiber.type;
  return (
    typeof type === 'function' &&
    (type as { isErrorBoundary?: boolean }).isErrorBoundary === true
  );
}

/** props 浅比较。children 也算一格；元素孩子是新对象时比较失败，不能误跳过。 */
function shallowEqual(prev: any, next: any): boolean {
  if (Object.is(prev, next)) {
    return true;
  }
  if (
    typeof prev !== 'object' ||
    prev == null ||
    typeof next !== 'object' ||
    next == null
  ) {
    return false;
  }
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) {
    return false;
  }
  for (const key of prevKeys) {
    if (!Object.prototype.hasOwnProperty.call(next, key) || !Object.is(prev[key], next[key])) {
      return false;
    }
  }
  return true;
}

/**
 * 跳过时把 current 的直接孩子克隆成 WIP，避免两棵树共用同一格 Fiber。
 * 这些克隆不会再 beginWork，所以函数组件不会被调用。
 */
function cloneChildFibers(workInProgress: Fiber): void {
  let currentChild = workInProgress.child;
  if (currentChild == null) {
    return;
  }
  let newChild = createWorkInProgress(
    currentChild,
    currentChild.pendingProps ?? currentChild.memoizedProps,
  );
  workInProgress.child = newChild;
  newChild.return = workInProgress;
  while (currentChild.sibling != null) {
    currentChild = currentChild.sibling;
    const sibling = createWorkInProgress(
      currentChild,
      currentChild.pendingProps ?? currentChild.memoizedProps,
    );
    newChild.sibling = sibling;
    newChild = sibling;
    newChild.return = workInProgress;
  }
  newChild.sibling = null;
}

/**
 * 四件事同时成立才跳过：
 * 1. 自己的 lanes 与本轮 renderLanes 无交集
 * 2. 子树 childLanes 也无交集（有的话父函数必须重跑）
 * 3. props 浅比较相同，ref 也没换
 * 4. 上次 useContext 读到的值还是现在的 _currentValue
 */
function canSkipUpdate(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
  propsEqual: boolean,
): boolean {
  if (current == null) {
    return false;
  }
  if ((workInProgress.flags & DidCapture) !== 0) {
    return false;
  }
  if (includesSomeLane(workInProgress.lanes, renderLanes)) {
    return false; // 1
  }
  if (includesSomeLane(workInProgress.childLanes, renderLanes)) {
    return false; // 2
  }
  if (!Object.is(current.ref, workInProgress.ref) || !propsEqual) {
    return false; // 3
  }
  if (hasContextChanged(current)) {
    return false; // 4
  }
  return true;
}

/** 克隆子链表后返回 null，workLoop 直接转入 complete。 */
function bailout(workInProgress: Fiber): Fiber | null {
  cloneChildFibers(workInProgress);
  return null;
}

/** 有 ref，或 ref 身份变了，Layout 阶段才写。 */
function markRef(current: Fiber | null, workInProgress: Fiber): void {
  const ref = workInProgress.ref;
  if (current == null) {
    if (ref != null) {
      workInProgress.flags |= Ref;
    }
    return;
  }
  if (!Object.is(current.ref, ref)) {
    workInProgress.flags |= Ref;
  }
}

function updateHostRoot(current: Fiber | null, workInProgress: Fiber): Fiber | null {
  const nextChildren = workInProgress.pendingProps.children;
  reconcileChildren(current, workInProgress, nextChildren);
  return workInProgress.child;
}

function updateFunctionComponent(
  current: Fiber | null,
  workInProgress: Fiber,
): Fiber | null {
  if ((workInProgress.flags & DidCapture) !== 0 && isErrorBoundaryFiber(workInProgress)) {
    reconcileChildren(current, workInProgress, workInProgress.pendingProps.fallback);
    return workInProgress.child; // 出错后不再跑组件函数，直接换成 fallback
  }
  markRef(current, workInProgress);
  const nextChildren = renderWithHooks(
    current,
    workInProgress,
    workInProgress.type,
    workInProgress.pendingProps,
  );
  reconcileChildren(current, workInProgress, nextChildren);
  return workInProgress.child;
}

function updateHostComponent(
  current: Fiber | null,
  workInProgress: Fiber,
): Fiber | null {
  markRef(current, workInProgress);
  reconcileChildren(
    current,
    workInProgress,
    workInProgress.pendingProps.children,
  );
  return workInProgress.child;
}

function updateFragment(current: Fiber | null, workInProgress: Fiber): Fiber | null {
  reconcileChildren(
    current,
    workInProgress,
    workInProgress.pendingProps.children,
  );
  return workInProgress.child;
}

/**
 * Provider：value 放进 memoizedState，并 push 给子树。
 * value 变了以后，消费者 props 即使相同也不能 bailout。
 */
function updateContextProvider(
  current: Fiber | null,
  workInProgress: Fiber,
): Fiber | null {
  const context = workInProgress.type._context as { _currentValue: any };
  const nextValue = workInProgress.pendingProps.value;
  pushProvider(workInProgress, context, nextValue);
  workInProgress.memoizedState = nextValue;
  reconcileChildren(
    current,
    workInProgress,
    workInProgress.pendingProps.children,
  );
  return workInProgress.child;
}

function updateForwardRef(
  current: Fiber | null,
  workInProgress: Fiber,
): Fiber | null {
  const render = workInProgress.type.render as (props: any, ref: any) => any;
  const nextChildren = renderWithHooks(
    current,
    workInProgress,
    render,
    workInProgress.pendingProps,
    workInProgress.ref,
  );
  reconcileChildren(current, workInProgress, nextChildren);
  return workInProgress.child;
}

function updateMemoComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
): Fiber | null {
  const memoType = workInProgress.type as {
    type: (props: any, ref?: any) => any;
    compare?: ((prev: any, next: any) => boolean) | null;
  };
  const compare = memoType.compare ?? shallowEqual;
  const propsEqual =
    current != null && compare(current.memoizedProps, workInProgress.pendingProps);
  if (canSkipUpdate(current, workInProgress, renderLanes, propsEqual)) {
    return bailout(workInProgress);
  }
  markRef(current, workInProgress);
  const nextChildren = renderWithHooks(
    current,
    workInProgress,
    memoType.type,
    workInProgress.pendingProps,
    workInProgress.ref,
  );
  reconcileChildren(current, workInProgress, nextChildren);
  return workInProgress.child;
}

function updateSuspenseComponent(
  current: Fiber | null,
  workInProgress: Fiber,
): Fiber | null {
  const nextChildren =
    (workInProgress.flags & DidCapture) !== 0
      ? workInProgress.pendingProps.fallback
      : workInProgress.pendingProps.children;
  reconcileChildren(current, workInProgress, nextChildren);
  return workInProgress.child;
}

/**
 * Render 向下入口。按 tag 分发，返回下一个要处理的 Fiber。
 *
 * 1. 函数组件 / memo / Fragment 先问能不能跳过
 * 2. 不能跳过就按 tag 接上 child
 * 3. HostText 是叶子，直接 null
 */
export function beginWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
): Fiber | null {
  const propsEqual = shallowEqual(current?.memoizedProps, workInProgress.pendingProps);
  switch (workInProgress.tag) {
    case HostRoot:
      return updateHostRoot(current, workInProgress);
    case FunctionComponent:
      if (canSkipUpdate(current, workInProgress, renderLanes, propsEqual)) {
        return bailout(workInProgress); // 1
      }
      return updateFunctionComponent(current, workInProgress); // 2
    case HostComponent:
      return updateHostComponent(current, workInProgress);
    case HostText:
      return null; // 3
    case Fragment:
      if (canSkipUpdate(current, workInProgress, renderLanes, propsEqual)) {
        return bailout(workInProgress);
      }
      return updateFragment(current, workInProgress);
    case ContextProvider:
      if (canSkipUpdate(current, workInProgress, renderLanes, propsEqual)) {
        return bailout(workInProgress);
      }
      return updateContextProvider(current, workInProgress);
    case ForwardRef:
      if (canSkipUpdate(current, workInProgress, renderLanes, propsEqual)) {
        return bailout(workInProgress);
      }
      return updateForwardRef(current, workInProgress);
    case MemoComponent:
      return updateMemoComponent(current, workInProgress, renderLanes);
    case SuspenseComponent:
      if (
        (workInProgress.flags & DidCapture) === 0 &&
        canSkipUpdate(current, workInProgress, renderLanes, propsEqual)
      ) {
        return bailout(workInProgress);
      }
      return updateSuspenseComponent(current, workInProgress);
    default:
      return null;
  }
}
