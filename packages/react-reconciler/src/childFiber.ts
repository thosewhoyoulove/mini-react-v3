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

/**
 * 子节点 diff：把「新的 ReactElement / 文本 / 数组」对成一条 Fiber sibling 链表。
 *
 * beginWork 调 reconcileChildren。新旧对比的是两条链：
 *
 *   旧：current.child → sibling → sibling → null
 *   新：nextChildren（element / 文本 / 数组）
 *   产出：wip.child → sibling → sibling → null
 *
 * 副作用只打在 Fiber 上，不碰 DOM：
 *   Placement      → 新节点要插入，或列表里相对前移
 *   ChildDeletion  → 父节点 deletions[] 里记下要摘掉的旧孩子
 *
 * ChildReconciler 工厂出两套函数，逻辑相同，只是该不该打副作用：
 *   shouldTrackSideEffects = false → mountChildFibers（首次，整棵树稍后一起插入）
 *   shouldTrackSideEffects = true  → reconcileChildFibers（更新，和旧链表 diff）
 *
 * 新 children 的形态决定走哪条 reconcile：
 *   单个文本 → reconcileSingleTextNode
 *   单个元素 → reconcileSingleElement
 *   数组     → reconcileChildrenArray（先按下标对齐，对不上再按 key 做 Map）
 */

/** 是不是 createElement / jsx 产出的对象（靠 $$typeof 认，不靠 constructor）。 */
function isReactElement(value: unknown): value is ReactElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ReactElement).$$typeof === REACT_ELEMENT_TYPE
  );
}

/**
 * 子节点调和器工厂。true / false 各 new 一套闭包，避免每个节点都把 flag 传来传去。
 *
 * false（mount）：还没有上屏的 DOM，删除无意义；插入交给 completeWork 一次性 append。
 * true（update）：必须记下 Placement / deletions，commit 才能改对 DOM。
 */
