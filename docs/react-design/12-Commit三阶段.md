# 第 12 章：Commit：把计划变成用户看到的结果

[← 返回总目录](../../React设计与实现.md) · [上一章](./11-completeWork.md) · [下一章 →](./13-函数组件的执行时机.md)

---

Render 结束时，DOM 还没有完全变成新界面，Effect 也没有执行。Commit 必须把删除、插入、更新、ref 和 Effect 排成一个不会互相打架的顺序。本章先看总时间线，再分别进入 Mutation 与 Effect。

## 本章书签

- [12.1 commitRoot 为什么按这个顺序执行](#121-commitroot-为什么按这个顺序执行)
- [12.2 Mutation 怎样落实删除插入和更新](#122-mutation-怎样落实删除插入和更新)
- [12.3 Layout 与 Passive 为什么分开](#123-layout-与-passive-为什么分开)
- [面试复习](#面试复习)

---

## 12.1 `commitRoot` 为什么按这个顺序执行

当前仓库的提交顺序是：

```text
1. flushPassiveEffects()       先处理上一轮仍未执行的 Passive
2. Before Mutation             教学版为空
3. Mutation                    删、插、改 DOM；layout destroy
4. root.current = finishedWork
5. Layout                      写 ref；layout create
6. 发现 Passive                预约后续 Scheduler 任务
```

Before Mutation 在官方 React 中还会处理 snapshot、选区等工作，本仓库只保留阶段位置。

`root.current` 必须夹在 Mutation 与 Layout 之间。Mutation 完成后，已挂载 DOM 已对应 `finishedWork`；切换 current 后，Layout Effect 中读取或触发更新时，使用的也是新树。太早切换会让 current 暂时领先于 DOM，太晚切换又会让 Layout 从旧树发起工作。

Mutation 与 Layout 在同一轮同步调用中连续执行，不做时间切片。Passive 不在这段同步主流程中执行；它由 Commit 发现并预约。

## 12.2 Mutation 怎样落实删除插入和更新

`commitMutationEffectsOnFiber` 对每个 Fiber 按这个顺序处理：

1. 当前父 Fiber 有 `deletions`，先提交删除；
2. 子树与 `MutationMask` 有交集，先递归孩子；
3. 当前 Fiber 有 `Placement`，插入或移动；
4. 当前 Fiber 有 `Update`，更新宿主，或执行 layout destroy。

删除一棵旧子树时，实际顺序是：

```text
detachRefs → unmountEffects → removeChild
```

先把对象 ref 写成 `null` 或调用函数 ref，再执行 Layout 与 Passive cleanup，最后从最近的宿主父节点删除顶层宿主节点。当前仓库把卸载时两类 Hook cleanup 都放在 Mutation 同步执行，这是教学简化，不应外推成所有官方版本的精确时机。

`Placement` 既表示新建，也表示移动。`commitPlacement` 先向上找到最近 HostComponent 或 HostRoot，再向右寻找第一个已经挂载且不带 `Placement` 的宿主兄弟：

```text
找到稳定兄弟 → insertBefore
找不到       → appendChild
```

带 `Placement` 的兄弟自己还没稳定，不能作为锚点。当前 Fiber 若是函数组件，提交过程会继续向下，把它覆盖的顶层宿主子孙插进去。

`Placement` 和 `Update` 必须用两个独立 `if`。同一个列表项可能既移动又改文字。HostComponent 的 `Update` 调 `commitUpdate`，HostText 调 `commitTextUpdate`；带 Hook 链表的函数类 Fiber 则在 Mutation 执行本轮 `useLayoutEffect` 的 destroy。

## 12.3 Layout 与 Passive 为什么分开

Mutation 结束、current 切换后，Layout 处理两类工作：

```text
Ref     → commitAttachRef
Update  → 函数组件的 useLayoutEffect create
```

所以 `LayoutMask` 是 `Update | Ref`，不是只有 `Update`。宿主 Fiber 的 `Update` 已在 Mutation 修改 DOM；Layout 遇到它时不会重复更新。此时仍在同一轮同步 JavaScript 中，Layout Effect 可以读取刚改完的 DOM，但也会推迟浏览器获得下一次绘制机会。

Passive Effect 通过 Scheduler 另约任务：

```ts
pendingPassiveEffects = finishedWork;
unstable_scheduleCallback(NormalPriority, flushPassiveEffects);
```

flush 时先遍历整棵树执行本轮 Passive destroy，再遍历执行 create。宏任务边界给浏览器留下绘制机会，但不保证回调开始前浏览器一定完成了绘制。若下一次 Commit 先到，`commitRoot` 开头会同步冲刷上一轮 pending Passive，避免两轮 Effect 交错。

用 Effect 实验可以预测顺序。依赖从 0 变成 1 时：

```text
Mutation：layout cleanup 0
Layout：  layout create 1
后续任务：passive cleanup 0
          passive create 1
```

删除整棵组件是前面提到的特例：当前教学实现会在 Mutation 中同步执行 layout 与 passive cleanup。

下一章回到函数组件，解释它怎样在 `renderWithHooks` 中建立 Hook 链。

## 面试复习

### 一句话结论

Commit 先在 Mutation 修改宿主树，再切换 current 并执行 Layout；Passive 只在本轮登记，通常由后续 Scheduler 任务执行。

### 常见追问

**为什么 current 要在 Mutation 与 Layout 之间切换？**

这时 DOM 已是新的，Layout 也应从新树读取和发起更新，内存中的已提交树才能重新与宿主结果一致。

**`useEffect` 是否保证浏览器已经绘制？**

本仓库只保证它被排到后续 Scheduler 任务，不实现浏览器绘制检测，因此不能承诺一定已经 paint。

**删除时 Passive cleanup 也会延后吗？**

当前教学仓库不会。删除路径在 Mutation 同步清理两类 Effect，这是明确的简化边界。

### 源码入口

- `packages/react-reconciler/src/commitWork.ts`：`commitRoot`。
- `packages/react-reconciler/src/commitWork.ts`：`commitMutationEffectsOnFiber`。
- `packages/react-reconciler/src/commitWork.ts`：`commitLayoutEffectsOnFiber`。
- `packages/react-reconciler/src/commitWork.ts`：`flushPassiveEffects`。
- `tests/run.ts`：Layout / Passive 的更新与卸载顺序测试。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./11-completeWork.md) · [下一章 →](./13-函数组件的执行时机.md)
