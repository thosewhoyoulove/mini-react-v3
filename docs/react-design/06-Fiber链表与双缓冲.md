# 第 6 章：Fiber 链表与双缓冲

[← 返回总目录](../../React设计与实现.md) · [上一章](./05-JSX与jsx-runtime与typeof.md) · [下一章 →](./07-副作用标记Flags.md)

---

第 2 章的 `mount` 要等整棵子树都 `appendChild` 完才能返回。若浏览器此时要求让出主线程，React 怎样记住「下一步从哪里继续」？ReactElement 的孩子嵌在 `props.children` 里，本身没有这个答案。本章把遍历进度放进 Fiber 链表，并为同一位置准备两格节点：一格对应当前屏幕，一格留给这一轮计算。flags 和调度代码留到后面几章。

## 6.1 描述树为什么停不下来

`packages/react-reconciler/src/fiber.ts` 文件头用了一棵很小的描述：

```js
createElement(
  'div',
  null,
  createElement('h1', null, 'Mini React'),
  createElement('p', null, 'count: 0'),
);
```

ReactElement 用嵌套对象表达这棵树：`div` 的孩子是数组，`h1` 的孩子是字符串 `'Mini React'`。普通递归把进度留在 JavaScript 调用栈里。处理 `h1` 时，下一步如何回到 `div`、再访问 `p`，都隐含在尚未返回的函数帧中，无法退出调用栈后再原地续上。

Fiber 把原本隐含的路径改成显式指针：

```text
child    第一个子节点
sibling  下一个兄弟
return   父节点
```

`return` 相当于父指针，表示当前节点完成后回到哪里。Fiber 没有 `prevSibling`；需要前一个兄弟时，只能从父节点的 `child` 重新向后查找。提交阶段寻找插入位置时，也会沿这些关系移动。

工作循环每次处理一个 Fiber。有 `child` 就向下；没有孩子便完成当前节点，再尝试 `sibling`；兄弟也不存在时，沿 `return` 向上。这样一来，遍历进度不再依赖调用栈。让出主线程时只需保留下一个工作单元，恢复后从那个 Fiber 继续，而不是停在一段函数执行到一半的位置。

## 6.2 三条指针怎么走完一棵小树

这棵描述对应的链表是：

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

`HostRoot` 不是 JSX 的产物。`createRoot` 先创建这个内部根节点，它的 `child` 才对应 `render` 收到的描述。图里 `div.child` 是 `h1`，`h1.sibling` 是 `p`，而 `p.return` 指回 `div`。

沿指针走一遍，路线如下：

```text
HostRoot → div → h1 → "Mini React"
完成文本，完成 h1，下一个是 p
p → "count: 0"
完成文本，完成 p，回到 div，再回到 HostRoot
```

假如处理完 `"Mini React"` 后需要让出主线程，接下来要访问的 Fiber 已经明确为 `p`。保存这个指针，下一次便能直接继续。此时 `div` 尚未完成，屏幕上的 DOM 也不会因为这次暂停而改变；Fiber 链只存在于内存中。

真实工作循环会在一个 Fiber 工作单元结束后检查是否应该让出，而不会暂停在任意一行源码中间。同步 Lane 也不会采用这条时间切片路径。这两点是理解「可暂停」时必须保留的边界。

每个 Fiber 还用数字 `tag` 标明种类。当前例子涉及 `HostRoot`（3）、`HostComponent`（5）和 `HostText`（6）；如果 `type` 是 `App` 这样的函数，就会得到 `FunctionComponent`（0）。这些数字与官方源码对齐，便于对照阅读。

文本本身不是 ReactElement，所以它走 `createFiberFromText`；元素则由 `createFiberFromElement` 根据 `type` 选择 tag。函数对应 `FunctionComponent`，普通标签字符串对应 `HostComponent`。`Fragment`、`Context.Provider`、`memo`、`forwardRef` 和 `Suspense` 也有各自的 tag，后面讲 `beginWork` 分发时再展开。

除了指针和 tag，后文还会频繁读到几组字段。`pendingProps` 保存本轮新输入，`memoizedProps` 保存上一轮使用的输入；函数组件用 `memoizedState` 挂住 Hook 链表；`flags` 记录待提交的副作用。`stateNode` 的含义取决于 tag：宿主节点对应 DOM，`HostRoot` 对应 `FiberRoot`，函数组件通常为 `null`。

