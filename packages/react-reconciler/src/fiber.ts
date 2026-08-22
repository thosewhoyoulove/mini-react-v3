import { NoFlags } from './fiberFlags';
import { NoLanes } from './fiberLanes';

/**
 * Fiber：协调器内部的工作单元。
 *
 * ReactElement 是树状数据（props.children 嵌套对象）。
 * Fiber 把同一棵树改成链表，才能在 work loop 里「做完一个节点就停」：
 *   child    → 第一个子节点
 *   sibling  → 下一个兄弟
 *   return   → 父节点（名字避开 JS 关键字 parent）
 *
 * 例：createElement('div', null,
 *       createElement('h1', null, 'Mini React'),
 *       createElement('p', null, 'count: 0'),
 *     )
 *
 * 链表长这样（箭头是指针，不是数组下标）：
 *
 *   HostRoot
 *     │ child
 *     ▼
 *   div ──sibling──► p
 *     │ child          │ child
 *     ▼                ▼
 *   h1 ──child──► "Mini React"     "count: 0"
 *
 * 从 div 出发：fiber.child 是 h1，h1.sibling 是 p，p.return 回到 div。
 */

/** 函数组件，如 createElement(App, null) → type 是函数 App */
export const FunctionComponent = 0;
/** 整棵树的根。createRoot(dom) 时创建，不对应任何 JSX 标签 */
export const HostRoot = 3;
/** 原生 DOM 标签，如 'div' / 'button'。数字与 React 源码对齐，方便对照 */
export const HostComponent = 5;
/** 文本节点，如 'Mini React'、'count: ' + count */
export const HostText = 6;

export interface Fiber {
  /** 上面四个 tag 常量之一，决定 beginWork / completeWork 走哪条分支 */
  tag: number;
  /**
   * 节点「是什么」。
   * HostComponent: 'div'
   * FunctionComponent: App 函数本身
   * HostText / HostRoot: null
   */
  type: any;
  /** 列表 diff 用的 key。createElement('li', { key: 'Fiber' }) 里的 'Fiber' */
  key: string | null;
  /**
   * 真实世界里对应的东西：
   * HostComponent → HTMLElement
   * HostText      → Text
   * HostRoot      → FiberRoot（见 createContainer）
   * FunctionComponent → 一般是 null
   */
  stateNode: any;
  /** 父 Fiber。调和时用来把 flags 向上冒泡 */
  return: Fiber | null;
  /** 第一个子 Fiber */
  child: Fiber | null;
  /** 下一个兄弟 Fiber。没有 prevSibling，要找上一个只能从父的 child 往后走 */
  sibling: Fiber | null;
  /** 在兄弟中的位置 0, 1, 2... 没有 key 时靠 index 对位 */
  index: number;
  /** 这次渲染刚传入的 props。函数组件 beginWork 时用它调用 App(pendingProps) */
  pendingProps: any;
  /** 上次渲染用过的 props。commit 时对比出要改哪些 DOM 属性 */
  memoizedProps: any;
  /**
   * 组件记住的状态。
   * 函数组件：hooks 链表的头节点（useState / useEffect / useLayoutEffect）
   * HostRoot：一般不用
   */
  memoizedState: any;
  /** 待处理更新队列。本项目里主要给 HostRoot / 函数组件挂 update */
  updateQueue: any;
  /** 这个节点自己的副作用：Placement / Update（含 useLayoutEffect）/ ChildDeletion / Passive */
  flags: number;
  /** 子树里有没有副作用。commit 时子树全是 NoFlags 就可以整棵跳过 */
  subtreeFlags: number;
  /** 要从 DOM 上删掉的子 Fiber 列表。有删除时 flags 会带 ChildDeletion */
  deletions: Fiber[] | null;
  /**
   * 双缓冲的另一棵树。
   * current.alternate === workInProgress
   * workInProgress.alternate === current
   * 屏幕上那棵叫 current；正在算的那棵叫 workInProgress。
   * commit 成功后 root.current = finishedWork，两棵角色对调。
   */
  alternate: Fiber | null;
  /**
   * 这个节点自己挂着的更新优先级。setState 时 |= lane，
   * 再顺着 return 把 lane 标到祖先的 childLanes 上。
   */
  lanes: number;
  /**
   * 子树里还有没有没处理的更新。官方 beginWork 用它做 bailout：
   * childLanes 与本轮 renderLanes 无交集就可以跳过整棵子树。
   * 本教学实现先记下这个字段，beginWork 暂未跳过。
   */
  childLanes: number;
}

