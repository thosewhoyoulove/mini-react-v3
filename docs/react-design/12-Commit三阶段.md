# 第 12 章：Commit：Mutation / Layout / Passive

[← 返回总目录](../../React设计与实现.md) · [上一章](./11-completeWork.md) · [下一章 →](./13-函数组件的执行时机.md)

> 主文件：`packages/react-reconciler/src/commitWork.ts`
> Render 结束：按阶段提交副作用。Mutation 与 Layout 同步、不可中断；Passive 另排后续 Scheduler 任务，不保证任务执行前浏览器已经绘制。

## 本章书签

- [12.1 Mutation](#121-mutation)
- [12.2 切换 `root.current`](#122-切换-rootcurrent)
- [12.3 Layout](#123-layout)
- [12.4 Passive](#124-passive)
- [面试复习](#面试复习)

---

`commitRoot` 只做五步，顺序不能乱：

```text
1. flushPassiveEffects()     上一轮还没跑的 useEffect 先清掉
2. Before Mutation           教学版空（官方：getSnapshotBeforeUpdate）
3. Mutation                  删 / 插 / 改 DOM；layout destroy
4. root.current = finishedWork，然后 Layout：layout create
5. 有 Passive → 后续 Scheduler 宏任务再 flush
```

切换 current **夹在** Mutation 和 Layout 之间：DOM 已经是新的，但 `useLayoutEffect` 里读到的 `root.current` 也必须是新树。Passive 排到后续任务，为浏览器留下绘制机会，但本仓库没有“保证已经绘制”的浏览器阶段检测。

## 12.1 Mutation

`commitMutationEffectsOnFiber` 深度优先，只认 `MutationMask`（Placement | Update | ChildDeletion）。四步：

1. **有 `deletions`**：先 `unmountEffects`（函数组件上两种 effect 的 destroy），再从最近宿主父节点 `removeChild`。
2. **子树带 MutationMask**：先处理孩子。
3. **自己有 Placement**：找宿主父节点和「下一个已挂载的宿主兄弟」，`insertBefore` 或 `appendChild`。函数组件没有 DOM，会往下把它的宿主子孙插进去。
4. **自己有 Update**：Host → `commitUpdate` / `commitTextUpdate`；函数组件 → `useLayoutEffect` 的 **destroy**（create 留到 Layout）。

Placement 和 Update 用两个独立的 `if`，不能 `else`。列表里一个节点可以既移动又改文本。

删除为什么必须先做：后面插入需要正确的兄弟锚点；先插再删容易把还要留下来的节点摘掉。

`getHostSibling` 会跳过同样带 Placement 的兄弟——它们自己还没进文档，不能当 `insertBefore` 的参照。

## 12.2 切换 `root.current`

```ts
commitMutationEffectsOnFiber(finishedWork);
root.current = finishedWork;
commitLayoutEffectsOnFiber(finishedWork);
```

这是双缓冲的交接点。Mutation 之后 DOM 已与 `finishedWork` 对齐；把 `root.current` 指过去，屏幕上那棵和内存里「已提交」的那棵重新重合。

若先切 current 再 Mutation：中途出错或读到的树会和 DOM 不一致。若 Layout 之后再切：`useLayoutEffect` 里若再 `setState`，标 lane 时可能标到旧树上。官方顺序是 Mutation → 切根 → Layout，本仓库对齐。

切完之后，刚才的 current 变成新的 `alternate`，下次 `createWorkInProgress` 复用它。

## 12.3 Layout

DOM 已改、浏览器**还没画**（仍在同一轮同步 JS 里）。`commitLayoutEffectsOnFiber`：

1. 子树带 `LayoutMask`（即 `Update`）→ 先递归孩子。
2. 自己是函数组件且带 `Update` → 跑 `HookLayout | HookHasEffect` 的 **create**。

Host 节点的 `Update` 只在 Mutation 里改 DOM，这里看到会因 tag 不是函数组件而跳过。

`useLayoutEffect` 适合「画之前量一下 DOM / 同步改样式」。它会推迟首次绘制，所以能用 `useEffect` 就不要用它。第 16 章对照两条时间线。

## 12.4 Passive

`useEffect` 不应堵住当前同步 Commit。`commitRoot` 只记下这棵树，再约一次 Scheduler 宏任务：

```ts
if (hasPassiveEffects) {
  pendingPassiveEffects = finishedWork;
  unstable_scheduleCallback(NormalPriority, () => {
    flushPassiveEffects();
  });
}
```

`flushPassiveEffects`：先全树 Passive **destroy**，再全树 **create**。同一轮里所有旧 effect 先清完，再跑新的，避免交错。宏任务边界让浏览器有机会先绘制，但不能把它说成“必定已经绘制”：浏览器可以按自己的事件循环时机安排渲染，而且下一次 `commitRoot` 还会主动同步冲刷尚未执行的 Passive。

下一次 `commitRoot` 开头会再 `flushPassiveEffects` 一次：若上一轮约过、还没执行（例如 Sync 紧接着又 commit），先清掉，避免和新树交错。

卸载特例：节点被删时，本仓库在 Mutation 的 `unmountEffects` 里把 Layout / Passive 的 destroy **一起跑完**，不把 Passive 留到绘制后。教学上少一条「已删除 Fiber 还要再扫一遍」的路径。

下一章回到函数组件：它在哪一次调用里变成「子树描述」，以及这和 Hook 规则的关系。

## 面试复习

### 一句话结论

Commit 是同步且不可中断的落地阶段：本仓库按 Before Mutation（空实现）→ Mutation → 切换 `root.current` → Layout 执行，Passive 再由 Scheduler 延后；删除子树时则教学化地把 Layout / Passive cleanup 都提前到 Mutation。

### 面试回答（为什么→机制→仓库落点→官方差异）

为什么：Render 只计算 Fiber 和 flags，DOM 更新与 effect 必须按可观察顺序一次提交，不能让用户看到半棵新树。机制：Mutation 先删、插、改 DOM，并执行更新场景的 layout destroy；随后切换 current，Layout 同步执行 layout create；Passive 在宏任务中先全树 destroy、再全树 create。仓库落点：`commitRoot` 编排阶段，`commitMutationEffectsOnFiber`、`commitLayoutEffectsOnFiber`、`flushPassiveEffects` 分别执行。官方差异：官方 Before Mutation、生命周期、选区恢复和删除后的 Passive 清理更完整；本仓库 Before Mutation 为空，卸载时两类 Hook cleanup 都在 Mutation 同步执行。

### 常见追问

**Q：为什么 `root.current` 必须夹在 Mutation 和 Layout 之间？**
A：此时 DOM 已对应新树，Layout effect 也应从已提交的新 Fiber 发起同步更新；过早会让 current 与 DOM 暂时不一致，过晚会让 Layout 读到旧树。

**Q：Passive 是否属于同步 Commit 主流程？**
A：它由 Commit 检出并预约，但 create / 更新 cleanup 实际在之后的 Scheduler 宏任务中执行；下一次 Commit 开头还会先冲刷尚未执行的 Passive。

**Q：删除节点时 `useEffect` cleanup 也会等宏任务吗？**
A：本仓库不会。`unmountEffects` 在 Mutation 中同步遍历被删子树，同时执行 Layout 与 Passive destroy，这是明确的教学简化。

### 容易说错

- 不要把三个阶段说成「Mutation / Layout / Passive 都同步连续执行」；Passive 被延后。
- 不要说 Mutation 只改 DOM；函数组件更新时的 `useLayoutEffect` destroy 也在这里。
- 不要把本仓库卸载 cleanup 的时机当成官方完整行为。

### 源码入口

- `packages/react-reconciler/src/commitWork.ts`：`commitRoot`
- `packages/react-reconciler/src/commitWork.ts`：`commitMutationEffectsOnFiber`、`commitLayoutEffectsOnFiber`
- `packages/react-reconciler/src/commitWork.ts`：`flushPassiveEffects`、`unmountEffects`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./11-completeWork.md) · [下一章 →](./13-函数组件的执行时机.md)
