# React 设计与实现

这是一份配合 **mini-react** 源码阅读的教程。它从一个具体问题出发：组件只返回界面描述，框架怎样把它变成 DOM，并在状态变化后更新页面？全书按「篇 → 章 → 节」展开，逐步说明每项设计解决什么问题，以及代码怎样实现。

正文以本仓库的实现为准。Fiber、Hooks 和调度保留了 React 的核心思路，同时也做了教学简化。读者可以先运行例子，再沿源码验证结论；与官方 React 的差异和未实现能力集中列在[附录](./docs/react-design/appendix.md)。各章从[第 1 章](./docs/react-design/01-声明式UI与命令式DOM的权衡.md)起独立成文，下方保留完整目录和主题阅读路径。

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

## 如何对照源码阅读

每章先回答一个能在例子中观察到的问题。阅读时可以按下面的顺序验证：

1. 先预测结果。例如倒序是否保留原来的 `<li>`，连续三次状态更新最后得到多少。
2. 找到正文提到的函数，只追踪与问题有关的输入、指针和返回值。代码片段有时会省去无关分支，需要看完整实现时再打开对应源文件。
3. 区分内存中的计算与已提交的页面变化。组件执行了、Fiber 改了，并不代表 DOM 已经改变。
4. 用 demo 或现有测试核对结论。`pnpm dev` 启动交互示例，`pnpm test` 检查状态、节点复用、Effect 等行为；测试覆盖的范围以 `tests/run.ts` 为准。

章节中的执行顺序均针对这份教学实现。对照官方 React 时，还需要确认版本、根类型和更新场景，尤其是事件、Effect 与优先级的细节。

## 面试主题短路径

- **JSX**：[第 4 章 ReactElement](./docs/react-design/04-ReactElement与createElement.md) → [第 5 章 JSX / runtime / `$$typeof`](./docs/react-design/05-JSX与jsx-runtime与typeof.md)
- **Fiber**：[第 6 章链表与双缓冲](./docs/react-design/06-Fiber链表与双缓冲.md) → [第 7 章 Flags](./docs/react-design/07-副作用标记Flags.md)
- **Render / Commit**：[第 8 章工作循环](./docs/react-design/08-工作循环.md) → [第 9 章 `beginWork`](./docs/react-design/09-beginWork按tag分发.md) → [第 11 章 `completeWork`](./docs/react-design/11-completeWork.md) → [第 12 章 Commit](./docs/react-design/12-Commit三阶段.md)
- **Diff**：[第 10 章单节点与 keyed 列表](./docs/react-design/10-子节点Diff.md)
- **Hooks**：[第 13 章函数组件](./docs/react-design/13-函数组件的执行时机.md) → [第 14 章 Hook 链表](./docs/react-design/14-Hook链表与Dispatcher.md) → [第 15 章 `useState`](./docs/react-design/15-useState与更新队列.md) → [第 16 章两种 Effect](./docs/react-design/16-useEffect与useLayoutEffect.md)
- **Scheduler / Lane**：[第 17 章时间切片](./docs/react-design/17-Scheduler与时间切片.md) → [第 18 章三档 Lane](./docs/react-design/18-最小Lane.md)
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

`createElement` 和 JSX 都只产生普通对象。这一篇把对象的字段走完，并说明运行时怎样认出它是一份合法描述。

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 4 | [ReactElement 与 `createElement`](./docs/react-design/04-ReactElement与createElement.md) | 已写 |
| 5 | [JSX、`jsx-runtime` 与 `$$typeof`](./docs/react-design/05-JSX与jsx-runtime与typeof.md) | 已写 |

---

## 第三篇：渲染器

描述从这里变成可以逐节点处理的工作。第 6 章先解释 Fiber 的父子兄弟关系，以及 current 和 work-in-progress 怎样配对；后面各章再说明工作循环如何向下计算、向上完成，最后把结果提交到 DOM。

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 6 | [Fiber 链表与双缓冲](./docs/react-design/06-Fiber链表与双缓冲.md) | 已写 |
| 7 | [副作用标记 Flags](./docs/react-design/07-副作用标记Flags.md) | 已写 |
| 8 | [工作循环：向下 begin、向上 complete](./docs/react-design/08-工作循环.md) | 已写 |
| 9 | [`beginWork` 怎样得到下一层 children](./docs/react-design/09-beginWork按tag分发.md) | 已写 |
| 10 | [子节点 Diff：key 怎样决定复用与移动](./docs/react-design/10-子节点Diff.md) | 已写 |
| 11 | [`completeWork` 为什么必须自底向上](./docs/react-design/11-completeWork.md) | 已写 |
| 12 | [Commit：把计划变成用户看到的结果](./docs/react-design/12-Commit三阶段.md) | 已写 |

---

## 第四篇：组件化与 Hooks

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 13 | [函数组件什么时候执行](./docs/react-design/13-函数组件的执行时机.md) | 已写 |
| 14 | [Hook 链表与 Dispatcher](./docs/react-design/14-Hook链表与Dispatcher.md) | 已写 |
| 15 | [`useState` 与更新队列](./docs/react-design/15-useState与更新队列.md) | 已写 |
| 16 | [`useEffect` 与 `useLayoutEffect`](./docs/react-design/16-useEffect与useLayoutEffect.md) | 已写 |

---

## 第五篇：调度与优先级

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 17 | [Scheduler 与时间切片](./docs/react-design/17-Scheduler与时间切片.md) | 已写 |
| 18 | [最小 Lane：三档更新怎样排队](./docs/react-design/18-最小Lane.md) | 已写 |

---

## 第六篇：宿主环境

| 章 | 标题 | 状态 |
| --- | --- | --- |
| 19 | [HostConfig：让 reconciler 不认识 `document`](./docs/react-design/19-HostConfig抽象.md) | 已写 |
| 20 | [DOM 属性更新与简易事件](./docs/react-design/20-DOM属性与简易事件.md) | 已写 |
| 21 | [`createRoot` 与 `updateContainer`](./docs/react-design/21-createRoot与updateContainer.md) | 已写 |

---

## 附录

- [复习附录](./docs/react-design/appendix.md)（三档讲解路线、术语与源码索引、面试映射、demo 验证、官方差异与未实现清单）
