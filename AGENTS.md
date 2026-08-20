# AGENTS.md

教学用 mini-react。改代码时优先保证「对着源码能讲清」，而不是追平官方实现。

## 注释

分两层，不要混用。

### 1. 函数、字段、类型、导出常量：JSDoc 写在上方

需要讲清「是什么 / 为什么」时，用 `/** ... */` 放在声明正上方，可以多行。
这是给阅读源码用的，宁可写透，不要压成一行尾注释。

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
}
```

### 2. 函数体里的单行注释：先写代码

解释某一行在干什么时，用 `//`：

- 能一行说完：写成**同行尾注释**
- 一行写不下：写在**这行代码下面**，不要写在代码前面

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

文件级总述（这个文件是干什么的）也用 JSDoc，放在 import 之后、第一个声明之前。

### 3. 重要函数：JSDoc 写步骤总图，函数体逐步标注

调度入口、工作循环、commit 分叉这类函数（例如 `ensureRootIsScheduled`），不要只写一句「这个函数很重要」。

- 上方 JSDoc：先列出步骤（1. 2. 3.），让人对着源码有一张地图
- 函数体：每个关键分支用行尾或下行 `//` 标清「这一步在干什么 / 为什么」
- 仍然遵守第 2 条：注释跟在代码后面，不要挡在语句前面

```ts
/**
 * 根上唯一的调度入口：有更新之后，要不要约工作、约哪一种。
 *
 * 只做四步：
 *   1. pending 空了 → 取消还没执行的回调
 *   2. 已经约过同一档 Lane → 直接返回（多次 setState 合并成一次）
 *   3. 档位变了 → cancel 旧回调
 *   4. 按最高 Lane 新约一次：Sync → 微任务，Default → Scheduler 宏任务
 */
function ensureRootIsScheduled(root: FiberRoot): void {
  const nextLanes = getNextLanes(root);
  // 只拿当前最高档。pending 同时有 Sync|Default 时这里是 Sync

  if (existingCallbackNode != null && root.callbackPriority === newCallbackPriority) {
    return; // 已约同档：连点三次 setState 只保留一个回调
  }
}
```

## 改动范围

- 只改当前任务需要的文件。
- 不要顺手重构、不要补 Lane / Suspense 等未要求的能力。
- 用户没要就不要改 README / INTERVIEW.md。