function ChildReconciler(shouldTrackSideEffects: boolean) {
  /**
   * 把一个旧 child 记到父节点 deletions，commit 时再从 DOM 摘掉。
   *
   * 1. mount 路径不记（还没上屏）
   * 2. 第一次删：new 数组，并给父节点打 ChildDeletion
   * 3. 之后往数组里追加
   */
  function deleteChild(returnFiber: Fiber, childToDelete: Fiber): void {
    if (!shouldTrackSideEffects) {
      return; // 1. 首次挂载没有旧 DOM 可删
    }
    const deletions = returnFiber.deletions;
    if (deletions == null) {
      returnFiber.deletions = [childToDelete]; // 2. 父节点记住「要删的孩子」
      returnFiber.flags |= ChildDeletion;
    } else {
      deletions.push(childToDelete); // 3. 已经有列表，追加即可
    }
  }

  /**
   * 从 currentFirstChild 起，整条 sibling 链都删掉。
   *
   * 新 children 更短、类型全换了、或单节点路径找到可复用的之后，剩下的旧兄弟都走这里。
   *
   * 1. mount 直接返回
   * 2. 顺着 sibling 链，每个都 deleteChild
   */
  function deleteRemainingChildren(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
  ): void {
    if (!shouldTrackSideEffects) {
      return; // 1
    }
    let childToDelete = currentFirstChild;
    while (childToDelete != null) {
      deleteChild(returnFiber, childToDelete); // 2
      childToDelete = childToDelete.sibling;
    }
  }

  /**
   * 复用旧 Fiber：克隆成 WIP，清掉 index / sibling，准备接到新链表上。
   *
   * 1. createWorkInProgress 拿出（或新建）对应的 wip，两棵树互相指
   * 2. index / sibling 属于「在新链表里的位置」，先清掉，后面 placeChild 再写
   * 3. 返回 clone 给调用方去接 return / sibling
   */
  function useFiber(fiber: Fiber, pendingProps: any): Fiber {
    const clone = createWorkInProgress(fiber, pendingProps); // 1
    clone.index = 0;
    clone.sibling = null; // 2. 还没接到新链表，避免带着旧兄弟指针
    return clone; // 3
  }

  /**
   * 单节点路径：没有 alternate 就是新建，打 Placement。
   *
   * 复用的节点 alternate 指向 current，已经在 DOM 上，不用再插。
   * 数组路径不走这里，改用 placeChild（还要判断是否相对前移）。
   */
  function placeSingleChild(newFiber: Fiber): Fiber {
    if (shouldTrackSideEffects && newFiber.alternate == null) {
      newFiber.flags |= Placement; // 新建：commit 时插入
    }
    return newFiber;
  }

  /**
   * 列表里给节点编号，并判断要不要移动。
   *
   * lastPlacedIndex = 已经「就地留下」的旧节点里，最大的 old index。
   * 新复用节点的 oldIndex 比它小 → 相对已经放过的节点前移，打 Placement。
   *
   * 例：旧 [A, B, C] 新 [A, C, B]
   *   放 A（oldIndex=0）→ lastPlacedIndex = 0
   *   放 C（oldIndex=2）→ 2 >= 0，不移动，lastPlacedIndex = 2
   *   放 B（oldIndex=1）→ 1 < 2，B 要挪到 C 后面，打 Placement
   *
   * 1. 给新链表写下标
   * 2. mount 不打 Placement，lastPlacedIndex 原样返回
   * 3. 有 current：oldIndex < lastPlacedIndex → 前移；否则就地留下，更新 lastPlacedIndex
   * 4. 没有 current：全新节点，打 Placement，lastPlacedIndex 不变
   */
  function placeChild(
    newFiber: Fiber,
    lastPlacedIndex: number,
    newIndex: number,
  ): number {
    newFiber.index = newIndex; // 1
    if (!shouldTrackSideEffects) {
      return lastPlacedIndex; // 2
    }
    const current = newFiber.alternate;
    if (current != null) {
      const oldIndex = current.index;
      if (oldIndex < lastPlacedIndex) {
        newFiber.flags |= Placement; // 3. 已放置的节点在它后面，这个要挪到前面
        return lastPlacedIndex;
      }
      return oldIndex; // 3. 相对位置没乱，它成为新的「最后就地留下的」
    }
    newFiber.flags |= Placement; // 4. 没有 current：全新节点，要插入
    return lastPlacedIndex;
  }

  /**
   * 当前位置要对成文本：旧的也是 HostText 就复用，否则新建。
   *
   * 1. 没有旧节点、或旧的不是文本 → 新建（旧的由调用方去删）
   * 2. 旧的也是文本 → 复用 Fiber+DOM，pendingProps 换成新字符串
   */
  function updateTextNode(
    returnFiber: Fiber,
    current: Fiber | null,
    textContent: string,
  ): Fiber {
    if (current == null || current.tag !== HostText) {
      const created = createFiberFromText(textContent, returnFiber); // 1
      return created;
    }
    const existing = useFiber(current, textContent); // 2
    existing.return = returnFiber;
    return existing;
  }

  /**
   * 当前位置要对成元素：type 相同则复用 Fiber+DOM，否则新建。
   *
   * 调用方已经用 key 对过位。这里只看 type（div 不能复用成 span）。
   * type 变了时旧节点还在，由调用方 deleteChild / 收尾扫 Map。
   *
   * 1. type 相同 → 复用，换 props
   * 2. 没有旧节点或 type 变了 → 新建
   */
  function updateElement(
    returnFiber: Fiber,
    current: Fiber | null,
    element: ReactElement,
  ): Fiber {
    if (current != null && current.type === element.type) {
      const existing = useFiber(current, element.props); // 1
      existing.return = returnFiber;
      return existing;
    }
    const created = createFiberFromElement(element, returnFiber); // 2
    return created;
  }

  /**
   * 只新建、不复用：旧链表已经走完，后面多出来的新孩子。
   *
   * 1. 文本 / 数字 → HostText
   * 2. ReactElement → 按 type 建 Fiber
   * 3. null / false / 未知类型 → 跳过
   */
  function createChild(returnFiber: Fiber, newChild: unknown): Fiber | null {
    if (typeof newChild === 'string' || typeof newChild === 'number') {
      return createFiberFromText('' + newChild, returnFiber); // 1
    }
    if (isReactElement(newChild)) {
      return createFiberFromElement(newChild, returnFiber); // 2
    }
    return null; // 3
  }

  /**
   * 数组 diff 第一轮：按「同一下标」试探。key 对得上才复用，对不上返回 null。
   *
   * 返回 null 不是「这个新节点不要了」，而是告诉 reconcileChildrenArray：
   * 下标对齐已经失效，break 出去改走 Map。
   *
   * 1. 取出旧节点的 key（没有旧节点则当 null）
   * 2. 新的是文本：旧节点有 key 就对不上（文本没有 key）；否则走 updateTextNode
   * 3. 新的是元素：key 必须相同才 updateElement
   * 4. 其他类型（null / false）对不上
   */
  function updateSlot(
    returnFiber: Fiber,
    oldFiber: Fiber | null,
    newChild: unknown,
  ): Fiber | null {
    const key = oldFiber != null ? oldFiber.key : null; // 1
    if (typeof newChild === 'string' || typeof newChild === 'number') {
      if (key !== null) {
        return null; // 2. 旧节点有 key、新的是文本，对不上
      }
      return updateTextNode(returnFiber, oldFiber, '' + newChild);
    }
    if (isReactElement(newChild)) {
      if (newChild.key !== key) {
        return null; // 3. key 不同，哪怕 type 一样也不在这一轮复用
      }
      return updateElement(returnFiber, oldFiber, newChild);
    }
    return null; // 4
  }

  /**
   * 把还没匹配完的旧孩子放进 Map，给第二轮按 key 查找。
   *
   * 有 key 用 key，没有用 index。和 React 约定一致：没写 key 就按下标认人。
   */
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

  /**
   * 数组 diff 第二轮：用新节点的 key（或下标）到 Map 里找旧 Fiber。
   *
   * 1. 文本没有 key，按下标找；再交给 updateTextNode 看是不是 HostText
   * 2. 元素：有 key 用 key，没有用下标；再交给 updateElement 看 type
   * 3. 其他类型跳过
   *
   * 找到但 type 对不上时，update* 会新建；旧 Fiber 仍留在 Map 里，收尾时删掉。
   */
  function updateFromMap(
    existingChildren: Map<string | number, Fiber>,
    returnFiber: Fiber,
    newIdx: number,
    newChild: unknown,
  ): Fiber | null {
    if (typeof newChild === 'string' || typeof newChild === 'number') {
      const matchedFiber = existingChildren.get(newIdx) ?? null; // 1
      return updateTextNode(returnFiber, matchedFiber, '' + newChild);
    }
    if (isReactElement(newChild)) {
      const matchedFiber =
        existingChildren.get(newChild.key == null ? newIdx : newChild.key) ??
        null; // 2
      return updateElement(returnFiber, matchedFiber, newChild);
    }
    return null; // 3
  }

  /**
   * 新 children 是单个文本：旧的第一个也是文本就复用，否则删光旧的再新建。
   *
   * 1. 旧链表头是 HostText → 复用它，后面的兄弟都多余，整段删掉
   * 2. 否则（没有旧孩子，或第一个不是文本）→ 旧的全删，新建文本 Fiber
   */
  function reconcileSingleTextNode(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    textContent: string,
  ): Fiber {
    if (currentFirstChild != null && currentFirstChild.tag === HostText) {
      deleteRemainingChildren(returnFiber, currentFirstChild.sibling); // 1
      const existing = useFiber(currentFirstChild, textContent);
      existing.return = returnFiber;
      return existing;
    }
    deleteRemainingChildren(returnFiber, currentFirstChild); // 2
    return createFiberFromText(textContent, returnFiber);
  }

  /**
   * 新 children 是单个元素：沿旧链表找相同 key+type 复用。
   *
   * 1. 取出新元素的 key，从旧链表头开始扫
   * 2. key 和 type 都对上 → 复用，删掉它后面的兄弟
   * 3. key 对上但 type 变了 → 从当前起整段删除，break 去新建（同一个 key 不能给两个 type）
   * 4. key 对不上 → 当前这个记删除，继续往后找
   * 5. 整条链都没找到 → 新建
   */
  function reconcileSingleElement(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    element: ReactElement,
  ): Fiber {
    const key = element.key; // 1
    let child = currentFirstChild;
    while (child != null) {
      if (child.key === key) {
        if (child.type === element.type) {
          deleteRemainingChildren(returnFiber, child.sibling); // 2. 复用这个，后面都多余
          const existing = useFiber(child, element.props);
          existing.return = returnFiber;
          return existing;
        }
        deleteRemainingChildren(returnFiber, child); // 3. key 对上但 type 变了，旧的整段不能留
        break;
      }
      deleteChild(returnFiber, child); // 4. key 对不上，路过的旧节点记删除
      child = child.sibling;
    }
    return createFiberFromElement(element, returnFiber); // 5
  }

    /**
     * 新 children 是数组：旧 sibling 链表 vs 新数组。
   *
   * 一边 diff 一边把新 Fiber 接到 previousNewFiber.sibling 上，最后返回链表头。
   *
   * 三轮：
   *   1. 按下标对齐（updateSlot）：同一位置 key 对得上就复用，对不上 break
   *   2. 某一边先走完：
   *      - 新列表走完 → 多出来的旧节点全删
   *      - 旧列表走完 → 多出来的新节点全新建
   *   3. 两边都还有 → 剩余旧节点进 Map，按 key（或 index）匹配；Map 里剩下的删掉
   *
   * lastPlacedIndex 见 placeChild。oldFiber.index > newIdx 是「旧列表里有空洞」：
   * 上一轮某个位置没有 Fiber（children 里有 null），后面的节点 index 会跳号。
   */
  function reconcileChildrenArray(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildren: unknown[],
  ): Fiber | null {
    let resultingFirstChild: Fiber | null = null; // 新 sibling 链表的头
    let previousNewFiber: Fiber | null = null; // 刚接上的那一格
    let oldFiber = currentFirstChild; // 旧链表游标
    let lastPlacedIndex = 0; // 已就地留下的旧节点里，最大的 old index
    let newIdx = 0; // 新数组下标
    let nextOldFiber: Fiber | null = null; // 先把 sibling 存起来，本轮可能把 oldFiber 删掉

    for (; oldFiber != null && newIdx < newChildren.length; newIdx++) {
      if (oldFiber.index > newIdx) {
        nextOldFiber = oldFiber; // 1. 旧节点编号跳过了这一格，当空洞：本轮没有旧节点
        oldFiber = null;
      } else {
        nextOldFiber = oldFiber.sibling;
      }
      const newFiber = updateSlot(returnFiber, oldFiber, newChildren[newIdx]);
      if (newFiber == null) {
        if (oldFiber == null) {
          oldFiber = nextOldFiber; // 空洞那一轮没消耗旧节点，还回去给 Map
        }
        break; // 1. 下标对不上了，改走第 3 轮 Map
      }
      if (shouldTrackSideEffects) {
        if (oldFiber != null && newFiber.alternate == null) {
          deleteChild(returnFiber, oldFiber); // 同位置新建了（type 变了），旧的要删
        }
      }
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      if (previousNewFiber == null) {
        resultingFirstChild = newFiber; // 新链表头
      } else {
        previousNewFiber.sibling = newFiber; // 接到上一格后面
      }
      previousNewFiber = newFiber;
      oldFiber = nextOldFiber;
    }

    if (newIdx === newChildren.length) {
      deleteRemainingChildren(returnFiber, oldFiber); // 2. 新列表更短，多出来的旧节点删掉
      return resultingFirstChild;
    }

    if (oldFiber == null) {
      for (; newIdx < newChildren.length; newIdx++) {
        const newFiber = createChild(returnFiber, newChildren[newIdx]); // 2. 旧的走完了，后面全是新增
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

    const existingChildren = mapRemainingChildren(oldFiber); // 3. 剩余旧节点进 Map
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

  /**
   * 工厂产出的总入口：看新 children 是文本 / 单个元素 / 数组，分到上面三个 reconcile*。
   *
   * 1. 文本 / 数字 → 单文本路径，再 placeSingleChild
   * 2. ReactElement → 单元素路径，再 placeSingleChild
   * 3. 数组 → 列表 diff（自己内部 placeChild）
   * 4. null / false / undefined → 旧孩子全删，没有新 child
   */
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
      ); // 1
    }

    if (isReactElement(newChild)) {
      return placeSingleChild(
        reconcileSingleElement(
          returnFiber,
          currentFirstChild,
          newChild,
        ),
      ); // 2
    }

    if (Array.isArray(newChild)) {
      return reconcileChildrenArray(returnFiber, currentFirstChild, newChild); // 3
    }

    deleteRemainingChildren(returnFiber, currentFirstChild); // 4
    return null;
  }

  return reconcileChildFibers;
}

/** 更新路径：和旧 child 链表 diff，打 Placement / ChildDeletion。 */
export const reconcileChildFibers = ChildReconciler(true);

/** 首次挂载：没有旧节点，不打副作用。整棵树稍后由 completeWork 一起插入。 */
export const mountChildFibers = ChildReconciler(false);

/**
 * beginWork 调用这里：给 wip 接上 child 链表。
 *
 * 1. 没有 current → 首次挂载，走 mountChildFibers（旧孩子传 null）
 * 2. 有 current → 更新，拿 current.child 当旧链表去 diff
 */
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
    ); // 1
  } else {
    workInProgress.child = reconcileChildFibers(
      workInProgress,
      current.child,
      nextChildren,
    ); // 2
  }
}
