# 第 14 章：Hook 链表与 mount / update 两套 Dispatcher

[← 返回总目录](../../React设计与实现.md) · [上一章](./13-函数组件的执行时机.md) · [下一章 →](./15-useState与更新队列.md)

> 主文件：`packages/react-reconciler/src/hooks.ts`、`packages/react/src/ReactHooks.ts`、`ReactCurrentDispatcher.ts`
> 对外 API 只读 Dispatcher；真正往 Fiber 上接链表的，是 reconciler 里成对的 `mount*` / `update*`。

## 本章书签

- [14.1 Hook 链表挂在哪](#141-hook-链表挂在哪)
- [14.2 游标怎么挪](#142-游标怎么挪)
- [14.3 mount 与 update](#143-mount-与-update)
- [14.4 Dispatcher](#144-dispatcher)
- [面试复习](#面试复习)

---

## 14.1 Hook 链表挂在哪

每个函数组件 Fiber 用 `memoizedState` 挂一条单向链表：

```text
fiber.memoizedState → Hook0 → Hook1 → Hook2 → null
```

一格 Hook 的字段：

| 字段 | 用途 |
| --- | --- |
| `memoizedState` | useState：当前值；useEffect：`Effect` 对象 |
| `queue` | useState 的更新队列（`pending` + `dispatch`） |
| `baseQueue` | 已从 pending 截过来、若 render 被丢掉还能重放的环形队列 |
| `next` | 下一格 Hook |

`useState` 和 `useEffect` / `useLayoutEffect` **混在同一条链上**。effect 靠 `memoizedState` 里是不是带 `create` / `deps` / `tag` 的对象来认，不靠单独一条链表。组件里第几次调用 `useXxx`，就对应第几格。

## 14.2 游标怎么挪

模块级三个指针（组件跑完必须清掉）：

| 指针 | 指向谁 |
| --- | --- |
| `currentlyRenderingFiber` | 正在执行的那个函数组件 wip |
| `workInProgressHook` | wip 链表上刚接好的那一格，下一格接到它的 `next` |
| `currentHook` | current 链表上正在对齐的那一格，下一格从它的 `next` 取 |

首次渲染只有前两个：每调一次 Hook，`mountWorkInProgressHook` 往后 new 一格。

更新时两个游标一起走：`currentHook` 在旧链上对齐，`workInProgressHook` 在新链上接克隆。两棵树各一条链表——current 只读，wip 才是本轮要 commit 的。

## 14.3 mount 与 update

`mountWorkInProgressHook` 四步：

1. new 一个空 Hook（`next` 还是 `null`）。
2. 本组件第一个 → 写成 `fiber.memoizedState`，游标指过去。
3. 已有 Hook → 接到当前游标的 `next`，游标挪到新节点。
4. 返回这一格，给 `mountState` / `mountEffectImpl` 填数据。

`updateWorkInProgressHook` 四步：

1. 取 current 下一格：第一次从 `alternate.memoizedState` 取头，之后走 `currentHook.next`。
2. current 没有下一格 → 抛「Rendered more hooks than during the previous render」。
3. 克隆一格到 wip（复用 `queue`，`next` 先空着），接到 wip 链表尾。
4. 返回克隆，给 `updateState` / `updateEffectImpl` 算新值。

`renderWithHooks` 开头会把 `wip.memoizedState = null` 并清游标：本轮从头建，不在上一轮 wip 链表上打补丁。若 concurrent 被重启，半成品链表直接丢掉，下次从 current 再克隆。

## 14.4 Dispatcher

`packages/react` 里的 `useState` 自己不算状态：

```ts
export function useState(initialState) {
  return resolveDispatcher().useState(initialState);
}
```

`ReactCurrentDispatcher.current` 是一个可替换的对象。reconciler 准备了两套：

```ts
HooksDispatcherOnMount  = { useState: mountState, useEffect: mountEffect, … }
HooksDispatcherOnUpdate = { useState: updateState, useEffect: updateEffect, … }
```

`renderWithHooks` 在调用组件函数之前写入，返回之后置 `null`。这样：

- 应用继续 `import { useState } from 'react'`，和官方用法一致。
- `react` 包不必依赖 reconciler 的实现细节。
- 同一句 `useState(0)`，首次和更新自动走不同函数，调用方无感。

依赖方向（第 3 章）在这里落地：`react-reconciler` 依赖 `react` 只为了取 / 写 Dispatcher；真正的链表逻辑全部留在 `hooks.ts`。

下一章专讲 `useState` 那一格里的环形队列，以及 `setState` 如何标 lane 进工作循环。

## 面试复习

### 一句话结论

Hook 以调用顺序为身份，混排在函数组件 Fiber 的单向链表中；Dispatcher 让同一个公开 API 在首次渲染和更新时分别走 `mount*` 与 `update*`。

### 面试回答（为什么→机制→仓库落点→官方差异）

为什么：Hook API 没有显式 key，需要用稳定调用顺序把本轮调用与上轮状态逐格对齐。机制：mount 新建 Hook 并接到 wip 链尾；update 从 current 链逐格克隆到 wip，复用 queue；`renderWithHooks` 根据 current 是否已有链表选择 Dispatcher。仓库落点：`mountWorkInProgressHook`、`updateWorkInProgressHook` 和两套 `HooksDispatcher` 都在 `hooks.ts`。官方差异：官方 Hook 节点和 Dispatcher 分工相同，但还处理更多 Hook、render phase update、重渲染 Dispatcher 与开发期顺序校验。

### 常见追问

**Q：为什么不能在 `if` 中调用 Hook？**
A：更新按第 N 次调用对齐第 N 格；条件变化会让后续 Hook 错位。本仓库多调用会抛错，少调用还没有完整的官方开发期校验。

**Q：current Hook 会被本轮直接修改吗？**
A：通常作为对齐来源，wip 克隆新 Hook；但 `useState` 合并 pending 时会把 `baseQueue` 写回 current，以便并发 Render 被丢弃后重放。

**Q：为什么 `react` 包不直接实现 `useState`？**
A：公开 API 只从 `ReactCurrentDispatcher.current` 分发，实际 Fiber 链表逻辑留在 reconciler，避免反向依赖。

### 容易说错

- 不要说每种 Hook 各有一条链；本仓库的 state、effect、layout effect 混在同一条链。
- 不要把 Dispatcher 说成调度任务的 Scheduler；它只是 Hook API 的当前实现表。
- 不要说更新复用同一个 Hook 对象；本仓库克隆 Hook，但复用其中的 queue。

### 源码入口

- `packages/react-reconciler/src/hooks.ts`：`mountWorkInProgressHook`
- `packages/react-reconciler/src/hooks.ts`：`updateWorkInProgressHook`
- `packages/react-reconciler/src/hooks.ts`：`renderWithHooks`、`HooksDispatcherOnMount`、`HooksDispatcherOnUpdate`
- `packages/react/src/ReactHooks.ts`：`resolveDispatcher`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./13-函数组件的执行时机.md) · [下一章 →](./15-useState与更新队列.md)
