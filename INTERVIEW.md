# React 原理面试便携讲稿

这份文件只保留可直接口述的主干和追问入口。完整推导见 [`React设计与实现.md`](./React设计与实现.md)，术语、源码索引、三档讲解路线与实现边界见[复习附录](./docs/react-design/appendix.md)。

> 回答口径：先说“本仓库如何实现”，再说“它保留了官方 React 的哪条主干”。不要把两档 Lane、FIFO Scheduler 或精简 Diff 说成官方完整实现。

## 可直接口述的 3 分钟主线

“JSX 不会直接生成 DOM，而会编译成 `createElement` 或 `jsx` 调用，得到带 `$$typeof、type、key、props` 的 ReactElement。Element 是 UI 描述，Reconciler 会把它调和成 Fiber。

Fiber 用 `child、sibling、return` 把树连接成可逐个处理的工作单元，并通过 `alternate` 维护 current 与 work-in-progress 双缓冲。Render 在 WIP 上执行函数组件、处理 Hook 更新、Diff 子节点并记录 Flags，所以未完成的树不会直接展示。

一次工作从 `beginWork` 向下，到没有 child 时进入 `completeWork`，再沿 sibling 或 return 向上。`completeWork` 可以创建尚未挂入文档的 DOM 实例并冒泡 `subtreeFlags`；插入、删除和修改已挂载 DOM 则集中在同步 Commit 中。

Commit 先做 Mutation，再把 `root.current` 切到 finishedWork，然后执行 Layout Effect；`useEffect` 的 Passive cleanup 和 create 延后到后续任务。这里的 `useLayoutEffect` 已经实现：更新时 destroy 在 Mutation，create 在 Layout。

`setState` 会把 update 放进 Hook 的环形队列，从当前 Fiber 向 Root 标 Lane，再调度新一轮 Render。本仓库只有两档：`root.render` 使用 `SyncLane`，在微任务中同步完成；用户 `setState` 使用 `DefaultLane`，由 Scheduler 通过 MessageChannel 宏任务和 5ms deadline 做时间切片。Lane 决定更新优先级，Scheduler 决定 callback 何时运行和何时让出。”

收尾边界：“这套实现覆盖 Element → Fiber → Render / Commit → Diff → Hooks → Scheduler / Lane → HostConfig 的闭环，但比官方 React 少很多分支和容错机制。”

## 六个主题的一句话提纲

### 1. JSX / Element

- JSX 编译为函数调用，返回 ReactElement 数据，不是 DOM。
- `key` 参与同层复用；`$$typeof` 用 `Symbol.for` 标识合法 Element。
- 细节：[第 4 章](./docs/react-design/04-ReactElement与createElement.md)、[第 5 章](./docs/react-design/05-JSX与jsx-runtime与typeof.md)

### 2. Fiber

- Fiber 是可逐个执行的工作单元；`child / sibling / return` 支持工作循环遍历。
- current / WIP 通过 `alternate` 对应，Commit 后切换 `root.current`。
- 细节：[第 6 章](./docs/react-design/06-Fiber链表与双缓冲.md)、[第 7 章](./docs/react-design/07-副作用标记Flags.md)

### 3. Render / Commit

- Render 负责计算、Diff、创建离屏实例和打 Flags；它不修改已挂载宿主树。
- Commit 同步处理 Mutation，切换 current，再跑 Layout；Passive 延后。
- 细节：[第 8 章](./docs/react-design/08-工作循环.md)～[第 12 章](./docs/react-design/12-Commit三阶段.md)

### 4. Diff

- 单节点由 `key + type` 决定复用；type 不同则删除旧节点并创建新节点。
- 数组先顺序试探，再用 Map 匹配剩余节点；`lastPlacedIndex` 判断移动。
- 细节：[第 10 章](./docs/react-design/10-子节点Diff.md)

### 5. Hooks

