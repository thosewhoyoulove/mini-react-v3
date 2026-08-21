# AGENTS.md

教学用 mini-react。改代码时优先保证「对着源码能讲清」，而不是追平官方实现。

## 注释

分两层，不要混用。粒度要对着源码能逐步讲，不要只写「这个函数很重要」。

### 1. 函数、字段、类型、导出常量：JSDoc 写在上方

需要讲清「是什么 / 为什么」时，用 `/** ... */` 放在声明正上方，可以多行。
这是给阅读源码用的，宁可写透，不要压成一行尾注释。

模块级指针、类型字段也一样：链表头在哪、游标指谁、这一格存什么，都写在声明上方。
哪怕只有一行，也用 `/** ... */`，不要用 `//`。类型字段、模块级指针之间空一行。

```ts
/**
 * 为 current 树上的某个节点，取出（或新建）对应的 workInProgress 节点。
 * 第一次还没有 alternate：两棵树互相指。之后复用同一格 wip，只重置 flags。
 */
export function createWorkInProgress(current: Fiber, pendingProps: any): Fiber {
  // ...
}

export interface Fiber {
  /**
   * 双缓冲的另一棵树。
   * current.alternate === workInProgress，commit 后角色对调。
   */
  alternate: Fiber | null;

  /** 要从 DOM 上删掉的子 Fiber 列表。 */
  deletions: Fiber[] | null;
}

/** wip 链表上「刚接好的那一格」。下一个 Hook 接到它的 next。 */
let workInProgressHook: Hook | null = null;

/** current 链表上「正在对齐的那一格」。下一个 Hook 从它的 next 取。 */
let currentHook: Hook | null = null;
```

文件级总述也用 JSDoc，放在 import 之后、第一个声明之前。
要画出这个文件的核心结构（链表头在哪、两套 dispatcher 谁走哪条），不要只写「这个文件实现了 XX」。

```ts
/**
 * 函数组件的 Hook 实现。
 *
 * 每个函数组件 Fiber 用 memoizedState 挂一条单向链表：
 *   fiber.memoizedState → Hook0 → Hook1 → Hook2 → null
 * 组件里第几次调用 useXxx，就对应第几格。没有名字，所以不能写在 if 里。
 *
 * 首次渲染走 mount*（往后接新格）；更新走 update*（顺着 current 链表克隆到 wip）。
 */
```

### 2. 函数体里的单行注释：先写代码

解释某一行在干什么时，用 `//`：

- 能一行说完：写成**同行尾注释**
- 一行写不下：写在**这行代码下面**，不要写在代码前面
- 一行干了两件事（`a = b = hook`）时，**拆开再标**，不要把两步揉进一行尾注释

```ts
current.alternate = wip; // 第一次：两棵树互相指
wip.deletions = null;
// 之后复用同一格 wip，只清副作用，避免每次 setState 都 new 一整棵
```

```ts
// ❌ 单行注释不要挡在语句前面
// 第一次：两棵树互相指
current.alternate = wip;
```

### 3. 重要函数：JSDoc 写步骤总图，函数体逐步标注

调度入口、工作循环、commit 分叉、链表挂接 / 游标移动（如 `mountWorkInProgressHook`）、mount / update 成对路径，都算重要函数。

- 上方 JSDoc：先列出步骤（1. 2. 3.），让人对着源码有一张地图
- 函数体：每一步用行尾或下行 `//` 标清，**编号和 JSDoc 对齐**
- 仍然遵守第 2 条：注释跟在代码后面，不要挡在语句前面
- 连等赋值拆开，让每一步都能单独标

```ts
/**
 * 首次渲染：在当前函数组件的 wip Fiber 上，追加一格新 Hook。
 *
 * 只做四步：
 *   1. new 一个空 Hook（next 还是 null）
 *   2. 这是本组件第一个 Hook → 写成 Fiber.memoizedState（链表头），游标也指过去
 *   3. 前面已经有 Hook → 接到当前游标的 next，再把游标挪到新节点
 *   4. 返回当前这格，给 useState / useEffect 往 memoizedState 里填数据
 *
 * 组件里每调一次 Hook，这里就往后接一格。顺序必须固定，下次更新才对得上。
 */
function mountWorkInProgressHook(): Hook {
  const hook: Hook = {
    memoizedState: null,
    baseQueue: null,
    queue: null,
    next: null,
  }; // 1. 先造一格空的，还没接进链表

  if (workInProgressHook == null) {
    currentlyRenderingFiber!.memoizedState = hook; // 2. Fiber 记住第一个 Hook（链表头）
    workInProgressHook = hook; // 游标指到这一格
  } else {
    workInProgressHook.next = hook; // 3. 上一格的 next 接到新 Hook
    workInProgressHook = hook; // 游标挪到新 Hook
  }
  return workInProgressHook; // 4. 把这一格交给 mountState / mountEffect 去填
}
```

不要写成「这个函数很重要」却不标步骤；也不要只在 JSDoc 里列步骤、函数体里一片空白。

## 改动范围

- 只改当前任务需要的文件。
- 不要顺手重构、不要补 Lane / Suspense 等未要求的能力。
- 用户没要就不要改 README / INTERVIEW.md。
