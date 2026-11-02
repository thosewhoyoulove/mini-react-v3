# 第 10 章：子节点 Diff：key 怎样决定复用与移动

[← 返回总目录](../../React设计与实现.md) · [上一章](./09-beginWork按tag分发.md) · [下一章 →](./11-completeWork.md)

---

点击 reverse 之后，新的 children 只是 `[C, B, A]`。框架要认出这三个 `<li>` 还是原来的节点，只是换了顺序。做法分两步：先用 key 和 type 认出同一项，再用旧下标判断谁要移动。Render 阶段只把结果记在 Fiber 上，不改 DOM。

## 10.1 key 和 type 怎样认出同一个节点

`reconcileChildren` 面对的是两种数据。旧 children 已经是一条 Fiber 链表，新 children 可能是文本、一个 Element，或一个数组。

```text
旧：current.child → sibling → sibling
新：nextChildren（文本、Element 或数组）
输出：workInProgress.child → sibling → sibling
```

父 Fiber 没有 `current`，说明这一格是新建的，整段子树按首次挂载处理。这时走 `mountChildFibers`，只建新链，不记录插入和删除。有 `current` 才走 `reconcileChildFibers`。判断的是 `current == null`，不是 `current.child == null`。一个已经挂载、暂时没有孩子的父节点，更新时仍然要给新增孩子打 `Placement`。

两套函数来自同一个 `ChildReconciler`。参数 `shouldTrackSideEffects` 为 false 时不记副作用，为 true 时才记。逻辑一样，避免每个调用再传一遍这个开关。

新 children 只有一个 Element 时，从旧链表头向后找。key 回答「是不是同一项」，type 回答「这一项能不能沿用原来的 Fiber 和 DOM」。

```text
旧：A(key=a) → B(key=b) → C(key=c)
新：B(key=b)
结果：复用 B；A、C 记入父节点的 deletions
```

扫描时三种情况分开处理：

1. key 和 type 都相同：`useFiber` 取出 WIP，换上新 props 和 ref，删掉它后面的兄弟。
2. key 相同但 type 变了，例如 `<div key="x">` 变成 `<span key="x">`：从这一格起把后面的旧兄弟都删掉，停止再找，然后新建。同一层里 key 不该对应两种 type，所以不必继续往后扫。
3. key 不同：把当前这个旧节点记入删除，继续看下一个兄弟。整条链都没有对上，才新建。

`useFiber` 通过 `createWorkInProgress` 拿到 WIP。它会清掉 `index` 和 `sibling`，免得把旧链表的指针带进新链。`return` 再指回这次的父 Fiber。

文本没有 key。新 children 是单段文本时，只要旧链表头是 `HostText` 就复用，并删掉它后面的兄弟。旧链表头不是文本，就删掉全部旧孩子，再新建文本 Fiber。

单 Element 和单文本走 `placeSingleChild`。只有更新路径上真正新建的 Fiber（没有 alternate）才打 `Placement`。复用到的节点已经在文档里，这里不再标记移动。数组里的移动要看旧下标，不走这个函数。

## 10.2 数组为什么先试位置再查 Map

数组仍是「key 定身份、type 定复用」，但不能为每个新节点都从旧链表头重找一遍。`reconcileChildrenArray` 从左到右扫，先做同位置匹配。`updateSlot` 只有 key 对得上才复用；对不上就返回 `null`。返回 `null` 不是丢掉这个新节点，而是告诉第一轮：位置对齐已经失效，剩下的改走 Map。

```text
同位置 key 对得上  → 继续向后
新列表先结束       → 删除剩余旧节点
旧列表先结束       → 创建剩余新节点
中途 key 对不上    → 剩余旧节点放进 Map
```

以旧 `[A, B, C]`、新 `[A, C, B]` 为例，假定 key 分别是 `a`、`b`、`c`。下标 0 的 A 对得上。下标 1 旧的是 B、新的是 C，key 不同，`updateSlot` 返回 `null`，第一轮停住。

```text
剩余旧节点：Map { b → B, c → C }
新 C：命中 c，复用并从 Map 删除
新 B：命中 b，复用并从 Map 删除
Map 为空：没有节点需要删除
```

这条路径先照顾顺序大体不变、只在尾部增删的更新。前面的节点在第一轮就复用完，不必建 Map。中途错位之后，稳定 key 仍能找回原来的 Fiber 和 DOM。

