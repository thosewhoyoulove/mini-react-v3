# 第 9 章：`beginWork` 怎样得到下一层 children

[← 返回总目录](../../React设计与实现.md) · [上一章](./08-工作循环.md) · [下一章 →](./10-子节点Diff.md)

---

调用 `createElement(App)` 只会得到一个描述 App 的 Element，App 函数体此时还没有运行。直到工作循环走到 App Fiber，`beginWork` 才执行组件，并把返回的 Element 变成下一层 Fiber。组件树正是在这条路径上逐层展开的。

## 9.1 `App()` 究竟在哪一行被调用

先看一个只有一层宿主标签的组件：

```js
function App() {
  return createElement('div', null, 'hello');
}
```

工作循环把 App Fiber 传给 `beginWork`。tag 是 `FunctionComponent`，于是分支进入 `updateFunctionComponent`，由 `renderWithHooks` 调用 `App(props)`。函数返回 `<div>hello</div>` 对应的 Element 后，`reconcileChildren` 才为 App 接上 div Fiber，并把它作为下一格返回。

div 的 tag 是 `HostComponent`，它不会调用任何组件函数，而是直接读取 `pendingProps.children`，得到字符串 `'hello'`。调和后生成 HostText。HostText 已是叶子，`beginWork` 返回 `null`，工作循环随即转入向上的 complete 阶段。

各类 Fiber 的 children 来源可以归纳为：

```text
HostRoot          从 pendingProps.children 取 root.render 传入的元素
FunctionComponent 用 renderWithHooks 执行组件，返回值就是 children
HostComponent     从 pendingProps.children 取标签内部内容
HostText          没有孩子，返回 null
```

其余 tag 也在做同一件事，只是取得 children 之前多了一步各自的处理。Fragment 直接调和 children；ContextProvider 先压入新的 value；ForwardRef 取包装对象中的 render 函数；MemoComponent 先做比较；Suspense 根据 `DidCapture` 选择正常内容或 fallback。每条分支最终都返回第一格 child，或者返回 `null`。

## 9.2 更新时为何有些组件没有再次执行

父组件进入新一轮 Render，不代表沿途每个函数组件都要调用一次。走到某个 Fiber 时，`canSkipUpdate` 会依次排除四种必须工作的情况：

1. Fiber 自己的 `lanes` 与本轮 `renderLanes` 没有交集；
2. `childLanes` 中也没有本轮工作；
3. props 浅比较相同，并且 ref 身份没变；
4. 上次读取的 context 仍是原值。

四项都成立，说明这个组件及其子树没有本轮要处理的输入或更新。`bailout` 不调用组件函数，只用 `createWorkInProgress` 克隆直接 child 链，复用 current 树已经算好的结果。随后返回 `null`，让工作循环直接进入 complete。

函数组件、Fragment、Provider、ForwardRef、Memo 和 Suspense 都有机会走这条路径。HostComponent 仍会进入 `updateHostComponent` 调和 children。已经带有 `DidCapture` 的错误边界或 Suspense 也会继续工作，因为这一次要把失败分支换成 fallback。

ref 的变化也在向下阶段被发现。首次传入 ref 或 ref 身份改变时，`markRef` 给 Fiber 加上 `Ref`；真正调用函数 ref 或写入对象 ref，要等 Commit 的 Layout 阶段。

## 9.3 首次渲染为何只有 App 带 `Placement`

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

关键在于分清 `current` 与 `current.child`。`createRoot` 已经创建 current HostRoot，`prepareFreshStack` 会为它准备 WIP，所以 HostRoot 的 `current` 存在，只是 `current.child` 还是空。根节点走跟踪副作用的 `reconcileChildFibers`，新建 App 时便给它加上 `Placement`。

App 自己是新 Fiber，没有 alternate。它调和后代时改走 `mountChildFibers(false)`，新建的 div 和 HostText 不再逐个标记 `Placement`。complete 阶段先创建 Text，再创建 div 并把 Text 装进去；Commit 处理 App 上的 `Placement` 时，会越过没有宿主实例的 App，把已经组装好的 div 子树插入根容器。

## 本章回顾

- 函数组件在其 Fiber 进入 `beginWork` 后由 `renderWithHooks` 执行，`createElement` 只创建 Element 描述。
- `beginWork` 按 tag 取得 children，再交给 `reconcileChildren` 接出 child 链；返回 `null` 只表示无法继续向下。
- bailout 复用 current 的结果；首次挂载时，HostRoot 下的新 App 负责 `Placement`，其新建后代由 complete 阶段组装成宿主子树。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./08-工作循环.md) · [下一章 →](./10-子节点Diff.md)
