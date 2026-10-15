# 第 7 章：副作用标记 Flags

[← 返回总目录](../../React设计与实现.md) · [上一章](./06-Fiber链表与双缓冲.md) · [下一章 →](./08-工作循环.md)

---

同一个 `<p>` 从 `count: 0` 更新为 `count: 1` 时，屏幕不会在 Render 途中突然变化。`completeWork` 已经发现文本不同，却只在 Fiber 上留下一个标记。真实文本要到 Commit 才会改写。Render 与 Commit 之间传递的这份待办记录，就是 flags。

## 7.1 文本已经变了，DOM 为什么还没变

先看 HostText 在 Render 结束时的状态：

```text
HostText
  pendingProps = "count: 1"
  flags        = Update
```

此时 Fiber 已经保存新文本，页面仍显示 `count: 0`。随后 Commit 读到 `Update`，调用宿主环境的文本更新方法，页面才变成 `count: 1`。

这段间隔让 Render 保持可撤销。DefaultLane 和 TransitionLane 的工作可以在 Fiber 边界暂停，优先级变化时，已经算出的半成品也可能被丢弃。若 Render 一边计算一边修改已挂载的节点，放弃半成品时就很难恢复原来的界面。把宿主修改集中到不可中断的 Commit，还能让同一轮的插入、删除、属性更新和 Effect 按固定阶段发生。

Render 并非完全不接触宿主对象。首次挂载时，`completeWork` 会调用 `createInstance` 或 `createTextInstance`，再把这些离屏节点组装起来。它们还没有接入页面，整棵 WIP 树作废时可以一起丢弃。插入、移动、删除以及已有节点的更新，才会等到 Commit。

## 7.2 一组二进制位如何变成提交清单

每种 flag 占一个二进制位。按位或把多项工作放进同一个数字，于是一个列表项可以同时携带 `Placement | Update`：它既要移动，属性也要更新。Commit 用按位与逐项检查，两项工作都会执行。

| flag | 在哪里产生 | 后续怎样消费 |
| --- | --- | --- |
| `Placement` | 子节点 Diff 发现新建或相对移动 | Mutation：插入或移动宿主节点 |
| `Update` | Host 在 `completeWork` 发现 props / 文本变化；Hook 渲染发现 Layout Effect 要执行 | Mutation 更新 DOM 或跑 layout destroy；Layout 跑 layout create |
| `ChildDeletion` | Diff 把待删旧 Fiber 放进父节点的 `deletions` | Mutation：清 ref、清 Effect、删除宿主节点 |
| `Ref` | `beginWork` 发现 ref 新增或身份变化 | Layout：写入新的 ref；删除时另行清空 |
| `Passive` | Hook 渲染发现 Passive Effect 要执行 | 后续 Scheduler 任务：先 destroy，再 create |
| `DidCapture` | Render 捕获错误或 thenable | 边界下一次 `beginWork` 改走 fallback |

`Update` 会出现在不同 tag 上。Host Fiber 携带它时，Mutation 阶段更新 DOM；函数组件、memo 或 forwardRef 携带它时，Mutation 先执行 `useLayoutEffect` 的 destroy，Layout 再执行 create。flag 只说“这个阶段有工作”，具体动作还要结合 `fiber.tag` 判断。

提交阶段先用 mask 筛选关心的位：

```ts
MutationMask = Placement | Update | ChildDeletion;
LayoutMask = Update | Ref;
PassiveMask = Passive | ChildDeletion;
```

Mutation 只进入可能插入、更新或删除的分支，Layout 还要处理 ref。`PassiveMask` 虽然包含 `ChildDeletion`，但这份教学实现会在 Mutation 的删除路径中同步清理被删子树的 Effect；后续 Passive 遍历处理的是仍在 finished tree 上的 Effect。`DidCapture` 不在这三组 mask 中，它留在 Render 流程里，引导错误边界或 Suspense 改走 fallback。

## 7.3 `subtreeFlags` 如何剪掉无事可做的分支

每个 Fiber 有两套标记：

- `flags` 只表示自己要做什么；
- `subtreeFlags` 汇总所有子孙的工作。

假设只有文本叶子需要更新：

```text
HostRoot  subtreeFlags = Update
└── App   subtreeFlags = Update
    └── p subtreeFlags = Update
        └── Text flags = Update
```

节点向上完成时，`bubbleProperties` 扫描直接孩子，把孩子自身和更深后代的标记都并入父节点：

```ts
subtreeFlags |= child.subtreeFlags;
subtreeFlags |= child.flags;
```

到了 Commit，`subtreeFlags & MutationMask` 若为 0，整棵子树在 Mutation 阶段都没有任务，遍历可以直接跨过。`subtreeFlags` 只收集后代，不含当前节点自己的 `flags`；递归处理完孩子后，Commit 仍会单独检查当前 Fiber。

删除稍有不同。被删 Fiber 已从新的 WIP child 链中消失，沿新树遍历已经找不到它。Diff 会把旧 Fiber 放进父节点的 `deletions[]`，同时在父节点加上 `ChildDeletion`。Commit 到达这个父节点时，先沿这份清单清理 ref 和 Effect，再移除对应宿主节点。

Render 完成时，WIP 树同时保存了两类结果：新的节点结构，以及散布在 `flags`、`subtreeFlags` 和 `deletions` 中的提交计划。Commit 无须重新做一次新旧树比较。

## 本章回顾

- Render 可以创建尚未挂载的宿主实例；会持续影响可见界面的插入、删除和更新集中在 Commit。
- `flags` 记录 Fiber 自己的任务，阶段 mask 决定何时消费；相同的位还会结合 `fiber.tag` 解释。
- `subtreeFlags` 是后代任务的索引，`deletions[]` 则保留已离开新 child 链的旧 Fiber。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./06-Fiber链表与双缓冲.md) · [下一章 →](./08-工作循环.md)
