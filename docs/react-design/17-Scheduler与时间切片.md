# 第 17 章：Scheduler 与时间切片

[← 返回总目录](../../React设计与实现.md) · [上一章](./16-useEffect与useLayoutEffect.md) · [下一章 →](./18-最小Lane.md)

一棵大 Fiber 树若在一个 JavaScript 任务中从头算到尾，用户输入和页面绘制都要排在它后面。把 Render 拆成几段可以缓解阻塞，但拆开只是第一步：多个 callback 等待执行时谁先开始，一段工作又该在哪里暂停？这个教学版 Scheduler 分别用最小堆、MessageChannel 和固定 5ms deadline 回答这两个问题。

> 源码范围：`packages/scheduler/src/Scheduler.ts`、`packages/react-reconciler/src/workLoop.ts`
>
> 官方 React Scheduler 还处理 expiration time、延迟任务和 continuation callback 等机制。本章只沿着这里实现的优先级排序与时间切片展开。

## 17.1 任务不是 FIFO：先比 `priorityLevel`，再比 `startTime`

三个任务依次入队，B 却会最先打印：

```ts
unstable_scheduleCallback(NormalPriority, () => console.log('A'));
unstable_scheduleCallback(UserBlockingPriority, () => console.log('B'));
unstable_scheduleCallback(NormalPriority, () => console.log('C'));
```

输出是 `B A C`。B 虽然后入队，优先级数字却比 A、C 小；A 和 C 同为 Normal，才继续比较较早的 `startTime`。

`taskQueue` 不是普通的先进先出队列，而是最小堆。数组首项 `taskQueue[0]` 始终保存比较结果最小的任务，比较函数正好对应刚才的输出：

```ts
function isLess(a: Task, b: Task): boolean {
  if (a.priorityLevel !== b.priorityLevel) {
    return a.priorityLevel < b.priorityLevel;
  }
  return a.startTime < b.startTime;
}
```

五档优先级从 1 到 5，数字越小，任务越靠近堆顶：

```text
ImmediatePriority      1
UserBlockingPriority   2
NormalPriority         3
LowPriority            4
IdlePriority           5
```

同档任务通常按入队时间表现为 FIFO，不过实现没有用 `id` 处理时间戳完全相同的情况，所以这不是严格的稳定排序。`unstable_scheduleCallback` 创建递增 `id`，记录优先级和 `startTime`，再把任务放到数组末尾，通过 `siftUp` 恢复最小堆；随后调用 `port.postMessage(null)`，预约一次 MessageChannel 宏任务。

取消任务时，`unstable_cancelCallback(id)` 线性扫描堆，把匹配项的 `callback` 改成 `null`。它没有从堆中间抽走节点，也就不必立即修复堆结构。等 `popTask` 取到这项时再跳过即可。已经开始执行的代码不会被这次取消撤回。

## 17.2 MessageChannel 如何承接任务，5ms 又如何形成时间片

最小堆选出了下一个任务，但堆本身不会获得主线程。真正的唤醒过程由 MessageChannel 串起来：

```text
schedule callback
  → push + siftUp
  → port2.postMessage(null)
  → 后续宏任务触发 port1.onmessage
  → popTask 取堆顶
  → 设置 deadline
  → 执行一条 callback
  → 堆中还有任务，再 postMessage
```

`postMessage` 让当前 JavaScript 栈先结束，再从后续宏任务继续。若改成连续的 `queueMicrotask`，浏览器会先清空微任务队列，不适合作为这里的切片间隔；`setTimeout(..., 0)` 虽然也能产生宏任务，却可能受到定时器最小延迟影响。MessageChannel 提供了更直接的快速续接。

宏任务切开了两段 JavaScript，却没有承诺中间一定发生绘制。浏览器有机会处理输入和渲染，是否实际 paint 仍由宿主决定，Scheduler 手中没有绘制完成信号。

每次 `onmessage` 取出一条任务，都会设置固定截止时间：

```ts
deadline = unstable_now() + 5;
```

reconciler 随后处理 Fiber，并在每个工作单元之间询问是否到点：

```ts
while (workInProgress != null && !unstable_shouldYield()) {
  performUnitOfWork(workInProgress);
}
```

`unstable_shouldYield()` 只比较 `performance.now()` 与 `deadline`。一旦 5ms 用完，循环退出，`workInProgress` 仍指向下一个待处理 Fiber。`performConcurrentWorkOnRoot` 再经 `ensureRootIsScheduled` 安排 Scheduler 任务，下一次从这个断点继续。

