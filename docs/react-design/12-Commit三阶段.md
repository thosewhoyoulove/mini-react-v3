# 第 12 章：Commit：把计划变成用户看到的结果

[← 返回总目录](../../React设计与实现.md) · [上一章](./11-completeWork.md) · [下一章 →](./13-函数组件的执行时机.md)

---

Render 结束时，DOM 还没有完全变成新界面，Effect 也没有执行。Commit 必须把删除、插入、更新、ref 和 Effect 排成一个不会互相打架的顺序。本章先看总时间线，再分别进入 Mutation 与 Effect。

## 12.1 `commitRoot` 为什么按这个顺序执行

沿用一个同时修改文本和 Effect 依赖的组件。Render 已经在 WIP 树上留下 `Update`、`Passive` 等 flags，`commitRoot` 接手后按下面的时间线消费它们：

```text
flushPassiveEffects()        冲刷上一轮尚未执行的 Passive
Before Mutation              教学版为空
Mutation                     删除、插入、更新 DOM；layout destroy
root.current = finishedWork  新树成为 current
Layout                       写 ref；layout create
发现 Passive                 预约后续 Scheduler 任务
```

开头先冲刷上一轮 pending Passive，是为了防止旧树的 Effect 与这次提交交错。Before Mutation 在官方 React 中还会处理 snapshot、选区等工作；当前仓库没有这些能力，只保留了阶段位置。

Mutation 完成时，已挂载 DOM 已经对应 `finishedWork`。此时再执行 `root.current = finishedWork`，接下来的 Layout Effect 无论读取 DOM 还是触发更新，看到的都是新树。若过早切换，current 会短暂领先于 DOM；若等 Layout 之后才切换，Layout 又会从旧树发起工作。

Mutation、切换 current 和 Layout 在同一轮同步调用中连续完成，不做时间切片。Passive 不进入这段同步主流程；Commit 只记住 `finishedWork`，再预约一个 Scheduler 任务。

## 12.2 Mutation 怎样落实删除插入和更新

进入 Mutation 后，`commitMutationEffectsOnFiber` 先处理当前父 Fiber 的 `deletions`，再递归带有 `MutationMask` 的子树，最后消费当前 Fiber 的 `Placement` 和 `Update`。因此一个列表更新可能沿着这样的调用链落到 DOM：

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

删除路径先把对象 ref 写成 `null`，或以 `null` 调用函数 ref；随后深度优先执行 Layout 与 Passive cleanup，最后从最近的宿主父节点移除顶层宿主节点。当前仓库把卸载时两类 Hook cleanup 都放在 Mutation 同步执行，这是教学实现的简化，不能外推为所有官方 React 版本的精确时机。

`Placement` 既可能来自新建，也可能来自列表移动。`commitPlacement` 先向上找到最近的 `HostComponent` 或 `HostRoot`，再向右寻找第一个已经挂载且不带 `Placement` 的宿主兄弟。找到它就调用 `insertBefore`，找不到就追加到末尾。带 `Placement` 的兄弟自身还没稳定，不能作为插入锚点。

```text
找到稳定兄弟 → insertBefore
找不到       → appendChild
```

如果带 `Placement` 的 Fiber 是函数组件，它没有可插入的 `stateNode`。提交过程会继续向下，插入它覆盖的顶层宿主子孙。

同一个列表项可能既移动又修改属性或文字，因此 `Placement` 和 `Update` 用两个独立的 `if` 消费，不能写成互斥分支。`HostComponent` 的 `Update` 调用 `commitUpdate`，`HostText` 调用 `commitTextUpdate`；带 Hook 链表的函数类 Fiber 则在这里执行本轮 `useLayoutEffect` 的 destroy。

## 12.3 Layout 与 Passive 为什么分开

Mutation 改完 DOM、current 切到新树后，Layout 紧接着处理 ref 和 `useLayoutEffect`：

```text
Ref     → commitAttachRef
Update  → 函数组件的 useLayoutEffect create
```

因此 `LayoutMask` 是 `Update | Ref`，不只有 `Update`。宿主 Fiber 的 `Update` 已在 Mutation 完成，Layout 遇到它不会重复修改 DOM。此时仍处于同一轮同步 JavaScript 中，Layout Effect 可以读取刚更新的 DOM；相应地，过重的 Layout 工作也会推迟浏览器获得绘制机会。

Passive Effect 则通过 Scheduler 另约任务：

```ts
pendingPassiveEffects = finishedWork;
unstable_scheduleCallback(NormalPriority, flushPassiveEffects);
```

`flushPassiveEffects` 先遍历已提交树执行本轮 Passive destroy，再遍历执行 create。这个任务边界给浏览器留下了绘制机会，但当前实现没有检测浏览器是否已经 paint，不能保证回调开始前一定完成了绘制。如果下一次 Commit 更早到来，它会在开头同步冲刷上一轮 pending Passive，避免两轮 Effect 交错。

现在可以预测开头那个组件的执行顺序。依赖从 0 变成 1，同时文字发生更新时：

```text
Mutation：更新文字；layout cleanup 0
Layout：  layout create 1
后续任务：passive cleanup 0 → passive create 1
```

## 本章回顾

Commit 的关键时序是 Mutation 修改宿主树、切换 `root.current`、Layout 读取新 DOM，最后再由后续任务处理 Passive。列表删除会先清 ref 和 Effect 再移除 DOM；`Placement` 通过稳定宿主兄弟选择 `insertBefore` 或追加；同一个 Fiber 的移动和更新可以在一次 Mutation 中同时发生。

整条时间线都在 `packages/react-reconciler/src/commitWork.ts`。如果想从行为反查顺序，可以再看 `tests/run.ts` 中 Layout / Passive 更新与卸载的测试。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./11-completeWork.md) · [下一章 →](./13-函数组件的执行时机.md)
