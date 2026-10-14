# React 设计与实现

基于本仓库 **mini-react** 的教学讲稿。体例模仿《Vue.js 设计与实现》：按「篇 → 章 → 节」展开，对着源码讲清「为什么这样设计、代码里怎么落地」。

本文件保留完整总目录，同时提供学习入口和面试短路径。每章正文从[第 1 章](./docs/react-design/01-声明式UI与命令式DOM的权衡.md)起独立成文；内容严格对齐仓库**已实现**路径，教学实现与官方 React 的差异、未实现能力见[附录](./docs/react-design/appendix.md)。

## 前置知识

开始前只需要具备这些基础：

- 能读 TypeScript、ES Module 和位运算；知道闭包、链表、Map、微任务与宏任务。
- 理解 JSX 最终会编译成函数调用，DOM 节点的创建、插入、更新是不同动作。
- 用过函数组件、`useState`、`useEffect`、`useLayoutEffect` 和列表 `key`。
- 不要求先读过官方 React 源码。本书先用教学版建立主干，再在附录标出差异，避免把简化实现误当成官方细节。

## 两条读法

### 系统学习

按原总目录从第 1 章读到第 21 章：先建立声明式 UI、包边界和 Element，再依次进入 Fiber、Render / Commit、Diff、Hooks、Scheduler / Lane 与 HostConfig。每读完一篇，用 [`demos/hello-dom`](https://github.com/thosewhoyoulove/mini-react-v3/tree/main/demos/hello-dom) 对照一次真实交互；最后用[附录的讲解路线](./docs/react-design/appendix.md#三档讲解路线)复述。

### 面试速查

先背 [`INTERVIEW.md`](./INTERVIEW.md) 的 3 分钟主线，再按薄弱主题进入下方短路径；需要源码文件定位、术语或“教学版 vs 官方”边界时查[附录](./docs/react-design/appendix.md)。

## 面试主题短路径

- **JSX**：[第 4 章 ReactElement](./docs/react-design/04-ReactElement与createElement.md) → [第 5 章 JSX / runtime / `$$typeof`](./docs/react-design/05-JSX与jsx-runtime与typeof.md)
- **Fiber**：[第 6 章链表与双缓冲](./docs/react-design/06-Fiber链表与双缓冲.md) → [第 7 章 Flags](./docs/react-design/07-副作用标记Flags.md)
- **Render / Commit**：[第 8 章工作循环](./docs/react-design/08-工作循环.md) → [第 9 章 `beginWork`](./docs/react-design/09-beginWork按tag分发.md) → [第 11 章 `completeWork`](./docs/react-design/11-completeWork.md) → [第 12 章 Commit](./docs/react-design/12-Commit三阶段.md)
- **Diff**：[第 10 章单节点与 keyed 列表](./docs/react-design/10-子节点Diff.md)
- **Hooks**：[第 13 章函数组件](./docs/react-design/13-函数组件的执行时机.md) → [第 14 章 Hook 链表](./docs/react-design/14-Hook链表与Dispatcher.md) → [第 15 章 `useState`](./docs/react-design/15-useState与更新队列.md) → [第 16 章两种 Effect](./docs/react-design/16-useEffect与useLayoutEffect.md)
- **Scheduler / Lane**：[第 17 章时间切片](./docs/react-design/17-Scheduler与时间切片.md) → [第 18 章两档 Lane](./docs/react-design/18-最小Lane.md)
- **HostConfig**：[第 19 章宿主抽象](./docs/react-design/19-HostConfig抽象.md) → [第 20 章 DOM 实现](./docs/react-design/20-DOM属性与简易事件.md) → [第 21 章根入口](./docs/react-design/21-createRoot与updateContainer.md)

```text
React设计与实现.md          ← 你在这里（总目录）
docs/react-design/
  01-….md … 21-….md         ← 各章正文
  appendix.md                  ← 附录
```

---

## 第一篇：框架设计概览

用同一份列表看清声明式省掉了什么、又欠下什么。这三章停在问题和包边界：不提前罗列 Fiber 字段，也不把调度细节写成清单。

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 1 | [声明式 UI 与命令式 DOM 的权衡](./docs/react-design/01-声明式UI与命令式DOM的权衡.md) | 已写 |
| 2 | [教学版框架要具备的核心能力](./docs/react-design/02-教学版框架要具备的核心能力.md) | 已写 |
| 3 | [mini-react 包结构与依赖方向](./docs/react-design/03-mini-react包结构与依赖方向.md) | 已写 |

---

## 第二篇：描述 UI

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 4 | [ReactElement 与 `createElement`](./docs/react-design/04-ReactElement与createElement.md) | 已写 |
| 5 | [JSX、`jsx-runtime` 与 `$$typeof`](./docs/react-design/05-JSX与jsx-runtime与typeof.md) | 已写 |

---

## 第三篇：渲染器

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 6 | [Fiber 链表与双缓冲](./docs/react-design/06-Fiber链表与双缓冲.md) | 已写 |
| 7 | [副作用标记 Flags](./docs/react-design/07-副作用标记Flags.md) | 已写 |
| 8 | [工作循环：向下 begin、向上 complete](./docs/react-design/08-工作循环.md) | 已写 |
| 9 | [`beginWork` 按 tag 分发](./docs/react-design/09-beginWork按tag分发.md) | 已写 |
| 10 | [子节点 Diff：单节点与列表 key](./docs/react-design/10-子节点Diff.md) | 已写 |
| 11 | [`completeWork` 创建实例与冒泡 flags](./docs/react-design/11-completeWork.md) | 已写 |
| 12 | [Commit：Mutation / Layout / Passive](./docs/react-design/12-Commit三阶段.md) | 已写 |

---

## 第四篇：组件化与 Hooks

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 13 | [函数组件的执行时机](./docs/react-design/13-函数组件的执行时机.md) | 已写 |
| 14 | [Hook 链表与 mount / update 两套 Dispatcher](./docs/react-design/14-Hook链表与Dispatcher.md) | 已写 |
| 15 | [`useState` 与更新队列](./docs/react-design/15-useState与更新队列.md) | 已写 |
| 16 | [`useEffect` 与 `useLayoutEffect`](./docs/react-design/16-useEffect与useLayoutEffect.md) | 已写 |

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
| 19 | [HostConfig 抽象](./docs/react-design/19-HostConfig抽象.md) | 已写 |
| 20 | [DOM 属性更新与简易 `onXxx` 事件](./docs/react-design/20-DOM属性与简易事件.md) | 已写 |
| 21 | [`createRoot` / `updateContainer` 入口](./docs/react-design/21-createRoot与updateContainer.md) | 已写 |

---

## 附录

- [复习附录](./docs/react-design/appendix.md)（三档讲解路线、术语与源码索引、面试映射、demo 验证、官方差异与未实现清单）
