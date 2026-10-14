# 第 11 章：`completeWork` 为什么必须自底向上

[← 返回总目录](../../React设计与实现.md) · [上一章](./10-子节点Diff.md) · [下一章 →](./12-Commit三阶段.md)

---

`beginWork` 已经接出 child 链，为什么还要再从叶子往上走一遍？因为父 DOM 要装入已经创建好的子 DOM，父 Fiber 也要汇总孩子的 flags。`completeWork` 正是 Render 的向上半程。

## 本章书签

- [11.1 为什么孩子要先完成](#111-为什么孩子要先完成)
- [11.2 首次创建与更新走两条路径](#112-首次创建与更新走两条路径)
- [11.3 flags 和 lanes 怎样向上汇总](#113-flags-和-lanes-怎样向上汇总)
- [面试复习](#面试复习)

---

## 11.1 为什么孩子要先完成

看一棵最小宿主树：

```text
div
└── span
    └── "hello"
```

向上 complete 的顺序是 Text → span → div：

1. HostText 调 `createTextInstance('hello')`；
2. span 调 `createInstance('span')`，再把 Text append 到 span；
3. div 调 `createInstance('div')`，再把已经组装好的 span append 到 div。

这些 parent 都是刚创建、尚未进入文档的离屏节点。直到 Commit 处理 `Placement`，最外层宿主子树才插进 `#root` 或已挂载的父 DOM。

中间若隔着函数组件，`appendAllChildren` 会继续向下寻找最近的宿主子孙：

```text
div（正在 complete）
└── Wrapper（没有 stateNode）
    ├── span（Host）
    └── "tail"（HostText）
```

它会把 span 和 `"tail"` append 到 div。遇到 span 后不会再钻进 span 内部，因为 span 的后代已经在 span complete 时组装好了。否则同一个文本会被重复挂到更高层。

## 11.2 首次创建与更新走两条路径

HostComponent 的分叉是：

```text
已有 current 和 stateNode
  → 复用实例，比较旧 props 与新 props
  → 除 children 外有变化，flags |= Update

没有可复用实例
  → createInstance(type, pendingProps)
  → appendAllChildren(instance, workInProgress)
  → stateNode = instance
```

children 不在 `propsNeedUpdate` 中比较，因为孩子的插入、移动和删除已经由第 10 章的 Diff 处理。HostText 更新则直接比较旧字符串与新字符串；不同就打 `Update`，相同就复用 Text。

更新路径不会重新 `appendAllChildren`。旧 DOM 结构仍在，孩子的变化已经表现为 `Placement` 和 `ChildDeletion`。`completeWork` 只为已有 Host 节点补上必要的 `Update`。

函数组件、Fragment、Memo、ForwardRef、Suspense 和 HostRoot 没有要创建的宿主实例，只做收尾与信息汇总。ContextProvider 还会在这里 `popProvider`，恢复外层 context。

这套分工需要和 Commit 分开记：

```text
completeWork     创建离屏实例、组装离屏子树、标记已有实例需要更新
commitPlacement  把顶层宿主节点插进已挂载的宿主树
commitWork       修改已挂载实例的属性或文本
```

## 11.3 flags 和 lanes 怎样向上汇总

每个分支结束前都会调用 `bubbleProperties`。它顺着直接孩子做三件事：

```ts
subtreeFlags |= child.subtreeFlags | child.flags;
childLanes |= child.lanes | child.childLanes;
child.return = completedWork;
```

假设只有文本变了：

```text
HostRoot  subtreeFlags = Update
└── App   subtreeFlags = Update
    └── p subtreeFlags = Update
        └── Text flags = Update
```

flags 描述本轮 Commit 要执行的具体工作；lanes 描述节点和子树还携带哪些优先级工作。两者都向上汇总，但含义不同。Commit 用 `subtreeFlags` 剪枝，下一轮 `beginWork` 用 `lanes / childLanes` 判断能否 bailout。

当前仓库已经实现 bailout。props、ref、context 都没变，并且自己与子树都没有本轮 lane 时，`beginWork` 可以不再执行函数组件。因此不能把这套实现概括成「每轮必然走完每个节点」。即便某个分支被复用，祖先仍需要可靠的 flags 和 lanes 汇总来决定后续路径。

下一章进入 Commit：把这棵已经 complete 的 WIP 树变成用户真正看到的宿主结果。

## 面试复习

### 一句话结论

`completeWork` 等孩子完成后再创建或复用宿主实例、组装离屏子树，并把 flags 与 lanes 汇总给祖先。

### 常见追问

**`createInstance` 后节点已经上屏了吗？**

没有。它只在离屏宿主子树中，真正进入已挂载树要等 `commitPlacement`。

**`appendAllChildren` 为什么要跨过函数组件？**

函数组件没有 `stateNode`，Fiber 父子关系与宿主父子关系并不总是一一对应。

**lanes 和 flags 有什么区别？**

lanes 表示更新优先级和待处理范围；flags 表示这次 Commit 要执行的具体副作用。

### 源码入口

- `packages/react-reconciler/src/completeWork.ts`：`completeWork`。
- `packages/react-reconciler/src/completeWork.ts`：`appendAllChildren`。
- `packages/react-reconciler/src/completeWork.ts`：`bubbleProperties`。
- `packages/react-reconciler/src/commitWork.ts`：`commitPlacement`、`commitWork`。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./10-子节点Diff.md) · [下一章 →](./12-Commit三阶段.md)
