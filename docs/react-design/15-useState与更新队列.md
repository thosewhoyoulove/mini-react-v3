# 第 15 章：`useState` 与更新队列

[← 返回总目录](../../React设计与实现.md) · [上一章](./14-Hook链表与Dispatcher.md) · [下一章 →](./16-useEffect与useLayoutEffect.md)

点击按钮后调用了 `setCount`，紧接着打印 `count`，看到的往往还是旧值。连续调用三次也不一定加到 `3`。要解释这些现象，不能把 `setState` 当成一次赋值。它先记下一条 action，再请求调度。新状态要等后续 render 才会算出来。

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

`handleClick` 来自某一次 render，闭包里的 `count` 也是那次 render 的快照。调用 `setCount` 不会重写这个局部变量，也不会当场改 `hook.memoizedState`。

`dispatchSetState` 把参数交给 `enqueueUpdate`。入队只做四步：造一个 Update，把它接进环，让 `pending` 指向新尾，然后按当前 Lane 调度。

```ts
/**
 * 把一条 action 插进环形 pending，并按当前 lane 发起调度。
 *
 * 1. 包成 Update，next 先空着
 * 2. 空队列时 next 指回自己；否则插到旧尾和旧头之间
 * 3. pending 改指向新尾
 * 4. 用入队这一刻的 Lane 调用 scheduleUpdateOnFiber
 */
function enqueueUpdate(fiber, queue, action) {
  const update = { action, next: null }; // 1
  const pending = queue.pending;
  if (pending == null) {
    update.next = update; // 2. 环上只有这一条
  } else {
    update.next = pending.next; // 2. 新节点指向旧头
    pending.next = update; // 2. 旧尾指向新节点
  }
  queue.pending = update; // 3
  scheduleUpdateOnFiber(fiber, requestUpdateLane()); // 4
}
```

普通值和更新函数都放在 `action` 里。消费时，普通值直接替换旧状态。action 若是函数，就把上一条 Update 算出的中间状态传给它。

`pending` 指向最后插入的节点，`pending.next` 才是最早插入的节点。空队列里新节点的 `next` 指回自己。之后每次插入都把新节点放在旧尾和旧头之间，再让 `pending` 移到新尾。追加不用遍历链表。读取时从 `pending.next` 出发，按先进先出走完一圈。

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

`mountState` 创建 dispatch 时，闭包捕获当前 Fiber 和这个共享的 `queue`。`hooks.ts` 若直接 import `workLoop`，会和 `beginWork` 形成循环依赖。`scheduleUpdate.ts` 因此只保存一个函数指针，`workLoop` 初始化时把真正的 `scheduleUpdateOnFiberImpl` 注进去。后续 render 会克隆 Hook 节点，但继续使用同一个 `queue`，`updateState` 返回的也是 `queue.dispatch`。所以 `setCount` 的函数身份保持稳定。

到这一步，队列里只有将来要算的 action。页面和 `hook.memoizedState` 都还没变。入队时也不做 `Object.is` 比较。即使传入的值与旧状态相同，更新仍会入队并触发调度，组件函数会再执行一遍。

初始值函数是另一条路径。`useState(() => 0)` 的函数只在 `mountState` 里调用一次，结果写入 `memoizedState`。更新渲染会丢掉这个参数。它和 `setCount(n => n + 1)` 都是函数，执行时机不同：前者只参与挂载，后者要等 render 消费队列。

## 15.2 render 按顺序消费 state 与 reducer 队列

下一次 render 进入 `updateState`，才处理积累的 action。它先从 current Hook 读 `baseQueue` 和 `queue.pending`。

`pending` 若有内容，就和 `baseQueue` 接成一个环，写回 **current** Hook 的 `baseQueue`，同时把 `queue.pending` 清空。原因是这条队列和 dispatch 共用。若本轮 WIP 后来被丢掉，pending 已经空了，更新必须还留在已提交的 current 上，下次才能重放。

两个环的拼接是常数时间。`baseQueue` 是较早的那圈，`pending` 是较新的那圈。把旧尾指向新头、新尾指向旧头，新的 `pending` 就成为整圈的尾：

```ts
/**
 * 把较早的 baseQueue 和较新的 pending 拼成一个环。
 *
 * 1. 取出两圈各自的头
 * 2. 旧尾指向新头，新尾指向旧头
 * 3. 返回新尾，调用方从它的 next 开始按先进先出重放
 */
function mergeCircularQueues(baseQueue, pending) {
  const baseFirst = baseQueue.next; // 1
  const pendingFirst = pending.next; // 1
  baseQueue.next = pendingFirst; // 2
  pending.next = baseFirst; // 2
  return pending; // 3
}
```

计算从合并后的 `baseQueue.next` 开始，初值是 `currentHook.memoizedState`，也就是上次留下的状态。走完一圈后，最终值写入 WIP Hook 的 `memoizedState`，被清成 `null` 的是这份 WIP 的 `baseQueue`。current Hook 上的 `baseQueue` 仍指着刚合并的那圈。commit 把这棵 WIP 换成新的 current 之后，对外的 `baseQueue` 才是 `null`。渲染若在 commit 前被放弃，`root.current` 还是原来那棵，更新因此还在。

没有 `pending` 也没有 `baseQueue` 时，走另一条出口：直接返回克隆下来的旧 state 和原来的 dispatch。这条路径不会把 state 重算一遍。

