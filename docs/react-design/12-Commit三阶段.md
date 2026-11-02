# 第 12 章：Commit：把计划变成用户看到的结果

[← 返回总目录](../../React设计与实现.md) · [上一章](./11-completeWork.md) · [下一章 →](./13-函数组件的执行时机.md)

---

Render 结束时，页面上的 DOM 还没完全变成新界面，Effect 也还没执行。Commit 要把删除、插入、更新、ref 和 Effect 排成一个固定顺序。这一段不再做时间切片。本章先看总时间线，再分别看 Mutation 和 Effect。

## 12.1 `commitRoot` 为什么按这个顺序执行

沿用一个同时改了文本和 Effect 依赖的组件。Render 已经在 WIP 树上留下 `Update`、`Passive` 等 flags。`commitRoot` 按下面的顺序消费它们：

```text
flushPassiveEffects()        冲刷上一轮还没执行的 Passive
Before Mutation              教学版为空
Mutation                     删除、插入、更新 DOM；layout destroy
root.current = finishedWork  新树成为 current
Layout                       写 ref；layout create
发现 Passive                 预约后续 Scheduler 任务
```

开头先冲刷上一轮的 `pendingPassiveEffects`，是为了不让旧树的 Effect 和这次提交交错。下一轮 Commit 如果来得更早，也是在这里同步冲掉上一轮，而不是等那个 Scheduler 回调。

Before Mutation 在官方 React 里还会做 `getSnapshotBeforeUpdate`、保存选区。当前仓库没有这些能力，函数体是空的，只把阶段留在这个位置。

Mutation 完成时，已挂载 DOM 已经对应 `finishedWork`。这时再执行 `root.current = finishedWork`。后面的 Layout Effect 无论读 DOM，还是再触发更新，看到的都是新树。切得太早，current 会暂时领先于 DOM。拖到 Layout 之后才切，Layout 里发起的工作又会从旧树出发。

Mutation、切换 current、Layout 在同一次同步调用里做完，中间不问 `shouldYield`。本轮的 Passive 通常不在这段流程中执行：Commit 先记住 `finishedWork`，再约一个 Scheduler 的 `NormalPriority` 任务。下一次 Commit 如果来得更早，会在开头同步冲刷上一轮等待中的 Passive，再为新树预约。因此，Passive 可以延后，也可能在下一次提交的调用栈里执行。

## 12.2 Mutation 怎样落实删除插入和更新

`commitMutationEffectsOnFiber` 对每个 Fiber 按固定四步走：先处理这个父节点的 `deletions`，再递归带有 `MutationMask` 的子树，然后才消费自己的 `Placement` 和 `Update`。子节点因此先于父节点落地。`subtreeFlags & MutationMask` 为 0 的子树直接跨过。

一个列表更新会落到这些调用上：

```text
父 Fiber.deletions
  → commitDeletion
  → detachRefs
  → unmountEffects
  → removeChild

子 Fiber.Placement
  → commitPlacement
  → getHostParentFiber + getHostSibling
  → insertBefore 或 appendChild

子 Fiber.Update
  → commitWork
  → commitUpdate 或 commitTextUpdate
```

删除先做，是为了后面插入时，锚点已经是留下来的节点。`detachRefs` 把这棵被删子树上的对象 ref 写成 `null`，函数 ref 则以 `null` 调用。没有 `Ref` 标记的旧节点也清，因为卸载时不能只看这一轮新打的 flag。接着深度优先执行 Layout 和 Passive 的 destroy。最后从最近的宿主父节点移除顶层宿主节点。删除一个 HostComponent 时，浏览器会把它的 DOM 后代一起拿走；函数组件没有 `stateNode`，就继续向下找 Host。

当前仓库把卸载时两类 Hook cleanup 都放在 Mutation 里同步执行。这是教学实现的简化，不能当成官方 React 每个版本的精确时机。

`Placement` 可能来自新建，也可能来自列表移动。`commitPlacement` 先向上找到最近的 `HostComponent` 或 `HostRoot`。根容器用 `containerInfo`，调用 `insertInContainerBefore` / `appendChildToContainer`。普通元素用父 DOM，调用 `insertBefore` / `appendChild`。

插到哪里，靠右边第一个已经稳定的宿主兄弟。`getHostSibling` 向右找。兄弟自己还带着 `Placement`，就整棵跳过，因为它马上也要移动，不能当锚点。找到不带 `Placement` 的 Host 实例，就 `insertBefore`。找不到就追加到末尾。

