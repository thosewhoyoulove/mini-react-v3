import {
  FunctionComponent,
  HostComponent,
  HostRoot,
  HostText,
  type Fiber,
} from './fiber';
import { NoFlags, Update } from './fiberFlags';
import { mergeLanes, NoLanes } from './fiberLanes';
import { getHostConfig } from './hostContext';

/**
 * Render 阶段的“向上”半程。
 *
 * beginWork 负责接 child，completeWork 则在子树完成后：
 *   1. mount Host 节点时创建离屏实例并装入已完成的宿主后代
 *   2. update Host 节点时比较 props / text，只打 Update flag
 *   3. 把孩子的 flags 与 lanes 汇总到父 Fiber
 *
 * 这里会调用 createElement/createTextNode，但不会修改屏幕上已挂载的 DOM；
 * 真正的插入、移动、删除和属性更新仍统一留给 Commit。
 */

/**
 * 把直接孩子携带的信息汇总到 completedWork。
 *
 * 1. 收集每个 child 的 subtreeFlags 与自身 flags
 * 2. 合并 child.lanes / child.childLanes
 * 3. 修正 return 指针后写回父 Fiber
 */
function bubbleProperties(completedWork: Fiber): void {
  let subtreeFlags = NoFlags;
  let newChildLanes = NoLanes;
  let child = completedWork.child;
  while (child != null) {
    subtreeFlags |= child.subtreeFlags; // 1. 孩子的后代副作用
    subtreeFlags |= child.flags; // 1. 孩子自己的副作用
    newChildLanes = mergeLanes(
      newChildLanes,
      mergeLanes(child.lanes, child.childLanes),
    );
    child.return = completedWork; // 3. 双缓冲复用后确保父指针指向本轮 WIP
    child = child.sibling;
  }
  completedWork.subtreeFlags |= subtreeFlags; // 3. Commit 可据此跳过无副作用子树
  completedWork.childLanes = newChildLanes; // 3. 为后续 bailout 结构预留；当前尚未消费
}

/**
 * 深度优先找到 workInProgress 下的宿主后代，装进刚创建的离屏 parent。
 * 遇到 HostComponent 就整棵 append，因为它自己的 completeWork 已装好后代；
 * 遇到函数组件则继续向下找，避免把没有 stateNode 的 Fiber 当作宿主节点。
 */
function appendAllChildren(parent: any, workInProgress: Fiber): void {
  const hostConfig = getHostConfig();
  let node = workInProgress.child;
  while (node != null) {
    if (node.tag === HostComponent || node.tag === HostText) {
      hostConfig.appendChild(parent, node.stateNode);
    } else if (node.child != null) {
      node.child.return = node;
      node = node.child;
      continue;
    }
    if (node === workInProgress) {
      return;
    }
    while (node.sibling == null) {
      if (node.return == null || node.return === workInProgress) {
        return;
      }
      node = node.return;
    }
    node.sibling.return = node.return;
    node = node.sibling;
  }
}

/** 比较 Host props（children 由子 Fiber 负责），决定是否需要打 Update。 */
function propsNeedUpdate(prev: any, next: any): boolean {
  if (prev === next) {
    return false;
  }
  if (prev == null || next == null) {
    return true;
  }
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === 'children') {
      continue;
    }
    if (!Object.is(prev[key], next[key])) {
      return true;
    }
  }
  return false;
}

/**
 * 完成一个 Fiber。
 *
 * 1. HostComponent 更新：复用实例，props 变化时打 Update，再冒泡
 * 2. HostComponent 首次挂载：创建实例、装入宿主后代，再冒泡
 * 3. HostText 更新或挂载：复用并打 Update，或创建离屏 Text
 * 4. FunctionComponent / HostRoot：没有实例，只冒泡子树信息
 */
export function completeWork(
  current: Fiber | null,
  workInProgress: Fiber,
): void {
  const hostConfig = getHostConfig();
  switch (workInProgress.tag) {
    case HostComponent: {
      if (current != null && workInProgress.stateNode != null) {
        if (propsNeedUpdate(current.memoizedProps, workInProgress.pendingProps)) {
          workInProgress.flags |= Update; // 1. 这里只记录，Commit 才改已有实例
        }
        bubbleProperties(workInProgress); // 1
        return;
      }
      const instance = hostConfig.createInstance(
        workInProgress.type,
        workInProgress.pendingProps,
      );
      appendAllChildren(instance, workInProgress); // 2. 子 Host 已完成，可以先组装离屏子树
      workInProgress.stateNode = instance; // 2. Fiber 记住对应宿主实例
      bubbleProperties(workInProgress); // 2
      return;
    }
    case HostText: {
      const newText = workInProgress.pendingProps;
      if (current != null && workInProgress.stateNode != null) {
        if (current.memoizedProps !== newText) {
          workInProgress.flags |= Update; // 3. 文本变化留给 Mutation
        }
        bubbleProperties(workInProgress); // 3
        return;
      }
      workInProgress.stateNode = hostConfig.createTextInstance(String(newText)); // 3. 尚未挂载
      bubbleProperties(workInProgress); // 3
      return;
    }
    case FunctionComponent:
    case HostRoot:
      bubbleProperties(workInProgress); // 4. 没有宿主实例，只汇总孩子
      return;
    default:
      bubbleProperties(workInProgress);
  }
}
