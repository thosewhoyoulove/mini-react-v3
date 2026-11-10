# 第 21 章：`createRoot` 与 `updateContainer`

[← 返回总目录](../../React设计与实现.md) · [上一章](./20-DOM属性与简易事件.md) · [下一章：附录 →](./appendix.md)

`createRoot(container)` 执行后，页面还没有出现应用内容。直到 `.render(element)`，第一次更新才开始。与此同时，源码在渲染前已经有了一个名为 `current` 的 Fiber。顺着这两个现象，可以把公开 API、HostRoot、调度器和前两章的 DOM 操作连成一条路径。

> 主文件：`packages/react-dom/src/client.ts`、`packages/react-reconciler/src/workLoop.ts`

## 21.1 `createRoot` 先建立什么

应用入口通常写成两句：

```tsx
const root = createRoot(document.getElementById('root')!);
root.render(<h1>Hello</h1>);
```

第一句准备一个可以反复使用的根。第二句才把 React element 交给它。本项目的 `createRoot` 很短：

```ts
/**
 * 给一个 DOM 容器建立可重复 render 的根。
 *
 * 1. 给容器挂上一次 click 委托
 * 2. 创建 FiberRoot，并让它记住这个容器和 DOM HostConfig
 * 3. 返回的 render 闭包固定使用这个 FiberRoot
 */
export function createRoot(container: Element) {
  ensureRootClickDelegation(container); // 1
  const root = createContainer(container, hostConfig); // 2
  return {
    render(element: ReactElement) {
      updateContainer(element, root); // 3
    },
    unmount() {
      unmountContainer(root);
      removeRootClickDelegation(container);
    },
    inspectFiberTree() {
      return inspectFiberTree(root);
    },
    formatFiberTree() {
      return formatDebugFiberTree(root);
    },
  };
}
```

`ensureRootClickDelegation` 安装第二十章的根 `click` 监听器。同一个容器再次调用时，`WeakSet` 会挡住重复绑定。`createContainer` 创建调和器使用的根结构。这时没有安排 Render，也没有改容器里的 DOM。返回对象里的 `render` 闭包保存了刚创建的 `FiberRoot`；`unmount` 会安排一次空 children 的同步更新，等删除路径清理 DOM、ref 和 Effect 后再移除根事件委托。`inspectFiberTree` 和 `formatFiberTree` 只读当前树，给 Demo 和测试观察 Fiber 结构。

`createContainer` 建立的数据关系是：

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

uninitializedFiber.stateNode = root; // HostRoot 反过来指向 FiberRoot
```

这里同时出现了两个“根”。`FiberRoot` 管理整棵应用，保存真实容器、当前树、HostConfig 和调度状态。`HostRoot Fiber` 位于 Fiber 树顶端，会像其他 Fiber 一样经过 begin、complete 和 commit。二者互相连接：

```text
FiberRoot.current ──► HostRoot Fiber
        ▲                    │
        └──── stateNode ─────┘
```

第一次调用 `.render()` 前，`current HostRoot` 已经存在。它的 `child` 还是 `null`，没有应用子树，`alternate` 也还没创建。`pendingProps` 同样是 `null`。工作真正开始后，`prepareFreshStack` 才调用 `createWorkInProgress(current, ...)`，生成与它配对的 WIP HostRoot。

文件里另有兼容入口 `render(element, container)`。它的函数体就是 `createRoot(container).render(element)`。每调用一次都新建一个 `FiberRoot`，所以不会更新前一个根里的 Fiber。同一个容器需要重复更新或卸载时，应保存 `createRoot` 的返回值，再调用同一个 `root.render` 或 `root.unmount`。click 监听按容器去重，但每个根的宿主树和调度状态都独立保存。

## 21.2 `updateContainer` 怎样启动首次渲染

`.render(element)` 最终调用：

```ts
/**
 * 把新的 React element 安排到已有根上。
 *
 * 1. 写进 current HostRoot 的 pendingProps.children
 * 2. 固定用 SyncLane 调度，不看当前是不是 transition
 */
