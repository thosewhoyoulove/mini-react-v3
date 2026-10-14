# 第 9 章：`beginWork` 怎样得到下一层 children

[← 返回总目录](../../React设计与实现.md) · [上一章](./08-工作循环.md) · [下一章 →](./10-子节点Diff.md)

---

`createElement(App)` 没有执行 `App`，那组件究竟在哪一刻运行？答案在 `beginWork`：工作循环拿到一个 Fiber 后，先根据 tag 找出它的下一层 children，再把 children 调和成 child 链。本章先走 HostRoot、函数组件、宿主节点这条主线，再补上 bailout 和其他 tag。

## 本章书签

- [9.1 不同 tag 的 children 从哪里来](#91-不同-tag-的-children-从哪里来)
- [9.2 什么情况下可以跳过组件](#92-什么情况下可以跳过组件)
- [9.3 首次渲染怎样接出 child 链](#93-首次渲染怎样接出-child-链)
- [面试复习](#面试复习)

---

## 9.1 不同 tag 的 children 从哪里来

`beginWork(current, workInProgress, renderLanes)` 的返回值就是下一格工作：

```text
HostRoot          从 pendingProps.children 取 root.render 传入的元素
FunctionComponent 用 renderWithHooks 执行组件，返回值就是 children
HostComponent     从 pendingProps.children 取标签内部内容
HostText          没有孩子，返回 null
```

例如：

```js
function App() {
  return createElement('div', null, 'hello');
}
```

处理 App Fiber 时，`renderWithHooks` 才真正调用 `App(props)`。输入是组件函数和 `pendingProps`，输出是 `<div>hello</div>` 对应的 Element。随后 `reconcileChildren` 把它接成 App 的 child，并把第一格 child 返回给工作循环。

宿主标签不会执行函数。处理 div Fiber 时，children 直接来自 `pendingProps.children`，也就是字符串 `'hello'`。HostText 已是叶子，返回 `null`，工作循环开始向上 complete。

当前仓库不只有这四种 tag。Fragment 直接调和自己的 children；ContextProvider 先 push 新 value；ForwardRef 用包装对象中的 render 函数；MemoComponent 先执行比较；Suspense 根据 `DidCapture` 选择 children 或 fallback。主线相同：每条分支最终要么返回第一格 child，要么返回 `null`。

## 9.2 什么情况下可以跳过组件

更新时，并不是每个函数组件都要重新执行。`canSkipUpdate` 只有在四类条件同时满足时才返回 true：

1. 当前 Fiber 的 `lanes` 与本轮 `renderLanes` 没有交集；
2. `childLanes` 也没有本轮工作；
3. props 浅比较相同，ref 身份也没变；
4. 上次读取的 context 没有变化。

满足条件后，`bailout` 不执行组件函数。它用 `createWorkInProgress` 克隆直接 child 链，再返回 `null`，让工作循环转入 complete。这里的 bailout 不是「丢掉整个子树」；它是复用 current 的结果，并为 WIP 准备对应 child。

函数组件、Fragment、Provider、ForwardRef、Memo 和 Suspense 都可能走这条路径。HostComponent 在当前实现中仍会进入 `updateHostComponent` 调和 children。错误边界或 Suspense 已带 `DidCapture` 时不能 bailout，因为这一轮必须改走 fallback。

ref 的标记也发生在 begin 阶段。`markRef` 发现首次传入 ref，或 ref 身份变化，就给 Fiber 打 `Ref`；真正写入要等 Layout。

## 9.3 首次渲染怎样接出 child 链

第一次执行：

```js
createRoot(container).render(createElement(App, null));
```

向下顺序是：

```text
1. HostRoot WIP
   current 存在，但 current.child 是 null
   reconcileChildFibers(null, <App />)
   → 新建 App，App.flags |= Placement

2. App
   current 是 null
   renderWithHooks() → <div>hello</div>
   mountChildFibers(null, <div />)
   → 新建 div，不打 Placement

3. div
   current 是 null
   mountChildFibers(null, "hello")
   → 新建 HostText，不打 Placement

4. HostText
   beginWork() → null
   → 转入 complete
```

这里最容易混淆的是 `current` 和 `current.child`。`createRoot` 已经创建 current HostRoot，`prepareFreshStack` 又为它准备 WIP，因此 HostRoot 的 `current` 存在，只是旧 child 为空。它走跟踪副作用的 `reconcileChildFibers`，所以 App 得到 `Placement`。

App 自己是新建 Fiber，没有 alternate，后代才走 `mountChildFibers(false)`。complete 阶段会先创建 Text，再创建 div 并把 Text 放进去。Commit 遇到 App 的 `Placement` 时，会跨过没有 DOM 的 App，把 div 子树插入根容器。

下一章展开 `reconcileChildren`：新旧 children 如何按 key 和 type 对成一条新的 sibling 链。

## 面试复习

### 一句话结论

`beginWork` 根据 tag 取得下一层 children，必要时执行函数组件，再由 `reconcileChildren` 接出 child 链；没有更深节点时返回 `null`。

### 常见追问

**函数组件何时执行？**

它的 Fiber 进入 `beginWork` 后，在 `renderWithHooks` 中执行，不是在 `createElement` 或 `completeWork` 中执行。

**`beginWork` 返回 `null` 表示 Render 结束吗？**

不表示。它只说明当前分支不能继续向下，工作循环接着向上 complete。

**首次渲染为什么 App 有 `Placement`，div 却没有？**

HostRoot 已有 current，根层跟踪副作用；新建 App 没有 current，它的后代走不跟踪副作用的 mount 路径。

### 源码入口

- `packages/react-reconciler/src/beginWork.ts`：tag 分发、bailout 与 ref 标记。
- `packages/react-reconciler/src/childFiber.ts`：`reconcileChildren`。
- `packages/react-reconciler/src/hooks.ts`：`renderWithHooks`。
- `packages/react-reconciler/src/workLoop.ts`：调用 `beginWork` 的工作单元。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./08-工作循环.md) · [下一章 →](./10-子节点Diff.md)
