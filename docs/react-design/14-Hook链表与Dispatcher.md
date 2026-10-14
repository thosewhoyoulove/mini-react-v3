# 第 14 章：Hook 链表与 Dispatcher

[← 返回总目录](../../React设计与实现.md) · [上一章](./13-函数组件的执行时机.md) · [下一章 →](./15-useState与更新队列.md)

同一个组件每次执行都会重新调用 `useState`，React 又没有让我们给 Hook 写 `key`。那么第二次渲染时，它怎样知道“这次的第一个 `useState`”仍对应上次那份状态，而不会拿到后面 `useRef` 或 `useEffect` 的数据？答案不是变量名，而是稳定的调用顺序、Fiber 上的 Hook 链表，以及渲染期间临时启用的 Dispatcher。

> 源码入口：`packages/react-reconciler/src/hooks.ts`、`packages/react/src/ReactHooks.ts`、`packages/react/src/ReactCurrentDispatcher.ts`

## 本章书签

- [14.1 调用顺序就是 Hook 的身份](#141-调用顺序就是-hook-的身份)
- [14.2 mount 新建链，update 对齐旧链](#142-mount-新建链update-对齐旧链)
- [14.3 Dispatcher 划定 Hook 的执行边界](#143-dispatcher-划定-hook-的执行边界)
- [面试复习](#面试复习)

---

## 14.1 调用顺序就是 Hook 的身份

先看一个最小组件：

```tsx
function Profile() {
  const [name, setName] = useState('Ada'); // 第 1 次 Hook 调用
  const inputRef = useRef(null);            // 第 2 次 Hook 调用
  useEffect(() => console.log(name), [name]); // 第 3 次 Hook 调用
  return <input ref={inputRef} value={name} />;
}
```

源码不会保存 `name`、`inputRef` 这些局部变量名。当前仓库为每个函数组件 Fiber 保存一条单向链表：

```text
fiber.memoizedState
        │
        ▼
      Hook0 ──next──► Hook1 ──next──► Hook2 ──next──► null
      useState       useRef           useEffect
```

因此，Hook 的身份就是“它是本次组件执行中的第几次 Hook 调用”。更新时，第 1 次调用取旧链第 1 格，第 2 次调用取第 2 格，以此类推。Hook 名称不同，也仍按同一顺序混排在一条链中。

这正是 Hook 不能放在条件分支里的原因：

```tsx
function Profile({ editable }) {
  const [name] = useState('Ada'); // 第 1 格
  if (editable) {
    useRef(null);                 // 有时出现的第 2 格
  }
  useEffect(() => {}, []);        // 可能从第 2 格滑到第 3 格
}
```

若 `editable` 从 `true` 变成 `false`，本轮第 2 次调用已变成 `useEffect`，旧链第 2 格却属于 `useRef`。链表没有名称可以补救这种错位。当前仓库会在“本轮调用比上轮多”时抛错，但没有完整检查“本轮调用更少”以及 Hook 类型变化；官方 React 的开发构建还有更完整的顺序校验。无论是否立刻报错，顶层调用规则都不能破坏。

链表中每格都有相同外壳：`memoizedState` 保存该 Hook 的主要数据，`queue` 和 `baseQueue` 服务于状态更新，`next` 指向下一格。不同 Hook 填入的数据不同：

| API | 当前仓库中的存储位置与内容 |
| --- | --- |
| `useState` | 一格普通 Hook；`memoizedState` 是状态值，`queue` 是更新队列 |
| `useReducer` | 一格普通 Hook；状态在 `memoizedState`，action 队列与 reducer 信息在 `queue` |
| `useEffect` | 一格普通 Hook；`memoizedState` 是 `{ tag, create, destroy, deps }` |
| `useLayoutEffect` | 与 `useEffect` 同形，`tag` 标出 Layout 类型 |
| `useRef` | `memoizedState` 保存稳定的 `{ current }` 对象 |
| `useMemo` | `memoizedState` 保存 `[计算结果, deps]` |
| `useCallback` | `memoizedState` 保存 `[函数, deps]` |
| `useContext` | **不占普通 Hook 格**；读取值后把 `{ context, memoizedValue }` 接到 `fiber.dependencies` |

`useContext` 是本仓库里需要特别记住的例外。它也通过 Dispatcher 调用，但 `readContext` 主要登记 Context 依赖，供 bailout 前检查值是否变化；它不会调用 `mountWorkInProgressHook` 或 `updateWorkInProgressHook`。每次 `renderWithHooks` 开始时，wip 的 `dependencies` 会清空并重新收集。

这里也有一处教学简化：当前仓库直接遍历 Hook 链来提交 effect。官方 React 同样有 Hook 链，但 effect 还会组织到函数组件的 effect 队列中，数据结构和开发期检查都更完整。

## 14.2 mount 新建链，update 对齐旧链

首次渲染没有旧 Hook 可读，`mountWorkInProgressHook` 每被调用一次就创建一格：

```text
第一次调用：fiber.memoizedState = Hook0
第二次调用：Hook0.next = Hook1
第三次调用：Hook1.next = Hook2
```

`workInProgressHook` 始终指向刚接好的链尾。具体的 `mountState`、`mountRef`、`mountEffect` 再把状态、ref 或 effect 数据写进返回的这一格。链表负责“这是第几格”，具体 Hook 实现负责“这一格装什么”。

更新渲染不能直接改已提交的 current 树。此时同时存在两条链：

```text
current Fiber:  old0 ─► old1 ─► old2
                   │       │       │
                   ▼       ▼       ▼
wip Fiber:      new0 ─► new1 ─► new2
```

`updateWorkInProgressHook` 用两个游标逐格完成对齐：

- `currentHook` 指向旧链当前读到的格子；
- `workInProgressHook` 指向 wip 新链刚接好的格子；
- `currentlyRenderingFiber` 指向正在执行的函数组件 wip Fiber。

第一次调用从 `currentlyRenderingFiber.alternate.memoizedState` 取得旧链表头，以后沿 `currentHook.next` 前进。每读到一格，就复制其 `memoizedState`、`baseQueue` 和 `queue`，再把副本接到 wip 链尾。Hook 节点是新的，但状态更新使用的 `queue` 对象会复用，所以同一个 `setState` 的函数身份可以跨渲染保持稳定。

`renderWithHooks` 在执行组件之前把 `workInProgress.memoizedState` 置空，表示本轮要从头构造 wip 链，而不是在旧 wip 链上修改。若渲染被打断并放弃，半成品 wip 链也可以一起丢弃；下次仍从已提交的 current 链重新对齐。

对 `Profile` 来说，一轮更新可以读成下面四步：

1. 第 1 次 `useState`：克隆 `old0`，`updateState` 再处理它的队列。
2. 第 2 次 `useRef`：克隆 `old1`，返回其中同一个 ref 对象。
3. 第 3 次 `useEffect`：克隆 `old2`，比较新旧 `deps`。
4. 组件执行结束：新链留在 wip Fiber，等待后续 commit 成为 current。

这套机制只靠位置匹配，不会搜索“哪一格是 `useState`”。顺序稳定不是风格建议，而是数据结构成立的前提。

## 14.3 Dispatcher 划定 Hook 的执行边界

应用调用的 `useState` 并不直接操作 Fiber。`react` 包中的公开 API 只做转发：

```ts
export function useState(initialState) {
  return resolveDispatcher().useState(initialState);
}
```

Dispatcher 可以理解为“当前这段组件执行应使用哪套 Hook 实现”的函数表。当前仓库准备了两套：

```ts
HooksDispatcherOnMount = {
  useState: mountState,
  useRef: mountRef,
  useEffect: mountEffect,
  // ...
};

HooksDispatcherOnUpdate = {
  useState: updateState,
  useRef: updateRef,
  useEffect: updateEffect,
  // ...
};
```

`renderWithHooks` 查看 current 是否已有普通 Hook 链：没有就安装 mount Dispatcher，有就安装 update Dispatcher；随后才调用 `Component(props)`。所以组件里的同一句 `useState(0)`，首次执行会创建链表格，更新时则会克隆并读取对应旧格。

```text
renderWithHooks
  → 设置 currentlyRenderingFiber 与链表游标
  → ReactCurrentDispatcher.current = mount 或 update 表
  → 执行 Component(props)
  → finally 中把 Dispatcher 和游标全部清空
```

`finally` 是边界的关键。即使组件抛错，`ReactCurrentDispatcher.current` 也会恢复为 `null`，避免下一个组件误用残留游标。组件渲染之外调用 Hook 时，没有可用 Dispatcher，也没有“正在渲染的 Fiber”，因此属于非法 Hook 调用。Dispatcher 不是 Scheduler：它不负责决定任务何时运行，只负责把公开 Hook API 分派到当前渲染阶段的实现。

当前仓库以 `current == null || current.memoizedState == null` 判断 mount。只使用 `useContext` 的组件没有普通 Hook 链，后续仍会选 mount 表；这不影响结果，因为两套表的 `useContext` 都指向同一个 `readContext`。官方 React 还有重渲染 Dispatcher、开发期 Dispatcher、render phase update 等分支，不能把这里的两张表当作官方实现的全部。

下一章将进入 `useState` 和 `useReducer` 共用的更新队列：`setState` 为什么只入队，以及这些 action 何时真正变成新状态。

## 面试复习

**一句话：** Hook 没有显式 key，React 用稳定调用顺序把本轮第 N 次调用与旧链第 N 格对齐；Dispatcher 决定这次调用走 mount 还是 update 实现。

**为什么不能在 `if` 中调用 Hook？** 条件变化会改变后续 Hook 的序号，位置身份随之错位；报错只是保护措施，根因是链表按顺序对齐。

**current 和 wip 共用什么？** 当前仓库更新时创建新的 Hook 节点，复制状态字段，并复用状态 Hook 的 `queue`；current 链主要作为已提交的对齐来源。

**`useContext` 在哪？** 它通过 Dispatcher 读取 Context，但不占普通 Hook 格，依赖记录在 `fiber.dependencies`。

**源码入口：**

- `packages/react-reconciler/src/hooks.ts`：`mountWorkInProgressHook`、`updateWorkInProgressHook`
- `packages/react-reconciler/src/hooks.ts`：`renderWithHooks`、`HooksDispatcherOnMount`、`HooksDispatcherOnUpdate`
- `packages/react-reconciler/src/hooks.ts`：`readContext`
- `packages/react/src/ReactHooks.ts`：`resolveDispatcher`

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./13-函数组件的执行时机.md) · [下一章 →](./15-useState与更新队列.md)
