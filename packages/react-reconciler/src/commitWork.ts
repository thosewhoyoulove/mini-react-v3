import {
  FunctionComponent,
  HostComponent,
  HostRoot,
  HostText,
  type Fiber,
  type FiberRoot,
} from './fiber';
import {
  ChildDeletion,
  MutationMask,
  Passive,
  PassiveMask,
  Placement,
  Update,
} from './fiberFlags';
import { getHostConfig } from './hostContext';
import {
  commitHookEffectListMount,
  commitHookEffectListUnmount,
} from './hooks';

function isHostParent(fiber: Fiber): boolean {
  return fiber.tag === HostComponent || fiber.tag === HostRoot;
}

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

function getHostSibling(fiber: Fiber): any {
  let node: Fiber = fiber;
  siblings: while (true) {
    while (node.sibling == null) {
      if (node.return == null || isHostParent(node.return)) {
        return null;
      }
      node = node.return;
    }
    node.sibling.return = node.return;
    node = node.sibling;
    while (node.tag !== HostComponent && node.tag !== HostText) {
      if ((node.flags & Placement) !== 0) {
        continue siblings;
      }
      if (node.child == null) {
        continue siblings;
      }
      node.child.return = node;
      node = node.child;
    }
    if ((node.flags & Placement) === 0) {
      return node.stateNode;
    }
  }
}

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

function commitPlacement(finishedWork: Fiber): void {
  const parentFiber = getHostParentFiber(finishedWork.return!);
  const isContainer = parentFiber.tag === HostRoot;
  const parentStateNode = isContainer
    ? (parentFiber.stateNode as FiberRoot).containerInfo
    : parentFiber.stateNode;
  const before = getHostSibling(finishedWork);
  insertOrAppendPlacementNode(
    finishedWork,
    before,
    parentStateNode,
    isContainer,
  );
}

function unmountEffects(fiber: Fiber): void {
  if (fiber.tag === FunctionComponent) {
    commitHookEffectListUnmount(fiber, true);
  }
  let child = fiber.child;
  while (child != null) {
    unmountEffects(child);
    child = child.sibling;
  }
}

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

function commitDeletion(deletedFiber: Fiber, nearestMountedAncestor: Fiber): void {
  unmountEffects(deletedFiber);
  const parentFiber = getHostParentFiber(nearestMountedAncestor);
  const isContainer = parentFiber.tag === HostRoot;
  const parentStateNode = isContainer
    ? (parentFiber.stateNode as FiberRoot).containerInfo
    : parentFiber.stateNode;
  commitHostUnmount(deletedFiber, parentStateNode, isContainer);
}

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

function commitMutationEffectsOnFiber(finishedWork: Fiber): void {
  const flags = finishedWork.flags;

  if ((flags & ChildDeletion) !== 0 && finishedWork.deletions != null) {
    for (const childToDelete of finishedWork.deletions) {
      commitDeletion(childToDelete, finishedWork);
    }
    finishedWork.deletions = null;
  }

  if ((finishedWork.subtreeFlags & MutationMask) !== 0) {
    let child = finishedWork.child;
    while (child != null) {
      commitMutationEffectsOnFiber(child);
      child = child.sibling;
    }
  }

  // Placement 和 Update 可以同时出现：列表里节点被移动，同时文本 / props 也变了。
  // 不能写成 if / else，否则移动会吃掉更新。
  if ((flags & Placement) !== 0) {
    commitPlacement(finishedWork);
    finishedWork.flags &= ~Placement;
  }
  if ((flags & Update) !== 0) {
    commitWork(finishedWork);
  }
}

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
    finishedWork.tag === FunctionComponent
  ) {
    commitHookEffectListUnmount(finishedWork, false);
  }
}

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
    finishedWork.tag === FunctionComponent
  ) {
    commitHookEffectListMount(finishedWork);
  }
}

export function commitRoot(root: FiberRoot): void {
  const finishedWork = root.finishedWork;
  if (finishedWork == null) {
    return;
  }
  root.finishedWork = null;

  commitMutationEffectsOnFiber(finishedWork);
  root.current = finishedWork;

  commitPassiveUnmountOnFiber(finishedWork);
  commitPassiveMountOnFiber(finishedWork);
}
