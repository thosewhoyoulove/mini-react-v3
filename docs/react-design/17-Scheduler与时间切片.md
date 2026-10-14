# 第 17 章：Scheduler 与时间切片

[← 返回总目录](../../React设计与实现.md) · [上一章](./16-useEffect与useLayoutEffect.md) · [下一章 →](./18-最小Lane.md)

一棵大 Fiber 树如果在一个 JavaScript 任务里从头算到尾，输入和绘制都只能等待。把工作拆开之后又出现两个问题：下一段 callback 该先跑谁，正在执行的 Render 何时暂停？本章用三个最小任务说明：最小堆负责顺序，MessageChannel 负责再次进入主线程，固定 5ms deadline 负责让出。

> 源码范围：`packages/scheduler/src/Scheduler.ts`、`packages/react-reconciler/src/workLoop.ts`
>
> 本章以当前教学仓库为准。官方 React Scheduler 还有 expiration time、延迟任务和 continuation callback 等机制，不能直接由这里的几十行实现外推。

## 本章书签

- [17.1 任务不是 FIFO：先比 `priorityLevel`，再比 `startTime`](#171-任务不是-fifo先比-prioritylevel再比-starttime)
- [17.2 MessageChannel 如何承接任务，5ms 又如何形成时间片](#172-messagechannel-如何承接任务5ms-又如何形成时间片)
- [17.3 `schedule/cancel`、调试同步边界与 Lane 的分工](#173-schedulecancel调试同步边界与-lane-的分工)
- [面试复习](#面试复习)

---

## 17.1 任务不是 FIFO：先比 `priorityLevel`，再比 `startTime`

先假设三个任务按 A、B、C 的顺序加入：

```ts
unstable_scheduleCallback(NormalPriority, () => console.log('A'));
unstable_scheduleCallback(UserBlockingPriority, () => console.log('B'));
unstable_scheduleCallback(NormalPriority, () => console.log('C'));
```

预期不是 `A B C`，而是 `B A C`：B 后入队，但它的优先级数字更小。A 与 C 同为 Normal，才继续按较早的 `startTime` 排序。

当前仓库的 `taskQueue` 是**最小堆**。堆顶 `taskQueue[0]` 始终保存比较结果最小的任务：

```ts
function isLess(a: Task, b: Task): boolean {
  if (a.priorityLevel !== b.priorityLevel) {
    return a.priorityLevel < b.priorityLevel;
  }
  return a.startTime < b.startTime;
}
```

五档优先级的数字越小越靠近堆顶：

```text
ImmediatePriority      1
UserBlockingPriority   2
NormalPriority         3
LowPriority            4
IdlePriority           5
```

因此，当前 Scheduler 不是 FIFO 队列。只有优先级相同且 `startTime` 能反映先后时，执行顺序才表现得像先入先出；实现没有再用 `id` 处理“时间戳完全相同”的稳定排序。

`unstable_scheduleCallback` 的工作很少：

1. 分配递增 `id`，记录 `priorityLevel` 与当前 `startTime`。
2. 把任务追加到数组末尾，再用 `siftUp` 恢复最小堆。
3. `port.postMessage(null)` 预约一个 MessageChannel 宏任务。

`unstable_cancelCallback(id)` 则线性扫描堆，把匹配任务的 `callback` 设为 `null`。它不立即从堆中间删除节点，因为那会额外维护堆结构；之后 `popTask` 弹到这个节点时会跳过它。取消只使尚未开始的 callback 失效，不能撤回已经执行的代码。

这与官方 React 的共同点是都要表达 Scheduler 优先级；但官方实现的排序键和任务生命周期更完整。当前仓库刻意只保留“优先级、开始时间、最小堆”这条主线。

## 17.2 MessageChannel 如何承接任务，5ms 又如何形成时间片

最小堆只决定“下一条是谁”，不会自动让 callback 获得主线程。当前仓库创建一对 MessageChannel port：

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

使用宏任务的目的，是让当前 JavaScript 栈结束后把控制权还给宿主。相比之下，连续使用 `queueMicrotask` 会在浏览器考虑下一轮任务前清空微任务队列，不适合作为这里的切片边界。`setTimeout(..., 0)` 也能形成宏任务，但可能受到定时器最小延迟限制；MessageChannel 更适合快速续接。

不过，“进入下一个宏任务”不等于“浏览器一定已经绘制”。浏览器在任务之间有机会处理输入和渲染，是否实际 paint 仍由宿主决定。Scheduler 本身没有绘制完成信号。

每次 `onmessage` 取出一条任务后，当前仓库设置固定截止时间：

```ts
deadline = unstable_now() + 5;
```

随后 reconciler 的 `workLoopConcurrent` 在每个 Fiber 工作单元之间检查：

```ts
while (workInProgress != null && !unstable_shouldYield()) {
  performUnitOfWork(workInProgress);
}
```

`unstable_shouldYield()` 只是比较 `performance.now()` 是否达到 `deadline`。若达到 5ms，循环退出，`workInProgress` 仍指向下一个待处理 Fiber。`performConcurrentWorkOnRoot` 再通过 `ensureRootIsScheduled` 安排一个 Scheduler 任务，下一拍从断点继续。

这里有三个边界：

- 5ms 是固定时间预算，不是“一帧 16.7ms”的精确切分，也不与刷新率同步。
- 检查发生在 Fiber 单元之间；单个 `performUnitOfWork` 若本身超过 5ms，Scheduler 不能从函数中间抢占。
- 当前 callback 不通过返回 continuation 续跑，而是由 reconciler 显式再次 schedule。官方 Scheduler 支持更完整的 continuation 与宿主调度策略。

## 17.3 `schedule/cancel`、调试同步边界与 Lane 的分工

当前仓库公开的核心操作可以先压缩成两行：

```ts
const id = unstable_scheduleCallback(priorityLevel, callback);
unstable_cancelCallback(id);
```

正常模式下，第一行把 callback 放进最小堆并返回任务 id；第二行可在任务开始前把它作废。`workLoop.ts` 把这个 id 保存到 `root.callbackNode`，当根的调度档位改变时取消旧任务。

`enableSchedulerDebugging` 打开时是一个重要例外：

```ts
if (enableSchedulerDebugging) {
  callback();
  return id;
}
```

此时 callback 在 `unstable_scheduleCallback` 的当前调用栈内**同步执行**，既不入堆，也不经过 MessageChannel，更没有 5ms deadline 所形成的异步切片边界。返回的 id 只是保持 API 形状；之后调用 `unstable_cancelCallback(id)` 找不到对应堆节点，也不可能撤销已经完成的 callback。这个开关用于让教学测试宿主不必等待宏任务，不能拿它观察真实异步调度顺序。

最后必须把 Scheduler 与 Lane 分开：

| 问题 | Lane（reconciler） | Scheduler |
| --- | --- | --- |
| 表达什么 | 哪次 React 更新更急，本轮处理哪些更新 | 已经投递的 callback 谁先获得主线程 |
| 数据放在哪 | Fiber 的 `lanes`、根的 `pendingLanes` | 最小堆中的 `Task` |
| 是否认识 Fiber | 是 | 否，只接收 callback |
| 当前仓库的主要输出 | 选择同步或并发路径、决定是否重启 WIP | 优先级排序、宏任务投递、5ms deadline、取消 |

桥梁是 `ensureRootIsScheduled`：

```text
SyncLane       → queueMicrotask → workLoopSync
DefaultLane    → NormalPriority → Scheduler → workLoopConcurrent
TransitionLane → LowPriority    → Scheduler → workLoopConcurrent
```

所以“Lane 高优先级”和“Scheduler 高优先级”有关联，却不是同一个值体系。SyncLane 甚至不进入 Scheduler，它走微任务并一次执行完。Default 与 Transition 才映射为 Scheduler 的 Normal 与 Low。

如果一个尚未开始的低优 Scheduler 任务需要让路，reconciler 会取消 `root.callbackNode` 再重新投递。若并发 Render 已经做出半棵 WIP，新更新是否要求从根重启，则由 `rootNeedsRestart`、当前 render lanes 等 reconciler 状态判断。取消 callback 与丢弃半成品 WIP 是两件不同的事。

Passive Effect 也会直接投递 `NormalPriority` callback，但它不是一次 Fiber 更新，因此没有为它创建 Lane。它只是借用 Scheduler 的宏任务与排序能力。

## 面试复习

**一句话回答：** 当前 Scheduler 用 `priorityLevel`、再用 `startTime` 排序最小堆；MessageChannel 每次取一条 callback，固定 5ms deadline 让并发 work loop 在 Fiber 之间暂停。Lane 决定 React 更新做什么，Scheduler 决定 callback 何时获得主线程。

**为什么不能说它是 FIFO？** 后加入的高优任务会先于低优任务出堆；同优先级才比较 `startTime`。

**`cancelCallback` 做了什么？** 把尚在堆中的任务 callback 置空，等弹出时跳过。它不撤销已执行代码，也不负责清理 WIP。

**调试开关打开后还有时间切片吗？** `unstable_scheduleCallback` 会同步执行 callback，不经过堆和 MessageChannel，因此失去正常异步切片边界；返回 id 也无法再取消这次执行。

**5ms 到点能打断任意 JavaScript 吗？** 不能。它只在 work loop 主动调用 `shouldYield` 的位置生效，当前 Fiber 单元必须先执行完。

### 源码入口

- `packages/scheduler/src/Scheduler.ts`：`isLess`、`siftUp`、`siftDown`、`popTask`
- `packages/scheduler/src/Scheduler.ts`：`unstable_scheduleCallback`、`unstable_cancelCallback`、`unstable_shouldYield`
- `packages/react-reconciler/src/workLoop.ts`：`workLoopConcurrent`、`performConcurrentWorkOnRoot`
- `packages/react-reconciler/src/workLoop.ts`：`ensureRootIsScheduled`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./16-useEffect与useLayoutEffect.md) · [下一章 →](./18-最小Lane.md)
