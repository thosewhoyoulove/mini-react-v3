# 第 21 章：`createRoot` 与 `updateContainer`

[← 返回总目录](../../React设计与实现.md) · [上一章](./20-DOM属性与简易事件.md) · [下一章：附录 →](./appendix.md)

`createRoot(container)` 执行后，页面还没有出现应用内容；直到 `.render(element)`，第一次更新才开始。与此同时，源码在渲染前已经有了一个名为 `current` 的 Fiber。顺着这两个现象，可以把公开 API、HostRoot、调度器和前两章的 DOM 操作连成一条路径。

> 主文件：`packages/react-dom/src/client.ts`、`packages/react-reconciler/src/workLoop.ts`

## 21.1 `createRoot` 先建立什么

应用入口通常写成两句：

```tsx
const root = createRoot(document.getElementById('root')!);
root.render(<h1>Hello</h1>);
```

第一句准备一个可以反复使用的根，第二句才把 React element 交给它。本项目的 `createRoot` 很短：

```ts
// packages/react-dom/src/client.ts
export function createRoot(container: Element) {
  ensureRootClickDelegation(container);
  const root = createContainer(container, hostConfig);
  return {
    render(element: ReactElement) {
      updateContainer(element, root);
    },
  };
}
```

`ensureRootClickDelegation` 安装第二十章的根 `click` 监听器，`createContainer` 则创建调和器使用的根结构。这时没有安排 Render，也没有改动容器中的 DOM；返回对象里的 `render` 闭包保存了刚创建的 `FiberRoot`。

`createContainer` 建立的数据关系可以缩写为：

```ts
const uninitializedFiber = createHostRootFiber();
const root: FiberRoot = {
  containerInfo,
  current: uninitializedFiber,
  hostConfig,
  finishedWork: null,
  pendingLanes: NoLanes,
  callbackNode: null,
  callbackPriority: NoLane,
};

uninitializedFiber.stateNode = root;
```

这里同时出现了两个“根”。`FiberRoot` 管理整棵应用，保存真实容器、当前树和调度状态；`HostRoot Fiber` 位于 Fiber 树顶端，会像其他 Fiber 一样经过 begin、complete 和 commit。二者互相连接：

```text
FiberRoot.current ──► HostRoot Fiber
        ▲                    │
        └──── stateNode ─────┘
```

第一次调用 `.render()` 前，`current HostRoot` 已经存在，只是 `current.child === null`，还没有应用子树，`alternate` 也尚未创建。工作真正开始后，`prepareFreshStack` 才调用 `createWorkInProgress(current, ...)`，生成与它配对的 WIP HostRoot。

文件里另有兼容入口 `render(element, container)`，它只是 `createRoot(container).render(element)` 的包装。每调用一次都会新建根；同一容器需要重复渲染时，应保存 `createRoot` 的返回值，再调用同一个 `root.render`。

## 21.2 `updateContainer` 怎样启动首次渲染

`.render(element)` 最终调用下面的函数：

```ts
export function updateContainer(
  element: unknown,
  container: FiberRoot,
): void {
  container.current.pendingProps = { children: element };
  scheduleUpdateOnFiberImpl(container.current, SyncLane);
}
```

第一行把 element 放进 current HostRoot 的 `pendingProps.children`。之后 `beginWork` 遇到 `HostRoot`，进入 `updateHostRoot`，再把这份 children 交给 `reconcileChildren`。

第二行在 HostRoot 上安排 `SyncLane`。这里不会根据调用场景另选 Lane，每次 `root.render(...)` 都使用固定的同步车道。同步任务先合并到微任务中；微任务开始执行后，`workLoopSync` 一次跑完 Fiber 遍历，不经过 `shouldYield` 切片。

从公开入口到 DOM 提交，主线如下：

