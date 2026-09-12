# 第 21 章：`createRoot` / `updateContainer` 入口

[← 返回总目录](../../React设计与实现.md) · [上一章](./20-DOM属性与简易事件.md) · [下一章：附录 →](./appendix.md)

> 主文件：`packages/react-dom/src/client.ts`、`packages/react-reconciler/src/workLoop.ts`
> 应用只看见 `createRoot(container).render(element)`。里面建的是 FiberRoot + HostRoot，更新一律走进工作循环。

## 本章书签

- [21.1 `createRoot(container)`](#211-createrootcontainer)
- [21.2 `render` → `updateContainer`](#212-render--updatecontainer)
- [21.3 挂载与更新同一套路径](#213-挂载与更新同一套路径)
- [面试复习](#面试复习)

---

## 21.1 `createRoot(container)`

```ts
// packages/react-dom/src/client.ts
export function createRoot(container: Element) {
  const root = createContainer(container, hostConfig);
  return {
    render(element: ReactElement) {
      updateContainer(element, root);
    },
  };
}
```

`createContainer` 只建数据结构，**不调度、不改 DOM**：

```ts
const uninitializedFiber = createHostRootFiber(); // tag = HostRoot，还没有孩子
const root: FiberRoot = {
  containerInfo,          // 真实 DOM，一般是 #root
  current: uninitializedFiber,
  hostConfig,
  finishedWork: null,
  pendingLanes: NoLanes,
  callbackNode: null,
  callbackPriority: NoLane,
};
uninitializedFiber.stateNode = root; // HostRoot ↔ FiberRoot 互相指
```

此时屏幕上还是空容器。`current` 是一棵只有根的树，`alternate` 为 `null`。第一次 `render` 才会 `createWorkInProgress` 建出配对的 WIP。

兼容入口 `render(element, container)` 等于 `createRoot(container).render(element)`，每次都新开一个 root，教学 demo 只用 `createRoot`。

## 21.2 `render` → `updateContainer`

```ts
export function updateContainer(element: unknown, container: FiberRoot): void {
  container.current.pendingProps = { children: element };
  scheduleUpdateOnFiberImpl(container.current, SyncLane);
}
```

两步：

1. 把要渲染的 element 挂到 HostRoot 的 `pendingProps.children`。`beginWork` 的 `updateHostRoot` 就从这里取孩子。
2. 对 HostRoot 打 **`SyncLane`**，走微任务里的 `workLoopSync`。首屏必须尽快画完，不能切片画一半。

之后就是第 8、18 章的路径：

```text
ensureRootIsScheduled
  → queueMicrotask
  → prepareFreshStack（从 current 克隆 WIP）
  → workLoopSync：begin / complete 整棵
  → commitRoot：Placement 把对应宿主节点插进 containerInfo
```

`setState` 不会再进 `updateContainer`。它从函数组件 Fiber 标 `DefaultLane`，约的是 Scheduler 宏任务。入口不同，后面的 begin / Diff / complete / commit 是同一套。

## 21.3 挂载与更新同一套路径

第一次 `render` 与之后再 `render`（或 `setState`）没有第二套「mount 专用协调器」。差别只在数据：

| | 首次 `root.render` | 之后 `setState` / 再 `render` |
| --- | --- | --- |
| HostRoot.current.child | `null` | 已有应用树 |
| HostRoot 的 Diff | `reconcileChildFibers(null, nextChildren)` | `reconcileChildFibers(current.child, nextChildren)` |
| 新建后代的 Diff | 从首个新建 Fiber 往下走 `mountChildFibers` | 新建分支走 mount，复用分支走 reconcile |
| Placement | 首个应用 Fiber会打标，其新建后代通常不逐个打标 | 新增或移动的节点打标 |
| 实例 | `completeWork` 创建并 `appendAllChildren` | 复用，props 变了打 Update |
| 进文档 | Commit 从带 Placement 的 Fiber 找到顶层宿主节点并插入 `#root` | 按 flags 插 / 移 / 删 / 改 |
| Lane | `SyncLane` | `setState` 为 `DefaultLane`；再 `render` 仍是 Sync |

所以「挂载」不是从 HostRoot 开始整棵切到另一套算法。首次边界要分两层看：

```text
prepareFreshStack
  current HostRoot
    ↕ alternate
  workInProgress HostRoot

HostRoot.beginWork
  current != null、current.child == null
  → reconcileChildFibers(true)
  → 创建 App，App.flags |= Placement

App.beginWork
  current = App.alternate = null
  → mountChildFibers(false)
  → 新建后代，不逐个记录 Placement
```

`completeWork` 会创建宿主实例并离线组装宿主子树。Commit 处理 App 的 `Placement` 时，若 App 是函数组件，就递归找到它下面的顶层 Host 节点并插入容器；不能把这件事机械概括成「Commit 只插最外层 Fiber」，因为最外层 Fiber可能没有 DOM，也可能覆盖多个顶层宿主节点。

对着 demo 收束全书最小闭环：

```text
createRoot(#root)
  → createElement(App, null)
  → updateContainer + SyncLane
  → App() 跑起来，useState(0) mount
  → 文本「count: 0」上屏
点 +1
  → setCount → DefaultLane
  → App() 再跑，updateState 得到 1
  → 文本 Fiber 复用，打 Update
  → commitTextUpdate
  → useEffect 宏任务改 document.title
```

未实现的能力（Fragment、合成事件、完整 Lane…）见附录 C。能把这条路径对着源码走通，教学版的目标就达到了。

---

## 面试复习

### 一句话结论

`createRoot` 只建立 FiberRoot 与 current HostRoot；`render` 把 element 写入 HostRoot 并调度 SyncLane，首次根层仍走可跟踪副作用的 reconcile。

### 面试回答（可口述，为什么→机制→仓库落点→官方差异）

为什么入口要拆成 `createRoot` 和 `render`：容器与调度根可以长期复用，多次更新只替换根 children。机制上，`createContainer` 建 FiberRoot/current HostRoot 并保存 HostConfig；`updateContainer` 写 `pendingProps.children`、标 SyncLane，随后从 current HostRoot 克隆 WIP，走 begin/complete/commit。仓库落点是 `react-dom/src/client.ts` 与 `react-reconciler/src/workLoop.ts`。官方根更新通过 update queue、event priority 和更完整的 root scheduler 进入，本仓库直接改 `pendingProps`，并将 `root.render` 固定为 SyncLane。

### 常见追问

**Q：`createRoot` 调用后为什么页面还没变化？**
A：它只建立根数据结构，没有 element，也没有调度 Render/Commit。

**Q：首次 HostRoot 为什么有 current？**
A：`createContainer` 已创建 current HostRoot；首次工作开始时 `createWorkInProgress` 为它建立 alternate。

**Q：首次应用 Fiber上的 Placement 如何插入函数组件下的 DOM？**
A：`commitPlacement` 找宿主父节点，`insertOrAppendPlacementNode` 跨过无实例 Fiber，插入其顶层宿主后代。

**Q：`setState` 也会调用 `updateContainer` 吗？**
A：不会。它从对应函数组件 Fiber 标 lane 并调度，但后续共享同一工作循环。

### 容易说错

- 错：首次 HostRoot 因 `current.child == null` 走 mount。对：判断的是 HostRoot 的 `current`，它存在。
- 错：首次整棵树都没有 Placement。对：首个应用 Fiber会有 Placement。
- 错：`root.render` 每次重建 FiberRoot。对：同一个 root 的 `render` 复用 FiberRoot；只有兼容 `render` 包装每次新建 root。

### 源码入口

- `packages/react-dom/src/client.ts`
- `packages/react-reconciler/src/workLoop.ts`：`createContainer`、`updateContainer`
- `packages/react-reconciler/src/workLoop.ts`：`prepareFreshStack`、`performSyncWorkOnRoot`
- `packages/react-reconciler/src/fiber.ts`：`createHostRootFiber`、`createWorkInProgress`
- `packages/react-reconciler/src/commitWork.ts`：`commitPlacement`

[← 返回总目录](../../React设计与实现.md) · [上一章](./20-DOM属性与简易事件.md) · [下一章：附录 →](./appendix.md)
