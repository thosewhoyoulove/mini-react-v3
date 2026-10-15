# 第 18 章：最小 Lane：三档更新怎样排队

[← 返回总目录](../../React设计与实现.md) · [上一章](./17-Scheduler与时间切片.md) · [下一章 →](./19-HostConfig抽象.md)

一次普通 `setState` 还没渲染完，`root.render` 和 `startTransition` 又先后带来更新。正在计算的半棵 WIP 是从断点继续，还是回到根重新开始？新旧更新又该先处理哪一档？Lane 记录更新的紧急程度，让 reconciler 能在根上选出下一批工作。

> 主文件：`packages/react-reconciler/src/fiberLanes.ts`、`workLoop.ts`

## 18.1 从三个数字理解 Lane

这个教学实现只保留三个 Lane：

```ts
SyncLane       = 0b001; // 1
DefaultLane    = 0b010; // 2
TransitionLane = 0b100; // 4
```

每个 Lane 占一个比特位，多档更新可以用按位或放进同一个集合。比如 Default 与 Transition 同时待处理时，集合就是 `0b010 | 0b100 = 0b110`。

优先级越高，置位越靠右。`getHighestPriorityLane(lanes)` 通过 `lanes & -lanes` 取出最低置位，所以从 `0b111` 得到的是 `0b001`，也就是 Sync。三个 Lane 的来源和执行路径如下：

| Lane | 更新从哪里来 | 后续执行方式 |
| --- | --- | --- |
| `SyncLane = 1` | `root.render(element)` 经 `updateContainer` 发起 | 微任务中的 `workLoopSync`，不中途让出 |
| `DefaultLane = 2` | 普通 `setState` / reducer dispatch | Scheduler 的 `NormalPriority` 任务，可时间切片 |
| `TransitionLane = 4` | `startTransition(() => setState(...))` 内的更新 | Scheduler 的 `LowPriority` 任务，可时间切片 |

`startTransition` 调用 `scope` 时，会暂时设置 `ReactCurrentBatchConfig.transition`。Hook dispatch 在更新入队时读取它：有 transition 就选择 Transition，否则选择 Default。Lane 标在更新传播经过的 Fiber 和根上，表达这次更新来自哪条路径、应当多快处理；它不是浏览器任务。

Scheduler Priority 属于另一层。Lane 留在 reconciler 中，决定本轮选择哪档 React 更新；Scheduler Priority 留在任务队列中，决定已经投递的 callback 谁先执行。SyncLane 直接走 `queueMicrotask`，不会进入 Scheduler 最小堆；Default 和 Transition 才映射到 Normal 和 Low。这两套值彼此衔接，并非同一个枚举。

官方 React 有更多 Lane，还要处理成组的 Transition Lane、过期和饥饿等情况。这里的 `1 / 2 / 4` 只用于讲清根级选档、插队和时间切片，并不表示 React 只有三种优先级。

## 18.2 根怎样选择并调度下一档工作

假设 Default 和 Transition 先后到达同一个根：

```text
root.pendingLanes = 0b010 | 0b100 = 0b110
```

`pendingLanes` 是这个根尚未完成的 Lane 集合。更新从 Fiber 出发后，`scheduleUpdateOnFiberImpl` 先给源 Fiber 的 `lanes` 加上对应位，再沿 `return` 链把它合入祖先的 `childLanes`，最后写进根的 `pendingLanes`：

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

根有了待办集合，`getNextLanes(root)` 按 Sync、Default、Transition 的顺序只选最高档；`getHighestPriorityLane(nextLanes)` 取出本次 callback 的优先级标记；`ensureRootIsScheduled(root)` 再比较已有预约，决定沿用、取消或重新投递。

```text
pendingLanes
    │
    ▼
getNextLanes
    ├─ Sync       → queueMicrotask → performSyncWorkOnRoot
    ├─ Default    → Scheduler(Normal) → performConcurrentWorkOnRoot
    └─ Transition → Scheduler(Low)    → performConcurrentWorkOnRoot
```

如果同档 callback 已经存在，`ensureRootIsScheduled` 直接复用。连续三次普通 `setState` 的 action 会留在 Hook 队列中，根只需要一个 Default callback，而不是预约三次。

新选出的档位不同，尚未开始的旧 Scheduler callback 会被 `unstable_cancelCallback` 作废，再按新档位投递。比如 Low callback 还在等待时来了 Default 更新，根会改约 Normal callback。被替换的只是 callback 预约，TransitionLane 仍保留在 `pendingLanes`。

