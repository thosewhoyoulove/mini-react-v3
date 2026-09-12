# 第 15 章：`useState` 与更新队列

[← 返回总目录](../../React设计与实现.md) · [上一章](./14-Hook链表与Dispatcher.md) · [下一章 →](./16-useEffect与useLayoutEffect.md)

> 主文件：`packages/react-reconciler/src/hooks.ts`、`scheduleUpdate.ts`
> `setState` 不立刻改 `hook.memoizedState`。它先入队，再标 lane，等下次 Render 在 `updateState` 里算新值。

## 本章书签

- [15.1 一格 Hook 里存什么](#151-一格-hook-里存什么)
- [15.2 环形 pending 队列](#152-环形-pending-队列)
- [15.3 连续三次更新推演](#153-连续三次更新推演)
- [15.4 调度一次更新](#154-调度一次更新)
- [面试复习](#面试复习)

---

## 15.1 一格 Hook 里存什么

`useState` 占用的那一格：

```text
hook.memoizedState  → 当前渲染用的值（0、{…}、数组…）
hook.queue          → { pending, dispatch }
hook.baseQueue      → 已从 pending 截过来、尚未算完的环形链表
hook.next           → 下一格 Hook
```

`mountState`：

1. 追加一格空 Hook。
2. `initialState` 若是函数，先调用一次当初始值（lazy init），否则直接用。
3. new 一个 `queue`，`dispatch` 闭包绑死**这一格的 fiber 和 queue**。
4. 返回 `[memoizedState, dispatch]`。

之后每次更新复用同一个 `dispatch`（`queue` 跟着 Hook 克隆复用）。所以事件处理函数里拿到的 `setCount` 引用稳定，不必进 `useEffect` 的 deps——本仓库没有 `useCallback`，这一点仍然值得知道。

`updateState` 不再看 `initialState` 参数。新值只来自队列里的 action。

## 15.2 环形 pending 队列

`dispatchSetState` 把一次更新收成 `{ action, next }`，接进 `queue.pending`。这是**环形链表**，`pending` 指向**最后插入**的那条，`pending.next` 才是最老的：

```text
第一次 setState(1)
  pending ──► U1 ──next──► U1

再 setState(v => v + 1)
  U1.next = U2, U2.next = U1
  pending ──► U2
               next
                ▼
               U1 ──► U2
```

同一事件里连点三次，三次都先入队，**不会**同步改界面。`scheduleUpdateOnFiber` 用 `DefaultLane` 约一次工作；`ensureRootIsScheduled` 对同一档只保留一个回调，三次更新在同一轮 `updateState` 里消化。

`updateState` 算值：

1. 把 `queue.pending` 接到 `baseQueue` 上（都是环形；有两边则 `mergeCircularQueues`）。
2. 写回 `current.baseQueue`，`pending` 清空。若本轮被切片重启丢掉 WIP，下次还能从 current 重放。
3. 从 `baseQueue.next`（最老）走到一圈，对每个 action：函数则 `(prev) => next`，否则当新值。
4. 结果写入 `hook.memoizedState`，`baseQueue` 置空。

```ts
setCount(1);
setCount((v) => v + 1);
// 若当前是 0：先变成 1，再变成 2。顺序就是入队顺序。
```

`Object.is` 相同是否跳过更新，本仓库没有做——每次 `setState` 都会调度。教学上先把队列和 lane 讲清。

## 15.3 连续三次更新推演

假设本次事件闭包里的 `count` 是 `0`：

```ts
setCount((v) => v + 1);
setCount((v) => v + 1);
setCount((v) => v + 1);
```

三次 `dispatchSetState` 形成环：

```text
pending → U3（尾）
           │
           ▼
          U1 → U2 → U3
           ▲         │
           └─────────┘

U1.action = v => v + 1
U2.action = v => v + 1
U3.action = v => v + 1
```

`updateState` 从 `pending.next`，也就是最老的 U1 开始走一圈：

```text
newState = 0
U1：action(0) = 1
U2：action(1) = 2
U3：action(2) = 3
最终 hook.memoizedState = 3
```

若改成三次非函数式更新：

```ts
setCount(count + 1);
setCount(count + 1);
setCount(count + 1);
```

三行都读取**同一次渲染闭包**里的 `count = 0`，所以入队的三个 action 都已经是普通值 `1`。本仓库遇到非函数 action 会直接覆盖 `newState`：

```text
newState = 0
U1：newState = 1
U2：newState = 1
U3：newState = 1
最终结果 = 1
```

差别不在「有没有入队」：两种写法都会入队三次，也都会调用三次调度入口；同档 `DefaultLane` 只保留一个 Scheduler 回调。真正差别是消费队列时，函数式 action 接收前一条算出的 `newState`，普通值 action 只会把它覆盖为闭包提前算好的相同值。本仓库没有 eager state、批处理边界或按 Lane 跳过单条 Update，这个推演只依赖当前 `updateState` 的顺序归约。

## 15.4 调度一次更新

入队之后立刻：

```ts
scheduleUpdateOnFiber(fiber, DefaultLane);
```

`scheduleUpdate.ts` 是一层间接：`workLoop` 启动时把 `scheduleUpdateOnFiberImpl` 注入进来，避免 `hooks.ts` 和 `workLoop.ts` 循环 import。

`scheduleUpdateOnFiberImpl` 三件事：

1. **`markUpdateLaneFromFiberToRoot`**：这个 Fiber 的 `lanes |= DefaultLane`，沿 `return` 给祖先 `childLanes` 也或上；`alternate` 同样标。
2. **`root.pendingLanes` 合并** 这一档。
3. **若正在 render 同一 root，且新更新同档或更高优** → `rootNeedsRestart = true`，半成品 WIP 丢掉。然后 `ensureRootIsScheduled`。

```text
setCount
  → 入队（环形 pending）
  → 从 Fiber 标到 HostRoot
  → pendingLanes |= DefaultLane
  → Scheduler 宏任务
  → beginWork(App) → updateState 算出新 count
  → Diff 子树（文本「count: N」打 Update）
  → commit 改 DOM
```

`root.render` 走的是 `SyncLane`，不进这条 `dispatchSetState`。用户事件一律 Default，才能切片、才能被随后的 Sync 插队。细节见第 18 章。

下一章：同一条 Hook 链表上的另一种格子——`useEffect` / `useLayoutEffect`。

## 面试复习

### 一句话结论

`setState` 先把 action 追加到环形队列，再以 `DefaultLane` 调度；Render 时从最老更新顺序归约，所以连续三个函数式 `+1` 从 0 得 3，三个同闭包的 `count + 1` 得 1。

### 面试回答（为什么→机制→仓库落点→官方差异）

为什么：状态更新可能连续发生，也可能因时间切片被重启，不能在调用 `setState` 时直接改当前 Hook。机制：`pending` 指向环形队列尾，`pending.next` 是队首；Render 合并到 `baseQueue` 后按入队顺序消费，函数 action 用前一结果，普通 action 直接替换结果。仓库落点：`dispatchSetState` 入队，`mergeCircularQueues` 合并，`updateState` 归约并把队列写回 current 保障重放。官方差异：官方还支持 eager state、按 Lane 跳过与 rebase、批处理等；本仓库所有 state update 都是 DefaultLane，且每次调用都会进入调度。

### 常见追问

**Q：连续三次 `setState` 是只入队一次吗？**
A：不是，入队三条 Update、调用三次调度入口；只是同一根同一 Lane 已有回调时不重复预约任务。

**Q：为什么 `setCount(count + 1)` 三次不是 3？**
A：三次都在同一闭包中先算成相同普通值，消费时连续覆盖；函数式 action 才会逐条拿到最新中间结果。

**Q：为什么把队列写回 current 的 `baseQueue`？**
A：若并发 Render 的 wip 被插队丢弃，current 仍保留已转移的更新，下次可从已提交状态重新推演。

**Q：相同新值会在入队时被跳过吗？**
A：本仓库不会做 `Object.is` eager bailout，每次都会入队并调度。

### 容易说错

- 不要说 `setState` 立即修改 `memoizedState`；真正计算发生在后续 `updateState`。
- 不要把 `pending` 当队首；它指向队尾，`pending.next` 才是最老更新。
- 不要把本仓库的简单归约描述成官方完整的 Lane 跳过与 rebase 算法。

### 源码入口

- `packages/react-reconciler/src/hooks.ts`：`dispatchSetState`
- `packages/react-reconciler/src/hooks.ts`：`mergeCircularQueues`、`updateState`
- `packages/react-reconciler/src/workLoop.ts`：`scheduleUpdateOnFiberImpl`、`ensureRootIsScheduled`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./14-Hook链表与Dispatcher.md) · [下一章 →](./16-useEffect与useLayoutEffect.md)
