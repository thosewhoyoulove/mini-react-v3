# 第 3 章：mini-react 包结构与依赖方向

[← 返回总目录](../../React设计与实现.md) · [上一章](./02-教学版框架要具备的核心能力.md) · [下一章 →](./04-ReactElement与createElement.md)

---

`useState` 从 `react` 导出，状态队列却实现在 `react-reconciler`。如果前者直接导入后者，而调和器又要使用 `react` 提供的共享对象，依赖很快就会绕成一圈。理解 mini-react 的五个包，不妨从这个看似反常的入口开始：为什么公开的 `useState` 几乎什么也不做？

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

根目录使用 pnpm workspace。各包 `package.json` 中的依赖组成下面这张图，箭头指向被导入的一方：

```text
react-dom ──► react-reconciler ──► react ──► shared
                 │                    ▲
                 ├──► scheduler ──────┘
                 └──────────────────► shared

react-dom 也直接依赖 react 和 shared
```

五个包各自只承担一层职责：

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

先执行的是 `react` 中的 `createElement(App, null)`。它返回一份元素描述，`type` 保存 `App` 函数，此时既没有调用 `App`，也没有创建 DOM。

接着，`react-dom` 的 `createRoot` 调用 `createContainer(container, hostConfig)`。调和器创建 `FiberRoot` 和空的 HostRoot Fiber，在根上保存容器与 DOM 操作函数。返回对象的 `render` 再进入 `updateContainer`，把元素写入 HostRoot 的 `pendingProps.children`，并以 `SyncLane` 安排首次更新。

首屏提交后，点击 `+1` 或 reverse 不会再次调用 `root.render`。事件回调调用公开的 `setState`，真正的 dispatch 已在 Hook 首次挂载时由调和器创建；它把 action 放进队列，再从组件 Fiber 发起调度。两条入口可以合并成一张简图：

```text
首次：createElement → createRoot → updateContainer ┐
                                                  ├→ 调度 → Render → Commit
更新：事件 → setState dispatch → Hook 更新队列 ────┘
```

公开入口、状态实现和 DOM 操作分处不同包，但最终汇入同一套 Fiber 工作循环。依赖保持单向，调用路径仍然能够连成闭环。

## 本章回顾

- `react` 中的 Hook 只通过 Dispatcher 转发；mount、update 和状态队列由 `react-reconciler` 在渲染期间提供。
- `shared`、`scheduler`、`react`、`react-reconciler`、`react-dom` 按职责单向依赖，DOM 细节停留在最外层。
- `root.render` 与组件 `setState` 的入口不同，进入调度后会共用 Render 和 Commit 路径。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./02-教学版框架要具备的核心能力.md) · [下一章 →](./04-ReactElement与createElement.md)
