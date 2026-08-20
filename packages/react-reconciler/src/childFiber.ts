import type { ReactElement } from 'react';
import { REACT_ELEMENT_TYPE } from 'shared';
import {
  HostText,
  createFiberFromElement,
  createFiberFromText,
  createWorkInProgress,
  type Fiber,
} from './fiber';
import { ChildDeletion, Placement } from './fiberFlags';

// 是不是 createElement / jsx 产出的对象（有 $$typeof）。
function isReactElement(value: unknown): value is ReactElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ReactElement).$$typeof === REACT_ELEMENT_TYPE
  );
}

// 工厂：true=更新（打 Placement/删除）；false=首次 mount（整棵树稍后一起插入，不记副作用）。
function ChildReconciler(shouldTrackSideEffects: boolean) {
  // 把一个旧 child 记到父节点 deletions，commit 时再从 DOM 摘掉。
  function deleteChild(returnFiber: Fiber, childToDelete: Fiber): void {
    if (!shouldTrackSideEffects) {
      return;
    }
    const deletions = returnFiber.deletions;
    if (deletions == null) {
      returnFiber.deletions = [childToDelete];
      returnFiber.flags |= ChildDeletion;
    } else {
      deletions.push(childToDelete);
    }
  }

  // 从 currentFirstChild 起，整条 sibling 链都删掉（新 children 更短、或类型全换了）。
  function deleteRemainingChildren(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
  ): void {
    if (!shouldTrackSideEffects) {
      return;
    }
    let childToDelete = currentFirstChild;
    while (childToDelete != null) {
      deleteChild(returnFiber, childToDelete);
      childToDelete = childToDelete.sibling;
    }
  }

  // 复用旧 Fiber：克隆成 WIP，清掉 index/sibling，准备接到新链表上。
  function useFiber(fiber: Fiber, pendingProps: any): Fiber {
    const clone = createWorkInProgress(fiber, pendingProps);
    clone.index = 0;
    clone.sibling = null;
    return clone;
  }

  // 单节点：没有 alternate 就是新建，打 Placement。
  function placeSingleChild(newFiber: Fiber): Fiber {
    if (shouldTrackSideEffects && newFiber.alternate == null) {
      newFiber.flags |= Placement;
    }
    return newFiber;
  }

  // 列表里给节点编号；旧位置比 lastPlacedIndex 更靠前 → 这是前移，打 Placement。
  function placeChild(
    newFiber: Fiber,
    lastPlacedIndex: number,
    newIndex: number,
  ): number {
    newFiber.index = newIndex;
    if (!shouldTrackSideEffects) {
      return lastPlacedIndex;
    }
    const current = newFiber.alternate;
    if (current != null) {
      const oldIndex = current.index;
      if (oldIndex < lastPlacedIndex) {
        newFiber.flags |= Placement; // 已放置的节点在它后面，这个要挪到前面
        return lastPlacedIndex;
      }
      return oldIndex; // 相对位置没乱，不移动
    }
    newFiber.flags |= Placement; // 没有 current：全新节点，要插入
    return lastPlacedIndex;
  }

  // 当前位置要对成文本：旧的也是 HostText 就复用，否则新建。
  function updateTextNode(
    returnFiber: Fiber,
    current: Fiber | null,
    textContent: string,
  ): Fiber {
    if (current == null || current.tag !== HostText) {
      const created = createFiberFromText(textContent, returnFiber);
      return created;
    }
    const existing = useFiber(current, textContent);
    existing.return = returnFiber;
    return existing;
  }

  // 当前位置要对成元素：type 相同则复用 Fiber+DOM，否则新建（旧的由调用方去删）。
  function updateElement(
    returnFiber: Fiber,
    current: Fiber | null,
    element: ReactElement,
  ): Fiber {
    if (current != null && current.type === element.type) {
      const existing = useFiber(current, element.props);
      existing.return = returnFiber;
      return existing;
    }
    const created = createFiberFromElement(element, returnFiber);
    return created;
  }

  // 只新建、不复用：mount 尾部或多出来的孩子。
  function createChild(returnFiber: Fiber, newChild: unknown): Fiber | null {
    if (typeof newChild === 'string' || typeof newChild === 'number') {
      return createFiberFromText('' + newChild, returnFiber);
    }
    if (isReactElement(newChild)) {
      return createFiberFromElement(newChild, returnFiber);
    }
    return null;
  }

  // 第一轮按「同一下标」试探：key 对得上才复用，对不上返回 null，数组 diff 改走 Map。
  function updateSlot(
    returnFiber: Fiber,
    oldFiber: Fiber | null,
    newChild: unknown,
  ): Fiber | null {
    const key = oldFiber != null ? oldFiber.key : null;
    if (typeof newChild === 'string' || typeof newChild === 'number') {
      if (key !== null) {
        return null; // 旧节点有 key、新的是文本，对不上
      }
      return updateTextNode(returnFiber, oldFiber, '' + newChild);
    }
    if (isReactElement(newChild)) {
      if (newChild.key !== key) {
        return null;
      }
      return updateElement(returnFiber, oldFiber, newChild);
    }
    return null;
  }

  // 把还没匹配完的旧孩子放进 Map：有 key 用 key，没有用 index。
  function mapRemainingChildren(
    currentFirstChild: Fiber,
  ): Map<string | number, Fiber> {
    const existingChildren = new Map<string | number, Fiber>();
    let existingChild: Fiber | null = currentFirstChild;
    while (existingChild != null) {
      if (existingChild.key != null) {
        existingChildren.set(existingChild.key, existingChild);
      } else {
        existingChildren.set(existingChild.index, existingChild);
      }
      existingChild = existingChild.sibling;
    }
    return existingChildren;
  }

  // 第二轮：用新节点的 key（或下标）到 Map 里找旧 Fiber 再 updateElement/Text。
  function updateFromMap(
    existingChildren: Map<string | number, Fiber>,
    returnFiber: Fiber,
    newIdx: number,
    newChild: unknown,
  ): Fiber | null {
    if (typeof newChild === 'string' || typeof newChild === 'number') {
      const matchedFiber = existingChildren.get(newIdx) ?? null;
      return updateTextNode(returnFiber, matchedFiber, '' + newChild);
    }
    if (isReactElement(newChild)) {
      const matchedFiber =
        existingChildren.get(newChild.key == null ? newIdx : newChild.key) ??
        null;
      return updateElement(returnFiber, matchedFiber, newChild);
    }
    return null;
  }

  // 新 children 是单个文本：旧的第一个也是文本就复用，否则删光旧的再新建。
  function reconcileSingleTextNode(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    textContent: string,
  ): Fiber {
    if (currentFirstChild != null && currentFirstChild.tag === HostText) {
      deleteRemainingChildren(returnFiber, currentFirstChild.sibling);
      const existing = useFiber(currentFirstChild, textContent);
      existing.return = returnFiber;
      return existing;
    }
    deleteRemainingChildren(returnFiber, currentFirstChild);
    return createFiberFromText(textContent, returnFiber);
  }

  // 新 children 是单个元素：沿旧链表找相同 key+type 复用，找不到就新建，路过的旧节点标记删除。
  function reconcileSingleElement(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    element: ReactElement,
  ): Fiber {
    const key = element.key;
    let child = currentFirstChild;
    while (child != null) {
      if (child.key === key) {
        if (child.type === element.type) {
          deleteRemainingChildren(returnFiber, child.sibling);
          const existing = useFiber(child, element.props);
          existing.return = returnFiber;
          return existing;
        }
        deleteRemainingChildren(returnFiber, child); // key 对上但 type 变了，旧的整段不能留
        break;
      }
      deleteChild(returnFiber, child);
      child = child.sibling;
    }
    return createFiberFromElement(element, returnFiber);
  }

  // 新 children 是数组：先按下标对齐，对不上再按 key 做 Map；lastPlacedIndex 决定谁要移动。
  function reconcileChildrenArray(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildren: unknown[],
  ): Fiber | null {
    let resultingFirstChild: Fiber | null = null;
    let previousNewFiber: Fiber | null = null;
    let oldFiber = currentFirstChild;
    let lastPlacedIndex = 0;
    let newIdx = 0;
    let nextOldFiber: Fiber | null = null;

    for (; oldFiber != null && newIdx < newChildren.length; newIdx++) {
      if (oldFiber.index > newIdx) {
        nextOldFiber = oldFiber;
        oldFiber = null;
      } else {
        nextOldFiber = oldFiber.sibling;
      }
      const newFiber = updateSlot(returnFiber, oldFiber, newChildren[newIdx]);
      if (newFiber == null) {
        if (oldFiber == null) {
          oldFiber = nextOldFiber;
        }
        break; // 下标对不上了，改走后面的 Map
      }
      if (shouldTrackSideEffects) {
        if (oldFiber != null && newFiber.alternate == null) {
          deleteChild(returnFiber, oldFiber); // 同位置新建了，旧的要删
        }
      }
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      if (previousNewFiber == null) {
        resultingFirstChild = newFiber;
      } else {
        previousNewFiber.sibling = newFiber;
      }
      previousNewFiber = newFiber;
      oldFiber = nextOldFiber;
    }

    if (newIdx === newChildren.length) {
      deleteRemainingChildren(returnFiber, oldFiber); // 新列表更短，多出来的旧节点删掉
      return resultingFirstChild;
    }

    if (oldFiber == null) {
      for (; newIdx < newChildren.length; newIdx++) {
        const newFiber = createChild(returnFiber, newChildren[newIdx]); // 旧的走完了，后面全是新增
        if (newFiber == null) {
          continue;
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (previousNewFiber == null) {
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
      return resultingFirstChild;
    }

    const existingChildren = mapRemainingChildren(oldFiber);
    for (; newIdx < newChildren.length; newIdx++) {
      const newFiber = updateFromMap(
        existingChildren,
        returnFiber,
        newIdx,
        newChildren[newIdx],
      );
      if (newFiber != null) {
        if (shouldTrackSideEffects && newFiber.alternate != null) {
          existingChildren.delete(
            newFiber.key == null ? newIdx : newFiber.key,
          ); // 复用成功，别在收尾时当成「没人要的旧节点」删掉
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (previousNewFiber == null) {
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
    }

    if (shouldTrackSideEffects) {
      existingChildren.forEach((child) => {
        deleteChild(returnFiber, child); // Map 里剩下的：新列表里没有，删
      });
    }
    return resultingFirstChild;
  }

  // 总入口：看新 children 是文本 / 单个元素 / 数组，分到上面三个 reconcile*。
  function reconcileChildFibers(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChild: unknown,
  ): Fiber | null {
    if (typeof newChild === 'string' || typeof newChild === 'number') {
      return placeSingleChild(
        reconcileSingleTextNode(
          returnFiber,
          currentFirstChild,
          '' + newChild,
        ),
      );
    }

    if (isReactElement(newChild)) {
      return placeSingleChild(
        reconcileSingleElement(
          returnFiber,
          currentFirstChild,
          newChild,
        ),
      );
    }

    if (Array.isArray(newChild)) {
      return reconcileChildrenArray(returnFiber, currentFirstChild, newChild);
    }

    deleteRemainingChildren(returnFiber, currentFirstChild); // null/false/undefined：旧孩子全删
    return null;
  }

  return reconcileChildFibers;
}

export const reconcileChildFibers = ChildReconciler(true); // 更新：要打副作用
export const mountChildFibers = ChildReconciler(false); // 首次挂载：不打

// beginWork 调用这里：没有 current 走 mount，有 current 走 reconcile（带 old child 链表）。
export function reconcileChildren(
  current: Fiber | null,
  workInProgress: Fiber,
  nextChildren: unknown,
): void {
  if (current == null) {
    workInProgress.child = mountChildFibers(
      workInProgress,
      null,
      nextChildren,
    );
  } else {
    workInProgress.child = reconcileChildFibers(
      workInProgress,
      current.child,
      nextChildren,
    );
  }
}
