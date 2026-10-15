# 第 11 章：`completeWork` 为什么必须自底向上

[← 返回总目录](../../React设计与实现.md) · [上一章](./10-子节点Diff.md) · [下一章 →](./12-Commit三阶段.md)

---

`beginWork` 已经接出 child 链，为什么还要再从叶子往上走一遍？因为父 DOM 要装入已经创建好的子 DOM，父 Fiber 也要汇总孩子的 flags。`completeWork` 正是 Render 的向上半程。

## 11.1 为什么孩子要先完成

先看一棵最小宿主树：

```text
div
└── span
    └── "hello"
```

`beginWork` 按 div → span → Text 向下走。Text 没有孩子后，`completeUnitOfWork` 开始收尾：先调用当前节点的 `completeWork`；如果有 sibling，就转去处理 sibling；没有 sibling，才回到父节点继续 complete。因此上面这棵树的完成顺序恰好反过来：

```text
Text：createTextInstance("hello")
  ↓
span：createInstance("span")，append Text
  ↓
div：createInstance("div")，append 已经组装好的 span
```

孩子必须先完成，因为 `appendAllChildren` 只能把已经存在的宿主实例装入父实例。这些实例此时都在离屏子树中，还没有进入文档；等 Commit 处理 `Placement`，最外层宿主节点才会插进 `#root` 或已挂载的父 DOM。

Fiber 层级与 DOM 层级并不总是一致。假如中间隔着一个函数组件：

```text
div（正在 complete）
└── Wrapper（没有 stateNode）
    ├── span（Host）
    └── "tail"（HostText）
```

`appendAllChildren` 遇到没有 `stateNode` 的 Wrapper 会继续向下，找到 span 和 `"tail"`，把这两个顶层宿主后代装入 div。遇到 span 后则不会再进入它的子树，因为 span 的后代早已在 span 自己 complete 时组装完毕。这样既能跨过函数组件，又不会把同一个后代重复挂到更高层。

## 11.2 首次创建与更新走两条路径

自底向上的顺序不变，但同一个 `HostComponent` 在首次挂载和更新时做的事情不同。`completeWork` 先看它是否同时拥有 `current` 和 `stateNode`：

```text
已有 current 和 stateNode
  → 复用宿主实例
  → 比较旧 props 与新 props，有变化则 flags |= Update

没有可复用实例
  → createInstance(type, pendingProps)
  → appendAllChildren(instance, workInProgress)
  → stateNode = instance
```

挂载路径创建实例并装好孩子。更新路径不会再次调用 `appendAllChildren`，因为旧 DOM 结构已经存在；孩子的插入、移动和删除也已经由子节点 Diff 变成了 `Placement` 和 `ChildDeletion`。因此更新路径只比较自身属性，并把真正的修改留给 Commit。

`propsNeedUpdate` 特意跳过 `children`，就是为了守住这条分工。其余 props 只要有一项不满足 `Object.is`，Host Fiber 就会带上 `Update`。`HostText` 不需要逐项比较 props，只比较旧字符串和新字符串；文本变化时打 `Update`，不变时继续复用原来的 Text 实例。

函数组件、Fragment、Memo、ForwardRef、Suspense 和 HostRoot 没有宿主实例可创建，只需完成信息汇总。`ContextProvider` 还会在子树完成后调用 `popProvider`，让外层节点重新读取外层 context。

把这段调用链连起来看，Render 与 Commit 的边界就很清楚：

```text
completeWork     创建离屏实例、组装离屏子树、标记已有实例需要更新
commitPlacement  把顶层宿主节点插进已挂载的宿主树
commitWork       修改已挂载实例的属性或文本
```

## 11.3 flags 和 lanes 怎样向上汇总

节点完成自身工作后，还要调用 `bubbleProperties`。它只遍历直接孩子，却能把整棵子树的信息带到父节点，因为每个孩子在此之前已经完成了同样的汇总：

```ts
subtreeFlags |= child.subtreeFlags | child.flags;
childLanes |= child.lanes | child.childLanes;
child.return = completedWork;
```

第 7 章已经用文本更新走过 `subtreeFlags` 的冒泡过程。这里多出的两项同样重要：`childLanes` 把后代尚未处理的优先级工作带到父节点，`child.return = completedWork` 则修正双缓冲复用后的父指针，确保后续向上寻找宿主父节点时沿着本轮 WIP 树。

lanes 也在这里向上合并，但它与 flags 回答不同的问题：flags 说明本轮 Commit 要执行哪些具体副作用，`lanes / childLanes` 说明节点和子树还携带哪些优先级工作。当前仓库已经实现 bailout；当 props、ref、context 都没有变化，并且自己与子树都没有本轮 lane 时，`beginWork` 可以跳过这一分支，而不是每轮必然执行每个函数组件。

## 本章回顾

`completeWork` 必须等孩子完成后再运行：挂载时，父宿主实例才能装入已经组装好的宿主后代；更新时，它复用实例并标记必要的 `Update`。每个节点收尾时还会把 flags 与 lanes 逐层汇总，分别服务于 Commit 剪枝和后续 Render 的工作范围判断。`createInstance` 得到的仍是离屏实例，真正上屏要等 `commitPlacement`。

对应实现集中在 `packages/react-reconciler/src/completeWork.ts` 的 `completeWork`、`appendAllChildren` 与 `bubbleProperties`；真正插入和更新宿主节点的代码位于 `commitWork.ts`。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./10-子节点Diff.md) · [下一章 →](./12-Commit三阶段.md)
