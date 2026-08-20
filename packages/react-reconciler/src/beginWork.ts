import {
  FunctionComponent,
  HostComponent,
  HostRoot,
  HostText,
  type Fiber,
} from './fiber';
import { reconcileChildren } from './childFiber';
import { renderWithHooks } from './hooks';

// HostRoot：孩子来自 root.render(element)。
function updateHostRoot(current: Fiber | null, workInProgress: Fiber): Fiber | null {
  const nextChildren = workInProgress.pendingProps.children; // root.render 挂在 pendingProps.children 上
  reconcileChildren(current, workInProgress, nextChildren);
  return workInProgress.child;
}

// 先执行函数组件（Hook 在这一次调用里走完），返回值再当 children 去 diff。
function updateFunctionComponent(
  current: Fiber | null,
  workInProgress: Fiber,
): Fiber | null {
  const nextChildren = renderWithHooks(
    current,
    workInProgress,
    workInProgress.type,
    workInProgress.pendingProps,
  ); // 这里才真正跑 App(props)
  reconcileChildren(current, workInProgress, nextChildren);
  return workInProgress.child;
}

// div/button 等宿主节点：不执行函数，只 diff props.children。
function updateHostComponent(
  current: Fiber | null,
  workInProgress: Fiber,
): Fiber | null {
  reconcileChildren(
    current,
    workInProgress,
    workInProgress.pendingProps.children,
  );
  return workInProgress.child;
}

// Render 向下：给当前 Fiber 接上 child，返回下一个要处理的节点；没有则 null，workLoop 开始 complete。
export function beginWork(
  current: Fiber | null,
  workInProgress: Fiber,
): Fiber | null {
  switch (workInProgress.tag) {
    case HostRoot:
      return updateHostRoot(current, workInProgress);
    case FunctionComponent:
      return updateFunctionComponent(current, workInProgress);
    case HostComponent:
      return updateHostComponent(current, workInProgress);
    case HostText:
      return null; // 叶子，没有 child，workLoop 转入 completeWork
    default:
      return null;
  }
}
