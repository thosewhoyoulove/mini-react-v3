# 第 6 章：Fiber 链表与双缓冲

[← 返回总目录](../../React设计与实现.md) · [上一章](./05-JSX与jsx-runtime与typeof.md) · [下一章 →](./07-副作用标记Flags.md)

> 主文件：`packages/react-reconciler/src/fiber.ts`
> Element 是嵌套对象树；Fiber 把同一棵树改成可暂停的链表。双缓冲保证屏幕上看不到半成品。

## 本章书签

- [6.1 为什么 Element 树要变成 Fiber 链表](#61-为什么-element-树要变成-fiber-链表)
- [6.2 Fiber 的 tag](#62-fiber-的-tag)
- [6.3 `current` 与 `workInProgress`](#63-current-与-workinprogress)
- [6.4 `createWorkInProgress`](#64-createworkinprogress)
- [面试复习](#面试复习)

---

## 6.1 为什么 Element 树要变成 Fiber 链表

ReactElement 的孩子在 `props.children` 里，是树，不是「下一个节点」指针。若工作循环用递归直接走这棵树，一次 `beginWork` 会陷进整棵子树，切片无法停在「刚好做完某一个节点」。

Fiber 把同一份结构改成三条指针：

```text
child    → 第一个子节点
sibling  → 下一个兄弟
return   → 父节点（避开 JS 关键字 parent）
```

`fiber.ts` 文件头的例子：

```ts
createElement('div', null,
  createElement('h1', null, 'Mini React'),
  createElement('p', null, 'count: 0'),
)
```

链表长这样：

```text
HostRoot
  │ child
  ▼
div
  │ child
  ▼
h1 ──sibling──► p
 │ child          │ child
 ▼                ▼
"Mini React"      "count: 0"
```

工作循环每次只处理**一个** Fiber：有 `child` 就往下，没有就 `complete`，有 `sibling` 就横走。停下来时，全局 `workInProgress` 指向「下一个该处理的节点」，下一拍从这里续。这就是第 2 章说的「可中断」的数据结构前提。

没有 `prevSibling`：要找上一个兄弟，只能从父的 `child` 往后走。Commit 找插入锚点（`getHostSibling`）也是顺着这条链。

## 6.2 Fiber 的 tag

`tag` 决定 `beginWork` / `completeWork` / `commit` 走哪条分支。数字与官方对齐，方便对照：

| 常量 | 值 | 对应什么 |
| --- | --- | --- |
| `FunctionComponent` | 0 | `createElement(App, null)`，`type` 是函数 |
| `HostRoot` | 3 | `createRoot` 时创建，不对应任何 JSX |
| `HostComponent` | 5 | `'div'` / `'button'` 等宿主标签 |
| `HostText` | 6 | 文本，如 `'count: ' + count` |

`createFiberFromElement` 的规则很短：`typeof type === 'function'` → 函数组件，否则当宿主标签。本仓库没有 Fragment / Portal / ClassComponent 等 tag，未知类型在 `beginWork` 里当叶子返回 `null`。

几个常对混的字段：

| 字段 | 存什么 |
| --- | --- |
| `stateNode` | Host → 真实 DOM；HostRoot → `FiberRoot`；函数组件一般为 `null` |
| `pendingProps` | 这次刚传入的 props |
| `memoizedProps` | 上次用过的 props，commit 时对比属性 |
| `memoizedState` | 函数组件：Hook 链表头 |
| `flags` / `subtreeFlags` | 自己 / 子树的副作用，第 7 章 |
| `lanes` / `childLanes` | 自己 / 子树上未处理的更新优先级 |

整棵应用还有一个 **不是 Fiber** 的入口 `FiberRoot`：`containerInfo` 指向 `#root`，`current` 指向 HostRoot Fiber，`finishedWork` 指向算完待 commit 的 WIP 根。HostRoot 的 `stateNode` 反过来指这个 `FiberRoot`，所以从任意 Fiber 一路 `return` 都能找到根。

## 6.3 `current` 与 `workInProgress`

双缓冲在节点上的名字叫 `alternate`：

```text
current.alternate        === workInProgress
workInProgress.alternate === current
```

- **current**：已经提交、屏幕上正在显示的那棵。
- **workInProgress**：本轮 Render 正在算的那棵。Diff、打 flags、创建尚未插入的实例，都发生在这里。
- **commit 成功**：`root.current = finishedWork`，角色对调。刚才的 WIP 变成新 current；下一次更新把旧 current 那一格拿来当新 WIP。

屏幕永远看不到半成品树。切片暂停只停 WIP 指针，current 与真实 DOM 仍是上一轮完整提交的结果。

`setState` 闭包里抓到的 Fiber 可能是两棵里的任意一棵，所以 `markUpdateLaneFromFiberToRoot` 给 `fiber` 和 `fiber.alternate` 都标 lane。

## 6.4 `createWorkInProgress`

为 current 上的某个节点取出（或新建）对应的 WIP：

**第一次还没有 `alternate`：**

1. `createFiber` 复制 `tag` / `key` / `type` / `stateNode`。
2. `wip.alternate = current`，`current.alternate = wip`，两棵树互相指。

**之后每次更新：**

1. 复用同一格 `wip`，只改 `pendingProps`。
2. 清空 `flags` / `subtreeFlags` / `deletions`，避免上次副作用残留。
3. **不再 new 一整棵。**

无论哪条路，都会先把 `child` / `memoizedState` / `updateQueue` 等从 current 拷过来。子树没变时可以直接复用旧 child 链表；变了再由 `reconcileChildFibers` 重新接。`return` 先置 `null`，挂回树时再接。

```text
第一次更新：current ──alternate──► 新 wip
之后更新：  复用那格 wip，只重置 flags
commit：    root.current = finishedWork，两棵对调
```

下一章讲这些节点上的 `flags`：Render 为什么不直接改 DOM，只打标记。

## 面试复习

### 一句话结论

Fiber 把不可暂停的递归树遍历改造成可保存进度的链式工作单元，双缓冲则让计算中的 WIP 与已提交的 current 分离。

### 面试回答

为什么 React 需要 Fiber？递归遍历依赖 JS 调用栈，一旦进入整棵子树，框架难以在节点边界暂停、恢复或放弃。Fiber 用 `child/sibling/return` 显式表达深度优先遍历，并把 props、state、lanes、flags 等工作状态挂在节点上；工作循环只需保留 `workInProgress` 就能续跑。为了不污染已提交结果，每个可复用节点通过 `alternate` 连接 current 与 WIP：Render 修改 WIP，完成后 Commit 更新宿主并令 `root.current = finishedWork`。本仓库的 `createWorkInProgress` 首次创建 alternate，之后复用并重置副作用字段。官方 Fiber 字段、bailout、并发恢复和错误边界更复杂；教学版还是单根、有限 tag 和两档 Lane，双缓冲也不意味着永远同时存在两棵结构完整且完全独立的树。

### 常见追问

**1. 三个指针怎样模拟递归？**

有 child 就下钻；无 child 就完成当前节点，找到 sibling 则横移，否则沿 return 上升，等价于递归的调用与返回顺序。

**2. `alternate` 是旧节点的备份吗？**

更准确地说，它连接同一逻辑位置的两份 Fiber 工作槽位；Commit 后 current/WIP 角色互换，并非每次都复制一份永久快照。

**3. 双缓冲为什么能支持丢弃工作？**

未提交计算主要留在 WIP，current 仍代表上次完成结果；高优更新可重新从 current 准备 WIP，而不把半成品当成已提交状态。

**4. Fiber 节点和 DOM 节点是一一对应吗？**

不是。HostComponent/HostText 通常有 DOM `stateNode`，FunctionComponent 没有对应 DOM，HostRoot 对应的是 FiberRoot。

### 容易说错

- 不要说 Fiber 本身就是线程或协程；它是可调度工作的数据结构，执行仍发生在 JS 主线程。
- 不要说双缓冲复制两套 DOM；成对的主要是 Fiber，DOM 副作用在 Commit 才落实。
- 不要说 WIP 与 current 始终完全隔离；教学版会复制并复用部分字段、child 指针和 `stateNode`。
- 不要把 `alternate` 理解成固定“旧树”；Commit 后两侧角色会交换。

### 源码入口

- `packages/react-reconciler/src/fiber.ts`：Fiber/FiberRoot 字段与 `createWorkInProgress`。
- `packages/react-reconciler/src/workLoop.ts`：`workInProgress` 游标与深度优先循环。
- `packages/react-reconciler/src/childFiber.ts`：child/sibling/return 链表的构建与复用。
- `packages/react-reconciler/src/completeWork.ts`：回溯阶段创建实例并冒泡信息。
- `packages/react-reconciler/src/scheduleUpdate.ts`：更新进入工作循环的转发入口。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./05-JSX与jsx-runtime与typeof.md) · [下一章 →](./07-副作用标记Flags.md)
