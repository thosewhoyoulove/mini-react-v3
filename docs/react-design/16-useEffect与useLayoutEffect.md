# 第 16 章：`useEffect` 与 `useLayoutEffect`

[← 返回总目录](../../React设计与实现.md) · [上一章](./15-useState与更新队列.md) · [下一章 →](./17-Scheduler与时间切片.md)

组件函数在 Render 阶段执行，但这时真实 DOM 还没有更新。如果此时就读取布局或建立订阅，读到的是哪一棵树？依赖没变时，React 又怎样跳过副作用，同时保证组件最终删除时仍会清理？本章从一个可预测的例子出发，把 Effect 的登记、依赖比较和 Commit 时间线连起来。

> 源码范围：`packages/react-reconciler/src/hooks.ts`、`packages/react-reconciler/src/commitWork.ts`
>
> 阅读约定：文中的“当前仓库”指这个教学版 mini-react；“官方 React”指 React 的完整实现。两者阶段思想相近，但调度、严格模式与删除清理等细节并不完全相同。

## 本章书签

- [16.1 Render 只登记 Effect，为什么还需要两层标记](#161-render-只登记-effect，为什么还需要两层标记)
- [16.2 deps 如何决定 `HookHasEffect`，bailout 又跳过了什么](#162-deps-如何决定-hookhaseffect，bailout-又跳过了什么)
- [16.3 Commit 的真实时间线，以及 Passive 的保证边界](#163-commit-的真实时间线，以及-passive-的保证边界)
- [面试复习](#面试复习)

---

## 16.1 Render 只登记 Effect，为什么还需要两层标记

先看一个最小例子：

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

首次渲染时，组件函数先返回按钮。两个回调并不会在函数执行到 Hook 那一行时运行；Render 只把它们登记下来。Commit 修改 DOM 后，Layout 回调同步执行，Passive 回调则交给后续任务。

每个 Effect 占用函数组件 Hook 链表中的一格：

```ts
type Effect = {
  tag: number;
  create: () => (() => void) | void;
  destroy: (() => void) | undefined;
  deps: unknown[] | undefined;
};
```

`create` 是用户传入的回调。它执行后的函数返回值会写进 `destroy`，供下一次依赖变化或卸载时清理。`deps` 保存本轮依赖，下一次 Render 再逐项比较。

当前仓库用了两层标记，因为它们回答不同问题：

| 标记位置 | 回答的问题 | `useLayoutEffect` | `useEffect` |
| --- | --- | --- | --- |
| `Fiber.flags` | 这棵子树是否值得进入对应 Commit 遍历 | `Update` | `Passive` |
| `Effect.tag` | Hook 链表中的这一格属于哪类、本轮是否执行 | `HookLayout` | `HookPassive` |

`HookHasEffect` 是第三个 bit，表示“这一格本轮需要执行”。首次挂载时，`mountEffectImpl` 会：

1. 向 Hook 链表追加一格。
2. 在 Fiber 上打 `Update` 或 `Passive`。
3. 把 `tag` 写成 `HookLayout | HookHasEffect` 或 `HookPassive | HookHasEffect`。

于是 Fiber flag 负责粗筛整棵子树，Hook tag 再精确筛选某一格。Render 阶段到这里就结束了，不执行 `create`，也不碰真实 DOM。

## 16.2 deps 如何决定 `HookHasEffect`，bailout 又跳过了什么

把上例的 `count` 从 `0` 更新为 `1`，预期顺序是旧回调先清理，新回调再建立：

```text
layout cleanup 0
layout create 1
passive cleanup 0
passive create 1
```

这里先忽略浏览器绘制，只看依赖判断。`updateEffectImpl` 取得上一轮 Effect，用 `Object.is` 逐项比较新旧 `deps`：

- 长度不同，或任一项不同：认为发生变化。
- 两边长度相同且每项都相同：认为没有变化。
- 没传依赖数组，即 `useEffect(fn)`：每次组件真正 Render 都认为变化。
- 空数组 `[]`：挂载时执行，普通更新时不再执行；卸载仍会清理。

依赖相同时，新 Effect 仍保存 `HookLayout` 或 `HookPassive`，并继承旧 `destroy`，但去掉 `HookHasEffect`，也不在 Fiber 上打本轮 Effect flag。这样更新 Commit 不会执行它，卸载扫描却仍能按类型找到旧 cleanup。

依赖变化时，Fiber 会重新打 flag，Effect 也带上 `HookHasEffect`。Commit 用下面的位运算筛选：

```ts
(effect.tag & hookFlags) === hookFlags
```

更新时传入的是“类型位 + `HookHasEffect`”，所以只有本轮变化的 Effect 能通过。卸载时只传类型位，所以即使最近一次 deps 相同，保存下来的 `destroy` 仍会执行。

还要区分“deps 相同”和“组件 bailout”。当前仓库若确认 Fiber 自己没有对应 Lane、子树没有对应 Lane、props/ref/context 也没有变化，`beginWork` 会 bailout。此时组件函数根本不执行，`renderWithHooks` 和 `updateEffectImpl` 都不会进入，因此也就**没有发生 deps 比较**。旧 Hook 数据随复用的 Fiber 保留下来，本轮不会产生新的 Effect 工作。

这两个场景的结论相同——Effect 不重跑——但原因不同：

```text
组件执行了 + deps 相同  → 比较后去掉 HookHasEffect
组件 bailout            → 组件没执行，根本没有比较 deps
```

这是当前仓库的具体路径，也是理解 React bailout 时应坚持的边界：不能把“没有重跑 Effect”一律解释成“React 比较了依赖”。

## 16.3 Commit 的真实时间线，以及 Passive 的保证边界

当前仓库一次更新的主时间线如下：

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

第一步很容易漏掉：`commitRoot` 在提交新树之前，会同步调用 `flushPassiveEffects()`。如果上一轮已经登记了 Passive，却还没等到它的 Scheduler 回调，新一轮 Commit 不能让两棵树的 Passive 交错，所以先把上一轮的 cleanup 与 create 跑完。

`useLayoutEffect` 的更新 cleanup 位于 Mutation 阶段，create 位于 Layout 阶段。此时 DOM 已经更新，当前 JavaScript 任务还没有结束，因此它适合读取布局并同步修正；代价是其中的耗时工作会继续阻塞浏览器获得绘制机会。

`useEffect` 的更新 cleanup 与 create 都在 `flushPassiveEffects` 中执行，并且全树先 cleanup、再全树 create。当前仓库通过 Scheduler 的 `NormalPriority` 把它安排到 MessageChannel 宏任务。这个机制只保证它不在当前同步 Commit 主体内执行，**不保证浏览器已经完成一次 paint**。宏任务之间浏览器通常有机会渲染，但是否真的绘制由浏览器决定，本实现没有调用任何“确认已绘制”的 API。

删除路径还有一个明确的教学简化。`commitDeletion` 在 Mutation 阶段深度遍历被删除子树，先同步执行其中所有 Layout 和 Passive cleanup，再移除宿主节点。也就是说，当前仓库的“组件删除 cleanup”不进入后续 Passive 宏任务。

官方 React 的总体原则仍是 Render 计算、Commit 执行副作用，Layout 与 Passive 也属于不同阶段；但完整实现还要处理并发根、开发模式的 Effect 检查、Offscreen 等情况，删除树的 Passive 清理路径也更复杂。不要用当前仓库“删除时两类 cleanup 都同步执行”的简化去推断官方所有版本和模式。

## 面试复习

**一句话回答：** Render 把 Effect、deps 和类型登记到 Hook 链表；deps 变化由 `HookHasEffect` 标记。Commit 中 Layout cleanup/create 同步夹在 Mutation 与 Layout 阶段，Passive cleanup/create 由后续 Scheduler 宏任务处理，但宏任务不等于已经 paint。

**为什么需要 Fiber flag 和 Hook tag 两层标记？** Fiber flag 用来跳过没有相关工作的子树；Hook tag 用来区分 Layout、Passive，以及某一格本轮是否因 deps 变化而执行。

**bailout 时会比较 deps 吗？** 不会。当前仓库直接跳过组件函数，因此 Hook 更新逻辑没有运行。只有组件实际 Render 后，`updateEffectImpl` 才比较 deps。

**为什么 `commitRoot` 先 flush 上一轮 Passive？** 为了在提交新树前完成上一棵已提交树的 Passive，避免不同提交的 Effect 生命周期交错。

**`useEffect` 一定在绘制后执行吗？** 不能这样保证。当前仓库只把它放到后续 MessageChannel 宏任务；浏览器可能在任务间绘制，也可能不绘制。

### 源码入口

- `packages/react-reconciler/src/hooks.ts`：`mountEffectImpl`、`updateEffectImpl`
- `packages/react-reconciler/src/hooks.ts`：`commitHookEffectListUnmount`、`commitHookEffectListMount`
- `packages/react-reconciler/src/commitWork.ts`：`commitRoot`、`flushPassiveEffects`
- `packages/react-reconciler/src/commitWork.ts`：`commitMutationEffectsOnFiber`、`commitLayoutEffectsOnFiber`、`commitDeletion`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./15-useState与更新队列.md) · [下一章 →](./17-Scheduler与时间切片.md)
