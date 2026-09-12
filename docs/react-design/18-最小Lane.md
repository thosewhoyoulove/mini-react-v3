# 第 18 章：最小 Lane：SyncLane 与 DefaultLane

[← 返回总目录](../../React设计与实现.md) · [上一章](./17-Scheduler与时间切片.md) · [下一章 →](./19-HostConfig抽象.md)

> 主文件：`packages/react-reconciler/src/fiberLanes.ts`、`workLoop.ts`
> 上一章讲 Scheduler；本章讲 React 自己的更新优先级 Lane，以及两套体系如何对接。

## 本章书签

- [18.1 两套优先级：Lanes 与 Scheduler Priority](#181-两套优先级lanes-与-scheduler-priority)
- [18.2 SyncLane](#182-synclane)
- [18.3 DefaultLane](#183-defaultlane)
- [18.4 高优插队](#184-高优插队)
- [18.5 本仓库刻意简化了什么](#185-本仓库刻意简化了什么)
- [面试复习](#面试复习)

---

## 18.1 两套优先级：Lanes 与 Scheduler Priority

React 并发更新里常听到两套「优先级」，它们**不是同一件事**，而是分层协作。

可以记成一句话：

> **Lane 是 React 的更新优先级；在本仓库主要决定根下一次约 Sync 还是 Default。Scheduler Priority 是主线程任务的优先级（这段 JS 何时跑、跑多久）。**

### 各管什么

| | Lanes | Scheduler Priority |
| --- | --- | --- |
| 归属 | `react-reconciler`（`fiberLanes.ts`） | 独立包 `scheduler` |
| 问的是 | 这次**更新**多急？根还挂着哪些档位？下一次按哪档投递？ | 这段 **callback** 该多早占用主线程？ |
| 载体 | Fiber / FiberRoot 上的比特位 | 调度队列里的任务档位 |
| 本仓库能做的事 | 合并、剔除、比高低、打断半成品 WIP、决定 sync / concurrent | 约宏任务、切片、`cancel`；（官方）按堆插队 |

若只留 Scheduler：根上无法保存「还有哪些档位待调度」，也无法在高优更新到来时判断是否应取消旧回调、重启 WIP。
若只留 Lane：仍得有人把工作投进浏览器事件循环，并在切片到期时让出主线程——那就是 Scheduler。

这里必须加一条教学版边界：Fiber 上虽然有 `lanes / childLanes`，但 `beginWork` 没有据此 bailout，Hook Update 也没有自己的 Lane。本仓库选出根的下一档以后仍会遍历整棵树，并消费队列中的全部 action；“按 Lane 选择具体 Fiber / Update”是官方完整实现具备、这里尚未实现的能力。

源码里写得很直白：

```ts
// packages/scheduler/src/Scheduler.ts
// 真正的优先级在 reconciler 的 Lane，不在这里。
// SyncLane 根本不会走进这个文件，它走 queueMicrotask。
```

### 本仓库的两档 Lane

Lane 用比特位表示，可按位或合并；**最低置位 = 最高优先级**（`lanes & -lanes`）：

```text
NoLane / NoLanes = 0b00
SyncLane         = 0b01   // 更急
DefaultLane      = 0b10
```

官方还有 InputContinuous、Transition、Idle 等更多 Lane：有的高于 Default，有的低于 Default，还有成组的 Transition Lane。这里不能把它们都理解成“夹在 Sync 与 Default 之间”，只需先记住官方优先级与集合运算更细。

### 映射关系：对接，不是等同

```text
应用更新                         主线程投递
────────                         ────────
root.render  → SyncLane    ──► queueMicrotask（通常不进 Scheduler）
setState     → DefaultLane ──► Scheduler NormalPriority 宏任务
                                 → 可切片 workLoopConcurrent

（官方更细，示意）
输入连续事件 → ContinuousLane → UserBlockingPriority
startTransition → Transition  → Normal / Low 一类
```

对接点在 `ensureRootIsScheduled`（对应官方 `ReactFiberRootScheduler`）：

1. 先看 **Lane**：`getNextLanes` 取出当前最高档；同档已约过则合并；换档则 `cancel` 旧回调。
2. 再选 **怎么投递**：`SyncLane` → `queueMicrotask`；`DefaultLane` → `unstable_scheduleCallback(NormalPriority, …)`。
3. Scheduler 只保证「何时被叫起来、能跑多久」；本仓库被叫起来后会走完整棵树，不按 Fiber 的 Lane 跳过子树。

```text
setState / root.render
    │
    ▼
标 lane → 合并进 root.pendingLanes
    │
    ▼
ensureRootIsScheduled
    ├─ SyncLane    → 微任务 → workLoopSync
    └─ DefaultLane → Scheduler(Normal) → workLoopConcurrent
    │
    ▼
commit 后若 pending 还剩低优 → 再 ensure 一次
```

面试时三句就够：

1. 两套体系：Lane = 更新优先级；Scheduler Priority = 任务调度优先级。
2. 不是一对一死绑：高优 Lane 常**绕开** Scheduler；低优才「Lane → 映射成某个 Priority → 排队」。
3. 在本仓库，Lane 决定走同步还是可切片工作循环；Scheduler 是 concurrent 路径的时钟与让出主线程。不要进一步推导成“Lane 会筛选 Fiber”。

---

## 18.2 SyncLane

谁打 Sync：`updateContainer`（`root.render`）——首屏 / 必须马上画出来的更新。

```ts
export function updateContainer(element: unknown, container: FiberRoot): void {
  container.current.pendingProps = { children: element };
  scheduleUpdateOnFiberImpl(container.current, SyncLane);
}
```

路径：

```text
ensureRootIsScheduled
  → scheduleSyncCallback（queueMicrotask）
  → performSyncWorkOnRoot
  → workLoopSync          // while 不问 shouldYield
  → finishRoot → commit
```

要点：

- **不切片**：一个微任务里把树走完，保证尽快上屏。
- **同一事件里多次 Sync 只约一次微任务**：只更新 `syncRoot` 指针，栈结束后一次性处理。
- **不能接着 Default 的半成品 WIP**：那棵树上已 `beginWork` 过的节点看不到这次 Sync 的新 props / hook 队列；`performSyncWorkOnRoot` 会 `prepareFreshStack` 从根重来。

---

## 18.3 DefaultLane

谁打 Default：用户 `setState`（见 `hooks.ts`）。

路径：

```text
ensureRootIsScheduled
  → unstable_scheduleCallback(NormalPriority, …)
  → performConcurrentWorkOnRoot
  → workLoopConcurrent    // 每单元问 shouldYield
  → 未完成则再 schedule；完成则 finishRoot
```

要点：

- **可切片**：5ms 到了就退出，断点留在 `workInProgress`，下一宏任务续跑。
- **多次 setState 合并**：已约过同一档 `DefaultLane` 时，`ensureRootIsScheduled` 直接返回；更新都堆在 `pendingLanes` / hook 队列里，一个回调消化。
- `getNextLanes`：pending 里**同时有 Sync 与 Default 时只返回 Sync**；Commit 只从 `pendingLanes` 移除本轮的 Sync，所以 Default 位仍会触发后续调度。但 Hook 队列没有按 Lane 筛选，Sync Render 可能已经消费 Default action，后续 Default 因而可能只是一次冗余遍历。

---

## 18.4 高优插队

典型场景：Default 的 concurrent 工作还在排队或切片中途，又来了 Sync（或同档又来了必须看见的新更新）。

`scheduleUpdateOnFiberImpl` 里：

1. `markUpdateLaneFromFiberToRoot`：沿 `return` 标 `lanes` / `childLanes`。
2. 合并进 `root.pendingLanes`。
3. `shouldRestartCurrentRender`：若正在 render **同一 root**，且新更新**同档或更高优** → `rootNeedsRestart = true`（半成品 WIP 必须丢弃）。
4. `ensureRootIsScheduled`：若档位从 Default 换成 Sync → `unstable_cancelCallback` 作废尚未执行的宏任务，改约微任务。

```text
Default 宏任务还在队列里
    │
Sync 到来
    │
cancel 旧 callbackNode
    → 微任务里 performSyncWorkOnRoot
    → 丢掉 WIP，从根 prepareFreshStack
    → workLoopSync → commit
    → ensure：pending 若还剩 Default 位，再约宏任务
```

更**低**优的 Lane：先记在 `pendingLanes`，不打断当前轮；本轮 Commit 后再调度。由于本仓库没有按 Lane 筛选 Hook Update，它描述的是根级调度顺序，不保证低优 action 一定留到低优 Render 才计算。

---

## 18.5 本仓库刻意简化了什么

对照官方时，心里有数即可，不必在本仓库里补齐：

| 官方 | 本仓库 |
| --- | --- |
| 十几条 Lane（Transition、Idle…） | 仅 Sync + Default |
| Scheduler 多优先级堆 | FIFO；换档靠 cancel + 重约 |
| 完整 `lane ↔ SchedulerPriority` 映射表 | Default → `NormalPriority`；Sync 走微任务 |
| `beginWork` bailout、按 `childLanes` 跳过子树等完整优化 | 有 `childLanes` 字段与冒泡，教学路径以能讲清分叉为主 |
| `startTransition` / `useDeferredValue` 等 API | 未实现（见附录 C） |

学完这两章，应能回答：**为什么 setState 可以「让出主线程」，而 root.render 往往「一口气跑完」——因为 Lane 不同，投递路径不同；Scheduler 只服务其中可中断的那一条。**

## 面试复习

### 一句话结论

Lane 是更新优先级和根级调度标记，Scheduler 是 callback 的主线程执行器；本仓库 Sync 插队 Default 时会取消旧任务、丢弃有遗漏新更新风险的 WIP、从根同步重启，残留的 Default 位在 Commit 后再约。

### 面试回答（为什么→机制→仓库落点→官方差异）

为什么：只取消低优任务不够，已经做过 `beginWork` 的半成品可能没看见后来入队的更新；只重建 WIP 也不够，还要保证高优 callback 先获得主线程。机制：更新沿 Fiber 向根标 Lane 并并入 `pendingLanes`；`getNextLanes` 为根的下一次工作选最高档；同 root 正在 Render 时，同档或更高档设置 `rootNeedsRestart`；调度档位变化再 cancel 旧 callback，Sync 走微任务从根重建，完成后重新调度仍残留的 Lane 位。仓库落点：`markUpdateLaneFromFiberToRoot`、`shouldRestartCurrentRender`、`ensureRootIsScheduled`、`prepareFreshStack`。官方差异：本仓库不按 Lane 筛选 Fiber 或 Hook Update；官方才有更完整的跳过/rebase、饥饿与过期策略，Scheduler 也不是本仓库的 FIFO。

### 常见追问

**Q：插队链路能完整说一遍吗？**
A：Sync 到来 → 标记 Fiber/祖先与 `root.pendingLanes` → 若 Default WIP 存在则置重启标记 → cancel 尚未执行的 Default callback → 约 Sync 微任务 → `prepareFreshStack` + `workLoopSync` → Commit 后若仍有 Default 再约宏任务。

**Q：为什么同档更新也要重启 WIP？**
A：若新 Update 在部分 Fiber 已完成 `beginWork` 后入队，直接续跑会漏掉它；本仓库因此把同档也判定为需要重启。

**Q：被插队的 Default 更新丢了吗？**
A：不会凭空丢失，但也不一定留到下一轮 Default 才计算。Default 位仍在 `root.pendingLanes`，而 Sync Render 会消费没有 Lane 字段的 Hook 队列；随后残留 Default 位仍会再约一次工作，可能只是冗余 Render。

**Q：取消的是 Lane 还是 Scheduler task？**
A：取消的是 `root.callbackNode` 对应的 task callback；Lane 仍保存在 Fiber/root 上，后续可以重新预约。

### 容易说错

- 不要把 Lane 与 Scheduler Priority 当成同一个枚举或一一对应关系。
- 不要说取消回调会自动撤销已构建的 WIP；WIP 由 reconciler 显式清空并重建。
- 不要说本仓库能在单条 Hook 队列内按 Lane 跳过更新；这里所有 `setState` 都是 DefaultLane。
- 不要说本仓库会根据 `childLanes` 只处理部分 Fiber；字段会冒泡，但 `beginWork` 尚未用它 bailout。
- 不要把官方 Scheduler 的优先级堆套到本仓库 FIFO 实现。

### 源码入口

- `packages/react-reconciler/src/fiberLanes.ts`：`getNextLanes`、`getHighestPriorityLane`
- `packages/react-reconciler/src/workLoop.ts`：`markUpdateLaneFromFiberToRoot`
- `packages/react-reconciler/src/workLoop.ts`：`shouldRestartCurrentRender`、`ensureRootIsScheduled`
- `packages/react-reconciler/src/workLoop.ts`：`performSyncWorkOnRoot`、`performConcurrentWorkOnRoot`、`prepareFreshStack`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./17-Scheduler与时间切片.md) · [下一章 →](./19-HostConfig抽象.md)
