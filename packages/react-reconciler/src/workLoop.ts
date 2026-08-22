import {
  NormalPriority,
  unstable_cancelCallback,
  unstable_scheduleCallback,
  unstable_shouldYield,
} from 'scheduler';
import { beginWork } from './beginWork';
import { commitRoot } from './commitWork';
import { completeWork } from './completeWork';
import {
  HostRoot,
  createHostRootFiber,
  createWorkInProgress,
  type Fiber,
  type FiberRoot,
} from './fiber';
import {
  DefaultLane,
  NoLane,
  NoLanes,
  SyncLane,
  getHighestPriorityLane,
  getNextLanes,
  includesSomeLane,
  isHigherPriorityLane,
  mergeLanes,
  removeLanes,
  type Lane,
  type Lanes,
} from './fiberLanes';
import { setHostConfig } from './hostContext';
import type { HostConfig } from './HostConfig';
import { setScheduleUpdateOnFiber } from './scheduleUpdate';

/**
 * 调和器入口：一次更新怎么从「有人 setState」走到「DOM 改完」。
 *
 * 1. Render 阶段（DefaultLane 可中断，SyncLane 必须一次跑完）
 *    在内存里走 Fiber 树：beginWork 向下、completeWork 向上。
 *    只打 flags，不碰真实 DOM。
 *
 * 2. Commit 阶段（不可中断）
 *    commitRoot：Before Mutation（教学版空）→ Mutation 改 DOM / layout destroy
 *    → 切换 current → Layout 跑 useLayoutEffect create
 *    → 绘制后再跑 useEffect（Scheduler 宏任务）。
 *
 * Lane 决定走哪条路（对齐官方 scheduleUpdateOnFiber / ensureRootIsScheduled）：
 *   SyncLane    → queueMicrotask → workLoopSync（不 shouldYield）
 *   DefaultLane → Scheduler 宏任务 → workLoopConcurrent（可切片）
 * 高优进来时 cancel 掉已约的低优回调，丢掉半成品 WIP 从根重来。
 */

/** 当前正在处理的 Fiber。时间切片暂停时它停在「下一个该处理的节点」。 */
let workInProgress: Fiber | null = null;
/** 正在 render 的那棵树的根。新更新用它判断「是不是打断正在做的这一轮」。 */
let workInProgressRoot: FiberRoot | null = null;
/** 本轮 render 正在处理的 lanes。新更新拿它比较：更高优 / 同档 → 从根重启。 */
let workInProgressRootRenderLanes: Lanes = NoLanes;

/** 教学实现：单根。setState 时顺着 return 找不到 HostRoot 就退回这里。 */
let currentRoot: FiberRoot | null = null;

/**
 * 切片暂停后（或本轮 render 尚未 commit）又来了同档或更高优更新。
 * 半成品 WIP 上已经 beginWork 过的节点看不到新的 hook 队列，必须丢弃从根重来。
 * 更低优的更新只记在 pendingLanes 里，等本轮 commit 后再 schedule。
 */
let rootNeedsRestart = false;

/** 同一事件里多次 Sync 更新只约一次微任务。 */
let syncScheduled = false;
/** 那个微任务真正要处理的 root。后到的 Sync 只改这个指针，不另约。 */
let syncRoot: FiberRoot | null = null;

/**
 * 顺着 return 找到 HostRoot，再取 stateNode 上的 FiberRoot。
 * 正常路径 markUpdateLaneFromFiberToRoot 就会返回；这里是找不到 HostRoot 时的兜底。
 */
function getFiberRoot(fiber: Fiber): FiberRoot {
  let node: Fiber | null = fiber;
  while (node.return != null) {
    node = node.return;
  }
  if (node.tag === HostRoot && node.stateNode != null) {
    return node.stateNode as FiberRoot;
  }
  if (currentRoot == null) {
    throw new Error('Cannot find FiberRoot');
  }
  return currentRoot;
}

/**
 * 从 sourceFiber 一直 return 到 HostRoot，沿途标记 lanes / childLanes。
 * current 和 alternate 都要标：setState 闭包里的 fiber 可能是双缓冲里的任意一棵。
 * 返回 FiberRoot，对应官方 markUpdateLaneFromFiberToRoot。
 */
