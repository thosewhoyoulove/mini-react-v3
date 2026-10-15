# 第 16 章：`useEffect` 与 `useLayoutEffect`

[← 返回总目录](../../React设计与实现.md) · [上一章](./15-useState与更新队列.md) · [下一章 →](./17-Scheduler与时间切片.md)

组件函数已经执行，页面上的 DOM 却还没更新。此时 `useLayoutEffect` 和 `useEffect` 里的回调有没有运行？等 `count` 改变后，旧回调又在什么时候清理？要回答这些问题，需要沿着一条 Effect 从 Render 走到 Commit。

> 源码范围：`packages/react-reconciler/src/hooks.ts`、`packages/react-reconciler/src/commitWork.ts`
>
> 这里讨论的是教学版 mini-react。它保留了 Render 登记、Commit 执行以及 Layout / Passive 分阶段等主线，调度、严格模式和删除清理则比官方 React 简单。

## 16.1 Render 只登记 Effect，为什么还需要两层标记

下面的组件同时使用两种 Effect。假设首次传入 `count = 0`，随后更新为 `count = 1`：

```tsx
function Counter({ count }: { count: number }) {
  useLayoutEffect(() => {
    console.log('layout create', count);
    return () => console.log('layout cleanup', count);
  }, [count]);

  useEffect(() => {
    console.log('passive create', count);
    return () => console.log('passive cleanup', count);
  }, [count]);

  return <button>{count}</button>;
}
```

组件函数执行到 Hook 时不会打印日志。Render 只保存回调及其依赖，随后返回按钮；等 Commit 修改完 DOM，Layout 回调同步运行，Passive 回调留给后续任务。Hook 的调用位置负责登记，真正执行发生在另一个阶段。

每个 Effect 占用 Hook 链表中的一格，其中保存四项数据：

```ts
type Effect = {
  tag: number;
  create: () => (() => void) | void;
  destroy: (() => void) | undefined;
  deps: unknown[] | undefined;
};
```

`create` 就是传给 Hook 的函数。它运行后若返回一个函数，这个返回值会写入 `destroy`，留给依赖变化或组件删除时调用。`deps` 记录本轮依赖，供下次 Render 比较。

数据登记好以后，Commit 还要快速找到它。这里用两层标记缩小查找范围：

| 标记位置 | 回答的问题 | `useLayoutEffect` | `useEffect` |
| --- | --- | --- | --- |
| `Fiber.flags` | 这棵子树是否值得进入对应 Commit 遍历 | `Update` | `Passive` |
| `Effect.tag` | 这一格属于哪类 Effect、本轮是否执行 | `HookLayout` | `HookPassive` |

`Fiber.flags` 负责子树级的粗筛，`Effect.tag` 再定位到 Hook 链表中的具体一格。`HookHasEffect` 也是 `tag` 中的一个 bit，表示这格 Effect 本轮需要执行。

首次挂载时，`mountEffectImpl` 向 Hook 链表追加 Effect，在 Fiber 上写入 `Update` 或 `Passive`，同时把 Effect 标成 `HookLayout | HookHasEffect` 或 `HookPassive | HookHasEffect`。到这里仍然只是在准备数据，`create` 尚未运行，真实 DOM 也没有被读取或修改。

## 16.2 deps 如何决定 `HookHasEffect`，bailout 又跳过了什么

现在把 `count` 从 `0` 更新为 `1`。忽略两类 Effect 之间可能发生的浏览器绘制，日志顺序是：

```text
layout cleanup 0
layout create 1
passive cleanup 0
passive create 1
```

这组输出的起点是 `updateEffectImpl`。它拿到上一轮 Effect，用 `Object.is` 逐项比较新旧 `deps`。数组长度不同或任一项不同，都算依赖变化；长度和每一项都相同，才会复用。没有传依赖数组的 `useEffect(fn)` 在组件每次真正 Render 时都会标记为变化；空数组 `[]` 只在挂载时执行 create，普通更新不再执行，组件删除时仍会 cleanup。

依赖变化后，Fiber 会重新写入对应 flag，Effect 也带上 `HookHasEffect`。Commit 通过位运算筛选：

```ts
(effect.tag & hookFlags) === hookFlags
```

更新时，`hookFlags` 同时包含类型位和 `HookHasEffect`，只有本轮变化的 Effect 能通过。删除组件时只按类型位查找，于是先前保存的 `destroy` 仍能执行。