这里的 5ms 是固定预算，不是按 16.7ms 一帧精确切分，也不随屏幕刷新率变化。检查只发生在 Fiber 单元之间，如果单次 `performUnitOfWork` 已经耗时超过 5ms，也要等它返回后才能让出。这个实现也没有通过 callback 返回 continuation，而是由 reconciler 显式重新 schedule；官方 Scheduler 在这些方面更完整。

## 17.3 `schedule/cancel`、调试同步边界与 Lane 的分工

从调用方看，Scheduler 的入口很简洁：

```ts
const id = unstable_scheduleCallback(priorityLevel, callback);
unstable_cancelCallback(id);
```

正常模式下，第一行入堆并返回任务 id，第二行可以在 callback 开始前将它作废。`workLoop.ts` 会把 id 保存到 `root.callbackNode`；根的调度档位变化时，reconciler 用它取消旧预约。

`enableSchedulerDebugging` 打开后，执行路径完全不同：

```ts
if (enableSchedulerDebugging) {
  callback();
  return id;
}
```

callback 会在 `unstable_scheduleCallback` 的调用栈里同步执行，不入堆，也不经过 MessageChannel，自然没有 5ms deadline 带来的异步切片。返回 id 只是维持 API 形状，之后拿它取消时，堆里也找不到对应任务。这个开关方便教学测试立即得到结果，不适合用来观察正常调度顺序。

走到这里，还需要把 Scheduler 与 Lane 放回各自的位置：

| 问题 | Lane（reconciler） | Scheduler |
| --- | --- | --- |
| 表达什么 | 哪次 React 更新更急，本轮处理哪些更新 | 已投递的 callback 谁先获得主线程 |
| 数据放在哪 | Fiber 的 `lanes`、根的 `pendingLanes` | 最小堆中的 `Task` |
| 是否认识 Fiber | 是 | 否，只接收 callback |
| 这里的主要职责 | 选择同步或并发路径、判断是否重启 WIP | 排序、宏任务投递、5ms deadline、取消 |

两者在 `ensureRootIsScheduled` 接上：

```text
SyncLane       → queueMicrotask → workLoopSync
DefaultLane    → NormalPriority → Scheduler → workLoopConcurrent
TransitionLane → LowPriority    → Scheduler → workLoopConcurrent
```

Lane 的高低与 Scheduler Priority 有映射关系，却不是同一套值。SyncLane 绕过 Scheduler，进入微任务后同步跑完整轮工作；Default 和 Transition 才分别映射为 Normal 与 Low。

低优 Scheduler 任务尚未开始时，reconciler 可以取消 `root.callbackNode` 并重新投递。若并发 Render 已经做出半棵 WIP，新更新是否需要从根重启，要由 `rootNeedsRestart` 和当前 render lanes 等 reconciler 状态判断。取消 callback 只处理预约，不等于丢弃 WIP。

Passive Effect 也会投递 `NormalPriority` callback。它不是 Fiber 更新，没有自己的 Lane，只是借用了 Scheduler 的宏任务和排序能力。

## 本章回顾

- Scheduler 用 `priorityLevel`、再用 `startTime` 比较最小堆；后入队的高优任务可以先执行。
- MessageChannel 把工作接到后续宏任务，5ms deadline 让并发 work loop 在 Fiber 单元之间主动暂停，既不是强制抢占，也不承诺已经 paint。
- Lane 决定 React 本轮处理哪档更新，Scheduler 决定 callback 何时获得主线程；取消预约与丢弃半成品 WIP 属于不同层。
- 调试开关会同步执行 callback，绕过堆、MessageChannel 和正常的时间切片路径。

### 源码入口

- `packages/scheduler/src/Scheduler.ts`：`isLess`、`siftUp`、`siftDown`、`popTask`
- `packages/scheduler/src/Scheduler.ts`：`unstable_scheduleCallback`、`unstable_cancelCallback`、`unstable_shouldYield`
- `packages/react-reconciler/src/workLoop.ts`：`workLoopConcurrent`、`performConcurrentWorkOnRoot`
- `packages/react-reconciler/src/workLoop.ts`：`ensureRootIsScheduled`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./16-useEffect与useLayoutEffect.md) · [下一章 →](./18-最小Lane.md)
