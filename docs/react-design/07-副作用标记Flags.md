# 第 7 章：副作用标记 Flags

[← 返回总目录](../../React设计与实现.md) · [上一章](./06-Fiber链表与双缓冲.md) · [下一章 →](./08-工作循环.md)

> 主文件：`packages/react-reconciler/src/fiberFlags.ts`
> Render 只在 Fiber 上打比特位；真正碰 DOM 和跑 effect，是 Commit 按 mask 扫树。

## 本章书签

- [7.1 为什么 Render 不直接改 DOM，只打标记](#71-为什么-render-不直接改-dom只打标记)
- [7.2 `Placement` / `Update` / `ChildDeletion` / `Passive`](#72-placement--update--childdeletion--passive)
- [7.3 flags 如何沿树冒泡](#73-flags-如何沿树冒泡)
- [面试复习](#面试复习)

---

## 7.1 为什么 Render 不直接改 DOM，只打标记

DefaultLane 的 Render 可中断。若 `beginWork` 一边 diff 一边 `appendChild`，切片中途屏幕上会少一块、或多一块刚插上的节点。双缓冲保证 WIP 是内存里的另一棵树，但宿主实例一旦挂进 `#root`，就和 current 脱节了。

所以 Render 的约定是：

1. 只改 Fiber：接 child 链表、写 `pendingProps`、打 `flags`。
2. `completeWork` 可以 `createInstance`（对齐官方 DOM host config：实例先挂在 `stateNode` 上，还没进文档树）。
3. **插入、删除、改属性和 Layout Effect** 留到同步、不可中断的 `commitRoot`；Passive Effect 由 Commit 登记，再在后续 Scheduler 任务执行。

flags 是这条约定的记账本。Commit 不用再 diff 一遍，按位扫描即可。

## 7.2 `Placement` / `Update` / `ChildDeletion` / `Passive`

值与官方同源，方便对照：

```ts
export const NoFlags = 0;
export const Placement = 2;
export const Update = 4;
export const ChildDeletion = 16;
export const Passive = 2048;
```

| flag | 谁打 | Commit 时做什么 |
| --- | --- | --- |
| `Placement` | Diff：新建，或列表里相对前移 | Mutation：`insertBefore` / `appendChild` |
| `Update` | `completeWork`：Host props / 文本变了；`useLayoutEffect` deps 变了 | Mutation：Host 改 DOM；函数组件跑 layout **destroy**。Layout：跑 layout **create** |
| `ChildDeletion` | Diff：`deleteChild` 时打在**父**节点上 | Mutation：遍历父的 `deletions[]`，卸 effect 再 `removeChild` |
| `Passive` | `useEffect` mount 或 deps 变了 | 后续 Scheduler 宏任务：先 destroy 再 create，并给浏览器留下绘制机会 |

`Update` 一身二职：Host 的属性更新和函数组件的 `useLayoutEffect` 共用这一位。Commit 按 `fiber.tag` 分叉——Host 走 `commitWork`，`FunctionComponent` 走 hook 链表。不要写成 `if Placement else if Update`：列表节点可以同时被移动又改文本。

三组 mask 决定「这一阶段要不要进这棵子树」：

```ts
MutationMask = Placement | Update | ChildDeletion
LayoutMask   = Update
PassiveMask  = Passive | ChildDeletion
```

`ChildDeletion` 出现在 PassiveMask 里：卸载时 Passive effect 的 destroy 也要跑（本仓库卸载简化为 Mutation 里两种 destroy 一起跑，第 12、16 章会说）。

## 7.3 flags 如何沿树冒泡

每个节点有两套位：

- `flags`：自己的副作用。
- `subtreeFlags`：子孙的副作用之或。

`completeWork` 末尾调 `bubbleProperties`：顺着 `child → sibling`，把孩子的 `flags | subtreeFlags` 或进自己的 `subtreeFlags`，同时把 `lanes | childLanes` 冒泡成自己的 `childLanes`。

```text
叶子打 Update
    │
    ▼
父.subtreeFlags |= Update
    │
    ▼
HostRoot.subtreeFlags 带上整棵树的副作用
```

Commit 时先看根的 `subtreeFlags`：某一 mask 为 0，整棵子树可以跳过。没有冒泡，就要无脑遍历每一个 Fiber。

`deletions` 不冒泡内容，只靠父节点自己的 `ChildDeletion`。真正要删的节点挂在父的数组里，因为被删的孩子已经不在 wip 的 child 链表上，光靠向下走当前树找不到它们。

下一章把「向下 begin、向上 complete」收成工作循环，flags 就是循环结束时树上留下的作业清单。

## 面试复习

### 一句话结论

flags 是 Render 阶段写在 Fiber 上的提交计划，`subtreeFlags` 是这份计划的子树索引，让 Commit 按阶段和位掩码只访问可能有副作用的分支。

### 面试回答

为什么 Render 不直接执行副作用？因为并发 Render 可能暂停、重启或丢弃，若此时已经插 DOM 或执行 effect，就无法安全回滚。于是数据结构上每个 Fiber 用 `flags` 记录自身工作，用 `subtreeFlags` 汇总后代工作，删除目标另存在父节点的 `deletions`；阶段上 Render 只计算，Commit 再按 Mutation、Layout、Passive 对应 mask 处理。本仓库支持 `Placement/Update/ChildDeletion/Passive`：其中 `Update` 会根据 Fiber tag 分别表示宿主更新或 layout effect 工作，多个位可同时存在，必须用按位与判断。官方 React 的 flags 和 mask 数量更多，具体数值及复用方式可能随版本变化；面试应解释机制，而不是背本仓库的四个常量值。

### 常见追问

**1. 为什么既要 `flags` 又要 `subtreeFlags`？**

前者说明节点自己要做什么，后者让祖先快速判断某阶段是否需要进入该子树，避免 Commit 每次全树扫描。

**2. 删除为什么记在父节点？**

被删 Fiber 已不在新的 WIP child 链上，只向下遍历新树找不到它；父节点保留 `deletions[]` 才能在 Commit 定位旧子树。

**3. 一个节点能同时 Placement 和 Update 吗？**

可以，例如列表项既移动又更新属性。flags 是位集合，提交逻辑不能假设副作用互斥。

**4. `completeWork` 创建 DOM 是否违背 Render 无副作用？**

创建未挂载实例是可丢弃的内存/宿主准备工作；真正改变可见容器的插入、删除和更新仍在 Commit。更严谨地说，Render 应避免用户可观察的持久副作用。

### 容易说错

- 不要把 flags 说成虚拟 DOM Diff 的结果对象；它们是挂在 Fiber 上、供分阶段提交读取的位集合。
- 不要背诵数值后声称与所有官方版本一致；本仓库只取教学子集，官方定义会演进。
- 不要说 `subtreeFlags` 包含当前节点自己的 flags；它只汇总子孙，当前节点仍检查 `flags`。
- 不要说 Render 完全不创建任何 DOM 对象；本仓库在 `completeWork` 可创建尚未插入容器的实例。

### 源码入口

- `packages/react-reconciler/src/fiberFlags.ts`：flags 与阶段 mask。
- `packages/react-reconciler/src/childFiber.ts`：Placement、ChildDeletion 的产生。
- `packages/react-reconciler/src/completeWork.ts`：Update 判断与 `subtreeFlags` 冒泡。
- `packages/react-reconciler/src/commitWork.ts`：按 Mutation/Layout/Passive 消费 flags。
- `packages/react-reconciler/src/fiber.ts`：`flags/subtreeFlags/deletions` 字段。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./06-Fiber链表与双缓冲.md) · [下一章 →](./08-工作循环.md)