应用入口 `FiberRoot` 不在这条 Fiber 链里。它的 `containerInfo` 指向页面容器，`current` 指向已经提交的 `HostRoot`；反过来，`HostRoot.stateNode` 又指回 `FiberRoot`。因此从任意 Fiber 沿 `return` 到达根后，就能找到真正的宿主容器。

## 6.3 同一位置为什么有两格 Fiber

显式记录遍历进度，只解决了「从哪里继续」。还有一个问题：计算进行到一半时，已显示的界面必须保持完整。为此，同一位置可以有两格 Fiber，并通过 `alternate` 互相连接：

```text
current.alternate        === workInProgress
workInProgress.alternate === current
```

`current` 属于已提交的树，`workInProgress` 承载本轮计算。比较结果、副作用标记和尚未插入文档的实例都先留在工作格上。提交成功后，`commitWork.ts` 执行 `root.current = finishedWork`，刚完成的树成为新的 current；原来的那格则可以在下一轮被复用。

所以，可复用的位置通常在两格 Fiber 之间交换角色，而不是每次更新都永久保留一份新树。两格 Fiber 也不意味着两套 DOM：满足复用条件时，它们共享同一个 `stateNode`。只有首次出现或无法复用的位置才需要创建新的 Fiber。

`createWorkInProgress` 每次只处理当前传入的这一格，并不会一次克隆整棵树：

```ts
export function createWorkInProgress(current: Fiber, pendingProps: any): Fiber {
  let wip = current.alternate;
  if (wip == null) {
    wip = createFiber(current.tag, pendingProps, current.key);
    wip.type = current.type;
    wip.stateNode = current.stateNode;
    wip.alternate = current;
    current.alternate = wip; // 1. 还没有另一格：新建并互相指向
  } else {
    wip.pendingProps = pendingProps;
    wip.flags = NoFlags;
    wip.subtreeFlags = NoFlags;
    wip.deletions = null; // 2. 沿用另一格，清掉上一轮的副作用
  }

  wip.type = current.type;
  wip.child = current.child; // 3. 先沿用 current 的孩子
  wip.memoizedProps = current.memoizedProps;
  wip.memoizedState = current.memoizedState;
  wip.updateQueue = current.updateQueue;
  wip.sibling = current.sibling;
  wip.index = current.index;
  wip.lanes = current.lanes;
  wip.childLanes = current.childLanes;
  wip.ref = current.ref;
  wip.dependencies = current.dependencies;
  wip.return = null; // 3. 还没挂回父节点，接上链表时再写
  return wip;
}
```

如果 `current.alternate` 还不存在，函数会按原来的 `tag` 和 `key` 新建一格，复制 `type`、`stateNode`，再让两格互相指向。`createContainer` 最初只创建一格空的 `HostRoot`；第一次 `render` 准备工作栈时，根节点才在这里得到配对。

如果另一格已经存在，函数直接复用它，更新 `pendingProps`，并清空 `flags`、`subtreeFlags` 和 `deletions`。否则上一轮留下的插入或删除标记可能被错误带进本轮。

无论走哪条路径，函数最后都会从 `current` 复制可延续的状态。`child` 暂时沿用旧链，之后由调和结果决定是否替换；`memoizedState` 被保留下来，函数组件的 Hook 状态才不会丢失。`return` 则先设为 `null`，等这格 Fiber 接入新链表时再确定父节点。

根和子节点得到 alternate 的时机不同。首次渲染时，`h1` 和文本 Fiber 由 `createFiberFromElement`、`createFiberFromText` 直接新建，`alternate` 仍为 `null`。下一次更新尝试复用这些位置时，它们才得到另一格，此后再交换角色。

未完成的结果始终留在 work-in-progress 树上。即使这一轮计算被放弃，`current` 仍指向上次成功提交的树，屏幕不会暴露半成品。至于哪些修改需要提交，由 Fiber 上的 `flags` 记录。

## 本章回顾

Fiber 用 `child`、`sibling` 和 `return` 显式保存遍历路径，让工作循环能在节点边界让出，再从确定的 Fiber 继续。它仍是主线程上的数据结构，不是一条额外线程。

`alternate` 把同一位置的两格 Fiber 连在一起：current 对应已提交结果，work in progress 保存本轮计算；提交后两者交换角色。两格 Fiber 不是两套 DOM，首次渲染时也不是所有子节点都已经配好 alternate。核心实现集中在 `packages/react-reconciler/src/fiber.ts` 的 `createWorkInProgress`，角色切换发生在 `packages/react-reconciler/src/commitWork.ts`。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./05-JSX与jsx-runtime与typeof.md) · [下一章 →](./07-副作用标记Flags.md)
