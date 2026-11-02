# 第 3 章：mini-react 包结构与依赖方向

[← 返回总目录](../../React设计与实现.md) · [上一章](./02-教学版框架要具备的核心能力.md) · [下一章 →](./04-ReactElement与createElement.md)

---

`useState` 从 `react` 导出，状态队列却实现在 `react-reconciler`。两个包怎样配合，又怎样避免互相导入？公开的 `useState` 提供了一个很好的观察入口：它几乎只做一次转发。沿这次调用往下找，五个包的分工就清楚了。

## 3.1 useState 为什么只有一行转发

`demos/hello-dom` 从 `react` 导入 `useState`。打开 `packages/react/src/ReactHooks.ts`，里面看不到更新队列，也没有 Fiber：

```ts
function resolveDispatcher() {
  const dispatcher = ReactCurrentDispatcher.current;
  if (dispatcher == null) {
    throw new Error(
      'Invalid hook call. Hooks can only be called inside function components.',
    );
  }
  return dispatcher;
}

export function useState<S>(
  initialState: S | (() => S),
): [S, Dispatch<S | ((prev: S) => S)>] {
  return resolveDispatcher().useState(initialState);
}
```

这里的 Dispatcher 是一张 Hook 函数表。真正的 `mountState` 和 `updateState` 位于 `packages/react-reconciler/src/hooks.ts`。`renderWithHooks` 执行组件前，根据本轮是首次渲染还是更新，把对应函数表写进 `ReactCurrentDispatcher.current`；组件返回或抛错后，再在 `finally` 中清空。

同一句 `useState(0)` 的行为取决于调用时机。组件首次渲染时，它会转到 `mountState`；更新时转到 `updateState`；组件之外没有可用 Dispatcher，会抛出 `Invalid hook call`。

这层转发解决的是依赖方向。`react` 声明 Dispatcher 接口并保存可变引用，调和器只在组件执行期间提供实现。公共 API 不必导入调和器，应用也不需要知道 `mountState` 在哪个文件中。

若把队列逻辑直接写进公开的 `useState`，`react` 就要反向依赖 `react-reconciler`；调和器为了读取 Dispatcher 又已经依赖 `react`，两个包会形成循环。现在的结构让 Hook API 保持稳定，首次渲染和更新的差异留在调和器内部。

`createElement` 不需要这种转发。它在调用时就能根据参数创建普通对象，所以实现直接放在 `react` 包中。

## 3.2 依赖只能朝更底层走

根目录使用 pnpm workspace 管理五个包。各包 `package.json` 声明的依赖从公共类型逐层向外展开：`react` 和 `scheduler` 都只依赖 `shared`，两者彼此独立；`react-reconciler` 依赖这三个包；`react-dom` 再依赖 `react-reconciler`、`react` 和 `shared`。

这份依赖关系决定了代码可以放在哪里：

| 包 | 依赖 | 对外做什么 |
| --- | --- | --- |
| `shared` | 无 | `ReactElement` 类型、`$$typeof` 用的符号 |
| `scheduler` | `shared` | 安排一段 JS 何时运行、是否该让出。不认识 Fiber |
| `react` | `shared` | `createElement`、JSX runtime、Hook 的公开函数 |
| `react-reconciler` | `react`、`scheduler`、`shared` | 把描述变成 Fiber，跑 Render / Commit。不写 `document` |
| `react-dom` | `react`、`react-reconciler`、`shared` | `createRoot`，以及真正的 DOM 实现 |

最底层的 `shared` 提供各包共用的类型和符号。`scheduler` 只安排回调何时执行、何时让出主线程，不需要了解 Fiber。`react-reconciler` 使用公开的 React 约定和 Scheduler 完成 Render、Commit。最外层的 `react-dom` 同时拿得到真实容器和调和器入口，负责注入 DOM 版 `HostConfig`。

`demos/hello-dom/package.json` 只声明 `react` 和 `react-dom`，正好对应应用看到的两个入口。其余包由运行时依赖带入。阅读源码时，如果在 `react-reconciler` 中看到 `document`，或在 `scheduler` 中看到 Fiber，通常说明职责已经穿透：前者不再能更换宿主，后者也不再是通用回调调度器。

`react` 还导出 `./jsx-runtime`。demo 手写 `createElement`，不会经过这个入口；编译器转换 JSX 时才会使用它。两条路径最终都会产生相同形状的 React Element。

## 3.3 从 createRoot 走到下一次点击

包图只有沿调用路径走一遍才容易记住。`demos/hello-dom/src/main.ts` 的入口是：

```ts
createRoot(container).render(createElement(App, null));
```

这行表达式先调用 `react-dom` 的 `createRoot(container)`，得到带有 `render` 方法的根对象。`createRoot` 内部把 DOM 版 `HostConfig` 传给 `createContainer`，由调和器创建 `FiberRoot` 和空的 HostRoot Fiber。前者保存应用容器等信息，后者是 Fiber 树的根。

随后，JavaScript 求出 `render` 的参数：`react` 中的 `createElement(App, null)` 返回元素描述，把 `App` 函数保存在 `type` 中，此时既没有调用 `App`，也没有创建 DOM。参数准备好后，`render` 才进入 `updateContainer`，把描述写入 HostRoot 的 `pendingProps.children`，并以 `SyncLane` 安排更新。

首屏提交后，点击 `+1` 或 reverse 不会再次调用 `root.render`。事件回调使用的是 `useState` 返回的状态 setter，例如 `setCount` 或 `setItems`；它们并非另一个从 `react` 导出的函数，而是调和器在 Hook 首次挂载时创建的 dispatch。dispatch 把 action 放进队列，再从组件 Fiber 发起调度。

因此，应用有两个更新入口：`root.render` 提交新的根描述，状态 setter 提交一条状态更新。它们最终都会安排 Fiber 工作，再经过 Render 和 Commit。

公开入口、状态实现和 DOM 操作分处不同包，但最终汇入同一套 Fiber 工作循环。依赖保持单向，调用路径仍然能够连成闭环。

## 本章回顾

- `react` 中的 Hook 只通过 Dispatcher 转发；mount、update 和状态队列由 `react-reconciler` 在渲染期间提供。
- `shared`、`scheduler`、`react`、`react-reconciler`、`react-dom` 按职责单向依赖，DOM 细节停留在最外层。
- `root.render` 与组件 `setState` 的入口不同，进入调度后会共用 Render 和 Commit 路径。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./02-教学版框架要具备的核心能力.md) · [下一章 →](./04-ReactElement与createElement.md)
