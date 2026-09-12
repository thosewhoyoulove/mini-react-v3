# 第 3 章：mini-react 包结构与依赖方向

[← 返回总目录](../../React设计与实现.md) · [上一章](./02-教学版框架要具备的核心能力.md) · [下一章 →](./04-ReactElement与createElement.md)

> 主文件：仓库根 `package.json`、`packages/*/package.json`
> 对照官方把源码拆成多个包：谁能 import 谁，决定了「调和器为什么碰不到 `document`」。

## 本章书签

- [3.1 monorepo 里有哪些包（`packages/*`）](#31-monorepo-里有哪些包packages)
- [3.2 依赖方向：`shared` ← `scheduler` / `react` ← `react-reconciler` ← `react-dom`](#32-依赖方向)
- [3.3 最小可运行路径：从 `createElement` 到屏幕上的节点](#33-最小可运行路径从-createelement-到屏幕上的节点)
- [面试复习](#面试复习)

---

## 3.1 monorepo 里有哪些包（`packages/*`）

根目录是 pnpm workspace。应用不直接引用五个包的相对路径，而是 `workspace:*`。职责和官方同名包对齐，体积按「能讲清」裁过：

| 包 | 对外暴露什么 | 不做什么 |
| --- | --- | --- |
| `shared` | `REACT_ELEMENT_TYPE`、`ReactElement` 类型、feature flag | 不是应用 API |
| `scheduler` | `unstable_scheduleCallback` / `shouldYield` / `cancel` | 不认识 Fiber |
| `react` | `createElement`、`jsx` / `jsxs`、`useState` / `useEffect` / `useLayoutEffect` | 不碰 DOM、不跑调和 |
| `react-reconciler` | `createContainer` / `updateContainer`、`HostConfig` 类型 | 不写 `document.*` |
| `react-dom` | `createRoot` / `render`、DOM `hostConfig` | 不实现 Diff / Hooks |

`demos/hello-dom` 是唯一可运行的应用：只依赖 `react` 和 `react-dom/client`，和真实项目用法一致。

`react` 额外导出了 `./jsx-runtime` 与 `./jsx-dev-runtime`（都指向 `jsx.ts`），给打包器的 automatic JSX runtime 用。demo 本身手写 `createElement`，两条入口在第 4、5 章对照。

## 3.2 依赖方向

箭头表示「谁依赖谁」（被指向的更底层，不能反向 import）：

```text
shared
  ▲
  ├── scheduler
  ├── react
  │     ▲
  │     └── react-reconciler ──► scheduler
  │              ▲
  └── react-dom ─┘
```

写成一串就是总目录里那句：

```text
shared ← scheduler / react ← react-reconciler ← react-dom
```

几条硬约束，对着 `package.json` 的 `dependencies` 就能核：

1. **`shared` 零依赖。** Symbol、类型放这里，避免 `react` 和 reconciler 互相抄一份。
2. **`scheduler` 只依赖 `shared`。** 它是主线程时钟，不能 import Fiber，否则循环依赖、职责也糊。
3. **`react` 不依赖 reconciler。** `useState` 只读 `ReactCurrentDispatcher.current`；真正的 mount / update 由 reconciler 在 `renderWithHooks` 里注入。应用 `import { useState } from 'react'`，底层实现却在 `hooks.ts`。
4. **`react-reconciler` 不依赖 `react-dom`。** 它依赖 `react`（取 Dispatcher）、`scheduler`、`shared`。宿主操作全部走注入的 `HostConfig`。
5. **`react-dom` 最外层。** 它把 DOM config 交给 `createContainer`，再把 `updateContainer` 包成 `root.render`。

读源码时若发现 reconciler 里出现了 `document`，就是依赖方向破了。本仓库里 `document` 只出现在 `packages/react-dom` 和 demo。

## 3.3 最小可运行路径：从 `createElement` 到屏幕上的节点

`demos/hello-dom/src/main.ts` 最后一行把整条链路串起来：

```ts
createRoot(container).render(createElement(App, null));
```

按包走一遍：

```text
1. react.createElement(App, null)
      → { $$typeof, type: App, key, ref, props }

2. react-dom.createRoot(#root)
      → createContainer(container, hostConfig)
      → FiberRoot + 空的 HostRoot Fiber

3. root.render(element)
      → updateContainer：HostRoot.pendingProps = { children: element }
      → scheduleUpdateOnFiberImpl(..., SyncLane)

4. react-reconciler 工作循环
      beginWork(App) → renderWithHooks → 得到子 Element
      reconcileChildren → Fiber 链表
      completeWork → hostConfig.createInstance / appendChild
      commitRoot → 插入 #root
```

首屏走 `SyncLane`（微任务里一次跑完），之后按钮上的 `setState` 走 `DefaultLane`（Scheduler 切片）。同一套 Fiber / flags / commit，只是调度入口不同。

下一章从最小的数据开始：`createElement` 到底返回了什么。

## 面试复习

### 一句话结论

拆包的核心不是目录整齐，而是让 React API、调度器、调和器和宿主实现保持单向依赖，各层只知道完成职责所需的最小接口。

### 面试回答

为什么 React 要拆成多个包？如果 Hooks、调和、调度和 DOM 操作互相引用，既容易形成循环依赖，也无法让同一套 reconciler 服务不同宿主。数据与阶段上，`react` 只生产 Element 并暴露 Hook API，`scheduler` 只安排任务，`react-reconciler` 把 Element 转成 Fiber、完成 Render/Commit，`react-dom` 在最外层注入 HostConfig 并提供 `createRoot`。本仓库从 `ReactElement.ts` 到 `client.ts`、`reconciler.ts`、`workLoop.ts`、`hostConfig.ts` 能走通最小链路。官方仓库包更多、入口与构建条件更复杂，renderer 也不止 DOM；教学版只保留五包和一个 DOM renderer，但依赖倒置的设计意图一致。

### 常见追问

**1. 为什么 `react` 不能直接依赖 reconciler 来实现 Hooks？**

Hook 的公开函数只需转发给当前 Dispatcher；由正在渲染的 renderer 注入实现，才能避免公共 API 与某个调和器执行环境绑死。

**2. Scheduler 为什么不认识 Fiber？**

它只回答任务何时执行、是否该让出。若依赖 Fiber，通用任务调度会与 React 树结构耦合，依赖层次也会反转。

**3. `react-dom` 为什么处在最外层？**

它同时知道 DOM 容器和 reconciler 入口，正适合负责组装；底层 reconciler 只通过接口请求宿主操作。

### 容易说错

- 不要把 `scheduler` 和 reconciler 混为一层：前者调度回调，后者遍历 Fiber 并计算变更。
- 不要说 `react` 包负责组件渲染；函数组件实际由 reconciler 的 `renderWithHooks` 执行。
- 不要把本仓库的包数量和导出面当成官方全貌；这里只保留教学链路。

### 源码入口

- `packages/react/package.json`：React 与 JSX runtime 导出。
- `packages/react/src/index.ts`：公共 React API。
- `packages/scheduler/src/Scheduler.ts`：与 Fiber 无关的任务调度。
- `packages/react-reconciler/src/reconciler.ts`：调和器公开入口。
- `packages/react-reconciler/src/HostConfig.ts`：依赖倒置接口。
- `packages/react-dom/src/client.ts`：DOM renderer 的组装入口。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./02-教学版框架要具备的核心能力.md) · [下一章 →](./04-ReactElement与createElement.md)
