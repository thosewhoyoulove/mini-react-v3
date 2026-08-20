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

function bubbleProperties(completedWork: Fiber): void {
  let subtreeFlags = NoFlags;
  let newChildLanes = NoLanes;
  let child = completedWork.child;
  while (child != null) {
    subtreeFlags |= child.subtreeFlags;
    subtreeFlags |= child.flags;
    newChildLanes = mergeLanes(
      newChildLanes,
      mergeLanes(child.lanes, child.childLanes),
    );
    child.return = completedWork;
    child = child.sibling;
  }
  completedWork.subtreeFlags |= subtreeFlags;
  completedWork.childLanes = newChildLanes;
}

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

export function completeWork(
  current: Fiber | null,
  workInProgress: Fiber,
): void {
  const hostConfig = getHostConfig();
  switch (workInProgress.tag) {
    case HostComponent: {
      if (current != null && workInProgress.stateNode != null) {
        if (propsNeedUpdate(current.memoizedProps, workInProgress.pendingProps)) {
          workInProgress.flags |= Update;
        }
        bubbleProperties(workInProgress);
        return;
      }
      const instance = hostConfig.createInstance(
        workInProgress.type,
        workInProgress.pendingProps,
      );
      appendAllChildren(instance, workInProgress);
      workInProgress.stateNode = instance;
      bubbleProperties(workInProgress);
      return;
    }
    case HostText: {
      const newText = workInProgress.pendingProps;
      if (current != null && workInProgress.stateNode != null) {
        if (current.memoizedProps !== newText) {
          workInProgress.flags |= Update;
        }
        bubbleProperties(workInProgress);
        return;
      }
      workInProgress.stateNode = hostConfig.createTextInstance(String(newText));
      bubbleProperties(workInProgress);
      return;
    }
    case FunctionComponent:
    case HostRoot:
      bubbleProperties(workInProgress);
      return;
    default:
      bubbleProperties(workInProgress);
  }
}