function markUpdateLaneFromFiberToRoot(sourceFiber: Fiber, lane: Lane): FiberRoot {
  sourceFiber.lanes = mergeLanes(sourceFiber.lanes, lane);
  let alternate = sourceFiber.alternate;
  if (alternate != null) {
    alternate.lanes = mergeLanes(alternate.lanes, lane);
  }

  let node: Fiber = sourceFiber;
  let parent = node.return;
  while (parent != null) {
    parent.childLanes = mergeLanes(parent.childLanes, lane); // 祖先记下「子树里还有没处理的更新」
    alternate = parent.alternate;
    if (alternate != null) {
      alternate.childLanes = mergeLanes(alternate.childLanes, lane);
    }
    node = parent;
    parent = node.return;
  }

  if (node.tag === HostRoot && node.stateNode != null) {
    return node.stateNode as FiberRoot;
  }
  return getFiberRoot(sourceFiber);
}

/**
 * 处理「一个」Fiber = 一个工作单元。
 *
 * beginWork：向下。对比 current / wip，diff 出 child 链表，返回第一个 child。
 * 有 child → 下一轮处理 child（深度优先往下）。
 * 没有 child（叶子）→ 转入 completeUnitOfWork，开始往上收。
 */
function performUnitOfWork(unitOfWork: Fiber): void {
  const current = unitOfWork.alternate;
  let next = beginWork(current, unitOfWork);
  unitOfWork.memoizedProps = unitOfWork.pendingProps;
  unitOfWork.lanes = removeLanes(unitOfWork.lanes, workInProgressRootRenderLanes);
  // 本轮 renderLanes 对应的更新已在这个节点上处理完，清掉以免下一轮重复
  if (next == null) {
    completeUnitOfWork(unitOfWork);
  } else {
    workInProgress = next;
  }
}

/**
 * 完成当前节点后往上走。顺序和递归的「函数返回」一样：
 *
 *   先 completeWork 自己（创建 DOM、冒泡 flags）
 *   有 sibling → 下一单元是兄弟（先把这一层走完）
 *   没 sibling → 回到父节点，父节点也 complete
 *
 * 一直升到 HostRoot，workInProgress 变成 null，表示 Render 结束。
 */
function completeUnitOfWork(unitOfWork: Fiber): void {
  let completedWork: Fiber | null = unitOfWork;
  do {
    completeWork(completedWork.alternate, completedWork);
    const siblingFiber = completedWork.sibling;
    if (siblingFiber != null) {
      workInProgress = siblingFiber; // 先走完这一层，父节点还没 complete
      return;
    }
    completedWork = completedWork.return;
    workInProgress = completedWork;
  } while (completedWork != null);
}

/** SyncLane：不问 shouldYield，一个微任务里把树走完。 */
function workLoopSync(): void {
  while (workInProgress != null) {
    performUnitOfWork(workInProgress);
  }
}

/**
 * DefaultLane：每处理完一个 Fiber 问一次 shouldYield。
 * 5ms 到了就退出，workInProgress 停在下一个节点，下一宏任务接着走。
 */
function workLoopConcurrent(): void {
  while (workInProgress != null && !unstable_shouldYield()) {
    performUnitOfWork(workInProgress);
  }
}

/**
 * 从 current 树根克隆一棵新的 WIP。Sync 插队、同档重启、第一次 render 都走这里。
 * pendingProps 优先：root.render 刚挂上的 children 还在 pending 上。
 */
function prepareFreshStack(root: FiberRoot): void {
  const current = root.current;
  workInProgress = createWorkInProgress(
    current,
    current.pendingProps ?? current.memoizedProps,
  );
  workInProgress.stateNode = root;
}

/**
 * Render 结束、即将 commit：从 pendingLanes 里抠掉刚处理的那档，
 * 并清掉已约的 callback，避免 commit 后再跑一次同一轮。
 */
function markRootFinished(root: FiberRoot, renderedLanes: Lanes): void {
  root.pendingLanes = removeLanes(root.pendingLanes, renderedLanes);
  root.callbackNode = null;
  root.callbackPriority = NoLane;
}

