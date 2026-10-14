# 第 3 章：mini-react 包结构与依赖方向

[← 返回总目录](../../React设计与实现.md) · [上一章](./02-教学版框架要具备的核心能力.md) · [下一章 →](./04-ReactElement与createElement.md)

---

五个包看起来像把官方仓库缩小了一份。值得先看懂的不是目录名，而是 `useState` 为什么几乎没有实现。这一行决定了谁可以 import 谁。

## 本章书签

- [3.1 useState 为什么只有一行转发](#31-usestate-为什么只有一行转发)
- [3.2 依赖只能朝更底层走](#32-依赖只能朝更底层走)
- [3.3 从 createRoot 走到下一次点击](#33-从-createroot-走到下一次点击)
- [面试复习](#面试复习)

---

## 3.1 useState 为什么只有一行转发

`demos/hello-dom` 写的是 `import { useState } from 'react'`。打开 `packages/react/src/ReactHooks.ts`，函数体并没有队列，也没有 Fiber：

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

`ReactCurrentDispatcher.current` 平时是 `null`。组件函数外面调用 `useState`，就会走到上面这个错误。真正的 mount / update 实现在 `packages/react-reconciler/src/hooks.ts`。调和器在调用组件函数之前，把当前这套实现填进 `current`，调用结束再清掉。

如果在组件外执行 `useState(0)`，可预测结果不是返回 `[0, setState]`，而是抛出 `Invalid hook call`。进入 `renderWithHooks` 后，同一行调用才会被转发到本轮的 mount 或 update 实现。

可以把 `current` 想成一个插座。这个比喻只描述“运行时替换实现”这一点：精确地说，`react` 包声明 `Dispatcher` 接口并保存一个可变引用，调和器在渲染函数组件期间写入对应实现。因此应用只依赖 `react` 和 `react-dom`，不必知道调和器的文件名。

如果把队列逻辑直接写进 `useState`，`react` 就要 import `react-reconciler`。而调和器为了拿到 `ReactCurrentDispatcher` 已经要 import `react`。两条依赖对着走，包就循环了，Hook 也会和某一种调和过程焊死。第 2 章说调和器不该认识 `document`，这里是同一条原则的另一面：公共 API 也不该认识某一次渲染的内部实现。

`createElement` 不同。它不需要等渲染开始，调用当下就能返回一个普通对象，所以实现留在 `react` 包里。第 4 章只讲这个对象。

## 3.2 依赖只能朝更底层走

根目录是 pnpm workspace。各包的 `dependencies` 把方向固定成这样（箭头指向被 import 的一方）：

```text
react-dom ──► react-reconciler ──► react ──► shared
                 │                    ▲
                 ├──► scheduler ──────┘
                 └──────────────────► shared

react-dom 也直接依赖 react 和 shared
```

对着每个 `package.json` 可以核对五条：

| 包 | 依赖 | 对外做什么 |
| --- | --- | --- |
| `shared` | 无 | `ReactElement` 类型、`$$typeof` 用的符号 |
| `scheduler` | `shared` | 安排一段 JS 何时运行、是否该让出。不认识 Fiber |
| `react` | `shared` | `createElement`、JSX runtime、Hook 的公开函数 |
| `react-reconciler` | `react`、`scheduler`、`shared` | 把描述变成 Fiber，跑 Render / Commit。不写 `document` |
| `react-dom` | `react`、`react-reconciler`、`shared` | `createRoot`，以及真正的 DOM 实现 |

`hello-dom` 的 `package.json` 只依赖 `react` 和 `react-dom`，和上面的应用用法一致。

读源码时用一条反例检查：调和器里出现 `document`，或 `scheduler` 里出现 Fiber，就是方向反了。调度器如果知道 Fiber，它就不再是「一段回调什么时候跑」，而会和这棵 UI 树绑在一起。

`react` 还导出了 `./jsx-runtime`。demo 手写 `createElement`，不走这条入口；打包器编译 JSX 时会走。第 5 章对照这两种入口，它们产出的对象是同一种。

## 3.3 从 createRoot 走到下一次点击

`demos/hello-dom/src/main.ts` 末尾：

```ts
createRoot(container).render(createElement(App, null));
```

按包走一遍，每一步只看已经能在源码里指到的事实：

1. `react` 的 `createElement(App, null)` 返回描述对象。`type` 是 `App` 这个函数，还没有执行它，也没有 DOM。
2. `react-dom` 的 `createRoot` 调用 `createContainer(container, hostConfig)`。根上记下容器和宿主实现，并放一个空的 HostRoot。
3. `root.render` 进入 `updateContainer`：把这棵描述写进 HostRoot 的 `pendingProps.children`，再请求一轮更新。首屏因此能画出来。
4. 之后点 `+1` 或 reverse，不再经过 `root.render`。事件里调用的是 `react` 转发出去的 `setState`，由调和器里的实现入队，再请求下一轮更新。

第 4 步和第 3 步共用后面的 Fiber、比较和提交，入口不同。工作循环怎么向下、向上，从第 8 章开始对着 `workLoop.ts` 走。下一章先把第 1 步的返回值拆开：`type`、`key`、`props` 各自交给谁。

## 面试复习

### 一句话结论

拆包是为了让公开 API、调度、调和、宿主实现单向依赖。`useState` 只转发到当前渲染插上的实现，所以 `react` 不必反过来依赖调和器。

### 面试回答

应用从 `react` 引入 `useState`，但这个函数只读取 `ReactCurrentDispatcher.current`。调和器在执行组件函数前把 mount 或 update 实现填进去，执行完再清空。这样 Hook 的公开入口不用 import 调和器，调和器也不用把 DOM 写进来。`react-dom` 待在最外层，负责把容器和宿主实现交给 `createContainer`。调度器单独一个包，只回答回调何时运行。本仓库从 `createElement(App)` 到 `createRoot().render`，再从按钮里的 `setState` 回到同一套更新，都可以沿这五个包走通。

### 常见追问

**1. 为什么不能让 `react` 直接依赖调和器来实现 Hook？**

调和器已经依赖 `react` 上的 dispatcher。再反向依赖就会成环，而且公共包会绑死某一种渲染实现。组件外面误调用时，现在的写法可以因为 `current == null` 直接报错。

**2. 调度器为什么不认识 Fiber？**

它只处理「这段回调何时占用主线程、是否该让出」。知道 Fiber 之后，通用的任务调度就和 UI 树的形状耦在一起了。

**3. 为什么 `react-dom` 在最外层？**

它同时看得到 DOM 容器和调和器入口，适合做组装。调和器只通过传进来的函数表操作宿主。

### 容易说错

- `react` 包导出 `useState`，不表示状态存在这个包里。状态在调和器为那次渲染准备的实现里。
- 调度器负责何时跑回调。哪一次更新更急、要不要丢掉算到一半的树，是调和器的决定。
- demo 只依赖 `react` 和 `react-dom`。这不表示运行时只有这两个包；`react-dom` 会再把调和器和调度器带进来。

### 源码入口

- `packages/react/src/ReactHooks.ts`：`resolveDispatcher` 和 `useState` 的转发。
- `packages/react/src/ReactCurrentDispatcher.ts`：渲染期间才有值的那格 `current`。
- `packages/react-dom/src/client.ts`：`createRoot` 如何把宿主实现交出去。
- `packages/react-reconciler/src/workLoop.ts`：`createContainer` / `updateContainer`。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./02-教学版框架要具备的核心能力.md) · [下一章 →](./04-ReactElement与createElement.md)
