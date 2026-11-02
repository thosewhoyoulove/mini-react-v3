# 第 16 章：`useEffect` 与 `useLayoutEffect`

[← 返回总目录](../../React设计与实现.md) · [上一章](./15-useState与更新队列.md) · [下一章 →](./17-Scheduler与时间切片.md)

组件函数已经执行，页面上的 DOM 却还没更新。此时 `useLayoutEffect` 和 `useEffect` 里的回调有没有运行？等 `count` 改变后，旧回调又在什么时候清理？要回答这些问题，需要沿着一条 Effect 从 Render 走到 Commit。

> 源码范围：`packages/react-reconciler/src/hooks.ts`、`packages/react-reconciler/src/commitWork.ts`
>
> 这里讨论的是教学版 mini-react。它保留了 Render 登记、Commit 执行以及 Layout / Passive 分阶段等主线。调度、严格模式和删除清理比官方 React 简单。

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

组件函数执行到 Hook 时不会打印日志。Render 只保存回调和依赖，然后返回按钮。等 Commit 改完 DOM，Layout 回调同步运行，Passive 回调留给后续任务。Hook 的调用位置负责登记，真正执行发生在另一个阶段。

每个 Effect 占用 Hook 链表中的一格。这一格的 `memoizedState` 是 Effect 对象，不是 `useState` 那种普通值：

```ts
type Effect = {
  tag: number;
  create: () => (() => void) | void;
  destroy: (() => void) | undefined;
  deps: unknown[] | undefined;
};
```

`create` 就是传给 Hook 的函数。它运行后若返回一个函数，这个返回值写入 `destroy`，留给依赖变化或组件删除时调用。返回的不是函数时，`destroy` 记成 `undefined`。`deps` 记录本轮依赖，供下次 Render 比较。

同一条链表上还有 state、ref 等格子。Commit 先看这一格是否同时带有 `create`、`deps` 和 `tag`，再做位运算。原因是链表不按 Hook 名字分叉。结果是 `useState` 的数字状态会被跳过，只有 Effect 格子进入后面的判断。

数据登记好以后，Commit 还要知道该走进哪一棵子树、停在哪一个 Fiber。这里用两层标记：

| 标记位置 | 回答的问题 | `useLayoutEffect` | `useEffect` |
| --- | --- | --- | --- |
| `Fiber.flags` | 这个 Fiber 自己要不要在 Commit 里停下来 | `Update` | `Passive` |
| `Effect.tag` | 这一格属于哪类 Effect、本轮是否执行 | `HookLayout` | `HookPassive` |

`Fiber.flags` 标在函数组件自己身上。`completeWork` 会把子节点的 `flags` 和 `subtreeFlags` 按位或到父节点的 `subtreeFlags`。Commit 处理一个 Fiber 时，先消费它自己的删除列表，再看 `subtreeFlags` 决定要不要递归孩子，最后看自身的 `flags`。真正让祖先被走进来的，是冒泡后的 `subtreeFlags`。

`useLayoutEffect` 借用的是 `Update` 这一位。宿主节点的属性更新也用它。Mutation 里遇到 `Update` 时，带 Hook 链表的函数组件跑 layout destroy，`HostComponent` / `HostText` 才去改 DOM。`useEffect` 使用单独的 `Passive` 位，避免和 DOM 更新混在同一次同步遍历里。

`HookHasEffect` 也是 `tag` 里的一个 bit，表示这一格本轮需要执行。三个位是：

```text
HookHasEffect = 0b001
HookLayout    = 0b010
HookPassive   = 0b100
```

首次挂载时，`mountEffectImpl` 向 Hook 链表追加 Effect，在 Fiber 上写入 `Update` 或 `Passive`，同时把 Effect 标成 `HookLayout | HookHasEffect` 或 `HookPassive | HookHasEffect`。到这里仍然只是在准备数据。`create` 尚未运行，真实 DOM 也没有被读取或修改。

