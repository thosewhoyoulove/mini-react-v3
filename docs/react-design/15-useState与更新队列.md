# 第 15 章：`useState` 与更新队列

[← 返回总目录](../../React设计与实现.md) · [上一章](./14-Hook链表与Dispatcher.md) · [下一章 →](./16-useEffect与useLayoutEffect.md)

点击按钮后调用了 `setCount`，紧接着打印 `count`，看到的往往还是旧值。连续调用三次也不一定加到 `3`。要解释这些现象，不能把 `setState` 当成一次赋值；它先记录一条 action 并请求调度，新状态要等后续 render 才会算出来。

> 源码入口：`packages/react-reconciler/src/hooks.ts`、`packages/react-reconciler/src/fiberLanes.ts`、`packages/react-reconciler/src/scheduleUpdate.ts`

## 15.1 setState 先入队，不直接改值

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

`handleClick` 来自某一次 render，它闭包里的 `count` 也是那次 render 的快照。调用 `setCount` 不会重写这个局部变量，也不会当场修改 `hook.memoizedState`。`dispatchSetState` 会把收到的参数交给 `enqueueUpdate`，保存为下面这样的节点：

```ts
type Update<S> = {
  action: S | ((prev: S) => S);
  next: Update<S>;
};
```

普通值和更新函数都放在 `action` 中。消费普通值时，新值会直接替换旧状态；如果 action 是函数，计算过程会把上一条 Update 得到的中间状态传给它。

这些节点接在 `hook.queue.pending` 所指的环形链表里。`pending` 指向最后插入的节点，而 `pending.next` 是最早插入的节点：

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

空队列中，新节点的 `next` 指回自己。之后每次插入，都把新节点放在旧尾与旧头之间，再让 `pending` 移到新尾。追加时不必遍历链表；读取时从 `pending.next` 出发，又能按照先进先出的顺序走完整个环。

`mountState` 创建 dispatch 函数时，会让闭包捕获当前 Fiber 和这个共享的 `queue`。后续 render 虽然克隆 Hook 节点，却继续使用同一个队列，所以 `setCount` 的函数身份保持稳定。到这一步，队列里只有未来要执行的状态计算，页面和状态值都还没有改变。

## 15.2 render 按顺序消费 state 与 reducer 队列

下一次 render 进入 `updateState`，才开始处理积累的 action。它先读取 `queue.pending`；如果 Hook 上还留有 `baseQueue`，`mergeCircularQueues` 会把两个环接成一个。合并后的队列写回 current Hook 的 `baseQueue`，同时清空 `queue.pending`。这样，即使本轮 WIP 被放弃，下次仍能从已提交的 current 找回这些更新。

计算从 `baseQueue.next` 开始，也就是从最早的 Update 依次走一圈。最终状态写入 WIP Hook 的 `memoizedState`，已消费的 `baseQueue` 随后清空。

现在再看连续调用。假设事件处理函数闭包里的 `count` 为 `0`：

```tsx
setCount(count + 1);
setCount(count + 1);
setCount(count + 1);
```

三个 `count + 1` 在入队前就已经完成求值，读到的都是同一个 `0`。队列收到的不是“加一”指令，而是三个普通值 `1`：

```text
初值 0
  → U1.action 是 1：替换为 1
  → U2.action 是 1：替换为 1
  → U3.action 是 1：替换为 1
最终结果 1
```

换成函数 action，队列保存的才是三次计算：

```tsx
setCount(n => n + 1);
setCount(n => n + 1);
setCount(n => n + 1);
```

```text
初值 0
  → U1.action(0) 得 1
  → U2.action(1) 得 2
  → U3.action(2) 得 3
最终结果 3
```

两种写法都产生三条 Update，区别在于 action 如何根据中间状态求值，而不在于有没有批处理。本实现也没有在入队时执行 `Object.is` eager bailout；即使传入的值与旧状态相同，更新仍会入队并触发调度。

`useReducer` 复用同一种环形队列与合并过程。变化的只是每条 action 的计算方式：