一轮渲染完成后，`markRootFinished` 只删除本轮的 `renderedLanes`。若原集合是 `Sync | Default`，Sync commit 后还剩 Default；`finishRoot` 再次调用 `ensureRootIsScheduled`，剩下的 Default 才拿到 callback。Scheduler 在这段过程里只认识 callback 和 Priority，根上的 Lane 选择及剩余工作始终由 reconciler 维护。

## 18.3 何时续跑何时重启，以及能跳过什么

并发渲染第一次开始时，`prepareFreshStack` 从根创建 WIP。`workLoopConcurrent` 每做完一个 Fiber 都调用 `unstable_shouldYield()`。5ms 时间片用完后，全局 `workInProgress` 保留着下一个节点：

```text
第一拍：A → B → C → 时间到，workInProgress 指向 D
第二拍：从 D 继续 → E → F → 完成
```

只要期间没有新更新，下一次 Scheduler callback 就能从 D 接着做。若渲染过程中又有 action 入队，旧 WIP 上已经执行过 `beginWork` 的节点可能看不到它，此时是否续跑要重新判断。

`shouldRestartCurrentRender` 处理的正是这种情况。同一个 root 收到同档或更高优更新时，它会设置 `rootNeedsRestart`，让半成品 WIP 被丢弃，并从根重新执行 `prepareFreshStack`。更低优更新只加入 `pendingLanes`，当前轮继续，等 commit 后再处理。Sync 更新除了要求重启，还会取消旧 Scheduler callback，改走微任务；`performSyncWorkOnRoot` 清空断点，用 `workLoopSync` 一次跑完。

```text
只是 shouldYield
  → 保留 workInProgress
  → 下一 Scheduler callback 从断点续跑

同档 / 更高档更新到来
  → rootNeedsRestart = true
  → 丢弃 workInProgress
  → 从 HostRoot 重建 WIP
```

Lane 不只在根上选档，也参与 Fiber 级 bailout。`beginWork` 的 `canSkipUpdate` 会查看 `fiber.lanes` 和 `fiber.childLanes` 是否都与 `renderLanes` 无交集，同时确认 props、ref 未变且 context 没有变化。全部满足时，函数组件、Fragment、Provider、ForwardRef、Memo、Suspense 等分支可以复用已有结果。`completeWork` 再把孩子的 `lanes / childLanes` 汇总到父级，供下一轮判断。

不过，跳过只做到 Fiber 这一层。这里的 Hook Update 没有 `lane` 字段；`updateState` 或 `updateReducer` 一旦进入某条 Hook 队列，就会按入队顺序重放整环 action，并清空 `baseQueue`。高优 render 可能顺带消费同一队列中的低优 action，而根上残留的低优 Lane 之后仍会触发一次可能多余的渲染。

官方 React 会给 Update 携带 Lane，保留被跳过的更新和基准状态，之后再 rebase。这里实现的是 Fiber 级 bailout，不包含完整的 Update 级筛选，阅读源码时要把这两层分开。

## 本章回顾

- 三档 Lane 分别来自 `root.render`、普通 Hook dispatch 和 `startTransition` 中的 Hook dispatch，优先级按 Sync、Default、Transition 递减。
- 根从 `pendingLanes` 选择最高档，再把 Default / Transition 映射为 Scheduler 的 Normal / Low；Sync 绕过 Scheduler，走微任务。
- 时间片耗尽时保留断点，同档或更高档更新到来时从根重启，更低档更新留到当前 commit 之后。
- Fiber 可以按 `lanes / childLanes` bailout，但 Hook Update 没有 Lane，进入队列后仍会整队消费。

### 源码入口

- `packages/react-reconciler/src/fiberLanes.ts`：三档 Lane、集合运算、`getNextLanes`
- `packages/react-reconciler/src/workLoop.ts`：`markUpdateLaneFromFiberToRoot`、`ensureRootIsScheduled`、续跑与重启
- `packages/react-reconciler/src/beginWork.ts`：基于 `lanes / childLanes` 的 bailout
- `packages/react-reconciler/src/hooks.ts`：Lane 来源、无 Lane 的 Hook Update 队列
- `packages/scheduler/src/Scheduler.ts`：Priority 最小堆与 5ms 时间片

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./17-Scheduler与时间切片.md) · [下一章 →](./19-HostConfig抽象.md)
