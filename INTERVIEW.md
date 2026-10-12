# React 原理面试便携讲稿

这份文件只保留可直接口述的主干和追问入口。完整推导见 [`React设计与实现.md`](./React设计与实现.md)。设计文档附录仍描述更早的两档 Lane 版本，背诵和面试以本文件为准。

> 回答口径：先说「本仓库如何实现」，再说「它保留了官方 React 的哪条主干」。Lane 在这里是三条，Scheduler 是优先级最小堆。不要把它们说成官方的完整 Lane 和过期调度。

## 术语（说出口时顺手解释）

| 说法 | 中文 |
| --- | --- |
| ReactElement | 描述界面的对象，还不是页面上的节点 |
| Fiber | 可以暂停、恢复、丢掉的工作单元 |
| current | 已经画到页面上的那棵树 |
| work-in-progress（WIP） | 正在内存里算的另一棵树 |
| Render | 计算下一版界面；可以重做、可以丢掉 |
| Commit | 把算完的结果同步应用到页面 |
| Flag | 这个节点这次要做的标记：插入、更新、删除、ref、被动副作用 |
| Lane | 用一个二进制位表示这批更新有多急，位越低越急 |
| Scheduler | 决定回调何时占用主线程、何时让出 |
| bailout | 子树不用重算，函数组件这次不会被调用 |
| Hook 链表 | 按调用顺序串起来的状态格，没有名字 |
| thenable | 带 `then` 的对象，Suspense 只认这种抛出 |

三条 Lane：`SyncLane` 走微任务一次跑完；`DefaultLane` 是普通 `setState`，可切片；`TransitionLane` 是 `startTransition` 里的更新，可以被更高优整段丢掉。

## 可直接口述的 3 分钟主线

「JSX 不会直接生成 DOM，而会编译成 `createElement` 或 `jsx`，得到 ReactElement。它只是界面描述。协调器再把它调和成 Fiber。

Fiber 用 `child`、`sibling`、`return` 把树拆成工作单元，用 `alternate` 维持 current 和 WIP。Render 在 WIP 上执行函数、处理 Hook、对比子节点、打标记。没算完的树不会直接展示。

工作从 `beginWork` 向下。没有孩子就进入 `completeWork`，再沿兄弟或父亲向上。`completeWork` 可以创建还没挂进文档的 DOM，并向上汇总 `subtreeFlags`。插入、删除、改已挂载节点集中在同步 Commit。

Commit 先改 DOM，再把 `root.current` 切到刚算完的树，然后跑 `useLayoutEffect` 的创建函数，并在这一步写 ref。`useEffect` 留到后面的宏任务。`setState` 不直接改状态，而是往 Hook 的环形队列放一条更新，从当前 Fiber 往根上标 Lane，再决定走微任务还是调度器。

父组件重渲染时，如果自己的 `lanes`、子树的 `childLanes` 都和本轮无关，props 浅比较相同，context 依赖也没过期，就 bailout，不再调用这个函数。子树里还有本轮 Lane 时，父函数必须重跑。

我实现完以后的判断是：React 是一套可调度的界面计算。更新描述发生了什么，Lane 决定先做哪一批，Fiber 把计算拆开，WIP 允许这次计算暂停或丢掉，Commit 才碰用户正在看的界面。」

收尾边界：「这套实现接上了剪枝、ref、常用 Hook、Fragment、Context、`memo`、`forwardRef`、过渡档、优先级堆、函数式错误边界、最小 Suspense，以及根上的 click 委托。官方还有更多 Lane 档位、按 Lane 跳过单条 Hook 更新、类生命周期、水合和完整合成事件。」

## 主题提纲

### 1. JSX / Element

- JSX 编译为函数调用，返回 ReactElement，不是 DOM。
- `key` 参与同层复用；`ref` 从 props 拆出，留给 Layout 写入。
- 细节：[第 4 章](./docs/react-design/04-ReactElement与createElement.md)、[第 5 章](./docs/react-design/05-JSX与jsx-runtime与typeof.md)

### 2. Fiber