```ts
// useState 的概念模型
nextState =
  typeof action === 'function' ? action(prevState) : action;

// useReducer
nextState = reducer(prevState, action);
```

`mountReducer` 同样创建 `{ pending, dispatch, lastRenderedReducer }`，`updateReducer` 也会合并 `pending` 与 `baseQueue`，再按顺序遍历。`useState` 解释值或更新函数，`useReducer` 则把 action 交给组件提供的 reducer；它们共用队列机制，并不是两套调度系统。

## 15.3 Lane 决定何时调度，不筛选单条 Update

action 入队后，`enqueueUpdate` 还会发起一次更新：

```ts
scheduleUpdateOnFiber(fiber, requestUpdateLane());
```

`requestUpdateLane` 在这里根据 `ReactCurrentBatchConfig.transition` 选择 Lane：

```ts
function requestUpdateLane(): Lane {
  return ReactCurrentBatchConfig.transition != null
    ? TransitionLane
    : DefaultLane;
}
```

普通事件中的 `setState` 请求 `DefaultLane`，`startTransition` 回调中的调用请求优先级更低的 `TransitionLane`：

```tsx
setInput(text); // DefaultLane

startTransition(() => {
  setQuery(text); // TransitionLane
});
```

Lane 描述 root 以什么优先级获得这次工作。`DefaultLane` 可以交给 Scheduler 做可切片渲染；`TransitionLane` 会等待更高优工作，也可能被它打断。`root.render` 走的是另一条入口，使用 `SyncLane`，不要与普通 Hook 更新混在一起。

需要在这里看清两层数据：调度路径记录 Lane，队列节点只记录 action。

```text
Update = { action, next }       // 没有 lane
root.pendingLanes = ...         // Lane 记在调度路径上
```

因为单条 Update 没有 `lane` 字段，render 一旦进入 `updateState` 或 `updateReducer`，就会消费队列里的全部 action，不会根据本轮 `renderLanes` 留下一部分。这里的 `baseQueue` 主要帮助中断或放弃后的 render 重放更新，没有实现按优先级跳过并 rebase。

于是，在 `startTransition` 中入队的 action 并不会永久携带 `TransitionLane`。这个 Lane 让 root 获得一次 Transition 优先级的调度机会；如果 Default 更新先触发 render，本实现可能在那一轮把两类 action 一起消费。

官方 React 的状态 Update 自身带有 lane，可以在 render 中跳过不属于本轮优先级的更新，再借助 `baseState`、`baseQueue` 保留和重放；它还包含 eager state、并发入队等机制。本项目只在这里简化了队列筛选，不能据此推断官方 React 也会全量消费。

把调用到生效的路径连起来，就是：

```text
setState(action)
  → action 接到 queue.pending 环形队列
  → requestUpdateLane：普通为 Default，transition 内为 Transition
  → scheduleUpdateOnFiber
  → 后续 render 调用 updateState / updateReducer
  → 从最早的 action 开始消费整条队列
  → 新状态写入 WIP Hook，commit 后显示在界面上
```

下一章会转向同一条 Hook 链上的 effect 节点，比较 `useEffect` 与 `useLayoutEffect` 在 commit 中的执行时机。

## 本章回顾

- `setState` 保存 action 并发起调度，闭包里的状态快照不会随调用立刻改变。
- `queue.pending` 是尾指针；从 `pending.next` 出发，可以按入队顺序消费整个环形队列。
- 普通值直接替换状态，函数 action 接收前一条 Update 的结果；`useReducer` 则把 action 交给 reducer。
- 本实现的 Lane 用于调度 root，单条 Update 不带 lane，所以一次 render 会消费整条状态队列。

对应源码集中在 `hooks.ts` 的 `enqueueUpdate`、`mergeCircularQueues`、`updateState`、`updateReducer` 与 `requestUpdateLane`；Lane 常量和调度入口分别位于 `fiberLanes.ts` 与 `scheduleUpdate.ts`。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./14-Hook链表与Dispatcher.md) · [下一章 →](./16-useEffect与useLayoutEffect.md)
