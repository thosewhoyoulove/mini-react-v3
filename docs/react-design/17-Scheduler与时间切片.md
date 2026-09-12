# 第 17 章：Scheduler 与时间切片

[← 返回总目录](../../React设计与实现.md) · [上一章](./16-useEffect与useLayoutEffect.md) · [下一章 →](./18-最小Lane.md)

> 主文件：`packages/scheduler/src/Scheduler.ts`
> 本章只讲「主线程上的任务怎么排队、怎么让出」。更新有多急、根下一次走同步还是可切片路径，见 [第 18 章](./18-最小Lane.md) 的 Lane。

浏览器一帧通常以约 16ms 作为直觉参照。若 React 在一个任务里把大树全部 reconcile，输入和绘制都会卡住。本仓库把工作拆成多个 MessageChannel 任务：每个任务设置 5ms deadline，`workLoop` 反复问 `shouldYield()`，到点就停。它不与浏览器帧边界严格对齐。

## 本章书签

- [17.1 为什么用 MessageChannel](#171-为什么用-messagechannel)
- [17.2 5ms deadline 与 `shouldYield`](#172-5ms-deadline-与-shouldyield)
- [17.3 `schedule` / `cancel`](#173-schedule--cancel)
- [17.4 和 Lane 的分工](#174-和-lane-的分工)
- [面试复习](#面试复习)

---

## 17.1 为什么用 MessageChannel

要把「现在立刻跑完整棵树」拆开，必须把后续工作排进**宏任务**：当前这段 JS 跑完后，浏览器有机会先绘制、处理输入，再执行下一拍。

常见投递方式对比：

| 方式 | 问题 |
| --- | --- |
| `setTimeout(fn, 0)` | 最小延迟常被夹到 4ms+，切片之间空隙大 |
| `Promise` / `queueMicrotask` | 微任务会在绘制前把队列清空，切不出去 |
| **MessageChannel** | `port.postMessage` 排一个较及时的宏任务：当前 JS 结束 → 可先绘制/输入 → 再 `onmessage` |

本仓库用一对 port：往 `port2` 发消息，`port1.onmessage` 被触发时从队列取出一个 task 执行。

```text
unstable_scheduleCallback
    → taskQueue.push
    → port.postMessage(null)
    →（宏任务）onmessage：设 deadline，跑 callback
    → 队列还有 → 再 postMessage
```

`SyncLane` **不会**走进这个文件，它走 `queueMicrotask`（第 18 章）。Scheduler 服务的是可中断的并发路径（以及 Commit 后延后的 `useEffect`）。

---

## 17.2 5ms deadline 与 `shouldYield`

每个切片开始时：

```ts
deadline = performance.now() + yieldInterval; // yieldInterval = 5
```

`workLoopConcurrent` 每处理完一个 Fiber 就问：

```ts
export function unstable_shouldYield(): boolean {
  return performance.now() >= deadline;
}
```

到点则退出循环，`workInProgress` 停在下一个节点；`ensureRootIsScheduled` 再约一拍宏任务，从断点继续。官方会随帧率调整切片长度，教学版写死 5ms，方便对着源码讲。

---

## 17.3 `schedule` / `cancel`

```ts
unstable_scheduleCallback(priorityLevel, callback) → task id
unstable_cancelCallback(id)  // 把对应 task.callback 置 null
```

导出的档位与官方对齐（数字越小越急）：

```text
ImmediatePriority      = 1
UserBlockingPriority   = 2
NormalPriority         = 3   ← 本仓库 DefaultLane / Passive effect 用这个
LowPriority            = 4
IdlePriority           = 5
```

**官方** Scheduler 会按 priority 进不同优先级堆。**本仓库仍是 FIFO**：`priorityLevel` 参数接了，但不靠堆插队；档位切换靠 reconciler **cancel 掉旧 task，再约新的**（典型：Default 还没跑，Sync 插队）。

`root.callbackNode` 记下 task id，正是为了能被 `unstable_cancelCallback` 作废。

---

## 17.4 和 Lane 的分工

一句话：**Scheduler 不认识 Fiber；真正的更新优先级在 reconciler 的 Lane。**

| | Scheduler（本章） | Lane（第 18 章） |
| --- | --- | --- |
| 问的是 | 这段 callback 何时占用主线程、跑多久 | 这次更新多急、根下一次按哪档投递 |
| 载体 | 任务队列 + deadline | Fiber / `pendingLanes` 比特位 |
| 本仓库职责 | 宏任务、5ms 切片、按 id 取消 | 决定 sync / concurrent、插队重启 |

对接发生在 `ensureRootIsScheduled`：先看最高 Lane，再决定投递方式——`SyncLane` → 微任务；`DefaultLane` → `unstable_scheduleCallback(NormalPriority, …)`。细节与对照表见下一章。

## 面试复习

### 一句话结论

Scheduler 只负责把 callback 放进主线程并用 5ms deadline 让出；Lane 才决定更新优先级与本轮 Render，而本仓库 Scheduler 是 FIFO，不具备官方优先级堆的原生插队能力。

### 面试回答（为什么→机制→仓库落点→官方差异）

为什么：React 既要表达「哪次更新更急」，又要控制「一段 JS 占用主线程多久」，两者不是一个问题。机制：Lane 在 reconciler 选择 Sync/Default；Default 映射为 Scheduler 宏任务并在 Fiber 单元之间检查 `shouldYield`，Sync 直接走微任务。仓库落点：`Scheduler.ts` 维护 FIFO `taskQueue`、deadline 和按 id 取消；`workLoop.ts` 的 `ensureRootIsScheduled` 做 Lane 到投递方式的桥接。官方差异：官方 Scheduler 用优先级堆和更完整的过期时间；本仓库忽略传入的 `priorityLevel` 排序，所谓插队依靠 reconciler 取消旧 callback、另走更早的微任务。

### 常见追问

**Q：Sync 如何插队一个尚未执行的 Default？**
A：Lane 层先发现更高优更新；`ensureRootIsScheduled` 把旧 task 的 callback 置空，再预约 Sync 微任务。不是 FIFO Scheduler 自己把 Sync 插到队首。

**Q：取消 task 是否等于丢弃半成品 WIP？**
A：不等于。取消只阻止旧 callback 执行；若 Default 已经切片产生 WIP，还要由 work loop 设置/检查重启状态并从根 `prepareFreshStack`。

**Q：切片暂停后为何能续跑，而插队后为何要重启？**
A：单纯超时没有新数据，`workInProgress` 可保留断点；同档或更高优更新到来后，已处理节点可能没看见新队列，所以半成品必须丢弃。

**Q：Passive effect 走 Scheduler，是否也有 Lane？**
A：没有。它直接预约 `NormalPriority` callback，只借用宏任务通道，不参与更新 Lane 选择。

### 容易说错

- 不要说 Scheduler 决定 Fiber 更新优先级；它甚至不认识 Fiber。
- 不要说本仓库 Scheduler 会按五档 priority 排序；常量存在，但队列严格 FIFO。
- 不要把 `cancelCallback` 与 WIP 重启混成一步；一个管任务，一个管 Render 状态。

### 源码入口

- `packages/scheduler/src/Scheduler.ts`：`unstable_scheduleCallback`、`unstable_cancelCallback`、`unstable_shouldYield`
- `packages/react-reconciler/src/workLoop.ts`：`workLoopConcurrent`
- `packages/react-reconciler/src/workLoop.ts`：`ensureRootIsScheduled`、`performConcurrentWorkOnRoot`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./16-useEffect与useLayoutEffect.md) · [下一章 →](./18-最小Lane.md)