- Fiber 是可逐个执行的工作单元；`child / sibling / return` 支撑工作循环。
- current / WIP 通过 `alternate` 对应。Commit 成功后切换 `root.current`；WIP 被丢掉时 current 不动。
- 细节：[第 6 章](./docs/react-design/06-Fiber链表与双缓冲.md)、[第 7 章](./docs/react-design/07-副作用标记Flags.md)

### 3. Render / Commit

- Render 负责计算、Diff、创建离屏实例和打标记。它不修改已经挂上的宿主树。
- Commit 顺序：Mutation，切换 current，Layout。Passive 延后。Layout 同时写 ref，卸载时写成 `null`。
- 细节：[第 8 章](./docs/react-design/08-工作循环.md)～[第 12 章](./docs/react-design/12-Commit三阶段.md)。ref 写入见 `packages/react-reconciler/src/commitWork.ts`。

### 4. Diff

- 单节点由 `key + type` 决定复用；对不上就删旧的、建新的。
- 数组先顺序试探，再用 Map 匹配剩余节点；`lastPlacedIndex` 判断移动。
- `Fragment` 走同一套对比，自己不创建 DOM。
- 细节：[第 10 章](./docs/react-design/10-子节点Diff.md)

### 5. Hooks

- Hook 按调用顺序挂在 `memoizedState` 链表上，所以不能写在条件里。
- `useState` / `useReducer` 共用环形队列。前者按函数式更新重放，后者调用 `reducer(state, action)`。
- `useRef` 每次返回同一个 `{ current }`。`useMemo` / `useCallback` 在依赖逐项相同时复用上一次的值或函数。
- `useLayoutEffect` 的清理在 Mutation，创建在 Layout。`useEffect` 在后续宏任务里先清理再创建。
- 细节：[第 13 章](./docs/react-design/13-函数组件的执行时机.md)～[第 16 章](./docs/react-design/16-useEffect与useLayoutEffect.md)。新增 Hook 见 `packages/react-reconciler/src/hooks.ts`。

### 6. bailout

- 四个条件同时成立才跳过：自己的 `lanes` 与本轮无关，`childLanes` 也无关，props 浅比较相同且 ref 没换，context 依赖没过期。
- 跳过时克隆直接孩子，避免两棵树共用同一格 Fiber，并且不再调用函数。
- `childLanes` 让父节点知道子树里还有活。孩子 `setState` 会把 Lane 标到祖先上，父函数不能跳。
- 源码：`packages/react-reconciler/src/beginWork.ts`。

### 7. Context、memo、forwardRef

- Provider 把 value 放进 Fiber，并让子树的 `useContext` 读到它。value 变了，消费者即使 props 相同也不能 bailout。
- `memo` 用比较函数决定是否进入内部函数，默认是 props 浅比较。Hook 挂在 `memo` 这格 Fiber 上。
- `forwardRef` 把 ref 交给渲染函数的第二个参数，由内部宿主节点写入。外层那格 Fiber 自己不占这个 ref。
- 源码：`packages/react/src/ReactHooks.ts`、`packages/react-reconciler/src/beginWork.ts`。

### 8. Scheduler / Lane

- Lane 回答「哪一批先做」。Scheduler 回答「回调何时跑、何时让出」。`MessageChannel` 只负责拿到宏任务。
- 根上同时有多档时只取最高档：同步，然后普通，最后过渡。
- 调度器按优先级和入队时间放进最小堆，5 毫秒后 `shouldYield`。同步档走微任务，不进这只堆。
- `startTransition` 把回调里的 `setState` 标成 `TransitionLane`。更高优更新到来时丢掉进行中的过渡 WIP，先做完高优再重开。被丢掉的那次不 Commit。
- 教学简化：单条 Hook 更新自己不带 Lane。组件一旦重跑，队列里的更新会一起算完。
- 调度器源码：`packages/scheduler/src/Scheduler.ts`。Lane 源码：`packages/react-reconciler/src/fiberLanes.ts`。设计文档第 17、18 章仍是旧的两档和先进先出队列。

### 9. 出错、挂起、事件