/**
 * WIP 整棵走完 → commitRoot（Mutation / Layout，Passive 延后到绘制后）。
 * 最后再 ensureRootIsScheduled：pendingLanes 里若还留着更低优（Default），接着约。
 */
function finishRoot(root: FiberRoot, renderedLanes: Lanes): void {
  const finishedWork = root.current.alternate;
  if (finishedWork == null) {
    return;
  }
  root.finishedWork = finishedWork;
  markRootFinished(root, renderedLanes);
  commitRoot(root);
  workInProgressRoot = null;
  workInProgressRootRenderLanes = NoLanes;
  ensureRootIsScheduled(root); // pending 里若还留着 Default，commit 后再约
}

/**
 * 微任务里跑 SyncLane。必须从根重来，不能接着 Default 的半成品 WIP：
 * 那棵树上已经 beginWork 过的节点看不到这次 Sync 的新 props / hook 队列。
 */
function performSyncWorkOnRoot(root: FiberRoot): void {
  setHostConfig(root.hostConfig);

  const lanes = getNextLanes(root);
  if (!includesSomeLane(lanes, SyncLane)) {
    ensureRootIsScheduled(root); // 约微任务时还有 Sync，执行时可能已没了，改约 Default
    return;
  }

  workInProgressRoot = root;
  workInProgressRootRenderLanes = SyncLane;
  rootNeedsRestart = false;
  workInProgress = null; // Sync 不能接着 Default 的半成品 WIP
  prepareFreshStack(root);
  workLoopSync();

  if (rootNeedsRestart) {
    workInProgress = null;
    ensureRootIsScheduled(root);
    return;
  }

  finishRoot(root, SyncLane);
}

/**
 * Scheduler 宏任务里跑 DefaultLane。可能是第一拍，也可能是切片后续拍。
 * 三种出口：让给 Sync / 时间到了再约一拍 / 树走完去 commit。
 */
function performConcurrentWorkOnRoot(root: FiberRoot): void {
  setHostConfig(root.hostConfig);
  root.callbackNode = null; // 本拍已开始跑，摘掉 id；yield 后再重新 schedule

  const lanes = getNextLanes(root);
  if (lanes === NoLanes) {
    return;
  }
  if (includesSomeLane(lanes, SyncLane)) {
    ensureRootIsScheduled(root); // 并发回调跑起来时已有 Sync，转微任务
    return;
  }

  workInProgressRoot = root;

  if (rootNeedsRestart) {
    workInProgress = null; // 同档/更高优插队：半成品上看不到新 hook 队列
    rootNeedsRestart = false;
  }

  if (workInProgress == null) {
    workInProgressRootRenderLanes = lanes;
    prepareFreshStack(root); // 第一拍或刚 restart：从根建新 WIP；否则接着上一拍的断点
  }

  workLoopConcurrent();

  if (rootNeedsRestart) {
    workInProgress = null;
    ensureRootIsScheduled(root);
    return;
  }

  if (workInProgress != null) {
    ensureRootIsScheduled(root); // 时间到了、树没走完：约下一拍从断点继续
    return;
  }

  finishRoot(root, workInProgressRootRenderLanes);
}

/**
 * 把 Sync 工作排进微任务。同一轮事件里多次 root.render / Sync 更新只约一次：
 * 只更新 syncRoot，等当前栈走完、微任务执行时一次性处理。
 */
function scheduleSyncCallback(root: FiberRoot): void {
  syncRoot = root;
  if (syncScheduled) {
    return; // 已经约过微任务，只更新 syncRoot
  }
  syncScheduled = true;
  queueMicrotask(() => {
    syncScheduled = false;
    const nextRoot = syncRoot;
    syncRoot = null;
    if (nextRoot != null) {
      performSyncWorkOnRoot(nextRoot);
    }
  });
}

/**
 * 根上唯一的调度入口：有更新之后，要不要约工作、约哪一种。
 *
 * setState、root.render、切片暂停后续跑、commit 后处理剩下的低优，都会进这里。
 * 它不遍历 Fiber，只做四步：
 *   1. pending 空了 → 取消还没执行的回调
 *   2. 已经约过同一档 Lane → 直接返回（多次 setState 合并成一次）
 *   3. 档位变了 → cancel 旧回调（典型：Default 还没跑，Sync 插队）
 *   4. 按最高 Lane 新约一次：Sync → 微任务，Default → Scheduler 宏任务
 *
 * 对应官方 ReactFiberRootScheduler.ensureRootIsScheduled。
 */
