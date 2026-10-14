# 第 7 章：副作用标记 Flags

[← 返回总目录](../../React设计与实现.md) · [上一章](./06-Fiber链表与双缓冲.md) · [下一章 →](./08-工作循环.md)

---

列表从 `A B C` 变成 `C B A` 时，Render 已经算出哪些 Fiber 要移动。Commit 为什么不用再比较一次新旧列表？因为 Render 会把后续工作写成 flags，Commit 只负责照单执行。本章只回答三个问题：为什么先记账、每一位表示什么、Commit 怎样跳过没有工作的子树。

## 本章书签

- [7.1 Render 为什么只记账](#71-render-为什么只记账)
- [7.2 一位 flag 对应一类后续工作](#72-一位-flag-对应一类后续工作)
- [7.3 subtreeFlags 怎样剪掉空分支](#73-subtreeflags-怎样剪掉空分支)
- [面试复习](#面试复习)

---

## 7.1 Render 为什么只记账

先看最小更新：同一个 `<p>` 从 `count: 0` 变成 `count: 1`。`completeWork` 发现文本不同，但不会立即改屏幕上的 Text。它只给 HostText Fiber 加一位 `Update`：

```text
HostText
  pendingProps = "count: 1"
  flags        = Update
```

预期结果很明确：Render 结束前，页面仍显示 `count: 0`；Commit 消费 `Update` 后，页面才显示 `count: 1`。

这样分阶段有两个原因。第一，DefaultLane 和 TransitionLane 的 Render 可以在 Fiber 边界让出，半成品也可能被丢弃。第二，同一轮的插入、删除、属性更新和 Effect 必须按固定顺序发生，否则用户可能看到一半新、一半旧的界面。

本仓库的 Render 也会创建宿主对象。`completeWork` 可以调用 `createInstance` 或 `createTextInstance`，但这些节点尚未挂进已显示的文档。这里更准确的边界是：Render 不执行用户可见、需要持久保留的宿主修改；插入、移动、删除和已有节点更新留给 Commit。

## 7.2 一位 flag 对应一类后续工作

flag 是一个二进制位。同一个 Fiber 可以按位或同时携带多项工作，例如列表项既移动又更新属性时会同时带 `Placement | Update`。

当前仓库在 `fiberFlags.ts` 定义了这些位：

| flag | 在哪里产生 | 后续怎样消费 |
| --- | --- | --- |
| `Placement` | 子节点 Diff 发现新建或相对移动 | Mutation：插入或移动宿主节点 |
| `Update` | Host 在 `completeWork` 发现 props / 文本变化；Hook 渲染发现 Layout Effect 要执行 | Mutation 更新 DOM 或跑 layout destroy；Layout 跑 layout create |
| `ChildDeletion` | Diff 把待删旧 Fiber 放进父节点的 `deletions` | Mutation：清 ref、清 Effect、删除宿主节点 |
| `Ref` | `beginWork` 发现 ref 新增或身份变化 | Layout：写入新的 ref；删除时另行清空 |
| `Passive` | Hook 渲染发现 Passive Effect 要执行 | 后续 Scheduler 任务：先 destroy，再 create |
| `DidCapture` | Render 捕获错误或 thenable | 边界下一次 `beginWork` 改走 fallback |

`Update` 一位有两种含义，不是混乱，而是不同 tag 在同一提交阶段需要工作。Host Fiber 消费它时修改 DOM；函数组件、memo、forwardRef 消费它时处理 `useLayoutEffect`。Commit 会先看 tag，再决定执行哪条路径。

阶段用 mask 把相关位合起来：

```ts
MutationMask = Placement | Update | ChildDeletion;
LayoutMask = Update | Ref;
PassiveMask = Passive | ChildDeletion;
```

因此不能把 `LayoutMask` 简化成 `Update`。当前实现还要在 Layout 写 ref。`DidCapture` 不属于这三组提交 mask，它服务于 Render 失败后的边界恢复。

## 7.3 `subtreeFlags` 怎样剪掉空分支

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

向上完成节点时，`bubbleProperties` 顺着直接孩子相加：

```ts
subtreeFlags |= child.subtreeFlags;
subtreeFlags |= child.flags;
```

Commit 进入某个分支前，先拿 `subtreeFlags` 和当前阶段的 mask 做按位与。结果为 0，说明这棵子树在本阶段没有工作，可以整棵跳过。`subtreeFlags` 不包含节点自己的 `flags`，所以递归回来后还要单独检查当前节点。

删除目标不能只靠向下遍历找到。旧 Fiber 已经不在新的 WIP child 链上，因此 Diff 把它放进父 Fiber 的 `deletions[]`，再给父节点打 `ChildDeletion`。Commit 先在父节点读出这份旧子树清单。

下一章把 Render 的遍历收成工作循环。那一轮循环结束后，整棵 WIP 树上的 flags 就是 Commit 的执行计划。

## 面试复习

### 一句话结论

`flags` 是 Fiber 自己的提交计划，`subtreeFlags` 是后代计划的索引；Render 负责写计划，Commit 按阶段 mask 消费。

### 常见追问

**为什么 Render 可以创建 DOM，却不能插入 DOM？**

创建尚未挂载的实例不会改变用户正在看的文档，可以随失败的 WIP 一起丢弃；插入、删除或更新已挂载节点会产生持续可见的结果，必须等 Commit。

**为什么删除记在父节点？**

被删 Fiber 不在新 child 链上。父节点用 `deletions[]` 保留旧子树引用，并用 `ChildDeletion` 告诉 Commit 来处理。

**官方 React 也只有这些 flag 吗？**

不是。本章描述当前教学仓库。官方版本的 flags、mask 和阶段细节更多，也会随版本演进。

### 源码入口

- `packages/react-reconciler/src/fiberFlags.ts`：flags 与阶段 mask。
- `packages/react-reconciler/src/childFiber.ts`：`Placement`、`ChildDeletion`。
- `packages/react-reconciler/src/completeWork.ts`：Host `Update` 与 `bubbleProperties`。
- `packages/react-reconciler/src/beginWork.ts`：`Ref`、`DidCapture` 的使用路径。
- `packages/react-reconciler/src/commitWork.ts`：按 mask 消费 flags。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./06-Fiber链表与双缓冲.md) · [下一章 →](./08-工作循环.md)
