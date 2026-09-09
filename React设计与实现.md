# React 设计与实现

基于本仓库 **mini-react** 的教学讲稿。体例模仿《Vue.js 设计与实现》：按「篇 → 章 → 节」展开，对着源码讲清「为什么这样设计、代码里怎么落地」。

**读法：** 本文件只作总目录（书签入口）。每章正文在 [`docs/react-design/`](./docs/react-design/) 下独立成文；章内再用锚点书签跳到各节。内容严格对齐仓库**已实现**路径，未实现能力见附录。

```text
React设计与实现.md          ← 你在这里（总目录）
docs/react-design/
  01-….md … 21-….md         ← 各章正文
  appendix.md                  ← 附录
```

---

## 第一篇：框架设计概览

先回答：**我们为什么需要像 React 这样的框架？** 搞清声明式相对命令式多付了什么、换回了什么，后面的双缓冲、Diff、调度才有落脚点。

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 1 | [声明式 UI 与命令式 DOM 的权衡](./docs/react-design/01-声明式UI与命令式DOM的权衡.md) | 已写 |
| 2 | [教学版框架要具备的核心能力](./docs/react-design/02-教学版框架要具备的核心能力.md) | 待写 |
| 3 | [mini-react 包结构与依赖方向](./docs/react-design/03-mini-react包结构与依赖方向.md) | 待写 |

---

## 第二篇：描述 UI

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 4 | [ReactElement 与 `createElement`](./docs/react-design/04-ReactElement与createElement.md) | 待写 |
| 5 | [JSX、`jsx-runtime` 与 `$$typeof`](./docs/react-design/05-JSX与jsx-runtime与typeof.md) | 待写 |

---

## 第三篇：渲染器

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 6 | [Fiber 链表与双缓冲](./docs/react-design/06-Fiber链表与双缓冲.md) | 待写 |
| 7 | [副作用标记 Flags](./docs/react-design/07-副作用标记Flags.md) | 待写 |
| 8 | [工作循环：向下 begin、向上 complete](./docs/react-design/08-工作循环.md) | 待写 |
| 9 | [`beginWork` 按 tag 分发](./docs/react-design/09-beginWork按tag分发.md) | 待写 |
| 10 | [子节点 Diff：单节点与列表 key](./docs/react-design/10-子节点Diff.md) | 已写 |
| 11 | [`completeWork` 创建实例与冒泡 flags](./docs/react-design/11-completeWork.md) | 待写 |
| 12 | [Commit：Mutation / Layout / Passive](./docs/react-design/12-Commit三阶段.md) | 待写 |

---

## 第四篇：组件化与 Hooks

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 13 | [函数组件的执行时机](./docs/react-design/13-函数组件的执行时机.md) | 待写 |
| 14 | [Hook 链表与 mount / update 两套 Dispatcher](./docs/react-design/14-Hook链表与Dispatcher.md) | 待写 |
| 15 | [`useState` 与更新队列](./docs/react-design/15-useState与更新队列.md) | 待写 |
| 16 | [`useEffect` 与 `useLayoutEffect`](./docs/react-design/16-useEffect与useLayoutEffect.md) | 待写 |

---

## 第五篇：调度与优先级

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 17 | [Scheduler 与时间切片](./docs/react-design/17-Scheduler与时间切片.md) | 已写 |
| 18 | [最小 Lane：SyncLane 与 DefaultLane](./docs/react-design/18-最小Lane.md) | 已写 |

---

## 第六篇：宿主环境

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 19 | [HostConfig 抽象](./docs/react-design/19-HostConfig抽象.md) | 待写 |
| 20 | [DOM 属性更新与简易 `onXxx` 事件](./docs/react-design/20-DOM属性与简易事件.md) | 待写 |
| 21 | [`createRoot` / `updateContainer` 入口](./docs/react-design/21-createRoot与updateContainer.md) | 待写 |

---

## 附录

- [附录 A / B / C](./docs/react-design/appendix.md)（面试对照、demo 验证路径、未实现清单）