## 16.2 deps 如何决定 `HookHasEffect`，bailout 又跳过了什么

现在把 `count` 从 `0` 更新为 `1`。先不计入两类 Effect 之间浏览器可能插入的绘制，这个组件上的日志顺序是：

```text
layout cleanup 0
layout create 1
passive cleanup 0
passive create 1
```

这组输出的起点是 `updateEffectImpl`。它拿到上一轮 Effect，用 `Object.is` 逐项比较新旧 `deps`。

```ts
/**
 * 判断这一轮 Effect 是否可以沿用上次的 destroy。
 *
 * 1. 任一侧没有依赖数组，视为发生变化
 * 2. 长度不同，视为发生变化
 * 3. 同一下标上 Object.is 失败，视为发生变化
 * 4. 长度和每一项都相同，才算没变
 */
function areHookInputsEqual(nextDeps, prevDeps) {
  if (prevDeps == null || nextDeps == null) {
    return false; // 1
  }
  if (nextDeps.length !== prevDeps.length) {
    return false; // 2
  }
  for (let i = 0; i < prevDeps.length; i++) {
    if (!Object.is(nextDeps[i], prevDeps[i])) {
      return false; // 3
    }
  }
  return true; // 4
}
```

没有传依赖数组的 `useEffect(fn)`，`deps` 是 `undefined`。比较直接失败，所以组件每次真正 Render 都会带上 `HookHasEffect`。空数组 `[]` 长度相同且没有元素可比较，普通更新不再执行 create。组件删除时仍会调用上次留下的 cleanup。

依赖变化后，Fiber 重新写入对应 flag，Effect 的 tag 也带上 `HookHasEffect`。Commit 通过位运算筛选：

```ts
(effect.tag & hookFlags) === hookFlags
```

更新时，`hookFlags` 同时包含类型位和 `HookHasEffect`。`0b011` 这种 tag 能通过 Layout 更新检查，只有类型位、没有 `HookHasEffect` 的格子会被跳过。删除组件时只传入 `HookLayout` 或 `HookPassive`。只要类型位还在，先前保存的 `destroy` 仍能执行。

依赖没变时，新 Effect 保留类型位，继承旧 `destroy`，去掉 `HookHasEffect`，Fiber 上也不写本轮 Effect flag。更新 Commit 会略过它。删除扫描仍能按类型找到 cleanup。这里省掉的是本轮执行，卸载需要的函数还在。

Effect 没有重跑，还有另一种来源：组件发生 bailout。`beginWork` 的 `canSkipUpdate` 要求 Fiber 自身的 `lanes`、子树的 `childLanes` 都与本轮 `renderLanes` 无交集，props 浅比较相同，ref 相同，context 也没有变化，并且没有 `DidCapture`。全部满足时，`renderWithHooks` 不会进入。

bailout 复制孩子 Fiber，但函数组件自己的 `memoizedState` 仍指向 current 上那条 Hook 链表。`updateEffectImpl` 没有机会比较 deps。

```text
组件执行了 + deps 相同  → 比较后去掉 HookHasEffect，destroy 仍复制到新格子
组件 bailout            → 组件没执行，Hook 链表原样留在 current 上
```

两条路径最后都没有新的 Effect 工作，源码走向不同。看到 Effect 没重跑时，不能据此认为 React 已经比较过依赖。

## 16.3 Commit 的真实时间线，以及 Passive 的保证边界

Effect 登记完毕后，接着沿 `commitRoot` 看它何时执行：

```text
commitRoot
  1. flushPassiveEffects()          上一轮还没跑的 Passive
  2. Before Mutation                教学版为空
  3. Mutation（深度优先，先孩子后自己）
       孩子：修改 / 插入 / 删除 DOM
       自己：函数组件跑 layout cleanup
  4. root.current = finishedWork
  5. Layout（深度优先，先孩子后自己）
       每个 Fiber：先写自己的 ref，再跑自己的 layout create
  6. 若这棵树带 Passive
       Scheduler NormalPriority
       后续宏任务：全树 passive cleanup，再全树 passive create
```

