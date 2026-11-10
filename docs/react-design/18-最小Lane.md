# 第 18 章：最小 Lane：三档更新怎样排队

[← 返回总目录](../../React设计与实现.md) · [上一章](./17-Scheduler与时间切片.md) · [下一章 →](./19-HostConfig抽象.md)

一次普通 `setState` 还没渲染完，`root.render` 和 `startTransition` 又先后带来更新。正在计算的半棵 WIP 是从断点继续，还是回到根重新开始？新旧更新又该先处理哪一档？Lane 把紧急程度记在 Fiber 和根上，reconciler 才能选出下一批工作。

> 主文件：`packages/react-reconciler/src/fiberLanes.ts`、`workLoop.ts`

## 18.1 从三个数字理解 Lane

这个教学实现只保留三个 Lane：

```ts
SyncLane       = 0b001; // 1
DefaultLane    = 0b010; // 2
TransitionLane = 0b100; // 4
```

每个 Lane 占一个比特位。多档更新用按位或放进同一个集合。Default 与 Transition 同时待处理时，集合是 `0b010 | 0b100 = 0b110`。

优先级越高，置位越靠右。`getHighestPriorityLane(lanes)` 用 `lanes & -lanes` 取出最低的那个 1。`0b111` 得到 `0b001`，也就是 Sync。三档的来源和执行路径是：

| Lane | 更新从哪里来 | 后续执行方式 |
| --- | --- | --- |
| `SyncLane = 1` | `root.render(element)` 经 `updateContainer` 发起 | 微任务中的 `workLoopSync`，循环内部不让出 |
| `DefaultLane = 2` | 普通 `setState` / reducer dispatch | Scheduler 的 `NormalPriority`，可时间切片 |
| `TransitionLane = 4` | `startTransition(() => setState(...))` 内的更新 | Scheduler 的 `LowPriority`，可时间切片 |

`startTransition` 调用 `scope` 前，把 `ReactCurrentBatchConfig.transition` 设成一个对象，`finally` 里再恢复。Hook 在入队时读取它。有 transition 就选 Transition，否则选 Default。Lane 标在更新经过的 Fiber 和根上，表示这次更新该多快被根拣起来。它不是浏览器任务，数值也不等于 Scheduler 的五档优先级。

第 17 章区分过 Lane 与 Scheduler Priority。这里的连接方式是：SyncLane 走 `queueMicrotask`，Default 和 Transition 分别映射到 Scheduler 的 Normal 和 Low。

官方 React 有更多 Lane，还要处理成组的 Transition、过期和饥饿。这里的 `1 / 2 / 4` 用来讲清根级选档、插队和时间切片，并不表示 React 只有三种优先级。

## 18.2 根怎样选择并调度下一档工作

假设 Default 和 Transition 先后到达同一个根：

```text
root.pendingLanes = 0b010 | 0b100 = 0b110
```

`pendingLanes` 是这个根还没处理完的 Lane 集合。更新从某个 Fiber 出发后，`scheduleUpdateOnFiberImpl` 先调用 `markUpdateLaneFromFiberToRoot`。

源 Fiber 和它的 `alternate` 都会或上这一位。原因是 `setState` 闭包里抓住的可能是 current，也可能是上一轮的 WIP，只标其中一棵，另一棵的 `beginWork` 就看不到这次更新。然后沿 `return` 把同一位或进每个祖先以及祖先 alternate 的 `childLanes`。走到 `HostRoot` 后，返回它 `stateNode` 上的 `FiberRoot`；正常更新都能通过这条链找到所属 root。

```text
sourceFiber.lanes 与 alternate.lanes 都标上
        │
        ├─ 沿 return 把 lane 合进祖先和 alternate 的 childLanes
        │
        └─ 把 lane 合进 root.pendingLanes
                         │
                         ▼
                ensureRootIsScheduled
```

`getNextLanes(root)` 按 Sync、Default、Transition 的顺序只返回最高的一档，不会把 `0b110` 整包交出去。`0b110` 的下一档是 Default。Transition 留在 `pendingLanes` 里。`ensureRootIsScheduled(root)` 再用这一档和已经约好的回调比较。

```text
pendingLanes
    │
    ▼
getNextLanes          只返回最高一档
    ├─ Sync       → queueMicrotask → performSyncWorkOnRoot
    ├─ Default    → Scheduler(Normal) → performConcurrentWorkOnRoot
    └─ Transition → Scheduler(Low)    → performConcurrentWorkOnRoot
```

普通 `setState` 会把 Scheduler 任务 id 记到 `root.callbackNode`，并把档位记到 `callbackPriority`。同档回调已经存在时，`ensureRootIsScheduled` 直接返回。连续三次普通 `setState` 的 action 都留在 Hook 队列里，根上只保留一个 Default 回调。

Sync 不把微任务任务号写进某个 root 的 `callbackNode`，而是用模块级的 `syncRoots` 集合记录本轮需要处理的根，再用 `syncScheduled` 保证只约一个微任务。微任务会逐个处理集合中的 root，不会用后一个 root 覆盖前一个 root。

新档位不同，而且旧的 Scheduler 回调还没开始，才会 `unstable_cancelCallback`。例如 Low 回调还在堆里时来了 Default，根会改约 Normal。被替换的是回调预约。TransitionLane 仍留在 `pendingLanes`。并发回调若已经开始，函数入口会先把 `callbackNode` 清空，这时取消旧 id 已经不起作用，剩下的事交给 18.3 的重启判断。

一轮渲染完成后，`markRootFinished` 只从 `pendingLanes` 里删掉本轮的 `renderedLanes`。原集合若是 `Sync | Default`，Sync 提交后还剩 Default。`finishRoot` 会再次调用 `ensureRootIsScheduled`，Default 这才拿到自己的回调。Scheduler 这段时间只认识 callback 和 Priority。哪一档还没做完，始终记在根上。