依赖没变时，新 Effect 保留 `HookLayout` 或 `HookPassive`，也继承旧 `destroy`，只是去掉 `HookHasEffect`，Fiber 上也不写本轮 Effect flag。更新 Commit 会略过它，删除扫描仍能依类型找到 cleanup。这里既省掉了本轮执行，又没有丢掉将来卸载所需的数据。

Effect 没有重跑，还有另一种来源：组件发生 bailout。当 Fiber 自身和子树都没有对应 Lane，props、ref、context 也没有变化时，`beginWork` 可以直接复用已有结果。组件函数、`renderWithHooks` 和 `updateEffectImpl` 都不会进入，deps 自然也没有比较。

```text
组件执行了 + deps 相同  → 比较后去掉 HookHasEffect
组件 bailout            → 组件没执行，根本没有比较 deps
```

两条路径最后都没有新的 Effect 工作，但源码走向不同。看到 Effect 没重跑时，不应一概认为 React 已经比较过依赖。

## 16.3 Commit 的真实时间线，以及 Passive 的保证边界

Effect 登记完毕后，接着沿 Commit 时间线看它何时执行：

```text
commitRoot
  1. flushPassiveEffects()          清掉上一轮尚未执行的 Passive
  2. Before Mutation                教学版为空
  3. Mutation
       修改 / 插入 / 删除 DOM
       layout cleanup（deps 变化）
  4. root.current = finishedWork
  5. Layout
       layout create（deps 变化）
  6. Scheduler NormalPriority
       后续 MessageChannel 宏任务
       全树 passive cleanup
       全树 passive create
```

时间线开头先调用 `flushPassiveEffects()`，处理上一轮尚未执行的 Passive。如果前一次 Commit 已经登记 Passive，新一轮又立刻到来，这一步会先完成旧树的 cleanup 和 create，避免两个提交的生命周期交错。

`useLayoutEffect` 的更新 cleanup 在 Mutation 阶段执行，create 则在 DOM 更新后的 Layout 阶段执行。两者仍处于同一个 JavaScript 任务中，适合读取布局并立即修正，但耗时操作也会继续占用主线程，推迟浏览器获得绘制机会。

`useEffect` 的更新 cleanup 和 create 都由 `flushPassiveEffects` 处理，而且是全树 cleanup 完成后，再开始全树 create。它通过 Scheduler 的 `NormalPriority` 安排到后续 MessageChannel 宏任务。这只能说明 Passive 不在同步 Commit 主体中；浏览器在两个任务之间是否真的 paint，仍由宿主决定，因为实现没有等待绘制完成的 API。

组件删除走的是更直接的路径。`commitDeletion` 在 Mutation 阶段深度遍历待删除子树，同步执行其中所有 Layout 和 Passive cleanup，然后移除宿主节点。这里的 Passive 删除清理不会等后续宏任务。官方 React 同样把 Render 计算与 Commit 副作用分开，也区分 Layout 和 Passive；并发根、开发模式检查、Offscreen 以及删除树的 Passive 清理要复杂得多，不能从这个教学简化推断所有版本和模式。

## 本章回顾

- Render 把 Effect、deps 和类型登记到 Hook 链表；Fiber flag 粗筛子树，Effect tag 再筛到具体 Hook。
- deps 变化会加入 `HookHasEffect`。deps 相同是比较后的结果，组件 bailout 则根本没有进入比较。
- Layout cleanup/create 分别落在 Mutation 和 Layout 阶段；Passive 全树先 cleanup、再 create，由后续 Scheduler 宏任务处理，但宏任务不代表浏览器已经 paint。
- 教学实现会在删除子树时同步清理两类 Effect，这一点不宜外推到官方 React 的全部路径。

### 源码入口

- `packages/react-reconciler/src/hooks.ts`：`mountEffectImpl`、`updateEffectImpl`
- `packages/react-reconciler/src/hooks.ts`：`commitHookEffectListUnmount`、`commitHookEffectListMount`
- `packages/react-reconciler/src/commitWork.ts`：`commitRoot`、`flushPassiveEffects`
- `packages/react-reconciler/src/commitWork.ts`：`commitMutationEffectsOnFiber`、`commitLayoutEffectsOnFiber`、`commitDeletion`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./15-useState与更新队列.md) · [下一章 →](./17-Scheduler与时间切片.md)
