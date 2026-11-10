import {
  ContextProvider,
  ForwardRef,
  Fragment,
  FunctionComponent,
  HostComponent,
  HostRoot,
  HostText,
  MemoComponent,
  SuspenseComponent,
  type Fiber,
  type FiberRoot,
} from './fiber';
import {
  ChildDeletion,
  DidCapture,
  Passive,
  Placement,
  Ref,
  Update,
} from './fiberFlags';

/**
 * Fiber Inspector 的可读节点。
 *
 * 这里只复制树形导航和调试字段，不把完整 Fiber 暴露给 Demo；child / sibling
 * 仍保持原链表含义，调用方可以同时看到树的层级和兄弟顺序。
 */
export type DebugFiberNode = {
  /** Fiber tag 的文字名称。 */
  tag: string;

  /** 宿主标签名或函数组件名。 */
  type: string;

  /** keyed Diff 使用的 key。 */
  key: string | null;

  /** 当前 Fiber 自己的 flags 名称。 */
  flags: string[];

  /** 第一个子节点。 */
  child: DebugFiberNode | null;

  /** 下一个兄弟节点。 */
  sibling: DebugFiberNode | null;
};

/**
 * FiberRoot 的双缓冲快照。
 *
 * 这些是用于 Demo 的字符串身份，不暴露 Fiber 对象本身：current 指向最近一次
 * 提交的 HostRoot，workInProgress 指向正在计算的另一格，alternate 显示两者配对。
 */
export type DebugFiberRootState = {
  /** 当前已经提交的 HostRoot 身份。 */
  currentRootId: string;

  /** 正在 Render 的 WIP HostRoot；没有进行中 Render 时为 null。 */
  workInProgressRootId: string | null;

  /** current.alternate 的身份，用来核对双向配对。 */
  currentAlternateId: string | null;

  /** 当前是否存在尚未完成的 WIP。 */
  isWorkInProgressActive: boolean;
};

/** 所有 Fiber 共享的调试身份表；只保存对象到编号的映射，不保存 Fiber 内容。 */
const fiberDebugIds = new WeakMap<object, number>();

/** 下一次分配给 Fiber 的调试编号。 */
let nextFiberDebugId = 1;

/** Fiber tag 到教学名称的映射。 */
function tagName(tag: number): string {
  switch (tag) {
    case FunctionComponent:
      return 'FunctionComponent';
    case HostRoot:
      return 'HostRoot';
    case HostComponent:
      return 'HostComponent';
    case HostText:
      return 'HostText';
    case Fragment:
      return 'Fragment';
    case ContextProvider:
      return 'ContextProvider';
    case ForwardRef:
      return 'ForwardRef';
    case SuspenseComponent:
      return 'Suspense';
    case MemoComponent:
      return 'Memo';
    default:
      return `Unknown(${tag})`;
  }
}

/** 为 Fiber 分配稳定的教学身份，方便在 Commit 前后比较 current 指针。 */
function debugFiberId(fiber: Fiber): string {
  let id = fiberDebugIds.get(fiber);
  if (id == null) {
    id = nextFiberDebugId;
    nextFiberDebugId += 1;
    fiberDebugIds.set(fiber, id);
  }
  return `${tagName(fiber.tag)}#${id}`;
}

/** flags 位图到可读名称的映射。没有副作用时返回 NoFlags。 */
function flagNames(flags: number): string[] {
  const names: string[] = [];
  if ((flags & Placement) !== 0) names.push('Placement');
  if ((flags & Update) !== 0) names.push('Update');
  if ((flags & ChildDeletion) !== 0) names.push('ChildDeletion');
  if ((flags & Ref) !== 0) names.push('Ref');
  if ((flags & Passive) !== 0) names.push('Passive');
  if ((flags & DidCapture) !== 0) names.push('DidCapture');
  return names.length > 0 ? names : ['NoFlags'];
}

/** 把 Fiber 的 type 转成不会触发组件执行的显示名称。 */
function typeName(fiber: Fiber): string {
  if (fiber.tag === HostRoot) return 'HostRoot';
  if (fiber.tag === HostText) return '#text';
  if (typeof fiber.type === 'string') return fiber.type;
  if (typeof fiber.type === 'function') return fiber.type.name || 'Anonymous';
  if (fiber.type != null && typeof fiber.type === 'object') {
    const displayName = (fiber.type as { displayName?: unknown }).displayName;
    if (typeof displayName === 'string') return displayName;
  }
  return tagName(fiber.tag);
}

/** 递归复制一个 Fiber 的 child / sibling 链表。 */
function inspectFiber(fiber: Fiber): DebugFiberNode {
  return {
    tag: tagName(fiber.tag),
    type: typeName(fiber),
    key: fiber.key,
    flags: flagNames(fiber.flags),
    child: fiber.child == null ? null : inspectFiber(fiber.child),
    sibling: fiber.sibling == null ? null : inspectFiber(fiber.sibling),
  };
}

/**
 * 把 current Fiber 树转换为可序列化的调试结构。
 * 传入 FiberRoot 时自动从 root.current 开始，传入 Fiber 时从该节点开始。
 */
export function inspectFiberTree(rootOrFiber: FiberRoot | Fiber): DebugFiberNode {
  const fiber = 'current' in rootOrFiber ? rootOrFiber.current : rootOrFiber;
  return inspectFiber(fiber);
}

/**
 * 把 Inspector 结构打印成教学用树。
 * 根节点不带前缀，后代使用 child / sibling 的层级线条表达链表关系。
 */
export function formatDebugFiberTree(
  rootOrFiber: FiberRoot | Fiber,
): string {
  const root = inspectFiberTree(rootOrFiber);
  const lines: string[] = [];

  const visit = (node: DebugFiberNode, prefix: string, isLast: boolean, isRoot: boolean): void => {
    const marker = isRoot ? '' : `${prefix}${isLast ? '└── ' : '├── '}`;
    const flagText = node.flags.join('|');
    lines.push(`${marker}${node.tag}(${node.type}) key=${node.key ?? 'null'} flags=${flagText}`);
    const childPrefix = isRoot ? '' : `${prefix}${isLast ? '    ' : '│   '}`;
    const children: DebugFiberNode[] = [];
    let child = node.child;
    while (child != null) {
      children.push(child);
      child = child.sibling;
    }
    children.forEach((childNode, index) => {
      visit(childNode, childPrefix, index === children.length - 1, false);
    });
  };

  visit(root, '', true, true);
  return lines.join('\n');
}

/**
 * 读取双缓冲根的当前快照。
 *
 * 1. 为 current HostRoot 分配可读身份
 * 2. 读取正在进行的 WIP 和 current.alternate
 * 3. 只返回字符串与布尔值，避免 Demo 持有内部 Fiber
 */
export function inspectFiberRootState(root: FiberRoot): DebugFiberRootState {
  const current = root.current; // 1. 最近一次成功提交的树
  const workInProgress = root.workInProgress; // 2. 可能正在计算的另一棵树
  return {
    currentRootId: debugFiberId(current),
    workInProgressRootId:
      workInProgress == null ? null : debugFiberId(workInProgress),
    currentAlternateId:
      current.alternate == null ? null : debugFiberId(current.alternate),
    isWorkInProgressActive: workInProgress != null,
  }; // 3. 只交给观察工具可序列化数据
}
