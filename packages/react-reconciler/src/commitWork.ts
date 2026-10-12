import {
  NormalPriority,
  unstable_scheduleCallback,
} from 'scheduler';
import {
  ForwardRef,
  FunctionComponent,
  HostComponent,
  HostRoot,
  HostText,
  MemoComponent,
  type Fiber,
  type FiberRoot,
} from './fiber';
import {
  ChildDeletion,
  LayoutMask,
  MutationMask,
  Passive,
  PassiveMask,
  Placement,
  Ref,
  Update,
} from './fiberFlags';
import { getHostConfig } from './hostContext';
import {
  HookHasEffect,
  HookLayout,
  HookPassive,
  commitHookEffectListMount,
  commitHookEffectListUnmount,
} from './hooks';

/**
 * Commit 阶段：把 render 打好的 flags 落到真实 DOM，并按阶段跑 effect。
 *
 *   commitRoot
 *     ├── Before Mutation   教学版空（官方：getSnapshotBeforeUpdate）
 *     ├── Mutation          删/插/改 DOM；useLayoutEffect 的 destroy
 *     ├── root.current = finishedWork
 *     ├── Layout            useLayoutEffect 的 create
 *     └── Passive（绘制后） useEffect 的 destroy → create
 *
 * 同一条 Hook 链表上两种 effect 混排，用 HookLayout / HookPassive 过滤。
 * useLayoutEffect 打的是 Update（和 Host DOM 更新共用），按 fiber.tag 分叉。
 */

/** HostComponent 和 HostRoot 才能直接承接宿主节点。 */
function isHostParent(fiber: Fiber): boolean {
  return fiber.tag === HostComponent || fiber.tag === HostRoot;
}

/** 从当前 Fiber 向上找到最近的 DOM 元素或根容器 Fiber。 */
function getHostParentFiber(fiber: Fiber): Fiber {
  if (isHostParent(fiber)) {
    return fiber;
  }
  let parent = fiber.return;
  while (parent != null) {
    if (isHostParent(parent)) {
      return parent;
    }
    parent = parent.return;
  }
  throw new Error('Expected to find a host parent');
}

/**
 * 找 Placement 节点右边第一个“已经在宿主树中”的稳定兄弟。
 *
 * 只做四步：
 *   1. 当前层没有 sibling 就向上，碰到宿主父节点表示后面没有锚点
 *   2. 找到 sibling 后转入它的子树
 *   3. 向下寻找 Host 节点；带 Placement 的新子树不能作为锚点，整棵跳过
 *   4. 返回第一个不带 Placement 的 Host 实例，找不到则返回 null 表示 append
 *
 * 这一步让列表移动能使用 insertBefore，而不必预先计算 DOM 下标。
 */
function getHostSibling(fiber: Fiber): any {
  let node: Fiber = fiber;
  siblings: while (true) {
    while (node.sibling == null) {
      if (node.return == null || isHostParent(node.return)) {
        return null; // 1. 已升到宿主父边界，右侧没有稳定兄弟
      }
      node = node.return; // 1. 到父层继续找 sibling
    }
    node.sibling.return = node.return;
    node = node.sibling; // 2. 从右侧兄弟开始寻找宿主锚点
    while (node.tag !== HostComponent && node.tag !== HostText) {
      if ((node.flags & Placement) !== 0) {
        continue siblings; // 3. 这个子树自己也待插入，不能当 before
      }
      if (node.child == null) {
        continue siblings; // 3. 非 Host 叶子没有可用实例
      }
      node.child.return = node;
      node = node.child; // 3. 函数组件等没有实例，继续向下
    }
    if ((node.flags & Placement) === 0) {
      return node.stateNode; // 4. 已挂载 Host 可以作为 insertBefore 锚点
    }
  }
}

/**
 * 把一个 Placement Fiber 对应的宿主节点插进 parent。
 * Fiber 本身若没有 stateNode（例如函数组件），就递归插入它的直接宿主后代。
 */
