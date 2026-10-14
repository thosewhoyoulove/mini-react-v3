# 附录

[← 返回总目录](../../React设计与实现.md) · [上一章](./21-createRoot与updateContainer.md)

## 复习书签

- [三档讲解路线](#三档讲解路线)
- [术语速查](#术语速查)
- [按主题查章节与源码](#按主题查章节与源码)
- [与 `INTERVIEW.md` 的面试映射](#与-interviewmd-的面试映射)
- [用 demo 验证](#用-demo-验证)
- [教学实现与官方 React 的差异](#教学实现与官方-react-的差异)
- [仓库未实现清单](#仓库未实现清单)

本附录用于复习、定位和校准边界，不重复各章推导。便携口述稿见 [`INTERVIEW.md`](../../INTERVIEW.md)，完整目录见 [`React设计与实现.md`](../../React设计与实现.md)。

---

## 三档讲解路线

### 3 分钟：只讲一条更新主线

1. JSX 编译后得到 ReactElement；它是 UI 描述，不是 DOM。
2. Reconciler 把 Element 调和成由 `child / sibling / return` 串起的 Fiber 工作单元。
3. 更新先进入 Lane；`SyncLane` 走微任务同步完成，`DefaultLane` / `TransitionLane` 交给 Scheduler 分片。
4. Render 在 work-in-progress 树上执行函数组件、处理 Hook 队列并 Diff 子节点，只创建离屏实例和记录 Flags，不修改已挂载的 DOM 树。
5. Commit 同步处理删除、插入和更新，切换 `root.current`，执行 Layout Effect；Passive Effect 延后。

口述后用一句边界收尾：这是本仓库的三档 Lane、优先级最小堆和精简 HostConfig，不是官方 React 的完整实现。

### 10 分钟：主线加三个高频问题

先讲 3 分钟主线，再展开：

- **为什么 Fiber 能暂停**：链表节点是工作单元，`workInProgress` 保存下一步；current / work-in-progress 双缓冲隔离半成品。
- **Diff 怎么复用和移动**：单节点看 `key + type`；数组先顺序试探，再用 Map 查剩余旧节点，`lastPlacedIndex` 判断 `Placement`。
- **Hooks 为什么不能写在条件里**：Hook 没有名字，mount / update 都靠调用顺序对齐 Fiber 的 `memoizedState` 链表；`useState` 的 pending 是环形队列。

最后补 Effect 时序：Layout destroy 在 Mutation、create 在 Layout；Passive destroy / create 在后续 Scheduler 任务中，为浏览器留下绘制机会，但不保证任务执行前已经绘制。

### 20 分钟：从入口完整走一遍

按这条顺序讲，每个节点只下钻一个关键问题：

1. `createRoot().render(element)` 如何进入 `updateContainer`，为什么初次 render 用 `SyncLane`。
2. `prepareFreshStack` 如何创建 work-in-progress 根；`beginWork` 向下、`completeWork` 向上。
3. 函数组件何时执行，Dispatcher 如何选择 mount / update Hook 路径。
4. `reconcileChildren` 如何做单节点和 keyed 数组 Diff。
5. `completeWork` 如何创建离屏宿主实例并冒泡 `subtreeFlags`。
6. Commit 为什么按 Mutation → 切换 current → Layout 排序，Passive 为什么延后。
7. `setState` 如何入队、标记 Lane、找到 Root，再由 Scheduler 决定后续执行。
8. HostConfig 如何把 reconciler 与 DOM 操作隔开。

被继续追问时，不凭官方印象补答案：先用下方索引定位本仓库，再明确哪些只是教学简化。

## 术语速查

| 术语 | 面试时的一句话 |
| --- | --- |
| ReactElement | JSX 编译产生的不可执行 UI 描述，核心字段是 `$$typeof / type / key / props`。 |
| Fiber | 带父子兄弟指针、状态、优先级和副作用标记的工作单元。 |
| current | 最近一次成功提交、与当前宿主 UI 对齐的 Fiber 树。 |
| work-in-progress（WIP） | Render 正在构建的另一棵树，通过 `alternate` 与 current 对应。 |
| Render | 可被切片的计算阶段：执行组件、处理更新、Diff、创建离屏实例并标 Flags。 |
| Commit | 把 Flags 同步应用到宿主树，并处理 Layout / Passive Effect 的阶段。 |
| Flag | 单个 Fiber 本轮要提交的副作用位，如 `Placement / Update / ChildDeletion / Passive`。 |
| `subtreeFlags` | 子树 Flags 的汇总，让 Commit 能跳过无副作用子树。 |
| Hook 链表 | 函数组件 Fiber 的 `memoizedState` 指向的顺序链表。 |
| Lane | Reconciler 中表示更新优先级的 bit；本仓库可据此在 Fiber 层 bailout，但不能按 Lane 筛选单条 Hook Update。 |
| Scheduler | 用优先级最小堆排列 callback，再通过宏任务与 5ms deadline 让出主线程的执行器。 |
| HostConfig | Reconciler 调用的宿主能力接口；本仓库只提供 DOM 实现。 |

注意：ReactElement 常被简称为 Element；“Fiber 树”在结构上通过链表指针连接。Lane 决定更新优先级，Scheduler 决定 callback 何时占用主线程，两者不是同一个概念。

## 按主题查章节与源码

以下路径都相对仓库根目录：

| 主题 | 章节 | 源码入口 |
| --- | --- | --- |
| JSX / Element | [第 4 章](./04-ReactElement与createElement.md)、[第 5 章](./05-JSX与jsx-runtime与typeof.md) | `packages/react/src/ReactElement.ts`、`packages/react/src/jsx.ts`、`packages/shared/src/ReactSymbols.ts` |
| Fiber / 双缓冲 / Flags | [第 6 章](./06-Fiber链表与双缓冲.md)、[第 7 章](./07-副作用标记Flags.md) | `packages/react-reconciler/src/fiber.ts`、`packages/react-reconciler/src/fiberFlags.ts` |
| Render 工作循环 | [第 8 章](./08-工作循环.md)、[第 9 章](./09-beginWork按tag分发.md)、[第 11 章](./11-completeWork.md) | `packages/react-reconciler/src/workLoop.ts`、`packages/react-reconciler/src/beginWork.ts`、`packages/react-reconciler/src/completeWork.ts` |
| Diff | [第 10 章](./10-子节点Diff.md) | `packages/react-reconciler/src/childFiber.ts` |
| Commit / Effect 时序 | [第 12 章](./12-Commit三阶段.md)、[第 16 章](./16-useEffect与useLayoutEffect.md) | `packages/react-reconciler/src/commitWork.ts`、`packages/react-reconciler/src/hooks.ts` |
| 函数组件 / Hooks | [第 13 章](./13-函数组件的执行时机.md)～[第 16 章](./16-useEffect与useLayoutEffect.md) | `packages/react/src/ReactHooks.ts`、`packages/react/src/ReactCurrentDispatcher.ts`、`packages/react-reconciler/src/hooks.ts` |
| Scheduler / Lane | [第 17 章](./17-Scheduler与时间切片.md)、[第 18 章](./18-最小Lane.md) | `packages/scheduler/src/Scheduler.ts`、`packages/react-reconciler/src/fiberLanes.ts`、`packages/react-reconciler/src/workLoop.ts` |
| HostConfig / DOM | [第 19 章](./19-HostConfig抽象.md)、[第 20 章](./20-DOM属性与简易事件.md) | `packages/react-reconciler/src/HostConfig.ts`、`packages/react-dom/src/hostConfig.ts` |
| 根入口 | [第 21 章](./21-createRoot与updateContainer.md) | `packages/react-dom/src/client.ts`、`packages/react-reconciler/src/reconciler.ts`、`packages/react-reconciler/src/workLoop.ts` |

## 与 `INTERVIEW.md` 的面试映射

讲稿保持便携，详细推导放在章节中：

| 面试主题 | 对应章节 | 常见追问 |
| --- | --- | --- |
| JSX / createElement | [第 4](./04-ReactElement与createElement.md)、[第 5](./05-JSX与jsx-runtime与typeof.md) 章 | Element 为什么不是 DOM；`key` 和 `$$typeof` 各做什么 |
| Fiber | [第 6](./06-Fiber链表与双缓冲.md)、[第 7](./07-副作用标记Flags.md) 章 | 为什么能暂停；alternate 如何复用；Flags 为什么要冒泡 |
| Render / Commit | [第 8](./08-工作循环.md)～[第 12](./12-Commit三阶段.md) 章 | Render 能否碰 DOM；current 何时切换；Effect 顺序 |
| Diff | [第 10](./10-子节点Diff.md) 章 | 为什么同时看 key 和 type；列表移动如何判断 |
| Hooks | [第 13](./13-函数组件的执行时机.md)～[第 16](./16-useEffect与useLayoutEffect.md) 章 | Hook 顺序；环形队列；两种 Effect 的时机 |
| Scheduler / Lane | [第 17](./17-Scheduler与时间切片.md)、[第 18](./18-最小Lane.md) 章 | 两者如何分工；Sync 如何插队 Default |
| HostConfig / 入口 | [第 19](./19-HostConfig抽象.md)～[第 21](./21-createRoot与updateContainer.md) 章 | 为什么 reconciler 不直接依赖 DOM |

## 用 demo 验证

demo 入口是 `demos/hello-dom/src/main.ts`。运行 `pnpm dev` 后，页面按 State、Keyed Diff、Effect 拆成三个独立实验：

**State 卡片：DefaultLane、更新队列与文本更新**

- `setCount` 进入环形队列，标 `DefaultLane`，在 Scheduler callback 中继续并发工作。
- `StateDemo` 再执行，`updateState` 计算新值；HostText 复用并打 `Update`，Mutation 调 `commitTextUpdate`。
- 点 `+3（函数式）` 会在同一事件里入队三条 action，只约一次同档工作，最终从 0 依次算到 3。

**Keyed Diff 卡片：复用、移动、新建与删除**

- 点 `reverse`：`<li key={item}>` 的 key 稳定，数组 Diff 在 Map 中按 key 找回旧 Fiber。
- `lastPlacedIndex` 给需要移动的节点打 `Placement`，Commit 移动已有 DOM，而不是全部重建。
- 点 `add`：新 key 没有可复用旧 Fiber，`completeWork` 创建实例，Commit 插到 `ul` 末尾。
- 点 `remove first`：旧 Fiber 进入父节点 `deletions`，Mutation 阶段从 DOM 删除。

**Effect 卡片：Layout / Passive 的阶段差异**

- 点 `next value`：Layout cleanup 在 Mutation，Layout create 在切换 current 后同步运行；日志里的 `DOM=...` 可以证明它读到新 DOM。
- Passive cleanup / create 由 Scheduler 放到后续宏任务，日志顺序与 Layout 分开。
- 点 `unmount`：教学版会在 Mutation 中同步执行被删子树的 Layout 与 Passive cleanup，这是与官方删除路径不同的简化。

首次进入页面则是：`createRoot().render(...)` → `SyncLane` → 微任务中的同步工作循环。它与 `+1` 共用 begin / complete / commit 主线，差别在 Lane 和是否存在 current 子树。

自动验证运行 `pnpm test`。内存 HostConfig 会保留宿主节点对象身份，所以测试不仅检查最终文本，还能证明 keyed Diff 是复用并移动旧节点。`pnpm typecheck` 同时检查所有 packages、demo 和测试源码。

## 教学实现与官方 React 的差异

面试时应主动说明边界，避免把“原理相似”说成“实现等同”：

- **Fiber / Reconciler**：保留 child / sibling / return、alternate、Flags 等主干，但 tag、更新类型和恢复策略都远少于官方。
- **Render / Commit**：阶段划分和核心顺序对齐；Before Mutation 在本仓库为空。删除时两种 Effect cleanup 都在 Mutation 中完成，是教学简化。
- **Diff**：实现单节点、Fragment 与普通数组的 key / type 复用和移动；不覆盖 Portal 等官方分支。
- **Hooks / 组件能力**：已实现 state、reducer、ref、memo/callback、context、两种 Effect，以及教学版的 Fragment、memo、forwardRef、Suspense 和 ErrorBoundary；开发期校验与异常恢复仍远少于官方。
- **Scheduler / Lane**：Scheduler 使用优先级最小堆和固定 5ms deadline；Lane 有 `SyncLane`、`DefaultLane`、`TransitionLane`，并支持 Fiber 级 bailout。单条 Hook Update 没有 Lane，官方的过期、饥饿、跳过与 rebase 更完整。
- **HostConfig / DOM**：接口体现宿主解耦，但本仓库只接 DOM；`onClick` 使用根容器委托，其他 `onXxx` 逐节点绑定，回调仍是原生事件而非官方 SyntheticEvent。
- **DOM 创建边界**：Render 的 `completeWork` 会创建尚未挂入文档的 DOM 实例；真正插入、删除、更新已挂载 DOM 在 Commit。不要简化成“Render 完全不碰 DOM API”。

## 仓库未实现清单

这些能力只用于回答“边界是什么”，本书不展开其官方实现：

- Portal / lazy
- Class 组件及官方 Class Error Boundary 生命周期（仓库有函数式教学边界）
- `useTransition` / `useDeferredValue` 等 Hook（`startTransition` 函数已实现）
- SyntheticEvent、事件插件、捕获阶段与完整事件优先级
- 完整 Lane 集合、单条 Update 的 Lane 跳过与 rebase、Scheduler 过期和饥饿策略
- SSR / hydrate、`flushSync`
- 完整的 ref 语义（宿主对象 ref、函数 ref 与 forwardRef 主路径已实现）
- style 对象细粒度 Diff、`dangerouslySetInnerHTML`

这些缺口不影响解释本仓库的核心闭环：描述 UI → 构建 Fiber → 可切片 Render → 同步 Commit。遇到清单外的官方能力，应明确“本仓库未实现”，再回到已验证的主线。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./21-createRoot与updateContainer.md)
