# 第 9 章：`beginWork` 怎样得到下一层 children

[← 返回总目录](../../React设计与实现.md) · [上一章](./08-工作循环.md) · [下一章 →](./10-子节点Diff.md)

---

`createElement(App)` 只得到一个描述 App 的 Element。App 的函数体这时还没运行。工作循环走到 App 这格 Fiber，`beginWork` 才执行组件，并把返回值变成下一层 Fiber。组件树是在这条路径上逐层展开的。

## 9.1 `App()` 究竟在哪一行被调用

先看一个只有一层宿主标签的组件：

```js
function App() {
  return createElement('div', null, 'hello');
}
```

工作循环把 App Fiber 传给 `beginWork`。`tag` 是 `FunctionComponent`，分支进入 `updateFunctionComponent`，由 `renderWithHooks` 调用 `App(props)`。函数返回的 Element 交给 `reconcileChildren`，接上 div Fiber，再把这格 child 返回给工作循环。

div 的 `tag` 是 `HostComponent`。它不调用组件函数，直接读 `pendingProps.children`，得到字符串 `'hello'`。调和后生成 HostText。HostText 已是叶子，`beginWork` 返回 `null`，工作循环转入 complete。

各类 Fiber 的 children 从哪来：

```text
HostRoot          pendingProps.children，也就是 root.render 传入的元素
FunctionComponent renderWithHooks 的返回值
HostComponent     pendingProps.children，标签里面的内容
HostText          没有孩子，返回 null
```

其余 tag 也是先拿到 children，再交给 `reconcileChildren`，最后返回第一格 child 或 `null`。差别在取 children 之前的那一步：

- Fragment 直接调和 `pendingProps.children`。
- ContextProvider 先 `pushProvider`，把 `value` 写进 context 的 `_currentValue`，子树里的 `useContext` 才能读到新值。然后才调和 children。
- ForwardRef 从包装对象上取出 `render`，`renderWithHooks` 调用时把 `fiber.ref` 当作第二个参数。
- Memo 先做 props 比较，不能跳过才执行内部组件。
- Suspense 看有没有 `DidCapture`：有就调和 `fallback`，没有就调和 `children`。

普通函数组件这次调用不传 ref。ref 要等 Commit 的 Layout 阶段才写到 DOM 或 Fiber 上。

## 9.2 更新时为何有些组件没有再次执行

父组件进入新一轮 Render，不代表沿途每个函数组件都要再调用一次。`beginWork` 对函数组件、Fragment、Provider、ForwardRef、Suspense 都会先问 `canSkipUpdate`。Memo 也问，只是问在 `updateMemoComponent` 里面，因为比较函数可能是 `memo` 的自定义 `compare`，缺省才是 `shallowEqual`。

`canSkipUpdate` 先拒绝两种情况：还没有 `current`（这格是新建的），或者身上已经有 `DidCapture`。然后下面四项要同时成立才跳过：

1. 自己的 `lanes` 与本轮 `renderLanes` 没有交集。
2. `childLanes` 里也没有本轮要做的工作。
3. props 浅比较相同，并且 ref 用 `Object.is` 比还是同一个。
4. 上次 `useContext` 记在 `dependencies` 上的值，仍等于 context 现在的 `_currentValue`。

第 2 项是为了子树里的更新。子组件 `setState` 时，沿 `return` 给祖先标上 `childLanes`。如果父函数在这里被跳过，工作循环不会再 `beginWork` 那个子组件，它的更新队列就没人重放。所以子树有本轮 lane 时，父函数必须重跑。

第 3 项比的是 props 里的每个字段，不是 props 对象的身份。字段是相同的字符串或数字，就可以通过。字段是元素时，例如 `children` 又是一次新的 `createElement(...)`，`Object.is` 对不上，子函数组件必须重跑。源码里把这件事写成：children 也算一格，元素孩子是新对象时不能误跳过。

父组件如果一直传入 `{ label: 'ok' }`，其中的 `label` 每轮都是相同的字符串，浅比较就能通过。再确认子组件和子树没有本轮更新、ref 与 context 没变，四项条件才全部满足，子函数才不会执行。

四项都成立时，`bailout` 不调用组件函数。它只用 `createWorkInProgress` 把 current 的直接 child 克隆成 WIP，避免两棵树共用同一格 Fiber。孙子节点先留在克隆孩子的 `child` 上，这一轮不再进入它们。然后返回 `null`，工作循环直接 complete 当前节点。

HostRoot、HostComponent 没有这条跳过分支。宿主组件每次都会 `reconcileChildren`，孩子是文本还是列表，都在第 10 章的 Diff 里决定复用还是新建。HostText 更简单，直接返回 `null`。

带 `DidCapture` 的错误边界不会重跑组件函数。`updateFunctionComponent` 发现这个标记，并且函数上有 `isErrorBoundary`，就直接调和 `pendingProps.fallback`。Suspense 同样改调和 fallback。跳过被拒绝，是为了不要把出错前的子树原样克隆下来。

ref 的变化也在向下阶段被发现。`markRef` 在首次挂载且 `ref != null`，或更新时 ref 身份变了，给 Fiber 加上 `Ref`。HostComponent、函数组件和 Memo 会走这里。真正调用函数 ref、或写入对象 ref 的 `current`，仍在 Commit 的 Layout 阶段。ForwardRef 的更新函数里没有调用 `markRef`。

Provider 只有没被跳过时才会 push 新值。值没变，Provider 自己 bailout，子组件也不会在这一轮重跑。push 出去的值要等这棵子树 complete 时再 pop，第 11 章会接到。

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

要分清的是 `current` 和 `current.child`。`createRoot` 已经创建了 current HostRoot，`prepareFreshStack` 会为它做 WIP，所以 HostRoot 的 `current` 存在，只是 `current.child` 还是空。`reconcileChildren` 看的是 `current == null`，不是 `current.child == null`。根走会打副作用的 `reconcileChildFibers`。新建的 App 没有 alternate，`placeSingleChild` 给它加上 `Placement`。

App 自己是新 Fiber，没有 alternate。它调和后代时改走 `mountChildFibers`，`shouldTrackSideEffects` 为 false。新建的 div 和 HostText 不再逐个标记 `Placement`。原因是整棵新子树稍后会一起插进去，不必每个节点都记一次插入。

complete 阶段先创建 Text，再创建 div 并把 Text 装进去。Commit 处理 App 上的 `Placement` 时，App 没有宿主实例，就继续向下，把已经组装好的 div 插进根容器。

已经挂过、只是暂时没有孩子的父节点，更新时 `current` 仍在，所以会走 `reconcileChildFibers`。这次新出现的孩子会打上 `Placement`。

## 本章回顾

- 函数组件在它的 Fiber 进入 `beginWork` 之后，才由 `renderWithHooks` 执行。`createElement` 只创建 Element。
- `beginWork` 按 tag 取得 children，再交给 `reconcileChildren`。返回 `null` 表示不能再向下，叶子和 bailout 都是这种返回。
- bailout 不调用组件函数，只克隆直接 child。子树还有本轮 lane，或孩子 Element 是新对象时，不能跳过。
- 首次挂载时，HostRoot 下的新 App 带 `Placement`。App 下面的新节点走 mount 路径，不逐个打标，等 complete 组装成宿主子树。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./08-工作循环.md) · [下一章 →](./10-子节点Diff.md)