/**
 * 一棵应用树的入口，不是 Fiber。
 * createRoot(container) → FiberRoot
 *
 *   FiberRoot
 *     containerInfo → 真实 DOM（#root）
 *     current       → HostRoot Fiber（current 树的根）
 *     finishedWork  → 算完、等 commit 的 WIP 树根
 *
 * HostRootFiber.stateNode 反过来指向这个 FiberRoot，
 * 所以从任意 Fiber 一直 return 上去，就能找到 root。
 */
export interface FiberRoot {
  /** 真实 DOM 容器，一般是 #root */
  containerInfo: any;
  /** 屏幕上那棵树的 HostRoot */
  current: Fiber;
  hostConfig: any;
  /** 算完、等 commit 的 WIP 树根 */
  finishedWork: Fiber | null;
  /** 根上还没处理完的更新。ensureRootIsScheduled 看这里决定走 sync 还是 concurrent */
  pendingLanes: number;
  /** Scheduler 返回的 task id。高优插队时用来 cancel 掉低优回调 */
  callbackNode: number | null;
  /** 当前已约的那次回调是哪一档 lane，同档就不再重复 schedule */
  callbackPriority: number;
}

/** 建一个空 Fiber，指针和副作用都是初始值。 */
export function createFiber(
  tag: number,
  pendingProps: any,
  key: string | null,
): Fiber {
  return {
    tag,
    type: null,
    key,
    stateNode: null,
    return: null,
    child: null,
    sibling: null,
    index: 0,
    pendingProps,
    memoizedProps: null,
    memoizedState: null,
    updateQueue: null,
    flags: NoFlags,
    subtreeFlags: NoFlags,
    deletions: null,
    alternate: null,
    lanes: NoLanes,
    childLanes: NoLanes,
  };
}

/** createRoot 时调用：先有一个空的 HostRoot，还没有子节点。 */
export function createHostRootFiber(): Fiber {
  return createFiber(HostRoot, null, null);
}

/**
 * 为 current 树上的某个节点，取出（或新建）对应的 workInProgress 节点。
 *
 * 第一次更新还没有 alternate：
 *   current.alternate = 新 wip
 *   wip.alternate     = current
 *
 * 之后每次更新复用那同一个 wip，只重置 flags / deletions，
 * 避免每次 setState 都 new 一整棵 Fiber。
 *
 * child / memoizedState 先拷自 current：
 *   子节点没变时可以直接复用旧 child 链表；
 *   变了再由 reconcileChildFibers 重新接。
 */
export function createWorkInProgress(
  current: Fiber,
  pendingProps: any,
): Fiber {
  let wip = current.alternate;
  if (wip == null) {
    wip = createFiber(current.tag, pendingProps, current.key);
    wip.type = current.type;
    wip.stateNode = current.stateNode;
    wip.alternate = current;
    current.alternate = wip; // 第一次：两棵树互相指
  } else {
    wip.pendingProps = pendingProps;
    wip.flags = NoFlags;
    wip.subtreeFlags = NoFlags;
    wip.deletions = null; // 复用同一格 wip，只清副作用
  }

  wip.type = current.type;
  wip.child = current.child; // 先拷 current；子树变了由 reconcile 再接
  wip.memoizedProps = current.memoizedProps;
  wip.memoizedState = current.memoizedState;
  wip.updateQueue = current.updateQueue;
  wip.sibling = current.sibling;
  wip.index = current.index;
  wip.lanes = current.lanes;
  wip.childLanes = current.childLanes;
  wip.return = null;
  return wip;
}

/**
 * ReactElement → Fiber。
 *
 * createElement('button', { onClick }, '+1')
 *   type 是 string  → tag = HostComponent，type 仍是 'button'
 *
 * createElement(App, null)
 *   type 是 function → tag = FunctionComponent，type 仍是 App
 *
 * pendingProps 直接等于 element.props（含 children）。
 * returnFiber 是父节点，链表的 return 指针现在就接上。
 */
export function createFiberFromElement(
  element: { type: any; key: string | null; props: any },
  returnFiber: Fiber,
): Fiber {
  const type = element.type;
  const tag = typeof type === 'function' ? FunctionComponent : HostComponent; // 函数→组件，否则当 DOM 标签
  const fiber = createFiber(tag, element.props, element.key);
  fiber.type = type;
  fiber.return = returnFiber;
  return fiber;
}

/**
 * 文本 → Fiber。没有 type / key。
 * createElement('h1', null, 'Mini React') 的第三个参数会走到这里，
 * pendingProps 就是字符串 'Mini React' 本身。
 */
export function createFiberFromText(content: string, returnFiber: Fiber): Fiber {
  const fiber = createFiber(HostText, content, null);
  fiber.return = returnFiber;
  return fiber;
}