同位置 key 相同、type 变了，并不进入 Map。`updateElement` 会新建一格，第一轮发现新 Fiber 没有 alternate，立刻 `deleteChild` 旧节点，然后继续看下一个下标。

没写 key 时，第一轮把两边的 `null` 当成同一个 key。type 又相同的话，位置匹配会一直成功，根本进不了 Map。中间插入就会把后面的旧节点错认成新位置上的项：

```text
旧：[A, B, C]          都没有 key
新：[A, X, B, C]       都没有 key，type 相同
下标 0：复用 A
下标 1：复用 B，但 props 换成了 X
下标 2：复用 C，但 props 换成了 B
旧列表结束，再新建一个 C
```

B 的 state、输入焦点会跟着下标走，看起来像是「插进了一项」，其实是旧 Fiber 被重复使用。Map 只在第一轮已经失败之后才参与。没有 key 的旧节点在 Map 里用 `index` 当键，有 key 的用 key。所以 key 要在同一层里稳定且唯一，不需要在整棵应用里全局唯一。

`null`、`false` 和未知类型不会变成 Fiber。它们如果出现在第一轮，`updateSlot` 同样返回 `null`，位置匹配在这里停住，这个下标不分配节点。后面的新节点改到 Map 里找。因此 Fiber 的 `index` 可能不连续，它记的是新数组里的下标，不是「第几个 Fiber」。

旧节点的 `index` 大于当前新下标时，当作旧列表里的空洞：上一轮这个位置没有 Fiber（比如 children 里曾经有 `null`）。这一格先不消耗那个旧节点。本轮如果没匹配上，再把它交还给后面的 Map。如果这个空洞位置自己生成了新 Fiber，旧节点就留到下一个下标继续比。

复用成功的旧节点会从 Map 删除。type 对不上时，`updateElement` 新建，旧 Fiber 留在 Map 里。扫描结束后，Map 里剩下的就是新列表不再需要的节点，进入父 Fiber 的 `deletions`。

## 10.3 `lastPlacedIndex` 怎样标记移动

复用只说明「还是这个节点」，没有说明它要不要移动。`placeChild` 维护一个 `lastPlacedIndex`：已经按新顺序处理过、并且可以留在原位的旧节点里，最大的旧下标。

回到 `[A, B, C] → [A, C, B]`，旧下标分别是 0、1、2：

1. A 的旧下标是 0，不小于当前边界，留在原位。边界变成 0。
2. C 的旧下标是 2，仍不小于 0，也留下。边界推进到 2。
3. B 的旧下标是 1，已经小于 2。新顺序又要求 B 位于 C 之后，所以 B 打上 `Placement`。边界保持 2，不退回去。

这里的 `Placement` 表示 Commit 时要重新插入或移动。Render 不操作 DOM。

整段倒序 `[A, B, C] → [C, B, A]` 时，C 的旧下标 2 先成为边界。B 和 A 的旧下标都小于 2，两个都带 `Placement`。稳定 key 保住了三个 DOM 的身份，却不保证只移动一次。这套从左到右的一遍扫描也不追求全局最少移动。

新建节点没有 alternate，同样打 `Placement`，但是不更新 `lastPlacedIndex`。它本来不在旧列表里，不能成为「已经就地留下」的边界。比如 `[A, B] → [A, X, B]`：A 留下，边界仍是 0；X 是新建，打 `Placement`，边界不变；B 的旧下标 1 不小于 0，继续留下。结果只有 X 需要插入。

删除的记法不同。被删节点自己不打标。父 Fiber 把它放进 `deletions`，并带上 `ChildDeletion`。到 Commit，这些记录才改变宿主树。

## 本章回顾

子节点 Diff 先用 key 和 type 决定能否复用，再用 `lastPlacedIndex` 判断复用节点是否要移动。没有 key 时，第一轮会把同一位置当成同一项，列表中间的插入和重排容易让状态跟错 Fiber。算法只记录 `Placement` 和 `ChildDeletion`，不在 Render 阶段操作 DOM，也不保证移动次数最少。

继续阅读时，可以沿 `packages/react-reconciler/src/childFiber.ts` 的 `ChildReconciler`、`reconcileChildrenArray`、`placeChild` 往下看。`tests/run.ts` 里有带 key 的复用、移动和删除案例。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./09-beginWork按tag分发.md) · [下一章 →](./11-completeWork.md)