现在看连续调用。事件处理函数闭包里的 `count` 为 `0`：

```tsx
setCount(count + 1);
setCount(count + 1);
setCount(count + 1);
```

三个 `count + 1` 在入队前就已经求值，读到的都是同一个 `0`。队列收到的是三个普通值 `1`，不是三次“加一”：

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

两种写法都产生三条 Update。差别在 action 怎样用中间状态求值。本实现没有在入队时做 eager bailout，所以上面两次点击都会进入调度。

`useReducer` 复用同一种环形队列和合并过程。`mountReducer` 同样创建 `{ pending, dispatch, lastRenderedReducer }`。每次 `updateReducer` 都会把本轮传入的 reducer 写进 `lastRenderedReducer`。当前仓库没有再读这个字段。重放循环直接调用本次函数收到的 reducer。计算方式因此不同：

```ts
// useState 的概念模型
nextState =
  typeof action === 'function' ? action(prevState) : action;

// useReducer
nextState = reducer(prevState, action);
```

`useState` 自己解释“值还是更新函数”。`useReducer` 把 action 原样交给组件提供的 reducer。它们共用队列，并不是两套调度。

## 15.3 Lane 决定何时调度，不筛选单条 Update

action 入队后，`enqueueUpdate` 还会发起一次更新：

```ts
scheduleUpdateOnFiber(fiber, requestUpdateLane());
```

`requestUpdateLane` 看的是**入队这一刻**的 `ReactCurrentBatchConfig.transition`：

```ts
/**
 * 按调用 setState 时是否位于 startTransition 选择 Lane。
 *
 * 1. transition 不是 null，说明当前栈在 startTransition 回调里
 * 2. 否则按普通更新处理
 */
function requestUpdateLane() {
  return ReactCurrentBatchConfig.transition != null
    ? TransitionLane // 1
    : DefaultLane; // 2
}
```

普通事件里的 `setState` 请求 `DefaultLane`。`startTransition` 会暂时把 `transition` 设成一个空对象，回调里的 `setState` 因此请求 `TransitionLane`，离开回调后恢复原值：

```tsx
setInput(text); // DefaultLane

startTransition(() => {
  setQuery(text); // TransitionLane
});
```

Lane 描述的是 root 以什么优先级获得这次工作。`DefaultLane` 交给 Scheduler 做可切片渲染。`TransitionLane` 要等更高优的工作先处理，进行中的这一档也可能被更高优更新要求重来。`root.render` 走 `updateContainer`，固定使用 `SyncLane`，和 Hook dispatch 不是同一条入口。

调度路径记录 Lane，队列节点只记录 action：

```text
Update = { action, next }       // 没有 lane
root.pendingLanes = ...         // Lane 记在 Fiber 到 root 的调度路径上
```

因为单条 Update 没有 `lane` 字段，render 一旦进入 `updateState` 或 `updateReducer`，就会按入队顺序消费整圈 action，并清空 WIP 的 `baseQueue`。这里的 `baseQueue` 用来在中断或放弃后重放，没有按优先级跳过再 rebase。

组件没有执行到这两个函数时，队列不会被消费。函数组件若在本轮 bailout，Hook 函数不会跑，action 仍留在共享队列里。

因此，`startTransition` 里入队的 action 不会永远带着 `TransitionLane`。这个 Lane 只让 root 获得一次 Transition 优先级的调度机会。Default 更新若先让组件进入 `updateState`，本实现会在那一轮把已经排在同一条队列里的 action 一起算完。root 上残留的 Transition 位之后还可能再触发一轮渲染，那时队列往往已经空了。

官方 React 的状态 Update 自身带有 lane，可以在 render 中跳过不属于本轮优先级的更新，再用 `baseState` 和 `baseQueue` 保留、重放。它还有 eager state 等机制。本项目只在这里省掉了队列筛选，不能据此推断官方 React 也会整圈消费。

从调用到生效的路径是：

```text
setState(action)
  → action 接到 queue.pending 环形队列
  → requestUpdateLane：普通为 Default，transition 内为 Transition
  → scheduleUpdateOnFiber
  → 后续 render 若执行该组件，调用 updateState / updateReducer
  → 从最早的 action 开始消费整条队列
  → 新状态写入 WIP Hook，commit 后显示在界面上
```

## 本章回顾

- `setState` 保存 action 并发起调度。闭包里的状态快照不会随调用立刻改变。
- `queue.pending` 是尾指针。从 `pending.next` 出发，可以按入队顺序消费整个环形队列。
- 合并后的队列先写回 current Hook。WIP 消费完才把自己的 `baseQueue` 清空，放弃渲染时更新还在。
- 普通值直接替换状态，函数 action 接收前一条 Update 的结果。`useState(fn)` 的初始函数只在挂载时跑一次。
- 本实现的 Lane 用于调度 root。单条 Update 不带 lane，所以一旦进入 state 更新函数，就会消费整条队列。

对应源码集中在 `hooks.ts` 的 `enqueueUpdate`、`mergeCircularQueues`、`updateState`、`updateReducer` 与 `requestUpdateLane`。Lane 常量在 `fiberLanes.ts`，调度转发在 `scheduleUpdate.ts`。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./14-Hook链表与Dispatcher.md) · [下一章 →](./16-useEffect与useLayoutEffect.md)
