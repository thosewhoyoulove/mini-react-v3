# 第 17 章：Scheduler 与时间切片

[← 返回总目录](../../React设计与实现.md) · [上一章](./16-useEffect与useLayoutEffect.md) · [下一章 →](./18-最小Lane.md)

> 主文件：`packages/scheduler/src/Scheduler.ts`  
> 本章只讲「主线程上的任务怎么排队、怎么让出」。更新有多急、树上怎么走，见 [第 18 章](./18-最小Lane.md) 的 Lane。

浏览器一帧大约 16ms。若 React 在一个任务里把大树全部 reconcile，输入和绘制都会卡住。Scheduler 把工作拆成「每帧只干一小段」：投到宏任务里，设 deadline，`workLoop` 反复问 `shouldYield()`，到点就停。

## 本章书签

- [17.1 为什么用 MessageChannel](#171-为什么用-messagechannel)
- [17.2 5ms deadline 与 `shouldYield`](#172-5ms-deadline-与-shouldyield)
- [17.3 `schedule` / `cancel`](#173-schedule--cancel)
- [17.4 和 Lane 的分工](#174-和-lane-的分工)

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
| 问的是 | 这段 callback 何时占用主线程、跑多久 | 这次更新多急、本轮 render 哪些 |
| 载体 | 任务队列 + deadline | Fiber / `pendingLanes` 比特位 |
| 本仓库职责 | 宏任务、5ms 切片、按 id 取消 | 决定 sync / concurrent、插队重启 |

对接发生在 `ensureRootIsScheduled`：先看最高 Lane，再决定投递方式——`SyncLane` → 微任务；`DefaultLane` → `unstable_scheduleCallback(NormalPriority, …)`。细节与对照表见下一章。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./16-useEffect与useLayoutEffect.md) · [下一章 →](./18-最小Lane.md)