export function updateContainer(element: unknown, container: FiberRoot): void {
  container.current.pendingProps = { children: element }; // 1
  scheduleUpdateOnFiberImpl(container.current, SyncLane); // 2
}
```

第一行把 element 放进 **current** HostRoot 的 `pendingProps.children`。之后 `prepareFreshStack` 用 `current.pendingProps ?? current.memoizedProps` 创建 WIP。首次渲染时 `memoizedProps` 还是 `null`，所以用的就是刚写上的这份 children。`beginWork` 遇到 `HostRoot`，进入 `updateHostRoot`，再把 `pendingProps.children` 交给 `reconcileChildren`。

第二行在 HostRoot 上安排 `SyncLane`。这里不根据调用场景另选 Lane。每次 `root.render(...)` 都使用同步车道。`scheduleSyncCallback` 把同一个根上的多次 Sync 合成一个微任务。微任务开始后，`workLoopSync` 在循环里不问 `shouldYield`。若这次遍历途中又来了新的 Sync，循环仍会先走完，再按第 18 章的重启规则丢掉这次结果并重新排队。没有这样的插队时，走完就进入 commit。

从公开入口到 DOM 提交，主线是：

```text
root.render(element)
  → updateContainer：写 current HostRoot.pendingProps.children
  → scheduleUpdateOnFiberImpl(HostRoot, SyncLane)
  → root.pendingLanes 合入 SyncLane
  → ensureRootIsScheduled
  → queueMicrotask
  → prepareFreshStack：current HostRoot → WIP HostRoot
  → workLoopSync：beginWork 向下，completeWork 向上
  → commitRoot：Mutation 改 DOM，切换 current，Layout 写 ref / 跑 effect
```

首次进入 `updateHostRoot` 时，传入的 `current` 就是 `createContainer` 提前创建的 HostRoot。空的是它的 `child`。调和器从这里生成第一棵应用 Fiber。`completeWork` 创建并组装离线 DOM。Commit 的 Placement 再把顶层宿主节点插入 `root.containerInfo`。

```text
FiberRoot
  └─ current HostRoot（已存在，child = null）
          ⇅ 第一次 prepareFreshStack 建立 alternate
     WIP HostRoot
          └─ 新应用 Fiber → 新宿主节点
```

“首次渲染没有 current”这句话对不上源码。根 Fiber 在 `createRoot` 时就已经就位。第一次 Render 新增的是它的 WIP 配对，以及这棵 WIP 下面的应用子树。Commit 之后，原来的 WIP 成为新的 `root.current`。

## 21.3 后续更新、多 root 与卸载

同一个 root 后续仍从 `updateContainer` 进入。下面把第二次调用放到定时器任务中，让第一次 Sync 更新先在微任务里提交：

```tsx
root.render(<h1>Hello</h1>);

