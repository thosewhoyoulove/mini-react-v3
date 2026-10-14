# 第 18 章：最小 Lane：三档更新怎样排队

[← 返回总目录](../../React设计与实现.md) · [上一章](./17-Scheduler与时间切片.md) · [下一章 →](./19-HostConfig抽象.md)

> 主文件：`packages/react-reconciler/src/fiberLanes.ts`、`workLoop.ts`

一次普通 `setState` 还没渲染完，`root.render` 和 `startTransition` 又先后到来：React 应该继续上次的断点，还是丢掉半成品重来？谁决定先做哪次更新，谁又负责把任务交还给浏览器？Lane 正是用来回答这些问题的。

## 本章书签

- [18.1 从三个数字理解 Lane](#181-从三个数字理解-lane)
- [18.2 根怎样选择并调度下一档工作](#182-根怎样选择并调度下一档工作)
- [18.3 何时续跑何时重启以及能跳过什么](#183-何时续跑何时重启以及能跳过什么)
- [面试复习](#面试复习)
- [源码入口](#源码入口)

---

## 18.1 从三个数字理解 Lane

先看本仓库的最小模型：

```ts
SyncLane       = 0b001; // 1
DefaultLane    = 0b010; // 2
TransitionLane = 0b100; // 4
```

Lane 是一个比特位，表示一次更新的优先级。多个更新可以用按位或放进同一个集合：

```text
Default | Transition = 0b010 | 0b100 = 0b110
Sync    | Default    = 0b001 | 0b010 = 0b011
```

数值小的置位更靠右，优先级更高。`getHighestPriorityLane(lanes)` 用 `lanes & -lanes` 取最低置位，所以 `0b111` 的结果是 `0b001`，也就是 Sync。

三档 Lane 的来源并不相同：

| Lane | 本仓库中的来源 | 后续执行方式 |
| --- | --- | --- |
| `SyncLane = 1` | `root.render(element)` 经 `updateContainer` 发起 | 微任务中的 `workLoopSync`，不中途让出 |
| `DefaultLane = 2` | 普通 `setState` / reducer dispatch | Scheduler 的 `NormalPriority` 任务，可时间切片 |
| `TransitionLane = 4` | `startTransition(() => setState(...))` 内的更新 | Scheduler 的 `LowPriority` 任务，可时间切片 |

`startTransition` 会在调用 `scope` 时暂时设置 `ReactCurrentBatchConfig.transition`。Hook dispatch 在入队时读取它：非空就选 Transition，否则选 Default。这里标记的是**更新从哪里来、应该多急**，不是把回调本身立刻放进浏览器队列。

Lane 与 Scheduler Priority 因而是两层概念：

- Lane 属于 reconciler，记录 Fiber 和根上还有哪档更新，并决定下一轮渲染处理哪一档。
- Scheduler Priority 属于调度器，决定 callback 在任务队列里的先后顺序。

本仓库的 Scheduler 不是 FIFO，而是**优先级最小堆**：先比较 `priorityLevel`，同档再比较 `startTime`。`SyncLane` 不进这个堆，直接走 `queueMicrotask`；Default 和 Transition 才分别映射到 Normal 与 Low。Lane 与 Scheduler Priority 会对接，但不是同一个枚举，也不是完整的一一对应。

> **官方 React 的边界**
>
> 官方 React 有更多 Lane、成组的 Transition Lane、过期与饥饿处理，也有更完整的 Lane 到 Scheduler Priority 映射。本仓库只保留 `1 / 2 / 4` 三档，用来讲清根级选档、插队和时间切片，不能据此推断官方只有三种优先级。

## 18.2 根怎样选择并调度下一档工作

假设根上先后收到 Default 和 Transition：

```text
root.pendingLanes = 0b010 | 0b100 = 0b110
```

`pendingLanes` 是根的待办集合。一次更新从 Fiber 出发后，`scheduleUpdateOnFiberImpl` 会做三件事：

```text
sourceFiber.lanes 标当前节点
        │
        ├─ 沿 return 把 lane 合进祖先 childLanes
        │
        └─ 把 lane 合进 root.pendingLanes
                         │
                         ▼
                ensureRootIsScheduled
```

接着，三个函数各管一层：

1. `getNextLanes(root)` 按 Sync → Default → Transition 的顺序，从 `pendingLanes` 只选当前最高档。
2. `getHighestPriorityLane(nextLanes)` 取得本次 callback 的优先级标记。
3. `ensureRootIsScheduled(root)` 比较旧预约与新预约，决定复用、取消还是重新投递。

最小流程如下：

```text
pendingLanes
    │
    ▼
getNextLanes
    ├─ Sync       → queueMicrotask → performSyncWorkOnRoot
    ├─ Default    → Scheduler(Normal) → performConcurrentWorkOnRoot
    └─ Transition → Scheduler(Low)    → performConcurrentWorkOnRoot
```

同一档 callback 已经存在时，`ensureRootIsScheduled` 直接返回。连续三次普通 `setState` 因而不会预约三个 Default callback；三个 action 留在 Hook 队列里，根只保留一个 Default 位。

如果新选出的档位不同，尚未开始的旧 Scheduler callback 会被 `unstable_cancelCallback` 取消，再按新档位预约。例如 Transition 已在堆中、Default 随后到来，旧 Low callback 会作废，根改约 Normal callback。Lane 本身没有被取消，它仍在 `pendingLanes`，本轮 commit 后会再次选择剩余的最低档。

完成一轮时，`markRootFinished` 只从 `pendingLanes` 删除本轮 `renderedLanes`。假设原来是 `Sync | Default`，Sync commit 后还剩 Default；`finishRoot` 最后再次调用 `ensureRootIsScheduled`，Default 才获得下一次 callback。

> **不要把“选 Lane”理解成“Scheduler 自己懂 React 更新”。**
>
> Scheduler 只看 callback 的 Priority，并用堆决定先执行哪条任务；`pendingLanes`、`getNextLanes` 和 commit 后的剩余工作都由 reconciler 管理。

## 18.3 何时续跑何时重启，以及能跳过什么

可切片渲染第一次被唤醒时，`prepareFreshStack` 从根创建 WIP。`workLoopConcurrent` 每处理一个 Fiber 都询问 `unstable_shouldYield()`；5ms 时间片耗尽时，它保留全局 `workInProgress`：

```text
第一拍：A → B → C → 时间到，workInProgress 指向 D
第二拍：从 D 继续 → E → F → 完成
```

这只是**没有新更新时的时间片续跑**。如果渲染途中又入队更新，旧 WIP 上已经执行过 `beginWork` 的节点可能看不到新 action，不能无条件沿断点继续。

本仓库用 `shouldRestartCurrentRender` 区分：

- 同一 root 收到**同档或更高优**更新：设置 `rootNeedsRestart`，丢弃半成品 WIP，从根重新 `prepareFreshStack`。
- 收到**更低优**更新：只记进 `pendingLanes`，当前轮继续，commit 后再处理。
- Sync 到来：除了要求重启，还会取消旧 Scheduler callback，改走微任务；`performSyncWorkOnRoot` 明确清空断点，并用 `workLoopSync` 一次跑完。

因此，“切片后续跑”和“新更新重启”不是一回事：

```text
只是 shouldYield
  → 保留 workInProgress
  → 下一 Scheduler callback 从断点续跑

同档 / 更高档更新到来
  → rootNeedsRestart = true
  → 丢弃 workInProgress
  → 从 HostRoot 重建 WIP
```

Lane 也确实参与 Fiber 级跳过。`beginWork` 的 `canSkipUpdate` 会检查：

```text
fiber.lanes      与 renderLanes 无交集
fiber.childLanes 与 renderLanes 无交集
props / ref 相同
context 没变化
```

四项都满足时，函数组件、Fragment、Provider、ForwardRef、Memo 或 Suspense 等分支可以 bailout，不再执行对应组件逻辑。`completeWork` 又会把孩子的 `lanes / childLanes` 向父级汇总，供下一轮判断。这个仓库并非“完全不会按 Lane 跳过 Fiber”。

但这里有一个重要的教学简化：**Hook Update 自身没有 `lane` 字段。** `updateState` / `updateReducer` 一旦处理到某条 Hook 队列，就会按入队顺序重放整环 action，并把 `baseQueue` 清空。于是：

- Fiber 层能借助 `lanes / childLanes` 决定某些子树是否进入；
- 一旦进入某个有更新的 Hook，队列内不能再按 Sync、Default、Transition 分别跳过和 rebase；
- 高优 render 可能提前消费同一队列里的低优 action，而根上残留的低优 Lane 之后还会触发一次可能冗余的渲染。

官方 React 会给 Update 携带 Lane，并保留被跳过的更新与基准状态，之后再 rebase。本仓库只实现了 Fiber 级 bailout，没有实现官方完整的 Update 级筛选；这两层不能混为一谈。

## 面试复习

**一句话：** Lane 管“哪档 React 更新先算”，Scheduler 的优先级堆管“哪个 callback 先获得主线程”；时间片结束可以续跑，新来的同档或更高档更新则让当前 WIP 从根重启。

**Q：三档 Lane 从哪里来？**

A：`root.render` 是 Sync；普通 Hook dispatch 是 Default；`startTransition` 调用栈内的 Hook dispatch 是 Transition，数值依次为 `1 / 2 / 4`。

**Q：本仓库是否会按 Lane 跳过工作？**

A：会。`beginWork` 确实检查 Fiber 的 `lanes / childLanes` 做 bailout；但 Hook Update 没有 Lane，进入队列后会整队消费，没有官方 React 的跳过与 rebase。

**Q：Scheduler 为什么仍然需要优先级？**

A：Lane 先决定投递哪类 callback；Default 和 Transition callback 进入 Scheduler 最小堆后，还要由 Normal / Low Priority 决定出堆顺序。Sync 则绕过 Scheduler，走微任务。

### 源码入口

- `packages/react-reconciler/src/fiberLanes.ts`：三档 Lane、集合运算、`getNextLanes`
- `packages/react-reconciler/src/workLoop.ts`：`markUpdateLaneFromFiberToRoot`、`ensureRootIsScheduled`、续跑与重启
- `packages/react-reconciler/src/beginWork.ts`：基于 `lanes / childLanes` 的 bailout
- `packages/react-reconciler/src/hooks.ts`：Lane 来源、无 Lane 的 Hook Update 队列
- `packages/scheduler/src/Scheduler.ts`：Priority 最小堆与 5ms 时间片

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./17-Scheduler与时间切片.md) · [下一章 →](./19-HostConfig抽象.md)
