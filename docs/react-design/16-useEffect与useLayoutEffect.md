# 第 16 章：`useEffect` 与 `useLayoutEffect`

[← 返回总目录](../../React设计与实现.md) · [上一章](./15-useState与更新队列.md) · [下一章 →](./17-Scheduler与时间切片.md)

> 主文件：`packages/react-reconciler/src/hooks.ts`、`commitWork.ts`
> 两种 effect 共用 Hook 链表，靠 tag 的 bit 区分阶段：后续任务（Passive）还是绘制前同步（Layout）。

## 本章书签

- [16.1 Effect 挂在哪](#161-effect-挂在哪)
- [16.2 deps 没变与变了](#162-deps-没变与变了)
- [16.3 Passive vs Layout](#163-passive-vs-layout)
- [面试复习](#面试复习)

---

## 16.1 Effect 挂在哪

`useEffect` / `useLayoutEffect` 也占 Hook 链表上的一格，但 `memoizedState` 不是普通值，而是：

```ts
type Effect = {
  tag: number;       // HookHasEffect | HookLayout | HookPassive
  create: () => (() => void) | void;
  destroy: (() => void) | undefined;
  deps: unknown[] | undefined;
};
```

同时在 **Fiber.flags** 上打位，Commit 才知道这棵子树要不要进对应阶段：

| API | Fiber flag | Hook tag |
| --- | --- | --- |
| `useEffect` | `Passive`（2048） | `HookPassive`（0b100） |
| `useLayoutEffect` | `Update`（4） | `HookLayout`（0b010） |

`HookHasEffect`（0b001）表示**本轮要执行** create / destroy。deps 没变时只保留 Layout / Passive 类型位，不带 `HookHasEffect`，Commit 用 mask 过滤就会跳过；卸载时只传类型位，没变过的也要跑 destroy。

demo 里：

```ts
useEffect(() => {
  document.title = 'count: ' + count;
  return () => {
    document.title = 'Mini React';
  };
}, [count]);
```

`create` 的返回值在 mount 之后存成 `destroy`，下次 deps 变化或卸载时先跑它。

## 16.2 deps 没变与变了

比较用 `Object.is` 逐项比，长度不同或任一项不同就算变。`deps` 是 `undefined`（没传）或对方是 `null`，一律当成变了——每次更新都跑。

**mount**（`mountEffectImpl`）：

1. 追加一格 Hook。
2. Fiber 或上对应 flag。
3. `tag = hookFlags | HookHasEffect`，本轮一定跑。`destroy` 还是 `undefined`。

**update**（`updateEffectImpl`）：

1. 取出上一轮 Effect。
2. deps 都相同 → 新对象只带类型位，**接着用旧 destroy**，不打 Fiber flags。
3. deps 变了 → Fiber 打 flags，`tag` 带上 `HookHasEffect`，`destroy` 仍先挂着旧的，等 Commit unmount 再跑。

Commit 扫链表时：`(effect.tag & hookFlags) === hookFlags` 才处理。更新传 `HookPassive | HookHasEffect`，没变的格子对不上，自然跳过。

没有 deps 数组（`useEffect(fn)`）每次都走「变了」；空数组 `[]` 只在 mount 跑 create，卸载跑 destroy——和官方一致。

## 16.3 Passive vs Layout

时间线对着第 12 章：

```text
Mutation
  Host 改 DOM
  useLayoutEffect destroy          ← 旧 layout 先清
切 current
Layout（同步，浏览器未绘制）
  useLayoutEffect create           ← 能读到新 DOM
浏览器有机会绘制
宏任务 flushPassiveEffects
  全树 useEffect destroy
  全树 useEffect create            ← 不挡住当前同步 Commit
```

| | `useLayoutEffect` | `useEffect` |
| --- | --- | --- |
| 何时 create | Mutation 之后、绘制之前 | 后续 Scheduler 宏任务；通常给绘制让路，但不保证已经绘制 |
| 何时 destroy（更新） | Mutation 里，create 之前 | Passive flush 里，先全树 destroy |
| 适合 | 量 DOM、同步矫正布局 | 订阅、改 title、请求 |
| 代价 | 推迟首次绘制 | 用户可能先看到一帧旧布局 |

`useLayoutEffect` 和 Host 属性更新共用 Fiber 的 `Update` 位，所以 Mutation 必须按 `fiber.tag` 分叉：函数组件跑 hook destroy，Host 改属性。

卸载：本仓库在 Mutation 里对要删的子树一次性跑 Layout + Passive 的 destroy，不把已删除节点的 Passive 留到绘制后。少一条「删掉的 Fiber 还要再扫」的路径，语义上仍保证 cleanup 会执行。

和下一章的衔接：Passive 的 flush 走 Scheduler `NormalPriority`，与 `setState` 的 DefaultLane 共用宏任务通道，但不走 Lane——它不是一次「更新」，只是把已经 commit 的 effect 延后到后续任务。

## 面试复习

### 一句话结论

两种 effect 都在 Render 时登记、Commit 后按阶段执行：Layout 的更新 cleanup 在 Mutation、create 在 Layout 且阻塞绘制；Passive 的更新 cleanup/create 在后续 Scheduler 宏任务；本仓库卸载时把两者 cleanup 都简化到 Mutation。

### 面试回答（为什么→机制→仓库落点→官方差异）

为什么：量 DOM 与同步矫正必须在浏览器绘制前完成，而订阅、请求等副作用应避开首帧。机制：Hook tag 区分 `HookLayout` / `HookPassive`，`HookHasEffect` 表示本轮 deps 变化；Fiber flags 让 Commit 快速找到子树。仓库落点：`mountEffectImpl` / `updateEffectImpl` 登记，`commitMutationEffectsOnFiber` 与 `commitLayoutEffectsOnFiber` 处理 Layout，`flushPassiveEffects` 处理 Passive。官方差异：核心阶段语义一致，但官方 Passive 调度、删除树 cleanup、严格模式开发行为更复杂；本仓库删除时同步执行两类 destroy。

### 常见追问

**Q：`useEffect` 的 cleanup 一定在绘制后吗？**
A：不一定。本仓库只保证更新时在后续 Passive flush 中先 destroy 后 create；宏任务通常给浏览器绘制机会，但不检测是否已经绘制，而且组件删除时会在 Mutation 中同步 cleanup。

**Q：deps 相同为什么卸载仍能 cleanup？**
A：新 Effect 保留类型位和旧 destroy，只去掉 `HookHasEffect`；卸载扫描只按 `HookLayout` / `HookPassive` 匹配。

**Q：Passive 为什么不走 Lane？**
A：它不是产生新 Fiber 树的更新，只是延迟执行已提交树上的 effect；这里直接投 Scheduler `NormalPriority`。

### 容易说错

- 不要说 effect 回调在 Render 中执行；Render 只保存 `create`、`destroy`、`deps` 和 tag。
- 不要说 Layout cleanup/create 都在 Layout；更新 cleanup 在 Mutation，create 才在 Layout。
- 不要把「删除时 Passive cleanup 延后」套到本仓库，它在 Mutation 同步执行。

### 源码入口

- `packages/react-reconciler/src/hooks.ts`：`mountEffectImpl`、`updateEffectImpl`
- `packages/react-reconciler/src/hooks.ts`：`commitHookEffectListUnmount`、`commitHookEffectListMount`
- `packages/react-reconciler/src/commitWork.ts`：`commitMutationEffectsOnFiber`、`commitLayoutEffectsOnFiber`、`flushPassiveEffects`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./15-useState与更新队列.md) · [下一章 →](./17-Scheduler与时间切片.md)