function ensureRootIsScheduled(root: FiberRoot): void {
  const nextLanes = getNextLanes(root);
  // 只拿当前最高档。pending 同时有 Sync|Default 时这里是 Sync，Default 等 commit 后再进

  if (nextLanes === NoLanes) {
    if (root.callbackNode != null) {
      unstable_cancelCallback(root.callbackNode); // 没活了，作废还挂着的 Default 回调
      root.callbackNode = null;
      root.callbackPriority = NoLane;
    }
    return;
  }

  const newCallbackPriority = getHighestPriorityLane(nextLanes); // 0b01 Sync / 0b10 Default
  const existingCallbackNode = root.callbackNode;

  if (
    existingCallbackNode != null &&
    root.callbackPriority === newCallbackPriority
  ) {
    return; // 已约同档：连点三次 setState 只保留一个回调，更新都在 pendingLanes 里
  }

  if (existingCallbackNode != null) {
    unstable_cancelCallback(existingCallbackNode); // 换档：作废尚未执行的低优 Default 回调
    root.callbackNode = null;
  }

  if (newCallbackPriority === SyncLane) {
    root.callbackPriority = SyncLane;
    scheduleSyncCallback(root); // 微任务：当前栈一结束就 workLoopSync，不切片
    return;
  }

  root.callbackPriority = newCallbackPriority;
  root.callbackNode = unstable_scheduleCallback(NormalPriority, () => {
    performConcurrentWorkOnRoot(root);
  });
  // DefaultLane：宏任务里可切片。task id 记在 callbackNode，方便被 Sync cancel
}

/**
 * 正在 render 时又来了更新：同档或更高优必须丢 WIP 从根重来。
 * 半成品节点已经 beginWork 过，看不到这次新入队的 hook / props。
 * 更低优只记在 pendingLanes，本轮 commit 完再处理。
 */
function shouldRestartCurrentRender(root: FiberRoot, updateLane: Lane): boolean {
  if (workInProgress == null || workInProgressRoot !== root) {
    return false;
  }
  const renderPriority = getHighestPriorityLane(workInProgressRootRenderLanes);
  const updatePriority = getHighestPriorityLane(updateLane);
  if (updatePriority === renderPriority) {
    return true;
  }
  return isHigherPriorityLane(updatePriority, renderPriority);
}

/**
 * hooks 里 setState / updateContainer 最终走到这里。
 * 只做三件事：沿途标 lane、合并进 root.pendingLanes、决定要不要重启并约一次工作。
 */
export function scheduleUpdateOnFiberImpl(fiber: Fiber, lane: Lane): void {
  const root = markUpdateLaneFromFiberToRoot(fiber, lane);
  root.pendingLanes = mergeLanes(root.pendingLanes, lane);
  if (shouldRestartCurrentRender(root, lane)) {
    rootNeedsRestart = true;
  }
  ensureRootIsScheduled(root);
}

setScheduleUpdateOnFiber(scheduleUpdateOnFiberImpl);

/** ReactDOM.createRoot 会调它：建 HostRoot Fiber + FiberRoot 容器。 */
export function createContainer(
  containerInfo: unknown,
  hostConfig: HostConfig,
): FiberRoot {
  const uninitializedFiber = createHostRootFiber();
  const root: FiberRoot = {
    containerInfo,
    current: uninitializedFiber,
    hostConfig,
    finishedWork: null,
    pendingLanes: NoLanes,
    callbackNode: null,
    callbackPriority: NoLane,
  };
  uninitializedFiber.stateNode = root; // HostRoot ↔ FiberRoot 互相指
  currentRoot = root;
  setHostConfig(hostConfig);
  return root;
}

/** root.render(element)：挂到 HostRoot.pendingProps，用 SyncLane 保证首屏马上画。 */
export function updateContainer(element: unknown, container: FiberRoot): void {
  container.current.pendingProps = { children: element };
  scheduleUpdateOnFiberImpl(container.current, SyncLane);
}

export { DefaultLane, SyncLane };
export type { Lane };