时间线开头先调用 `flushPassiveEffects()`。如果前一次 Commit 已经登记 Passive，新一轮又立刻到来，这一步会先完成旧树的 cleanup 和 create。原因是 Passive 回调是异步的，不先冲掉它，新旧两棵树的 Effect 会交错。

Mutation 不是“先改完全部 DOM，再统一跑 cleanup”的两遍扫描。它是一次深度优先：父 Fiber 先处理 `deletions`，再递归孩子，最后才处理自己的 `Placement` 和 `Update`。所以子按钮的文本会先改完，父组件的 `useLayoutEffect` cleanup 才运行。cleanup 和后面的 create 仍处在同一个 JavaScript 调用栈里。这适合读取布局并立刻修正，耗时操作也会继续占用主线程，浏览器还拿不到绘制机会。

`useEffect` 的更新 cleanup 和 create 都由 `flushPassiveEffects` 处理，而且是整棵已提交树的 cleanup 完成以后，再开始整棵树的 create。嵌套组件因此是“所有 passive cleanup，然后所有 passive create”，和 Layout 那种“孩子 cleanup 紧挨着孩子的 DOM 更新”不一样。

这次 flush 通过 Scheduler 的 `NormalPriority` 安排到后续 MessageChannel 宏任务。`pendingPassiveEffects` 指向刚提交的树。若标记显示已经约过回调，就不会为同一次等待再约一个。这只能说明 Passive 不在同步 Commit 主体中。浏览器在两个任务之间是否真的 paint，仍由宿主决定，因为实现没有等待绘制完成的 API。

组件删除走更直接的路径。`commitDeletion` 先把这棵子树上的 ref 清掉，再深度优先执行 Effect。对每个 Fiber，先跑 Layout destroy，再跑 Passive destroy，然后才走进孩子。全部 cleanup 结束后，才从宿主父节点移除对应 DOM。这里的 Passive 删除清理不会等后续宏任务。官方 React 同样把 Render 计算与 Commit 副作用分开，也区分 Layout 和 Passive。并发根、开发模式检查、Offscreen 以及删除树的 Passive 清理要复杂得多，不能从这个教学简化推断所有版本和模式。

## 本章回顾

- Render 把 Effect、deps 和类型登记到 Hook 链表。`Fiber.flags` 标出这个 Fiber 自己的工作，`subtreeFlags` 让祖先被遍历进来，Effect tag 再筛到具体 Hook。
- `useLayoutEffect` 与宿主更新共用 `Update` 位。Mutation 靠 Fiber 种类决定是改 DOM 还是跑 layout cleanup。
- deps 变化会加入 `HookHasEffect`。deps 相同是比较后的结果。组件 bailout 则连比较都没有进入，Hook 链表仍是 current 上的那一条。
- Layout cleanup 发生在 Mutation 的归路上，create 发生在随后的 Layout 阶段。Passive 由后续宏任务先全树 cleanup、再全树 create。宏任务不代表浏览器已经 paint。
- 教学实现会在删除子树时同步清理两类 Effect。这一点不能外推到官方 React 的全部路径。

### 源码入口

- `packages/react-reconciler/src/hooks.ts`：`mountEffectImpl`、`updateEffectImpl`、`areHookInputsEqual`
- `packages/react-reconciler/src/hooks.ts`：`commitHookEffectListUnmount`、`commitHookEffectListMount`
- `packages/react-reconciler/src/commitWork.ts`：`commitRoot`、`flushPassiveEffects`
- `packages/react-reconciler/src/commitWork.ts`：`commitMutationEffectsOnFiber`、`commitLayoutEffectsOnFiber`、`commitDeletion`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./15-useState与更新队列.md) · [下一章 →](./17-Scheduler与时间切片.md)
