# 第 9 章：`beginWork` 按 tag 分发

[← 返回总目录](../../React设计与实现.md) · [上一章](./08-工作循环.md) · [下一章 →](./10-子节点Diff.md)

> 主文件：`packages/react-reconciler/src/beginWork.ts`
> 向下半程只做一件事：给当前 wip 接上 child 链表，把第一个 child 交回 workLoop。

## 本章书签

- [9.1 HostRoot：从根往下调和](#91-hostroot从根往下调和)
- [9.2 函数组件：执行函数，得到子 Element](#92-函数组件执行函数得到子-element)
- [9.3 HostComponent / HostText](#93-hostcomponent--hosttext)
- [9.4 完整推演：HostRoot → App → div → HostText](#94-完整推演hostroot--app--div--hosttext)
- [面试复习](#面试复习)

---

`beginWork` 是一张 switch。孩子从哪来，按 tag 分四条路；真正的 Diff 都进 `reconcileChildren`：

```text
HostRoot          → pendingProps.children（root.render 塞进来的 element）
FunctionComponent → 先 renderWithHooks 跑组件函数，返回值当 children
HostComponent     → pendingProps.children（div 的孩子，不执行函数）
HostText          → 叶子，没有 child，返回 null
```

`reconcileChildren` 再按**当前正在处理的 Fiber 有没有 `current`** 分叉：`current == null` → `mountChildFibers`（不跟踪副作用）；否则 → `reconcileChildFibers`。判断条件不是 `current.child == null`。这一阶段只改 Fiber、打 flags，不碰真实 DOM。

返回值约定：非 `null` 则 workLoop 继续向下；`null` 开始 `completeUnitOfWork`。

## 9.1 HostRoot：从根往下调和

```ts
function updateHostRoot(current, workInProgress) {
  const nextChildren = workInProgress.pendingProps.children;
  reconcileChildren(current, workInProgress, nextChildren);
  return workInProgress.child;
}
```

`updateContainer` 把 `root.render(element)` 的 element 挂在 HostRoot 的 `pendingProps.children`。根节点自己不是 DOM 标签，也不执行函数；它只是整棵应用树的入口。

这里最容易把「旧孩子为空」误说成「当前 Fiber 不存在」。

第一次 `root.render` 时，`prepareFreshStack` 已经用 `createWorkInProgress(root.current, ...)` 创建了 HostRoot WIP，所以：

```text
HostRoot WIP.alternate → current HostRoot
current HostRoot.child → null
```

因此 HostRoot 调 `reconcileChildren` 时 `current != null`，走的是
`reconcileChildFibers(workInProgress, current.child, nextChildren)`。旧孩子虽然是 `null`，但这是**带副作用跟踪的 update 闭包**；新建出的首个应用 Fiber（例如 App）会被 `placeSingleChild` 打上 `Placement`。

之后新建 App 自己执行 `beginWork` 时，它没有 `alternate`，传入的 `current == null`，它的后代才走 `mountChildFibers(false)`。

## 9.2 函数组件：执行函数，得到子 Element

```ts
function updateFunctionComponent(current, workInProgress) {
  const nextChildren = renderWithHooks(
    current,
    workInProgress,
    workInProgress.type,
    workInProgress.pendingProps,
  );
  reconcileChildren(current, workInProgress, nextChildren);
  return workInProgress.child;
}
```

三步必须按这个顺序：

1. **`renderWithHooks`**：按有没有 current 链表切 mount / update dispatcher，真正执行 `App(props)`。Hook 在这一次调用里走完。
2. **返回值当 children 去 Diff**。通常是一个 Element，也可能是数组或文本。
3. **把第一个 child 交回 workLoop。**

函数组件本身没有宿主实例。DOM 由下面的 Host* 节点在 `completeWork` 里创建。第 13、14 章会把「为什么必须在 beginWork 里跑函数、Hook 为何不能进 if」讲透。

## 9.3 HostComponent / HostText

宿主标签不执行函数，只 Diff `props.children`：

```ts
function updateHostComponent(current, workInProgress) {
  reconcileChildren(
    current,
    workInProgress,
    workInProgress.pendingProps.children,
  );
  return workInProgress.child;
}
```

自己的 DOM 实例要等 `completeWork`：首次 `createInstance`，更新则对比 props 后打 `Update`。

`HostText` 是叶子，`beginWork` 直接 `return null`。文本内容在 `pendingProps` 里（就是那个字符串），创建 / 对比发生在 `completeWork`。

未知 tag（Fragment 等未实现）也返回 `null`，当作没有孩子。教学版不在这里扩展类型，避免和「按 tag 分发」这条主线抢戏。

## 9.4 完整推演：HostRoot → App → div → HostText

假设首次执行：

```tsx
root.render(<App />);

function App() {
  return <div>hello</div>;
}
```

向下的 `beginWork` 顺序如下：

```text
1. HostRoot WIP
   current = current HostRoot（存在）
   nextChildren = <App />
   reconcileChildFibers(current.child = null)
   → 新建 App Fiber，App.flags |= Placement

2. App Fiber
   current = App.alternate = null
   renderWithHooks(...) → <div>hello</div>
   mountChildFibers(null, <div />)
   → 新建 div Fiber，不打 Placement

3. div Fiber
   current = div.alternate = null
   nextChildren = "hello"
   mountChildFibers(null, "hello")
   → 新建 HostText Fiber，不打 Placement

4. HostText Fiber
   beginWork 直接返回 null
   → 向下结束，工作循环转入 completeWork
```

对应的首次 WIP 树是：

```text
HostRoot
  └── App [Placement]
        └── div [NoFlags]
              └── "hello" [NoFlags]
```

随后向上 complete：先创建 Text，再创建 div，并把 Text append 到尚未进文档的 div。Commit 处理 App 的 `Placement` 时，`insertOrAppendPlacementNode` 会跨过没有 DOM 的 App，找到 div 并把它插入根容器。

所以准确结论不是「首次整棵树都走 mount」或「首次所有节点都不打 Placement」，而是：

- HostRoot 因已有 current，走 `reconcileChildFibers`，首个应用 Fiber 会打 `Placement`；
- 这个新建应用 Fiber 的后代因没有 current，走 `mountChildFibers`，通常不各自打 `Placement`；
- Commit 从带 `Placement` 的 Fiber 向下找到宿主节点，把 complete 阶段已组装好的宿主子树挂入容器。

下一章进入 `reconcileChildren`：单节点与列表 key 如何对成一条 sibling 链表。

---

## 面试复习

### 一句话结论

`beginWork` 按 tag 决定 children 从哪来，再以当前 Fiber 是否有 `current` 决定是否跟踪 Diff 副作用；首次 HostRoot 有 current，首个应用 Fiber会打 `Placement`。

### 面试回答（可口述，为什么→机制→仓库落点→官方差异）

为什么要有 `beginWork`：ReactElement 是嵌套描述，渲染器需要把它逐层展开成可暂停的 Fiber 链表。机制上，HostRoot 读取 `pendingProps.children`，函数组件先执行 `renderWithHooks`，HostComponent 读取 `props.children`，HostText 到叶子返回 `null`；三类有孩子的节点统一进入 `reconcileChildren`。仓库落点是 `beginWork.ts` 与 `childFiber.ts`。本仓库只实现四种 tag，也没有官方基于 lanes、props 和 context 的 bailout，但首次 HostRoot 的边界和官方思路一致：判断 `current`，不是判断 `current.child`。

### 常见追问

**Q：首次渲染为什么 HostRoot 不是 mount 路径？**
A：`createRoot` 已创建 current HostRoot，`prepareFreshStack` 又为它创建 WIP；所以 HostRoot 的 `current` 存在，只是 `current.child` 为 `null`。

**Q：函数组件在哪一刻真正执行？**
A：它的 Fiber 进入 `beginWork` 后，在 `updateFunctionComponent` 调 `renderWithHooks` 时执行。

**Q：`beginWork` 返回 `null` 是渲染结束吗？**
A：不是，只表示不能继续向下，工作循环转入 `completeUnitOfWork` 向上完成当前分支。

### 容易说错

- 错：`current.child == null` 就走 `mountChildFibers`。对：只看当前 Fiber 的 `current == null`。
- 错：首次整棵树都不打 `Placement`。对：根层新建的首个应用 Fiber会被跟踪并打标。
- 错：函数组件在 `completeWork` 执行。对：函数组件在 `beginWork` 执行，`completeWork` 只冒泡。

### 源码入口

- `packages/react-reconciler/src/beginWork.ts`
- `packages/react-reconciler/src/childFiber.ts`
- `packages/react-reconciler/src/workLoop.ts`：`performUnitOfWork`、`prepareFreshStack`
- `packages/react-reconciler/src/fiber.ts`：`createWorkInProgress`

[← 返回总目录](../../React设计与实现.md) · [上一章](./08-工作循环.md) · [下一章 →](./10-子节点Diff.md)