倒序 `[A, B, C] → [C, B, A]` 可以看清这个规则。第 10 章里，C 的旧下标最大，可以留在原位；B 和 A 都带 `Placement`。页面上原来是 `A B C`。提交时先处理 C，它不动。再到 B：右边的 A 也带着 `Placement`，不能当作插入点，于是把 B 追加到末尾，顺序变成 `A C B`。最后 A 同样没有稳定的右兄弟，再追加到末尾，得到 `C B A`。

带 `Placement` 的 Fiber 如果是函数组件，就没有可插入的 `stateNode`。提交会继续向下，插入它下面的顶层宿主子孙。第 9 章首次挂载时，App 上的那一个 `Placement` 就是这样把已经组装好的 div 插进容器的。

同一个列表项可以既移动又改属性。`Placement` 和 `Update` 用两个独立的 `if`，不能写成互斥分支。处理完插入后，代码会清掉 `Placement` 这一位，避免下次提交再插一次。`Update` 不在这里清除。

`HostComponent` 的 `Update` 调用 `commitUpdate`，`HostText` 调用 `commitTextUpdate`。函数组件、Memo、ForwardRef 带着 `Update`，表示本轮 `useLayoutEffect` 的依赖变了，Mutation 里先跑 destroy。宿主节点的 `Update` 走 DOM 更新，不会进这条 Hook 路径。

## 12.3 Layout 与 Passive 为什么分开

Mutation 改完 DOM、`current` 切到新树之后，Layout 紧接着处理 ref 和 `useLayoutEffect` 的 create：

```text
Ref     → commitAttachRef
Update  → 函数组件的 useLayoutEffect create
```

`LayoutMask` 是 `Update | Ref`。宿主 Fiber 的 `Update` 已在 Mutation 里改过 DOM。Layout 只有 `hasHookList` 的 Fiber 才会用 `Update` 去跑 effect，所以不会把属性再写一遍。

`commitAttachRef` 先看 ref 身份变了没有。变了就先把旧 ref 清成 `null`。新 ref 是函数，就直接调用；是对象，就写 `current`。HostComponent 和 HostText 写进去的是 `stateNode`，也就是 DOM。函数组件和 Memo 写进去的是 Fiber 自己。

这时仍是同一轮同步 JavaScript，浏览器还没有绘制。Layout Effect 可以读到刚更新的 DOM。过重的 Layout 工作也会推迟这次绘制。

deps 没变的 effect 不会走到这里。更新时如果依赖逐项 `Object.is` 都相同，Hook 上的 tag 只保留 Layout 或 Passive，不带 `HookHasEffect`，Fiber 也不打 `Update` / `Passive`。destroy 仍留在 Hook 上，等卸载时再跑。

Passive Effect 另约任务：

```ts
pendingPassiveEffects = finishedWork;
unstable_scheduleCallback(NormalPriority, flushPassiveEffects);
```

`flushPassiveEffects` 先对整棵已提交树做 Passive destroy，再对整棵树做 create。先全部清理、再全部创建，是为了不让某个新 effect 跑在另一个组件的旧 cleanup 前面。这个任务边界给浏览器留下了绘制机会。当前实现没有检查浏览器是否已经 paint，不能保证回调开始前一定画完。下一次 Commit 如果更早到来，会在开头同步冲刷这份 pending，避免两轮 Effect 交错。

依赖从 0 变成 1，同时文字也变了，顺序可以预测成：

```text
Mutation：先更新子树里的文字，再跑父组件的 layout cleanup 0
Layout：  layout create 1
后续任务：passive cleanup 0 → passive create 1
```

文字在子节点上，Mutation 先递归孩子，所以文本先于父组件的 layout destroy。Passive 的 cleanup 和 create 分属两次整树遍历，都在这次同步 Commit 之后。

## 本章回顾

Commit 先在 Mutation 里修改宿主树，再切换 `root.current`，然后 Layout 读取新 DOM。Passive 交给后续任务。列表删除会先清 ref 和 Effect，再移除 DOM。`Placement` 用右边第一个不带 `Placement` 的宿主兄弟决定 `insertBefore` 还是追加。同一个 Fiber 的移动和更新可以在一次 Mutation 里都发生。

整条时间线在 `packages/react-reconciler/src/commitWork.ts`。`tests/run.ts` 里有 Layout、Passive 的更新和卸载测试，可以用来对照这条顺序。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./11-completeWork.md) · [下一章 →](./13-函数组件的执行时机.md)
