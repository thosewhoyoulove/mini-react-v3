# 第 15 章：`useState` 与更新队列

[← 返回总目录](../../React设计与实现.md) · [上一章](./14-Hook链表与Dispatcher.md) · [下一章 →](./16-useEffect与useLayoutEffect.md)

调用 `setCount(count + 1)` 后，当前函数里的 `count` 为什么没有立刻变化？连续调用三次时，为什么传普通值常得到 `1`，传更新函数却能得到 `3`？关键在于：`setState` 不直接修改状态。它只把一条 action 放进队列并请求调度，真正的新状态要到后续 render 才按入队顺序算出。

> 源码入口：`packages/react-reconciler/src/hooks.ts`、`packages/react-reconciler/src/fiberLanes.ts`、`packages/react-reconciler/src/scheduleUpdate.ts`

## 本章书签

- [15.1 setState 先入队，不直接改值](#151-setstate-先入队不直接改值)
- [15.2 render 按顺序消费 state 与 reducer 队列](#152-render-按顺序消费-state-与-reducer-队列)
- [15.3 Lane 决定何时调度，不筛选单条 Update](#153-lane-决定何时调度不筛选单条-update)
- [面试复习](#面试复习)

---

## 15.1 setState 先入队，不直接改值

从一个可以预测结果的例子开始：

```tsx
function Counter() {
  const [count, setCount] = useState(0);

  function handleClick() {
    setCount(count + 1);
    console.log(count); // 仍是 0
  }

  return <button onClick={handleClick}>{count}</button>;
}
```

`handleClick` 是本次 render 创建的函数，其中的 `count` 已经是这次 render 的快照。`setCount` 不会改写这个局部变量，也不会当场改 `hook.memoizedState`。当前仓库的 `dispatchSetState` 只把参数交给 `enqueueUpdate`。

一条更新的结构很小：

```ts
type Update<S> = {
  action: S | ((prev: S) => S);
  next: Update<S>;
};
```

`action` 有两种形式：

- 普通值，例如 `setCount(1)`，消费时直接把状态替换为 `1`；
- 更新函数，例如 `setCount(n => n + 1)`，消费时把当时的中间状态传给函数。

新 Update 会进入 `hook.queue.pending` 所指的环形链表。`pending` 指向最新插入的尾节点，`pending.next` 才是最早的头节点：

```text
第一次入队 U1：

pending
   │
   ▼
  U1 ──next──► U1

再入队 U2：

pending
   │
   ▼
  U2 ──next──► U1 ──next──► U2
               ▲             │
               └─────────────┘
```

这种结构让插入保持简单：空队列让新节点指向自己；非空队列则把新节点插在旧尾与旧头之间，再让 `pending` 指向新尾。读取时从 `pending.next` 开始，正好仍按先进先出的顺序处理。

`mountState` 创建的 `dispatch` 闭包会捕获当前 Fiber 和这一个共享 `queue`。更新渲染虽然会克隆 Hook 节点，却复用 `queue`，所以 `setCount` 的函数身份保持稳定。此时队列中只是“以后怎样更新”的描述，状态值尚未改变。

## 15.2 render 按顺序消费 state 与 reducer 队列

下一次 render 调用 `updateState` 时，才会处理积累的 action。流程分为四步：

1. 取得 `queue.pending`；若已有 `baseQueue`，用 `mergeCircularQueues` 把两个环接成一个环。
2. 把合并结果写到 current Hook 的 `baseQueue`，并清空 `queue.pending`。若本轮 wip 被放弃，下次仍可从 current 找回这些更新。
3. 从 `baseQueue.next`，也就是最老的 Update 开始走一圈，逐条计算。
4. 把最终结果写入 wip Hook 的 `memoizedState`，并清空已消费的 `baseQueue`。

普通值与函数 action 的差异，现在就能准确解释。假设事件处理函数闭包中的 `count` 是 `0`：

```tsx
setCount(count + 1);
setCount(count + 1);
setCount(count + 1);
```

三行表达式在入队前都已经读取了同一个 `count`，所以队列实际收到的是三个普通值 `1`：

```text
初值 0
  → U1.action 是 1：替换为 1
  → U2.action 是 1：替换为 1
  → U3.action 是 1：替换为 1
最终结果 1
```

改成更新函数：

```tsx
setCount(n => n + 1);
setCount(n => n + 1);
setCount(n => n + 1);
```

队列保存的是三个函数。每个函数都接收前一条刚算出的结果：

```text
初值 0
  → U1.action(0) 得 1
  → U2.action(1) 得 2
  → U3.action(2) 得 3
最终结果 3
```

两种写法都入队三条 Update。差别不是“是否批处理”，而是 action 在 render 中如何归约。当前仓库也没有在入队时做 `Object.is` eager bailout；即使传入与旧状态相同的值，仍会入队和调度。

`useReducer` 使用同一种环形队列。它与 `useState` 的主要区别不是队列形状，而是消费 action 的方式：

```ts
// useState 的概念模型
nextState =
  typeof action === 'function' ? action(prevState) : action;

// useReducer
nextState = reducer(prevState, action);
```

`mountReducer` 同样创建 `{ pending, dispatch, lastRenderedReducer }`，`updateReducer` 同样合并 `pending` 与 `baseQueue`，再按入队顺序遍历。只是每一条 action 都交给组件提供的 `reducer`。因此可以把 `useState` 和 `useReducer` 看成“共用队列机制，采用不同状态计算规则”，而不是两套独立调度系统。

## 15.3 Lane 决定何时调度，不筛选单条 Update

action 入队之后，`enqueueUpdate` 会调用：

```ts
scheduleUpdateOnFiber(fiber, requestUpdateLane());
```

当前仓库的 `requestUpdateLane` 只看 `ReactCurrentBatchConfig.transition`：

```ts
function requestUpdateLane(): Lane {
  return ReactCurrentBatchConfig.transition != null
    ? TransitionLane
    : DefaultLane;
}
```

因此，普通事件中的 `setState` 请求 `DefaultLane`；`startTransition` 回调内的 `setState` 请求更低优先级的 `TransitionLane`。

```tsx
setInput(text); // DefaultLane

startTransition(() => {
  setQuery(text); // TransitionLane
});
```

Lane 在这里描述“这次更新请求以什么优先级让 root 工作”。`DefaultLane` 可以交给 Scheduler 做可切片渲染；`TransitionLane` 会等更高优工作完成，也可以被更高优更新打断。`root.render` 使用的 `SyncLane` 是另一条入口，不是 Hook 的 `setState` 在普通情况下选择的 Lane。

但必须区分**调度 Lane**与**队列中的单条 Update**。当前教学实现的 Update 只有 `action` 和 `next`，没有 `lane` 字段：

```text
Update = { action, next }       // 没有 lane
root.pendingLanes = ...         // Lane 记在调度路径上
```

这意味着当前 render 一旦进入 `updateState` 或 `updateReducer`，就会消费队列中的全部 action，不会依据本轮 `renderLanes` 跳过某一条低优更新。`baseQueue` 在这里主要用于渲染被中断或丢弃后的重放，不是完整的“跳过低优更新并在以后 rebase”实现。

这个边界会产生一个重要结论：即使某条 action 是在 `startTransition` 内入队，它自身也没有永久携带 `TransitionLane`。Lane 让 root 以 Transition 优先级获得一次调度机会；若另一条 Default 更新先触发了 render，当前简化实现可能在这轮中把队列里的 action 一并消费。

官方 React 的状态 Update 会携带 lane，render 可以跳过不属于当前优先级的更新，并用 `baseState`、`baseQueue` 保留与重放，另外还有 eager state、并发入队等机制。因此，“Transition action 永远只在 Transition render 中处理”不能从当前仓库推出；反过来，也不能用当前仓库的全量消费去描述官方 React。

完整路径可以概括为：

```text
setState(action)
  → action 接到 queue.pending 环形队列
  → requestUpdateLane：普通为 Default，transition 内为 Transition
  → scheduleUpdateOnFiber
  → 后续 render 调用 updateState / updateReducer
  → 从最老 action 开始消费整条队列
  → 新状态写入 wip Hook，commit 后对界面生效
```

下一章将查看同一条 Hook 链上的 effect 格子，以及 `useEffect` 和 `useLayoutEffect` 在 commit 时机上的区别。

## 面试复习

**一句话：** `setState` 先把值或更新函数放入环形队列，再请求一次 Lane 调度；状态到后续 render 才按入队顺序计算。

**为什么三次 `setCount(count + 1)` 得 1？** 三次都从同一 render 闭包读到 `0`，入队的是三个值 `1`；函数 action 才会接收前一条的中间结果。

**`useReducer` 是另一种队列吗？** 不是。当前仓库复用同样的 Update 环和合并流程，只把每条 action 交给 reducer。

**Transition 更新会被单独筛选吗？** 不会。`requestUpdateLane` 会为调度选择 `TransitionLane`，但单条 Update 没有 lane，当前 render 会消费全队列；官方 React 才有按 Update lane 跳过与 rebase。

**源码入口：**

- `packages/react-reconciler/src/hooks.ts`：`enqueueUpdate`、`requestUpdateLane`
- `packages/react-reconciler/src/hooks.ts`：`mergeCircularQueues`、`updateState`、`updateReducer`
- `packages/react-reconciler/src/fiberLanes.ts`：`DefaultLane`、`TransitionLane`
- `packages/react-reconciler/src/scheduleUpdate.ts`：`scheduleUpdateOnFiber`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./14-Hook链表与Dispatcher.md) · [下一章 →](./16-useEffect与useLayoutEffect.md)