function insertOrAppendPlacementNode(
  node: Fiber,
  before: any,
  parent: any,
  isContainer: boolean,
): void {
  const hostConfig = getHostConfig();
  const isHost = node.tag === HostComponent || node.tag === HostText;
  if (isHost) {
    const stateNode = node.stateNode;
    if (isContainer) {
      if (before) {
        hostConfig.insertInContainerBefore(parent, stateNode, before);
      } else {
        hostConfig.appendChildToContainer(parent, stateNode);
      }
    } else if (before) {
      hostConfig.insertBefore(parent, stateNode, before);
    } else {
      hostConfig.appendChild(parent, stateNode);
    }
    return;
  }
  let child = node.child;
  while (child != null) {
    insertOrAppendPlacementNode(child, before, parent, isContainer);
    child = child.sibling;
  }
}

/**
 * 提交一个 Placement。
 *
 * 只做四步：
 *   1. 向上找到最近宿主父 Fiber
 *   2. 区分根容器与普通 HostComponent，取得真实 parent
 *   3. 向右找到稳定宿主兄弟作为 before
 *   4. 插入当前 Host，或递归插入非 Host Fiber 的宿主后代
 */
function commitPlacement(finishedWork: Fiber): void {
  const parentFiber = getHostParentFiber(finishedWork.return!); // 1
  const isContainer = parentFiber.tag === HostRoot; // 2
  const parentStateNode = isContainer
    ? (parentFiber.stateNode as FiberRoot).containerInfo
    : parentFiber.stateNode;
  const before = getHostSibling(finishedWork); // 3. null 表示追加到末尾
  insertOrAppendPlacementNode(
    finishedWork,
    before,
    parentStateNode,
    isContainer,
  ); // 4
}

/** 深度优先执行被删除子树中的 Layout / Passive cleanup。 */
function unmountEffects(fiber: Fiber): void {
  if (hasHookList(fiber)) {
    commitHookEffectListUnmount(fiber, HookLayout);
    commitHookEffectListUnmount(fiber, HookPassive);
    // 教学简化：卸载时两种 effect 的 destroy 都在 Mutation 里跑完，不把 Passive 留到绘制后
  }
  let child = fiber.child;
  while (child != null) {
    unmountEffects(child);
    child = child.sibling;
  }
}

/**
 * 从宿主父节点删除一棵 Fiber 子树的顶层宿主节点。
 * 删除 HostComponent 时浏览器会连带移除其 DOM 后代；函数组件则继续向下寻找 Host。
 */
function commitHostUnmount(
  fiber: Fiber,
  parent: any,
  isContainer: boolean,
): void {
  const hostConfig = getHostConfig();
  if (fiber.tag === HostComponent || fiber.tag === HostText) {
    if (isContainer) {
      hostConfig.removeChildFromContainer(parent, fiber.stateNode);
    } else {
      hostConfig.removeChild(parent, fiber.stateNode);
    }
    return;
  }
  let child = fiber.child;
  while (child != null) {
    commitHostUnmount(child, parent, isContainer);
    child = child.sibling;
  }
}

/** 函数组件、memo、forwardRef 的 Hook 都挂在这个 Fiber 上。 */
function hasHookList(fiber: Fiber): boolean {
  return (
    fiber.tag === FunctionComponent ||
    fiber.tag === MemoComponent ||
    fiber.tag === ForwardRef
  );
}

/**
 * 写入 ref。
 *
 * 1. 身份变了就先把旧 ref 清成 null
 * 2. 宿主节点写真实实例；函数组件和 memo 写 Fiber 本身
 * 3. 函数 ref 直接调用，对象 ref 写 current
 */
function commitAttachRef(finishedWork: Fiber): void {
  const prevRef = finishedWork.alternate?.ref ?? null;
  const nextRef = finishedWork.ref;
  if (prevRef != null && !Object.is(prevRef, nextRef)) {
    detachRef(prevRef); // 1
  }
  if (nextRef == null) {
    return;
  }
  const instance =
    finishedWork.tag === HostComponent || finishedWork.tag === HostText
      ? finishedWork.stateNode
      : finishedWork; // 2
  if (typeof nextRef === 'function') {
    nextRef(instance); // 3
    return;
  }
  nextRef.current = instance; // 3
}

/** 卸载或换 ref 时把上一格清空。 */
function detachRef(ref: any): void {
  if (typeof ref === 'function') {
    ref(null);
    return;
  }
  ref.current = null;
}

