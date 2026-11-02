# 第 11 章：`completeWork` 为什么必须自底向上

[← 返回总目录](../../React设计与实现.md) · [上一章](./10-子节点Diff.md) · [下一章 →](./12-Commit三阶段.md)

---

`beginWork` 已经接出 child 链。还要再从叶子往上走一遍，是因为父 DOM 要装入已经创建好的子 DOM，父 Fiber 也要汇总孩子的 flags。`completeWork` 是 Render 的向上半程。它会创建离屏节点，但不会改已经出现在页面上的 DOM。

## 11.1 为什么孩子要先完成

先看一棵最小宿主树：

```text
div
└── span
    └── "hello"
```

`beginWork` 按 div → span → Text 向下走。Text 没有孩子，`completeUnitOfWork` 开始收尾：先 `completeWork` 当前节点；有 sibling 就转去 sibling；没有才回到父节点。完成顺序因此反过来：

```text
Text：createTextInstance("hello")
  ↓
span：createInstance("span")，append Text
  ↓
div：createInstance("div")，append 已经组装好的 span
```

孩子必须先完成。`appendAllChildren` 只能把已经有 `stateNode` 的宿主节点装进父实例。这些实例这时都在离屏子树里，还没有进入文档。等 Commit 处理最外层的 `Placement`，它们才插进 `#root` 或已经挂载的父 DOM。

Fiber 层级和 DOM 层级经常不一致。中间可以隔着函数组件：

```text
div（正在 complete）
└── Wrapper（没有 stateNode）
    ├── span（Host）
    └── "tail"（HostText）
```

`appendAllChildren` 从 `workInProgress.child` 往下走。遇到没有 `stateNode` 的 Wrapper，就继续找它的 child，直到 span 和 `"tail"`。这两个才是要装进 div 的顶层宿主后代。

遇到 span 之后不再进入 span 的子树。span 的后代在 span 自己 complete 时已经装好了。再挂一次，会把同一个节点重复插到更高层。函数组件这样被跨过去，宿主节点则整棵算作一个已经完成的单位。

## 11.2 首次创建与更新走两条路径

自底向上的顺序不变。同一个 `HostComponent` 在挂载和更新时做的事不同。`completeWork` 看它是否同时有 `current` 和 `stateNode`：

```text
已有 current 和 stateNode
  → 复用宿主实例
  → 比较旧 props 与新 props，有变化则 flags |= Update

没有可复用实例
  → createInstance(type, pendingProps)
  → appendAllChildren(instance, workInProgress)
  → stateNode = instance
```

挂载路径创建实例，并把已经完成的宿主后代装进去。更新路径不再调用 `appendAllChildren`。旧 DOM 结构还在；孩子的插入、移动和删除已经变成 `Placement` 和 `ChildDeletion`。如果这时再 append 一遍，Render 就会去碰已经上屏的树。更新路径只比较自己的属性，真正改 DOM 留给 Commit。

`propsNeedUpdate` 跳过 `children`。孩子由子 Fiber 负责，不能因为 children 不同就给父宿主打 `Update`。例如 div 的 `className` 从 `a` 变成 `b`，比较用 `Object.is`，div 带上 `Update`。div 里面的文本从 `hello` 变成 `world`，变化记在 HostText 上，不记在 div 的 props 更新里。某一侧多了一个属性、或少了一个属性，也会算作需要更新。

`HostText` 不逐项比较 props。它的 `pendingProps` 就是字符串，用 `!==` 和旧的 `memoizedProps` 比较。变了就打 `Update`，没变就继续用原来的 Text 实例。

函数组件、Fragment、Memo、ForwardRef、Suspense 和 HostRoot 没有宿主实例要创建，只做后面的汇总。`ContextProvider` 在汇总之前先 `popProvider`。

push 发生在 begin：进入 Provider 时写上新值，子树里的 `useContext` 读到它。pop 发生在 complete：这棵子树已经全部 begin 过，值可以恢复成外层。下一个兄弟再 begin 时，读到的是外层值。顺序靠深度优先保证，所以 pop 不能提前到 begin 返回的时候。

把调用链接起来，Render 和 Commit 的边界是：

```text
completeWork     创建离屏实例、组装离屏子树、标记已有实例需要更新
commitPlacement  把顶层宿主节点插进已挂载的宿主树
commitWork       修改已挂载实例的属性或文本
```

## 11.3 flags 和 lanes 怎样向上汇总

节点做完自己的工作后调用 `bubbleProperties`。它只遍历直接孩子。整棵子树的信息仍能到达父节点，因为每个孩子在此之前已经汇总过自己的孩子：

```ts
subtreeFlags |= child.subtreeFlags | child.flags;
childLanes |= child.lanes | child.childLanes;
child.return = completedWork;
```

`subtreeFlags` 用按位或累加，不覆盖父节点身上已经有的标记。第 7 章用文本更新走过这条冒泡。这里还有两项：`childLanes` 把后代还没处理的优先级带到父节点，下一轮 `beginWork` 靠它判断子树有没有工作；`child.return = completedWork` 把父指针修正到本轮 WIP。`createWorkInProgress` 会把 `return` 先置空，Diff 或 bailout 之后要重新指回这一轮的父节点，后面向上找宿主父节点才不会走到另一棵树。

flags 和 lanes 回答的不是同一个问题。flags 说明本轮 Commit 要做哪些副作用。`lanes` / `childLanes` 说明节点和子树还带着哪些优先级的更新。props、ref、context 都没变，自己和子树也没有本轮 lane 时，`beginWork` 可以 bailout，不必每次都执行函数组件。

## 本章回顾

`completeWork` 等孩子完成后再运行。挂载时，父宿主实例才能装入已经组装好的宿主后代；更新时，它复用实例，只在自身属性或文本变化时标记 `Update`。每个节点收尾时把 flags 和 lanes 逐层汇总，分别给 Commit 剪枝和下一轮 Render 判断工作范围。`createInstance` 得到的仍是离屏实例，上屏要等 `commitPlacement`。

对应实现在 `packages/react-reconciler/src/completeWork.ts` 的 `completeWork`、`appendAllChildren` 和 `bubbleProperties`。真正插入和修改宿主节点的代码在 `commitWork.ts`。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./10-子节点Diff.md) · [下一章 →](./12-Commit三阶段.md)
