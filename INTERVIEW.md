# 面试讲解笔记

上一版骨架只能 mount 一次 div，不足以讲清 React 内部原理。

这一版覆盖面试官真正会问的问题。讲解时按下面的文件走一遍。

## 1. JSX / createElement

文件：packages/react/src/ReactElement.ts

JSX 编译成 createElement。返回值是 ReactElement：$$typeof、type、key、props。
它是数据，不是 DOM 节点。

讲解点：为什么 $$typeof 用 Symbol.for('react.element') —— 防止 XSS 注入的 JSON 被当成合法 element。

## 2. Fiber

文件：packages/react-reconciler/src/fiber.ts

ReactElement 是树。Fiber 是链表：child / sibling / return。
这样 work loop 才能暂停和恢复（时间切片）。

current vs workInProgress（alternate）：双缓冲。
Render 改的是 WIP 树。Commit 时交换 root.current = finishedWork。
屏幕永远看不到半成品树。

## 3. Render vs Commit

文件：
- workLoop.ts —— performUnitOfWork
- beginWork.ts —— 向下走，reconcile 子节点，执行函数组件
- completeWork.ts —— 创建 DOM 实例，向上冒泡 flags
- commitWork.ts —— 把 Placement / Update / ChildDeletion 应用到真实 DOM

Render 阶段：DefaultLane（setState）可中断；SyncLane（root.render）在微任务里一次跑完。
Render 阶段不能碰 document（completeWork 里创建实例是例外，对齐 React DOM 的 host config）。
Commit 阶段是同步的：插入、更新、删除。

演示：点 +1，说「setState 调度一次新的 render，然后 commit 打补丁到文本节点」。

## 4. Diff

文件：packages/react-reconciler/src/childFiber.ts

- 相同 type + 相同 key => 复用 Fiber（以及 DOM）
- type 变了 => 删旧的，建新的
- 列表：先按 index 走一遍，再用 Map 按 key 处理剩余节点
- lastPlacedIndex 决定复用节点要不要 Placement（移动）

演示：点 reverse。key 稳定，所以节点是移动而不是重新挂载。

## 5. Hooks

文件：
- packages/react/src/ReactHooks.ts —— 对外 API，读取 dispatcher
- packages/react-reconciler/src/hooks.ts —— mount / update 两套 dispatcher

Hooks 是挂在 fiber.memoizedState 上的链表。
调用顺序必须稳定（Hooks 规则）。
useState：环形 pending 队列，下次 render 时处理。
useEffect：Passive flag，commit 之后先 destroy 再 create。

演示：title 随 count 更新；cleanup 在下一次 effect 时执行。

## 6. Scheduler

文件：packages/scheduler/src/Scheduler.ts

MessageChannel 投递一个宏任务。每个切片设 5ms deadline。
workLoop 在 unstable_shouldYield() 为 true 时停下，再重新调度。

Lane（最小实现）：packages/react-reconciler/src/fiberLanes.ts + workLoop.ts。

- SyncLane：root.render，queueMicrotask 里 workLoopSync（不切片）
- DefaultLane：setState，Scheduler 里 workLoopConcurrent（可切片）
- setState 时从 fiber 往上标 lanes / childLanes，root.pendingLanes 合并
- 高优插队：cancel 低优 callback，丢掉 WIP 从根重来

未实现（被问到时可以说）：完整 Lane 档位、beginWork bailout、Suspense、useLayoutEffect。

## 建议的 3 分钟讲稿

1. JSX 是一个 element 对象。
2. Reconciler 把它转成 Fiber 链表，这样工作才能让出。
3. Render 构建 WIP；commit 改 DOM。
4. setState 入队一次 update，调度工作，重新渲染函数组件，diff 子节点，再 commit。
5. Scheduler 只负责 DefaultLane 的时间切片；优先级由 lanes 决定，SyncLane 走微任务、可打断低优并发渲染。
