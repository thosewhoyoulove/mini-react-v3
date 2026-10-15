# 第 10 章：子节点 Diff：key 怎样决定复用与移动

[← 返回总目录](../../React设计与实现.md) · [上一章](./09-beginWork按tag分发.md) · [下一章 →](./11-completeWork.md)

---

点击 reverse 后，新的 children 只是 `[C, B, A]`。框架怎样知道这三个 `<li>` 是原来的节点换了顺序，而不是三个全新节点？答案分两步：先用 key 和 type 认出同一项，再用旧下标判断谁需要移动。

## 10.1 key 和 type 怎样认出同一个节点

`reconcileChildren` 面对的是两种不同形态的数据：旧 children 已经是一条 Fiber 链表，新 children 则可能是文本、一个 Element，也可能是数组。

```text
旧：current.child → sibling → sibling
新：nextChildren（文本、Element 或数组）
输出：workInProgress.child → sibling → sibling
```

父 Fiber 没有 `current`，说明整段子树正在首次挂载。此时走 `mountChildFibers`，只建立新链，不记录插入和删除；有 `current` 才走 `reconcileChildFibers`，把新 children 与 `current.child` 比较并留下 flags。这里判断的是 `current == null`，不是 `current.child == null`：一个已经挂载但暂时没有孩子的父节点，更新时仍然要记录新增孩子的 `Placement`。

先看新 children 只有一个 Element 的情况。算法沿旧兄弟链查找，只有 `key` 和 `type` 都相同才会复用：

```text
旧：A(key=a) → B(key=b) → C(key=c)
新：B(key=b)
结果：复用 B；A、C 记入父节点的 deletions
```

`key` 回答「是不是同一项」，`type` 回答「这一项能不能沿用原来的实现」。例如 `<div key="x">` 变成 `<span key="x">`，身份标记虽然没变，宿主类型却变了，原来的 DOM 不能复用。匹配成功后，`useFiber` 通过 `createWorkInProgress` 取得对应的 WIP Fiber，换上新 props，并重新接入本轮的 sibling 链。

文本没有 key。新 children 是单段文本时，只要旧链表头也是 `HostText` 就复用；否则删除旧孩子并创建文本 Fiber。无论是单 Element 还是单文本，只有在 update 路径中确实创建了新 Fiber，`placeSingleChild` 才会打上 `Placement`。

## 10.2 数组为什么先试位置再查 Map

数组仍然沿用「key 定身份、type 定复用」这条规则，只是不能为每个新节点都从旧链表头重新查找。`reconcileChildrenArray` 从左到右扫描，先走成本最低的同位置匹配：

```text
同位置 key 对得上  → 继续向后
新列表先结束       → 删除剩余旧节点
旧列表先结束       → 创建剩余新节点
中途 key 对不上    → 剩余旧节点放进 Map
```

以旧 `[A, B, C]`、新 `[A, C, B]` 为例，A 在下标 0 直接复用；走到下标 1，旧 B 与新 C 的 key 不同，同位置匹配到此结束。剩余过程如下：

```text
剩余旧节点：Map { b → B, c → C }
新 C：命中 c，复用并从 Map 删除
新 B：命中 b，复用并从 Map 删除
Map 为空：没有节点需要删除
```

这条路径既照顾了顺序大体不变、只在尾部增删的常见更新，也能在失配后借助稳定 key 找回原来的 Fiber 和 DOM。复用成功的旧节点会从 Map 删除；扫描结束后，Map 中剩下的节点就是新列表不再需要的节点，它们会进入父 Fiber 的 `deletions`。

新 children 中的 `null`、`false` 和未知类型会被跳过，Fiber 的 `index` 因而可能不连续。第一轮遇到 `oldFiber.index > newIdx` 时，会把这一格视为旧列表中的空洞，并保留 `oldFiber` 给后续匹配，而不是误以为这个旧节点已经被消费。

如果没有 key，Map 只能改用 index。尾部追加通常不受影响，但在中间插入、删除或倒序时，「同位置」很容易被当成「同一项」，组件状态、焦点和输入内容也可能跟着位置走。因此 key 要在同一层中稳定且唯一，不需要在整棵应用树里全局唯一。

## 10.3 `lastPlacedIndex` 怎样标记移动

复用只是确认「还是这个节点」，并没有回答它要不要移动。回到 `[A, B, C] → [A, C, B]`，`placeChild` 会维护一个 `lastPlacedIndex`：

> `lastPlacedIndex`：已经按新顺序处理过、并可留在原位的旧节点中，最大的旧下标。

新顺序先处理 A。A 的旧下标是 0，可以留在原位，`lastPlacedIndex` 变成 0。接着是 C，它的旧下标 2 不小于 0，也可以留下，于是边界推进到 2。最后处理 B，它的旧下标 1 已经落在边界后面；新顺序又要求 B 位于 C 之后，所以 B 会得到 `Placement`。

这里的 `Placement` 只表示「Commit 时重新插入或移动」，Render 不会立刻操作 DOM。整段倒序 `[A, B, C] → [C, B, A]` 时，C 的旧下标 2 先成为边界，随后 B 和 A 的旧下标都小于 2，因此二者都会带上 `Placement`。稳定 key 能保住三个 DOM 的身份，却不保证只移动一次；这套从左到右的 O(n) 算法也不追求全局最少移动。

新建 Fiber 没有 `alternate`，同样会得到 `Placement`。删除的记录方式不同：被删节点本身不打标，父 Fiber 把它收入 `deletions[]`，并带上 `ChildDeletion`。到 Commit 阶段，这些记录才会真正改变宿主树。

## 本章回顾

子节点 Diff 先用 key 和 type 决定能否复用，再用 `lastPlacedIndex` 判断复用节点是否需要移动。没有 key 时仍可按 index 匹配，但列表中间的增删和重排容易让状态跟错位置。算法只记录 `Placement`、`ChildDeletion` 等结果，不在 Render 阶段操作 DOM，也不保证得到全局最少移动次数。

继续阅读时，可以沿 `packages/react-reconciler/src/childFiber.ts` 的 `ChildReconciler → reconcileChildrenArray → placeChild` 追踪整段算法；`tests/run.ts` 里还有 keyed Diff 的复用、移动和删除案例。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./09-beginWork按tag分发.md) · [下一章 →](./11-completeWork.md)
