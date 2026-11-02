# 第 17 章：Scheduler 与时间切片

[← 返回总目录](../../React设计与实现.md) · [上一章](./16-useEffect与useLayoutEffect.md) · [下一章 →](./18-最小Lane.md)

一棵大 Fiber 树若在一个 JavaScript 任务中从头算到尾，用户输入和页面绘制都要排在它后面。把 Render 拆成几段可以缓解阻塞，但拆开只是第一步。多个 callback 等待执行时谁先开始，一段工作又该在哪里暂停？这个教学版 Scheduler 用最小堆决定先后，用 MessageChannel 取得宏任务，用固定 5ms deadline 决定这一段何时让出。

> 源码范围：`packages/scheduler/src/Scheduler.ts`、`packages/react-reconciler/src/workLoop.ts`
>
> 官方 React Scheduler 还处理 expiration time、延迟任务和 continuation callback。本章只沿着这里实现的优先级排序与时间切片展开。

## 17.1 任务不是 FIFO：先比 `priorityLevel`，再比 `startTime`

三个任务在同一次同步调用里依次入队，B 却会最先打印：

```ts
unstable_scheduleCallback(NormalPriority, () => console.log('A'));
unstable_scheduleCallback(UserBlockingPriority, () => console.log('B'));
unstable_scheduleCallback(NormalPriority, () => console.log('C'));
```

输出是 `B A C`，前提是 A 的 `startTime` 早于 C。B 虽然后入队，优先级数字却比 A、C 小。A 和 C 同为 Normal，才继续比较各自记录的 `startTime`。

`taskQueue` 是最小堆，不是普通的先进先出队列。数组首项 `taskQueue[0]` 始终是比较结果最小的任务。比较函数正好对应刚才的输出：

```ts
/**
 * 判断 a 是否应该比 b 更靠近堆顶。
 *
 * 1. 优先级数字不同时，小的更紧急
 * 2. 优先级相同，更早的 startTime 更靠近堆顶
 */
function isLess(a: Task, b: Task): boolean {
  if (a.priorityLevel !== b.priorityLevel) {
    return a.priorityLevel < b.priorityLevel; // 1
  }
  return a.startTime < b.startTime; // 2
}
```

五档优先级从 1 到 5。数字越小，任务越靠近堆顶：

```text
ImmediatePriority      1
UserBlockingPriority   2
NormalPriority         3
LowPriority            4
IdlePriority           5
```

这五档是 Scheduler 自己的刻度。当前 reconciler 实际投递时只用到 `NormalPriority` 和 `LowPriority`。`ImmediatePriority`、`UserBlockingPriority` 和 `IdlePriority` 可以用来理解堆的顺序，本仓库的更新路径没有把 Fiber 工作标成这三档。

同档任务的 `startTime` 不同时，较早的先执行。时间完全相同则没有进一步的排序规则：`id` 只用于取消，不参与比较。后入队的同值节点虽然不会在 `siftUp` 中越过前一个，但出堆后还会用数组末项补到堆顶，因此整个堆并不保证同值任务严格按入队顺序执行。

`unstable_scheduleCallback` 创建递增 `id`，记录优先级和 `startTime`，把任务放到数组末尾，再通过 `siftUp` 恢复最小堆。随后调用 `port.postMessage(null)`，预约一次 MessageChannel 宏任务。

取消任务时，`unstable_cancelCallback(id)` 线性扫描堆，把匹配项的 `callback` 改成 `null`。它不把节点从堆中间抽走，因此也不必立刻修复堆结构。下一次 `popTask` 会在同一次 `onmessage` 里连续丢掉这些空项，再执行下一条 callback 还在的任务。已经开始执行的函数不会被这次取消撤回：任务弹出后会先把 `callback` 置空，然后才调用它，此时它已经不在堆里。

## 17.2 MessageChannel 如何承接任务，5ms 又如何形成时间片

最小堆选出了下一个任务，但堆本身不会获得主线程。唤醒过程由 MessageChannel 串起来：

```text
schedule callback
  → push + siftUp
  → port2.postMessage(null)
  → 后续宏任务触发 port1.onmessage
  → popTask 取一条还活着的任务
  → deadline = now + 5
  → 执行这一条 callback
  → 堆中还有任务，再 postMessage
```

先按刚才 `B A C` 的顺序看消息处理。三次连续的 `scheduleCallback` 会发出三次 `postMessage`。第一条宏任务弹出 B 之后，若堆里还有 A 和 C，会再补一次 `postMessage`。多出来的消息稍后看到空堆，直接返回。一次 `postMessage` 只保证以后有一次机会检查堆，不与某一条任务绑定。

`postMessage` 让当前 JavaScript 栈先结束，再从后续宏任务继续。若改成连续的 `queueMicrotask`，浏览器会先清空微任务队列，这种连续入队可能让绘制一直等下去。`setTimeout(..., 0)` 也能产生宏任务，但嵌套到一定层级的定时器会受到最小 4ms 延迟的限制，后台页面还可能被进一步节流。MessageChannel 在这里用于调度后续任务。

宏任务切开了两段 JavaScript，却没有承诺中间一定发生绘制。浏览器有机会处理输入和渲染。是否实际 paint，仍由宿主决定。Scheduler 手里没有绘制完成信号。

每次 `onmessage` 取出一条任务，都重新设置截止时间：

```ts
deadline = unstable_now() + 5;
```

这条 callback 若是 `performConcurrentWorkOnRoot`，里面会处理许多 Fiber。reconciler 在每个工作单元之间询问是否到点：

