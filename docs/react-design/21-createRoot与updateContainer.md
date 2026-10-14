# 第 21 章：`createRoot` 与 `updateContainer`

[← 返回总目录](../../React设计与实现.md) · [上一章](./20-DOM属性与简易事件.md) · [下一章：附录 →](./appendix.md)

为什么 `createRoot(container)` 不会立刻显示内容，而 `.render(element)` 才启动更新？第一次渲染明明还没有应用节点，为什么源码里已经存在 `current`？理解这两个问题，就能把公开 API、HostRoot、调度器和上一章的 DOM 操作接成一条完整路径。

> 主文件：`packages/react-dom/src/client.ts`、`packages/react-reconciler/src/workLoop.ts`

## 本章书签

- [21.1 `createRoot` 先建立什么](#211-createroot-先建立什么)
- [21.2 `updateContainer` 怎样启动首次渲染](#212-updatecontainer-怎样启动首次渲染)
- [21.3 后续更新、多根与官方实现的边界](#213-后续更新多根与官方实现的边界)
- [面试复习](#面试复习)

---

## 21.1 `createRoot` 先建立什么

最小入口只有两句：

```tsx
const root = createRoot(document.getElementById('root')!);
root.render(<h1>Hello</h1>);
```

第一句建立可复用的根，第二句才提交 React element。当前仓库的完整 `createRoot` 是：

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

这里先做两件互不替代的事：

1. `ensureRootClickDelegation(container)` 在容器上建立一次 `click` 委托。第二十章中节点的 `onClick` 只有这时才有统一入口。
2. `createContainer(container, hostConfig)` 建立调和器的根数据结构，但不安排 Render，也不修改 DOM。

`createContainer` 的核心可以缩成下面这样：

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

这里有两个名字容易混淆：

- `FiberRoot` 是整棵应用的管理对象，保存真实容器、当前树和调度状态；
- `HostRoot Fiber` 是 Fiber 树最上方的节点，参与 begin/complete/commit。

它们互相连接：`root.current` 指向 HostRoot，HostRoot 的 `stateNode` 又指回 `root`。

因此，首次 `.render()` **不是没有 current**。`createContainer` 已经创建了 current HostRoot，只是 `current.child === null`，下面还没有应用树；它的 `alternate` 也还没有建立。第一次工作开始时，`prepareFreshStack` 才用 `createWorkInProgress(current, ...)` 创建配对的 WIP HostRoot。

文件中的兼容入口 `render(element, container)` 只是 `createRoot(container).render(element)` 的包装。每调用一次它都会新建根；要在同一容器上重复渲染，应保留 `createRoot` 返回的对象并重复调用它的 `render`。

## 21.2 `updateContainer` 怎样启动首次渲染

`.render(element)` 闭包持有刚才的 `FiberRoot`，并调用：

```ts
export function updateContainer(
  element: unknown,
  container: FiberRoot,
): void {
  container.current.pendingProps = { children: element };
  scheduleUpdateOnFiberImpl(container.current, SyncLane);
}
```

这段代码只有两个动作。

第一，把 element 放入 current HostRoot 的 `pendingProps.children`。工作循环开始后，`beginWork` 按 `HostRoot` 分支进入 `updateHostRoot`，再把这个 children 交给 `reconcileChildren`。

第二，在 HostRoot 上调度固定的 **`SyncLane`**。这里没有根据调用现场选择 Lane；在当前仓库中，每次 `root.render(...)` 都走 SyncLane。Sync 工作被合并进微任务，微任务执行时用 `workLoopSync` 一次完成本轮 Fiber 遍历，不经过 `shouldYield` 切片。

完整主线如下：

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

首次进入 `updateHostRoot` 时，参数 `current` 是那个已经存在的 HostRoot，而 `current.child` 才是 `null`。调和器据此创建第一个应用 Fiber，并记录需要插入的节点。`completeWork` 在内存中创建、组装 DOM；Commit 的 Placement 最终把顶层宿主节点插入 `root.containerInfo`。

所以不能把首次渲染描述成“从一棵完全不存在的 current 树开始”。更准确的图是：

```text
FiberRoot
  └─ current HostRoot（已存在，child = null）
          ⇅ 第一次 prepareFreshStack 建立 alternate
     WIP HostRoot
          └─ 新应用 Fiber → 新宿主节点
```

## 21.3 后续更新、多根与官方实现的边界

同一个 root 再次渲染时，仍然调用 `updateContainer`：

```tsx
root.render(<h1>Hello</h1>);
root.render(<h1>Welcome</h1>);
```

第二次只是覆盖当时 current HostRoot 的 `pendingProps.children`，再调度一次 SyncLane。此时 `current.child` 已指向已提交的应用树，调和器会尽量复用 Fiber 和 DOM，只对变化打 Placement、Update 或 Deletion 标记。

组件里的 `setState` 则**不经过 `updateContainer`**：

```tsx
function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
```

调用 `setCount` 时，Hook 把更新放进自身队列，从对应的函数组件 Fiber 向 HostRoot 标记 Lane，然后直接进入 `scheduleUpdateOnFiberImpl`。它与 `root.render` 的入口和 Lane 来源不同，但后面共享 `ensureRootIsScheduled → begin/complete → commit` 这套工作循环。

当前仓库还做了重要的教学简化：

- `updateContainer` 直接改 HostRoot 的 `pendingProps`，并固定使用 SyncLane；
- 官方 React 会把根更新放入更新队列，由更完整的事件优先级、Lane 与根调度逻辑处理；
- 当前仓库已经有 `FiberRoot.hostConfig`，执行根工作时也会重新设置它，但工作循环和宿主上下文仍保留多个**模块级全局变量**。

最后一点意味着多 root 隔离并不完整。例如 `currentRoot` 是找不到 HostRoot 时的全局兜底，`workInProgress`、`workInProgressRoot`、`syncRoot` 和 `syncScheduled` 也由所有根共享；`setHostConfig` 保存的当前 HostConfig 同样是模块级状态。连续建立根会改写这些全局指针，同一轮中多个根的同步任务也可能互相覆盖。这个实现适合讲清单根工作流，不能据此推断它具有官方 React 的多根并发隔离能力。

这也是阅读教学源码时应保持的边界：数据结构保留了官方设计的主线，但调度细节不是生产实现的等价替代。

## 面试复习

**一句话：** `createRoot` 建 click 委托、FiberRoot 和空的 current HostRoot；`updateContainer` 写入根 children，并固定用 SyncLane 启动工作循环。

**Q：首次渲染时有 current 吗？**

A：有。current HostRoot 已存在，只是 `current.child === null`；第一次 Render 才创建它的 WIP alternate 和应用子树。

**Q：`setState` 会调用 `updateContainer` 吗？**

A：不会。Hook 更新从组件 Fiber 直接标 Lane 并调度，只在后半段与根更新共享工作循环。

**Q：为什么当前仓库不能证明多 root 已完整支持？**

A：多个调度游标、同步根指针和当前 HostConfig 仍是模块级全局状态，根之间可能相互覆盖。

### 源码入口

- `packages/react-dom/src/client.ts`：`createRoot`、`render`
- `packages/react-dom/src/hostConfig.ts`：`ensureRootClickDelegation`
- `packages/react-reconciler/src/workLoop.ts`：`createContainer`、`updateContainer`
- `packages/react-reconciler/src/workLoop.ts`：`prepareFreshStack`、`ensureRootIsScheduled`
- `packages/react-reconciler/src/beginWork.ts`：`updateHostRoot`
- `packages/react-reconciler/src/commitWork.ts`：`commitRoot`、`commitPlacement`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./20-DOM属性与简易事件.md) · [下一章：附录 →](./appendix.md)