setTimeout(() => {
  root.render(<h1>Welcome</h1>); // 首次提交完成后，再提交新描述
}, 0);
```

第二次调用会改写那一刻的 current HostRoot 的 `pendingProps.children`，再安排一次 SyncLane。此时 `current.child` 已经指向上次提交的应用树。调和器可以复用 Fiber 和 DOM，只为实际变化标记 Placement、Update 或 Deletion。`performUnitOfWork` 在处理节点时会把 `pendingProps` 抄到 `memoizedProps`。下一次若没有新的 `root.render`，`prepareFreshStack` 仍能从 HostRoot 上拿到上一份 children。

如果两次 `root.render` 紧挨着写在同一次同步调用里，结果不同：第二次会在首次微任务执行前覆盖 HostRoot 的 `pendingProps`，这一轮直接提交 `Welcome`。此时还没有一棵已提交的 `Hello` 子树可供复用。两种写法都能更新根，但对应的是不同的执行过程。

组件里的 `setState` 不会绕回 `updateContainer`：

```tsx
function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
```

`setCount` 先把更新放进 Hook 队列，再从函数组件 Fiber 向 HostRoot 标记 Lane，直接进入 `scheduleUpdateOnFiberImpl`。这次 Lane 来自 `requestUpdateLane`，普通点击是 `DefaultLane`，不是 `SyncLane`。HostRoot 的 `pendingProps.children` 保持 `root.render` 留下的那份。从 `ensureRootIsScheduled` 开始，它和根更新共用 begin、complete、commit。

根更新在这里直接改 `pendingProps`，并固定使用 SyncLane。生产实现还会把根更新放进队列，交给更完整的事件优先级和 Lane 逻辑。这里展示的是调用主线，不是那套队列的等比例缩写。

多个 root 的调度状态已经挂在各自的 `FiberRoot` 上。每个 root 保存自己的 `hostConfig`、`pendingLanes`、`callbackNode`、`workInProgress`、Render lanes、重启标记和 Passive 队列；模块级状态只保留 `syncRoots` 集合与 `syncScheduled` 标记。这样同一轮里对两个根调用 `render` 时，微任务会逐个处理集合中的 root：

```tsx
const a = createRoot(document.getElementById('a')!);
const b = createRoot(document.getElementById('b')!);
a.render(<h1>A</h1>);
b.render(<h1>B</h1>);
```

微任务会先复制并清空 `syncRoots`，再分别执行 `performSyncWorkOnRoot(a)` 和 `performSyncWorkOnRoot(b)`。一个 root 的 `workInProgress`、HostConfig 或 Passive 回调不会覆盖另一个 root。测试中的“双 root 同步更新”会检查两个容器都完成提交。

`root.unmount()` 把 HostRoot 的 children 置为空并安排一次 SyncLane 更新。删除路径会清理旧宿主节点、ref 和 Effect；之后 root 被标记为已卸载，旧 Fiber 上保存的 dispatch 不会再安排新的工作，根容器上的 click 委托也会被移除。

这些字段串起了单 root 和多 root 的生命周期：创建空的 current HostRoot，用 SyncLane 提交第一棵树，再用同一个根接受后面的 `render`、`setState` 和 `unmount`。`FiberRoot` 持有调度隔离，`syncRoots` 只负责把同一轮的多个同步根集中唤醒。

## 本章回顾

- `createRoot` 安装根 click 委托，并建立相互引用的 `FiberRoot` 与空 `current HostRoot`。真正的更新从 `.render()` 开始；返回对象还提供 `unmount` 和 Fiber Inspector。
- `render(element, container)` 每次新建根。重复调用不会更新上一个 Fiber 树；需要持续更新时保存同一个 `createRoot` 返回值。
- `updateContainer` 写入 current 根的 `pendingProps.children`，并用固定的 SyncLane 调度首次及后续根更新。
- 首次渲染已经有 current HostRoot。第一次工作创建的是 WIP alternate 和应用子树。
- `setState` 从组件更新队列进入调度，不改写这份根 children；多个 root 的工作指针和 Passive 队列分别挂在各自 `FiberRoot` 上。
- `root.unmount()` 复用删除 Commit 路径清理 DOM、ref、Effect，并阻止旧 dispatch 继续调度。

### 源码入口

- `packages/react-dom/src/client.ts`：`createRoot`、`render`
- `packages/react-dom/src/hostConfig.ts`：`ensureRootClickDelegation`
- `packages/react-reconciler/src/workLoop.ts`：`createContainer`、`updateContainer`
- `packages/react-reconciler/src/workLoop.ts`：`prepareFreshStack`、`ensureRootIsScheduled`、`scheduleSyncCallback`
- `packages/react-reconciler/src/beginWork.ts`：`updateHostRoot`
- `packages/react-reconciler/src/commitWork.ts`：`commitRoot`、`commitPlacement`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./20-DOM属性与简易事件.md) · [下一章：附录 →](./appendix.md)