```text
root.render(element)
  → updateContainer：写 HostRoot.pendingProps.children
  → scheduleUpdateOnFiberImpl(HostRoot, SyncLane)
  → root.pendingLanes 合入 SyncLane
  → ensureRootIsScheduled
  → queueMicrotask
  → prepareFreshStack：current HostRoot → WIP HostRoot
  → workLoopSync：beginWork 向下，completeWork 向上
  → commitRoot：Mutation 改 DOM，切换 current，Layout 写 ref / 跑 effect
```

首次进入 `updateHostRoot` 时，传入的 `current` 就是 `createContainer` 提前创建的 HostRoot；空的是它的 `child`。调和器从这里生成第一棵应用 Fiber，`completeWork` 创建并组装离线 DOM，Commit 的 Placement 再把顶层宿主节点插入 `root.containerInfo`。

```text
FiberRoot
  └─ current HostRoot（已存在，child = null）
          ⇅ 第一次 prepareFreshStack 建立 alternate
     WIP HostRoot
          └─ 新应用 Fiber → 新宿主节点
```

所以“首次渲染没有 current”并不准确。根 Fiber 早已就位，第一次 Render 新增的是它的 WIP 配对和下面的应用子树。

## 21.3 后续更新与多 root 限制

同一个 root 后续仍从 `updateContainer` 进入：

```tsx
root.render(<h1>Hello</h1>);
root.render(<h1>Welcome</h1>);
```

第二次调用会改写那一刻的 current HostRoot 的 `pendingProps.children`，再安排一次 SyncLane。此时 `current.child` 已经指向上次提交的应用树，调和器可以复用 Fiber 和 DOM，只为实际变化标记 Placement、Update 或 Deletion。

组件里的 `setState` 不会绕回 `updateContainer`：

```tsx
function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
```

调用 `setCount` 后，Hook 先把更新放入自己的队列，再从函数组件 Fiber 向 HostRoot 标记 Lane，直接进入 `scheduleUpdateOnFiberImpl`。它与 `root.render` 的入口和 Lane 来源不同，从 `ensureRootIsScheduled` 开始则共享 begin、complete、commit 这段工作循环。

根更新在这里被简化成直接改写 HostRoot 的 `pendingProps`，并固定使用 SyncLane。官方 React 会把根更新放入更新队列，再由更完整的事件优先级、Lane 和根调度逻辑处理。阅读这段教学代码时，根更新的数据结构不应与生产实现画等号。

多 root 也受到共享状态的影响。虽然每个 `FiberRoot` 都有自己的 `hostConfig` 和调度字段，`currentRoot`、`workInProgress`、`workInProgressRoot`、`syncRoot`、`syncScheduled` 仍是模块级变量，`setHostConfig` 保存的活动 HostConfig 也是如此。连续建立 root 会改写部分全局指针，同一轮多个根的同步任务还可能互相覆盖。

这些字段足以串起单 root 的完整生命周期，却没有形成官方 React 那样的多 root 并发隔离。这里保留的是数据结构和调用主线，不是生产调度器的等价实现。

## 本章回顾

- `createRoot` 安装根 click 委托，并建立相互引用的 `FiberRoot` 与空 `current HostRoot`；真正的更新从 `.render()` 开始。
- `updateContainer` 写入根的 `pendingProps.children`，以固定的 SyncLane 调度首次及后续根更新。
- 首次渲染已有 current HostRoot，第一次工作创建的是 WIP alternate 和应用子树。
- `setState` 从组件更新队列进入调度；模块级工作指针又使这套调度只适合解释单 root 主线。

### 源码入口

- `packages/react-dom/src/client.ts`：`createRoot`、`render`
- `packages/react-dom/src/hostConfig.ts`：`ensureRootClickDelegation`
- `packages/react-reconciler/src/workLoop.ts`：`createContainer`、`updateContainer`
- `packages/react-reconciler/src/workLoop.ts`：`prepareFreshStack`、`ensureRootIsScheduled`
- `packages/react-reconciler/src/beginWork.ts`：`updateHostRoot`
- `packages/react-reconciler/src/commitWork.ts`：`commitRoot`、`commitPlacement`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./20-DOM属性与简易事件.md) · [下一章：附录 →](./appendix.md)