- 渲染抛出普通错误时，沿 `return` 找到带标记的函数组件。这不是类，也没有生命周期。current 保持不动，边界改提交 `fallback`。
- 子树抛出 thenable 时，`Suspense` 先提交 `fallback`；完成后用挂起时的那一档 Lane 再渲染。
- `click` 只在容器上听一次，再沿 `parentNode` 找到目标上的处理函数。其余事件仍逐节点绑定，用来对照。
- 源码：`packages/react-reconciler/src/workLoop.ts`、`packages/react-dom/src/hostConfig.ts`。

## 常见追问

- **为什么 Fiber 能停，递归调用栈不方便停？** 下一个工作单元写在指针上，不依赖浏览器调用栈。看[工作循环](./docs/react-design/08-工作循环.md)和[Fiber 链表](./docs/react-design/06-Fiber链表与双缓冲.md)。

- **Render 能不能碰 DOM？** 能在 `completeWork` 里创建还没挂上的节点。插入、删除、改已挂载节点在 Commit。

- **为什么要两棵树？** Render 可以重做。改的是 WIP。丢掉它时，已经展示的 current 不变。

- **为什么 `key` 不能只用下标？** 下标不能稳定表示跨更新的身份，重排时会把状态套错节点。看[数组 Diff](./docs/react-design/10-子节点Diff.md#103-数组子节点)。

- **为什么 Hooks 不能写在条件里？** mount / update 靠调用顺序对齐，格子没有名字。看[第 14 章](./docs/react-design/14-Hook链表与Dispatcher.md)。

- **`useEffect` 和 `useLayoutEffect` 差在哪？** Layout 在 DOM 改完、绘制前同步跑。Passive 放到后续宏任务。这个仓库不保证那个任务执行前一定已经画完。

- **父组件 `setState`，子组件一定重跑吗？** props 浅比较相同、自己和子树都没有本轮 Lane、context 也没变，就不重跑。子树有 Lane 时父函数必须重跑。

- **Lane 和 Scheduler 是一回事吗？** Lane 是更新档位。Scheduler 是时间片执行器。同步档不经过 Scheduler。

- **高优更新打断过渡后，用户会看到中间态吗？** 被打断的那次没有 Commit。current 仍是上一棵已经展示的树。

- **为什么协调器不直接调用 `document`？** HostConfig 把宿主能力隔开。这个仓库的实现是 DOM。看[第 19 章](./docs/react-design/19-HostConfig抽象.md)。

- **和官方 React 差在哪？** 这里是三条 Lane、固定 5 毫秒、优先级堆，以及最小的错误边界、Suspense 和 click 委托。官方还有更多档位、单条更新的 Lane、类生命周期、水合和完整合成事件。设计文档附录里的未实现清单还是旧版本，不要拿它当边界。

## 演示时怎么说

- 点 `+1`：「更新进环形队列，标 `DefaultLane`，重新执行组件，复用文本节点，Commit 改文本。」
- 点 `+3（函数式）`：「三条 action 进同一个环，只预约一次，从最老的一条开始算。」
- 点 `reverse`：「稳定 key 找回旧 Fiber 和 DOM；`lastPlacedIndex` 决定谁要移动。」
- 点 `add`：「新 key 没有旧 Fiber，Render 创建离屏实例并打插入标记，Commit 插入。」
- 点 `remove first`：「父 Fiber 记下 deletions，Mutation 先清副作用再删节点。」
- 点 `next value`：「Layout 在同步 Commit 里，Passive 在后面的宏任务里。」
- 第四张，点 `parent +1`：「子函数次数停住。子按钮一加，`childLanes` 把父函数拉回来。」
- 第五张：「context 的 value 不变时，消费者次数停住；value 一变就再执行。`memo` 在 `n` 不变时跳过内部函数。」
- 第六张：「崩溃后提交 fallback。挂起时先看到 loading，完成后变成内容。委托按钮每点一次只加一。」

`pnpm dev` 打开 `demos/hello-dom`。`pnpm test` 用内存宿主证明复用、剪枝、ref、过渡被丢掉、错误边界和 Suspense 这些不变量。