/** 被删子树上的 ref 都要写成 null，包含没有 Ref flag 的旧节点。 */
function detachRefs(fiber: Fiber): void {
  if (fiber.ref != null) {
    detachRef(fiber.ref);
  }
  let child = fiber.child;
  while (child != null) {
    detachRefs(child);
    child = child.sibling;
  }
}

/** 删除一棵旧子树：先清理 Effect 和 ref，再修改宿主树。 */
function commitDeletion(deletedFiber: Fiber, nearestMountedAncestor: Fiber): void {
  detachRefs(deletedFiber);
  unmountEffects(deletedFiber);
  const parentFiber = getHostParentFiber(nearestMountedAncestor);
  const isContainer = parentFiber.tag === HostRoot;
  const parentStateNode = isContainer
    ? (parentFiber.stateNode as FiberRoot).containerInfo
    : parentFiber.stateNode;
  commitHostUnmount(deletedFiber, parentStateNode, isContainer);
}

/** 按 Fiber tag 把 Update flag 翻译为宿主属性更新或文本更新。 */
function commitWork(finishedWork: Fiber): void {
  const hostConfig = getHostConfig();
  switch (finishedWork.tag) {
    case HostComponent: {
      const instance = finishedWork.stateNode;
      if (instance != null && finishedWork.alternate != null) {
        hostConfig.commitUpdate(
          instance,
          finishedWork.type,
          finishedWork.alternate.memoizedProps,
          finishedWork.memoizedProps,
        );
      }
      return;
    }
    case HostText: {
      const instance = finishedWork.stateNode;
      if (instance != null && finishedWork.alternate != null) {
        hostConfig.commitTextUpdate(
          instance,
          String(finishedWork.alternate.memoizedProps),
          String(finishedWork.memoizedProps),
        );
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Mutation 阶段：先删、再递归子树、最后处理自己的 Placement / Update。
 *
 * 只做四步：
 *   1. 有 deletions → 先卸 effect 再从 DOM 摘掉
 *   2. 子树带 MutationMask → 先处理孩子（深度优先）
 *   3. Placement → 插入或移动真实 DOM
 *   4. Update → Host 改属性；FunctionComponent 跑 useLayoutEffect destroy
 *
 * Placement 和 Update 可能同时存在，必须用两个 if 分别消费，不能互斥。
 */
function commitMutationEffectsOnFiber(finishedWork: Fiber): void {
  const flags = finishedWork.flags;

  if ((flags & ChildDeletion) !== 0 && finishedWork.deletions != null) {
    for (const childToDelete of finishedWork.deletions) {
      commitDeletion(childToDelete, finishedWork);
    }
    finishedWork.deletions = null; // 1
  }

  if ((finishedWork.subtreeFlags & MutationMask) !== 0) {
    let child = finishedWork.child;
    while (child != null) {
      commitMutationEffectsOnFiber(child); // 2
      child = child.sibling;
    }
  }

  if ((flags & Placement) !== 0) {
    commitPlacement(finishedWork); // 3
    finishedWork.flags &= ~Placement;
  }
  if ((flags & Update) !== 0) {
    if (hasHookList(finishedWork)) {
      commitHookEffectListUnmount(finishedWork, HookLayout | HookHasEffect);
      // 4. 函数组件的 Update = useLayoutEffect deps 变了：先跑 destroy
    } else {
      commitWork(finishedWork); // 4. Host：改真实 DOM
    }
  }
}

/**
 * Layout 阶段：DOM 已改、浏览器还没画，跑 useLayoutEffect 的 create。
 *
 * 只做三步：
 *   1. 子树带 LayoutMask（Update 或 Ref）→ 先递归孩子
 *   2. 带 Ref → 写入宿主实例或函数组件 Fiber；卸载路径另走 detachRefs
 *   3. 函数组件 / memo / forwardRef 带 Update → 跑 useLayoutEffect create
 */
function commitLayoutEffectsOnFiber(finishedWork: Fiber): void {
  if ((finishedWork.subtreeFlags & LayoutMask) !== 0) {
    let child = finishedWork.child;
    while (child != null) {
      commitLayoutEffectsOnFiber(child); // 1
      child = child.sibling;
    }
  }
  if ((finishedWork.flags & Ref) !== 0) {
    commitAttachRef(finishedWork); // 2
  }
  if ((finishedWork.flags & Update) !== 0 && hasHookList(finishedWork)) {
    commitHookEffectListMount(finishedWork, HookLayout | HookHasEffect); // 3
  }
}

/** 深度优先执行本轮 deps 变化的 Passive cleanup。 */
function commitPassiveUnmountOnFiber(finishedWork: Fiber): void {
  if ((finishedWork.subtreeFlags & PassiveMask) !== 0) {
    let child = finishedWork.child;
    while (child != null) {
      commitPassiveUnmountOnFiber(child);
      child = child.sibling;
    }
  }
  if (
    (finishedWork.flags & Passive) !== 0 &&
    hasHookList(finishedWork)
  ) {
    commitHookEffectListUnmount(finishedWork, HookPassive | HookHasEffect);
  }
}

/** 深度优先执行本轮 deps 变化的 Passive create。 */
function commitPassiveMountOnFiber(finishedWork: Fiber): void {
  if ((finishedWork.subtreeFlags & PassiveMask) !== 0) {
    let child = finishedWork.child;
    while (child != null) {
      commitPassiveMountOnFiber(child);
      child = child.sibling;
    }
  }
  if (
    (finishedWork.flags & Passive) !== 0 &&
    hasHookList(finishedWork)
  ) {
    commitHookEffectListMount(finishedWork, HookPassive | HookHasEffect);
  }
}

/** 已经约了一次 flush，还没执行。避免每次 commit 都再约一个回调。 */
let rootDoesHavePassiveEffects = false;

/** 等绘制后要跑 Passive 的那棵已提交树。 */
let pendingPassiveEffects: Fiber | null = null;

/**
 * 跑上一轮（或本轮约好的）useEffect：先全树 destroy，再全树 create。
 *
 * 只做三步：
 *   1. 没有 pending → 已经跑过或从未约过，直接返回
 *   2. 摘掉 pending / 预约标记，避免回调重入再跑一遍
 *   3. 先 unmount 再 mount（和官方 flushPassiveEffects 一样）
 */
function flushPassiveEffects(): void {
  if (pendingPassiveEffects == null) {
    return; // 1
  }
  const finishedWork = pendingPassiveEffects;
  pendingPassiveEffects = null; // 2
  rootDoesHavePassiveEffects = false;
  commitPassiveUnmountOnFiber(finishedWork); // 3
  commitPassiveMountOnFiber(finishedWork);
}

/**
 * 官方在这里跑 getSnapshotBeforeUpdate、恢复选区。
 * 教学版没有 class / 选区，占位，让 commitRoot 的三阶段结构能对着讲。
 */
function commitBeforeMutationEffects(_finishedWork: Fiber): void {}

/**
 * Render 结束：按官方顺序提交副作用。
 *
 * 只做五步：
 *   1. 上一轮约过、还没跑的 useEffect 先清掉，避免和新树交错
 *   2. Before Mutation（教学版空）
 *   3. Mutation：改 DOM；函数组件跑 useLayoutEffect destroy
 *   4. 切换 current，然后 Layout：useLayoutEffect create
 *   5. 有 Passive → 记下这棵树，用 Scheduler 宏任务等绘制后再 flush
 */
export function commitRoot(root: FiberRoot): void {
  const finishedWork = root.finishedWork;
  if (finishedWork == null) {
    return;
  }
  root.finishedWork = null;

  flushPassiveEffects(); // 1

  const hasPassiveEffects =
    (finishedWork.flags & PassiveMask) !== 0 ||
    (finishedWork.subtreeFlags & PassiveMask) !== 0;

  commitBeforeMutationEffects(finishedWork); // 2
  commitMutationEffectsOnFiber(finishedWork); // 3
  root.current = finishedWork;

  commitLayoutEffectsOnFiber(finishedWork); // 4

  if (hasPassiveEffects) {
    pendingPassiveEffects = finishedWork; // 5
    if (!rootDoesHavePassiveEffects) {
      rootDoesHavePassiveEffects = true;
      unstable_scheduleCallback(NormalPriority, () => {
        flushPassiveEffects();
      });
    }
  }
}