## 18.3 何时续跑何时重启，以及能跳过什么

并发渲染第一次开始时，`prepareFreshStack` 从根创建 WIP。`workLoopConcurrent` 每做完一个 Fiber 都调用 `unstable_shouldYield()`。5ms 用完后，全局 `workInProgress` 停在下一个节点：

```text
第一拍：A → B → C → 时间到，workInProgress 指向 D
第二拍：从 D 继续 → E → F → 完成
```

这段时间若没有新更新，下一次 Scheduler 回调从 D 接着做。`performConcurrentWorkOnRoot` 只有在 `workInProgress == null` 时才重新 `prepareFreshStack`。断点还在，就不会从根再克隆一棵。

渲染过程中又有 action 入队时，已经执行过 `beginWork` 的节点不会自动再跑一遍。`shouldRestartCurrentRender` 处理的是这种情况。同一个 root 正在渲染，且新 Lane 与本轮优先级相同或更高，就把 `rootNeedsRestart` 设为 true。更低的 Lane 只进入 `pendingLanes`，不要求重来。

这个标记不会把正在执行的 `performUnitOfWork` 从中途打断，`workLoopConcurrent` 的循环里也不读它。原因是 JavaScript 只有在这次循环回到 `performConcurrentWorkOnRoot` 之后才有检查点。结果是：当前这 5ms 里已经排上的节点仍会走完，然后 WIP 被清空，这次不 commit，再按新的最高档重新 schedule。Sync 循环内部没有 `shouldYield`，所以一旦在同步渲染途中又来了同档或更高档更新，这次 `workLoopSync` 会先把整棵树走完，再丢掉结果，留到下一个微任务重做。

```text
只是 shouldYield
  → 保留 workInProgress
  → 下一 Scheduler callback 从断点续跑

同档 / 更高档更新到来
  → rootNeedsRestart = true
  → 当前这段 workLoop 返回后丢弃 workInProgress
  → 不 commit，随后从 HostRoot 重建 WIP

更低档更新到来
  → 只并进 pendingLanes
  → 当前轮可以继续，commit 后再 schedule
```

Sync 更新除了可能要求重启，还会去约微任务。若旧的 Scheduler 回调还没开始，`ensureRootIsScheduled` 会先取消它。`performSyncWorkOnRoot` 自己也会把 `workInProgress` 清空，再用 `workLoopSync` 从新的 `prepareFreshStack` 跑。它不会接着 Default 留下的半成品。

Lane 也参与 Fiber 级 bailout。`beginWork` 里，函数组件、Fragment、Provider、ForwardRef、Memo、Suspense 会问 `canSkipUpdate`。要同时满足：自己的 `lanes` 和 `childLanes` 都与 `renderLanes` 无交集，props 浅比较相同，ref 相同，context 没变，并且没有 `DidCapture`。满足时组件函数不执行，直接克隆已有的子 Fiber。

`HostRoot`、`HostComponent` 和 `HostText` 不走这道判断。宿主节点仍会进入 `completeWork`，在那里比较 props 或文本。`completeWork` 再把孩子的 `lanes` 和 `childLanes` 汇总到父级的 `childLanes`，供下一轮使用。

跳过只做到 Fiber 这一层。Hook Update 没有 `lane` 字段。`updateState` 或 `updateReducer` 一旦执行，就按入队顺序重放整圈 action，并清空 WIP 的 `baseQueue`。所以高优 render 只有在组件真的执行了这两个函数时，才会把同一条队列里的低优 action 一起算掉。组件若 bailout，action 还在队列里，等自己那一档渲染。

根上残留的低优 Lane 不一定会因为 action 已经被高优渲染消费而消失。`markRootFinished` 只删除本轮 `renderedLanes`。之后仍可能再调度一次，进入组件时队列已经是空的。

生产版 React 会给 Update 带上 Lane，把跳过的更新和基准状态留下来再 rebase。这里是 Fiber 级 bailout，加上“进入队列就整圈消费”。阅读时要把这两层分开。

## 本章回顾

- 三档 Lane 分别来自 `root.render`、普通 Hook dispatch 和 `startTransition` 中的 Hook dispatch。优先级按 Sync、Default、Transition 递减。
- 标 Lane 时源 Fiber 和 alternate 都要写。根每次只取出 `pendingLanes` 里最高的一档。
- Default 的重复调度靠 `callbackNode` 合并。同一轮里的多个 Sync 靠 `syncRoots` 集合和一个微任务槽合并，集合会保留每个待处理的 root。
- 时间片耗尽时保留断点。同档或更高档更新要等当前 `workLoop` 返回后才丢弃 WIP。更低档留到这次 commit 之后。
- 一部分 Fiber 可以按 `lanes / childLanes` bailout。Hook Update 没有 Lane，函数真的执行时仍会整队消费。

### 源码入口

- `packages/react-reconciler/src/fiberLanes.ts`：三档 Lane、集合运算、`getNextLanes`
- `packages/react-reconciler/src/workLoop.ts`：`markUpdateLaneFromFiberToRoot`、`ensureRootIsScheduled`、续跑与重启
- `packages/react-reconciler/src/beginWork.ts`：基于 `lanes / childLanes` 的 bailout
- `packages/react-reconciler/src/hooks.ts`：Lane 来源、无 Lane 的 Hook Update 队列
- `packages/scheduler/src/Scheduler.ts`：Priority 最小堆与 5ms 时间片

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./17-Scheduler与时间切片.md) · [下一章 →](./19-HostConfig抽象.md)