```ts
while (workInProgress != null && !unstable_shouldYield()) {
  performUnitOfWork(workInProgress);
}
```

`unstable_shouldYield()` 只比较 `performance.now()` 与 `deadline`。5ms 从弹出任务、调用 callback 之前开始计算，`setHostConfig` 和选择 Lane 的时间也算在里面。时间用完后循环退出，`workInProgress` 仍指向下一个待处理 Fiber。`performConcurrentWorkOnRoot` 再经 `ensureRootIsScheduled` 安排下一次 Scheduler 任务，新任务会拿到新的 5ms。

这里的 5ms 是固定预算，不是按 16.7ms 一帧精确切分，也不随屏幕刷新率变化。检查只发生在 Fiber 单元之间。单次 `performUnitOfWork` 已经超过 5ms 时，也要等它返回后才能让出。这个实现没有让 callback 返回 continuation，而是由 reconciler 在没做完时显式再 schedule。官方 Scheduler 在这些方面更完整。

## 17.3 `schedule/cancel`、调试同步边界与 Lane 的分工

从调用方看，Scheduler 的入口是两行：

```ts
const id = unstable_scheduleCallback(priorityLevel, callback);
unstable_cancelCallback(id);
```

正常模式下，第一行入堆并返回任务 id，第二行可以在 callback 开始前将它作废。`workLoop.ts` 会把并发任务的 id 保存到 `root.callbackNode`。根要换档时，reconciler 用它取消还没开始的预约。

`enableSchedulerDebugging` 打开后，执行路径不同：

```ts
if (enableSchedulerDebugging) {
  callback(); // 在当前调用栈里立刻执行
  return id; // 这个 id 没有对应的堆节点
}
```

callback 在 `unstable_scheduleCallback` 的调用栈里同步执行，不入堆，也不经过 MessageChannel，因此没有 5ms deadline。返回的 id 只是维持 API 形状。之后拿它取消时，堆里找不到任务。这个开关方便测试立刻看到结果，不能用来观察正常的调度顺序。Passive effect 和并发渲染走的是同一个入口，开关打开时它们也会变成同步调用。

Scheduler 和 Lane 回答的是两件不同的事：

| 问题 | Lane（reconciler） | Scheduler |
| --- | --- | --- |
| 表达什么 | 哪次 React 更新更急，本轮处理哪一档 | 已投递的 callback 谁先获得主线程 |
| 数据放在哪 | Fiber 的 `lanes`、根的 `pendingLanes` | 最小堆中的 `Task` |
| 是否认识 Fiber | 是 | 否，只接收 callback |
| 这里的主要职责 | 选择同步或并发路径、判断是否重启 WIP | 排序、宏任务投递、5ms deadline、取消 |

两者在 `ensureRootIsScheduled` 接上：

```text
SyncLane       → queueMicrotask → workLoopSync
DefaultLane    → NormalPriority → Scheduler → workLoopConcurrent
TransitionLane → LowPriority    → Scheduler → workLoopConcurrent
```

Lane 的高低与 Scheduler Priority 有映射关系，数值却不是同一套。`SyncLane` 的值是 `1`，Scheduler 的 `ImmediatePriority` 也是 `1`，但同步更新不进这个堆，而是在微任务里把整轮 `workLoopSync` 跑完。`DefaultLane` 和 `TransitionLane` 才分别映射为 Normal 与 Low。

低优 Scheduler 任务尚未开始时，reconciler 可以取消 `root.callbackNode` 并重新投递。并发 Render 一旦开始，`performConcurrentWorkOnRoot` 会先把 `callbackNode` 清掉。此后取消旧 id 影响不到已经在跑的这段工作。新更新要不要丢掉半棵 WIP，由 `rootNeedsRestart` 和当前 render lanes 判断。取消 callback 只处理预约，不会自动丢弃 WIP。

Passive Effect 也投递 `NormalPriority` callback。它没有自己的 Lane，只是借用 Scheduler 的宏任务。`DefaultLane` 同样映射到 `NormalPriority`。这两类任务在堆中使用同一套比较规则，较早的 `startTime` 优先；时间相同则没有稳定的先后保证。Scheduler 不会因为任务是 Effect 就自动把它排到渲染后面。

## 本章回顾

- Scheduler 先比 `priorityLevel`，再比 `startTime`。后入队的高优任务可以先执行。`id` 只用于取消。
- 一次 `postMessage` 只预约一次看堆的机会。5ms deadline 让并发 work loop 在 Fiber 之间暂停。这不是强制抢占，也不承诺已经 paint。
- Lane 决定 React 本轮处理哪档更新，Scheduler 决定 callback 何时获得主线程。取消预约和丢弃半成品 WIP 属于不同层。
- 调试开关会同步执行 callback，绕过堆、MessageChannel 和正常的时间切片。reconciler 目前只把工作投到 Normal 和 Low 两档。

### 源码入口

- `packages/scheduler/src/Scheduler.ts`：`isLess`、`siftUp`、`siftDown`、`popTask`
- `packages/scheduler/src/Scheduler.ts`：`unstable_scheduleCallback`、`unstable_cancelCallback`、`unstable_shouldYield`
- `packages/react-reconciler/src/workLoop.ts`：`workLoopConcurrent`、`performConcurrentWorkOnRoot`
- `packages/react-reconciler/src/workLoop.ts`：`ensureRootIsScheduled`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./16-useEffect与useLayoutEffect.md) · [下一章 →](./18-最小Lane.md)