- Hook 按调用顺序挂在函数组件 Fiber 的 `memoizedState` 链表上，所以不能条件调用。
- `useState` 用环形 pending 队列；Effect 用 Hook tag 与 Fiber flag 标记执行阶段。
- `useLayoutEffect` **已实现**；`useEffect` 与它的时序见[第 16 章](./docs/react-design/16-useEffect与useLayoutEffect.md)。
- 细节：[第 13 章](./docs/react-design/13-函数组件的执行时机.md)～[第 16 章](./docs/react-design/16-useEffect与useLayoutEffect.md)

### 6. Scheduler / Lane

- Lane 属于 Reconciler；在本仓库回答“更新多急、根下一次走同步还是可切片路径”。Scheduler 回答“callback 何时跑、何时让出”。本仓库尚未按 Lane 筛选具体 Fiber 或 Hook Update。
- 本仓库 `SyncLane` 走微任务同步循环，`DefaultLane` 走 Scheduler 并发循环；Sync 可取消 Default callback 并从根重启。
- 细节：[第 17 章](./docs/react-design/17-Scheduler与时间切片.md)、[第 18 章](./docs/react-design/18-最小Lane.md)

## 常见追问入口

- **为什么 Fiber 能中断，而递归调用栈不方便中断？** 看[工作循环](./docs/react-design/08-工作循环.md)和[Fiber 链表](./docs/react-design/06-Fiber链表与双缓冲.md)：下一工作单元由显式指针保存，不依赖浏览器调用栈。

- **Render 阶段到底能不能操作 DOM？** 能在 `completeWork` 中创建离屏实例，但不在已挂载 DOM 树上插入、删除或更新；后者属于 Commit。看[第 11 章](./docs/react-design/11-completeWork.md)和[第 12 章](./docs/react-design/12-Commit三阶段.md)。

- **为什么 `key` 不能只看 index？** index 不能稳定表示跨更新的节点身份，重排时会错复用状态；看[数组 Diff](./docs/react-design/10-子节点Diff.md#103-数组子节点)。

- **为什么 Hooks 不能写在条件分支？** mount / update 依赖调用次序逐格对齐，没有名字可查；看[第 14 章](./docs/react-design/14-Hook链表与Dispatcher.md)。

- **`useEffect` 和 `useLayoutEffect` 的区别？** Layout 在 DOM Mutation 后、绘制前同步执行；Passive 在后续任务执行。看[第 16 章](./docs/react-design/16-useEffect与useLayoutEffect.md#163-passive-vs-layout)。

- **Lane 和 Scheduler 是一回事吗？** 不是。Lane 是更新优先级；本仓库用它选择根的投递路径，Scheduler 则是 callback 执行器。这里尚未按 Lane 筛选 Fiber 或 Hook Update；看[第 18 章](./docs/react-design/18-最小Lane.md#181-两套优先级lanes-与-scheduler-priority)。

- **为什么 reconciler 不直接调用 `document`？** HostConfig 隔离宿主能力，让调和主干不绑定 DOM；本仓库只实现了 DOM HostConfig。看[第 19 章](./docs/react-design/19-HostConfig抽象.md)。

- **这个 mini-react 与官方 React 最大差别是什么？** 本仓库只有两档 Lane、FIFO Scheduler、精简 tag / Diff / Hooks / HostConfig，没有 Suspense、完整 bailout、合成事件等。看[官方差异提醒](./docs/react-design/appendix.md#教学实现与官方-react-的差异)和[未实现清单](./docs/react-design/appendix.md#仓库未实现清单)。

## 演示时怎么说

- 点 `+1`：“update 入 Hook 环形队列 → 标 `DefaultLane` → Render 重跑组件并复用 HostText → Commit 更新文本 → Passive Effect 后续执行。”
- 点 `reverse`：“稳定 key 让旧 Fiber 和 DOM 被找回；`lastPlacedIndex` 判断哪些节点需要 `Placement` 移动。”
- 点 `add`：“新 key 没有旧 Fiber，Render 创建离屏实例并打 `Placement`，Commit 插入。”

demo 的完整验证路径见[附录](./docs/react-design/appendix.md#用-demo-验证)。
