# 第 11 章：`completeWork` 创建实例与冒泡 flags

[← 返回总目录](../../React设计与实现.md) · [上一章](./10-子节点Diff.md) · [下一章 →](./12-Commit三阶段.md)

> 主文件：`packages/react-reconciler/src/completeWork.ts`
> 向上半程：叶子先完成，父节点再完成。Host 节点在这里创建（或标记更新）实例，并把 flags / lanes 冒泡给祖先。

## 本章书签

- [11.1 Host 节点何时创建实例](#111-host-节点何时创建实例)
- [11.2 把子 DOM append 到父实例](#112-把子-dom-append-到父实例)
- [11.3 props 变化与 subtreeFlags](#113-props-变化与-subtreeflags)
- [11.4 实例创建、子树组装与 Placement](#114-实例创建子树组装与-placement)
- [面试复习](#面试复习)

---

工作循环走到叶子（`beginWork` 返回 `null`）后开始往上。`completeWork` 按 tag 分叉：Host 负责实例，函数组件和 HostRoot 只冒泡。

## 11.1 Host 节点何时创建实例

**HostComponent** 两条路：

```text
current != null 且 stateNode 已有
    → 复用 DOM，只问 props 变了没（变了打 Update）
否则（首次挂载）
    → hostConfig.createInstance(type, pendingProps)
    → appendAllChildren
    → stateNode = instance
```

**HostText** 同构：已有实例则比字符串，不同打 `Update`；否则 `createTextInstance`。

这是 Render 阶段唯一允许「new 出宿主对象」的地方，对齐官方 React DOM：实例先挂在 Fiber 上，**还没有** `append` 进文档树里的 `#root`。挂进文档是 Commit 的 `Placement`。

函数组件、HostRoot 没有自己的 DOM，`completeWork` 只调 `bubbleProperties`。

## 11.2 把子 DOM append 到父实例

首次创建 Host 实例之后，要把已经 complete 的子孙挂到这个实例上。`appendAllChildren` 不是只看直接 `child`，因为中间可能隔着函数组件：

```text
div（正在 complete）
  └── App（FunctionComponent，无 stateNode）
        └── p（Host，有 stateNode）
```

算法：从 `wip.child` 出发，遇到 HostComponent / HostText 就 `appendChild`；遇到还有孩子的非 Host（函数组件），往下钻；本层没兄弟了就回退，直到回到正在 complete 的那个节点。

```text
深度优先收集「最近的宿主子孙」，挂到刚创建的父实例上
```

注意：这里 `appendChild` 的 parent 是**刚 new 出来、尚未进文档的节点**。宿主子树先在内存里拼好，再由 Commit 处理祖先上的 `Placement`，把对应的顶层宿主节点插入 `#root`（或已有父 DOM）。

首次渲染不能概括成「整棵树都走 mount、Commit 只插最外层 Host Fiber」：HostRoot WIP 有 current，根层新建的首个应用 Fiber（可能是 FunctionComponent）会打 `Placement`；Commit 若遇到没有 DOM 的函数组件，会继续向下，把它覆盖的顶层 Host 节点逐个插入。函数组件后代走 `mountChildFibers(false)`，才不会各自重复打标。

更新路径不会走 `appendAllChildren`——旧 DOM 还在，孩子的插删移交给 Diff 打的 flags。

## 11.3 props 变化与 subtreeFlags

更新时 `propsNeedUpdate` 比较 `current.memoizedProps` 与 `wip.pendingProps`：

- 引用相同 → 不变。
- 跳过 `children`（孩子走 Diff，不走属性更新）。
- 其余 key 做 `Object.is`，有一个不同就打 `Update`。

文本更简单：`current.memoizedProps !== newText`。

每条分支末尾都 `bubbleProperties`：

1. 顺着 `child → sibling`，把孩子的 `flags | subtreeFlags` 或进自己的 `subtreeFlags`。
2. 把孩子的 `lanes | childLanes` 合并成自己的 `childLanes`。
3. 顺手把 `child.return` 指回自己（链表在 Diff 后可能还没接牢）。

例如，某次更新同时新增一个分支，并修改另一个分支的文本：

```text
HostRoot
  subtreeFlags = Placement | Update
  ├── ExistingApp
      subtreeFlags = Update
      └── div
          flags        = NoFlags
          subtreeFlags = Update
          └── "count: 1"
              flags = Update
  └── NewPanel
      flags = Placement

向上合并：
父.subtreeFlags |= 子.flags | 子.subtreeFlags
```

lane 的冒泡规则相同，但字段独立。假设本轮还保留一项较低优先级工作：

```text
HostRoot.childLanes = DefaultLane
  └── App.childLanes = DefaultLane
      └── Counter.lanes = DefaultLane

父.childLanes    |= 子.lanes | 子.childLanes
```

flags 是本次 Commit 要做的副作用；lanes 是更新优先级与仍待处理的工作信息。二者都向上汇总，但不能混为一谈。

冒泡完成后，HostRoot 的 `subtreeFlags` 就是整棵树的作业清单。Commit 先看 mask，子树全是 `NoFlags` 就整棵跳过。

官方 `beginWork` 还能用 `childLanes` 做 bailout（子树与本轮 `renderLanes` 无交集则跳过）。本仓库记下了字段并在这里冒泡，教学路径暂不跳过，避免和「每个节点都走一遍」的讲解打架。

## 11.4 实例创建、子树组装与 Placement

这三个动作属于不同层次，面试时要拆开说：

```text
createInstance / createTextInstance
  → 创建独立 DOM 节点，保存到 fiber.stateNode

appendAllChildren(instance, wip)
  → 把已完成的最近宿主子孙挂到这个独立实例
  → 形成离线 DOM 子树，仍未进入 document 中的根容器

commitPlacement(fiber)
  → 找最近 Host 父节点或 HostRoot.containerInfo
  → 把需放置 Fiber 对应的顶层宿主节点插入已挂载树
```

以 `HostRoot → App → div → span → "hello"` 为例，向上 complete 时：

1. HostText 调 `createTextInstance`。
2. span 调 `createInstance('span')`，`appendAllChildren` 把 Text 挂到 span。
3. div 调 `createInstance('div')`，`appendAllChildren` 遇到 span 后直接 append；不会继续钻进 span，否则 Text 会被重复挂到 div。
4. App 没有实例，只冒泡。
5. Commit 处理 App 的 `Placement`，跨过 App 找到 div，将整个已组装的 div 子树挂到容器。

跨函数组件时则不同：

```text
div（正在 complete）
  └── Wrapper（无 stateNode）
      ├── span（Host）
      └── "tail"（HostText）
```

`appendAllChildren` 会钻过 Wrapper，append span 和 `"tail"`；遇到 Host 后不再向其内部下钻。它收集的是当前 Host 父节点下面的**最近一层宿主子孙**，而不是所有宿主后代。

下一章把这些 flags 落到真实 DOM，并按 Mutation / Layout / Passive 跑 effect。

---

## 面试复习

### 一句话结论

`completeWork` 自底向上创建或复用宿主实例、组装离线宿主子树，并把 flags 与 lanes 汇总到祖先，真正挂入已提交树要等 Commit 的 `Placement`。

### 面试回答（可口述，为什么→机制→仓库落点→官方差异）

为什么需要 complete 阶段：父 DOM 要组装孩子，必须等孩子先完成，所以 Fiber 遍历在叶子处转为自底向上。机制上，HostComponent 首次创建实例并用 `appendAllChildren` 收集最近宿主子孙，更新时只标 `Update`；非 Host 节点不创建实例；最后统一 `bubbleProperties`。仓库落点是 `completeWork.ts`。官方 completeWork 还包含 host context、更新 payload、hydration、资源类型等分支，本仓库把首次属性直接放进 `createInstance`，更新只做布尔判定。

### 常见追问

**Q：`appendAllChildren` 为什么要跨函数组件？**
A：函数组件没有 `stateNode`，真实宿主父子关系可能跨过多个无实例 Fiber。

**Q：`createInstance` 后 DOM 已经上屏了吗？**
A：没有。节点只是被创建并可能组装成离线子树，进入根容器或已挂载父节点要等 `commitPlacement`。

**Q：为什么既有 `flags` 又有 `subtreeFlags`？**
A：`flags` 描述节点自身工作；`subtreeFlags` 汇总后代工作，让 Commit 用 mask 跳过无副作用子树。

**Q：lanes 和 flags 是一回事吗？**
A：不是。lanes 表示更新优先级与待处理范围，flags 表示本次提交要执行的具体副作用。

### 容易说错

- 错：`completeWork` 把节点挂进 `#root`。对：它只创建和组装实例，挂入已提交树在 Commit。
- 错：`appendAllChildren` append 所有宿主后代。对：它 append 最近宿主子孙，遇到 Host 就不再下钻。
- 错：首次所有 Fiber 都无 `Placement`。对：首次 HostRoot 根层会给新建应用 Fiber打 `Placement`。

### 源码入口

- `packages/react-reconciler/src/completeWork.ts`：`completeWork`
- `packages/react-reconciler/src/completeWork.ts`：`appendAllChildren`
- `packages/react-reconciler/src/completeWork.ts`：`bubbleProperties`
- `packages/react-reconciler/src/commitWork.ts`：`commitPlacement`

[← 返回总目录](../../React设计与实现.md) · [上一章](./10-子节点Diff.md) · [下一章 →](./12-Commit三阶段.md)
