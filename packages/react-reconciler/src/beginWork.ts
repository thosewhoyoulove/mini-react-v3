import {
  FunctionComponent,
  HostComponent,
  HostRoot,
  HostText,
  type Fiber,
} from './fiber';
import { reconcileChildren } from './childFiber';
import { renderWithHooks } from './hooks';

/**
 * Render 阶段的「向下」半程。workLoop.performUnitOfWork 对每个 Fiber 先调这里。
 *
 * 职责只有一件：给当前 wip 接上 child 链表，返回「下一个要处理的节点」。
 *
 *   beginWork(wip)  →  接上 child  →  返回 child（深度优先往下）
 *        ↑                              ↓
 *        └── completeWork ←── 返回 null（叶子 / 没有孩子）
 *
 * 孩子从哪来，按 tag 分四条路（真正的 diff 都进 reconcileChildren）：
 *   HostRoot          → pendingProps.children（root.render 塞进来的 element）
 *   FunctionComponent → 先 renderWithHooks 跑组件函数，返回值当 children
 *   HostComponent     → pendingProps.children（div 的孩子，不执行函数）
 *   HostText          → 叶子，没有 child
 *
 * reconcileChildren 再按有没有 current 分叉：
 *   current == null → mountChildFibers（首次，不打副作用）
 *   current != null → reconcileChildFibers（更新，和旧 child 链表对比）
 *
 * 这一阶段只改 Fiber、打 flags，不碰真实 DOM。创建 DOM 是 completeWork 的事。
 */

/**
 * 根节点：孩子来自 root.render(element)，挂在 pendingProps.children。
 *
 * 三步：
 *   1. 取出新的 children（整棵应用树的入口 element）
 *   2. 和 current 树上的旧孩子 diff，结果写到 wip.child
 *   3. 把第一个 child 交回 workLoop，作为下一个工作单元
 */
function updateHostRoot(current: Fiber | null, workInProgress: Fiber): Fiber | null {
  const nextChildren = workInProgress.pendingProps.children; // 1. root.render 挂在这里
  reconcileChildren(current, workInProgress, nextChildren); // 2. 接上 wip.child
  return workInProgress.child; // 3. 往下走；没有孩子则 null，转入 complete
}

/**
 * 函数组件：必须先跑组件函数，Hook 在这一次调用里走完。
 *
 * 三步：
 *   1. renderWithHooks：按有没有 current 切 mount/update dispatcher，真正执行 App(props)
 *   2. 返回值当 children 去 diff（通常是一个 element 或数组）
 *   3. 把第一个 child 交回 workLoop
 *
 * 函数组件本身没有宿主实例。DOM 由下面的 Host* 节点在 completeWork 里创建。
 */
function updateFunctionComponent(
  current: Fiber | null,
  workInProgress: Fiber,
): Fiber | null {
  const nextChildren = renderWithHooks(
    current,
    workInProgress,
    workInProgress.type,
    workInProgress.pendingProps,
  ); // 1. 这里才真正跑 App(props)，Hook 链表一并接好
  reconcileChildren(current, workInProgress, nextChildren); // 2. 返回值当 children 去 diff
  return workInProgress.child; // 3. 下一个工作单元
}

/**
 * 宿主节点（div/button 等）：不执行函数，只 diff props.children。
 *
 * 两步：
 *   1. 用 pendingProps.children 和 current.child 做 diff，接到 wip.child
 *   2. 把第一个 child 交回 workLoop
 *
 * 自己的 DOM 实例要等 completeWork 才创建，或对比 props 后打 Update flag。
 */
function updateHostComponent(
  current: Fiber | null,
  workInProgress: Fiber,
): Fiber | null {
  reconcileChildren(
    current,
    workInProgress,
    workInProgress.pendingProps.children,
  ); // 1. 孩子写在 props 上，直接 diff
  return workInProgress.child; // 2. 下一个工作单元
}

/**
 * Render 向下入口。按 tag 分发，返回下一个要处理的 Fiber。
 *
 * 1. HostRoot / FunctionComponent / HostComponent → 各自 update*，返回 wip.child
 * 2. HostText → 叶子，没有 child，直接 null
 * 3. 未知 tag → null（教学实现不覆盖 Fragment 等）
 *
 * 返回值给 workLoop：非 null 继续向下；null 开始 completeUnitOfWork。
 */
export function beginWork(
  current: Fiber | null,
  workInProgress: Fiber,
): Fiber | null {
  switch (workInProgress.tag) {
    case HostRoot:
      return updateHostRoot(current, workInProgress); // 1. 孩子来自 root.render
    case FunctionComponent:
      return updateFunctionComponent(current, workInProgress); // 1. 先跑函数再 diff
    case HostComponent:
      return updateHostComponent(current, workInProgress); // 1. 只 diff props.children
    case HostText:
      return null; // 2. 叶子，workLoop 转入 completeWork 创建文本节点
    default:
      return null; // 3. 未实现的 tag，当作没有孩子
  }
}
