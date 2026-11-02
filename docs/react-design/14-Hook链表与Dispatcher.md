# 第 14 章：Hook 链表与 Dispatcher

[← 返回总目录](../../React设计与实现.md) · [上一章](./13-函数组件的执行时机.md) · [下一章 →](./15-useState与更新队列.md)

上一章已经看到，Hook 靠调用位置找回上一轮的数据。这一章继续看两件事：这些数据在 Fiber 上怎样接成一条链，以及同一句 `useState(0)` 怎样在首次 render 和更新 render 里进入不同的函数。

> 源码入口：`packages/react-reconciler/src/hooks.ts`、`packages/react/src/ReactHooks.ts`、`packages/react/src/ReactCurrentDispatcher.ts`

## 14.1 调用顺序就是 Hook 的身份

```tsx
function Profile() {
  const [name, setName] = useState('Ada');    // 第 1 次 Hook 调用
  const inputRef = useRef(null);              // 第 2 次 Hook 调用
  useEffect(() => console.log(name), [name]); // 第 3 次 Hook 调用
  return <input ref={inputRef} value={name} />;
}
```

组件执行时，`name` 和 `inputRef` 只是局部变量。Fiber 保存的是按调用次序接起来的单向链表：

```text
fiber.memoizedState
        │
        ▼
      Hook0 ──next──► Hook1 ──next──► Hook2 ──next──► null
      useState       useRef           useEffect
```

下一次执行 `Profile`，第一次 Hook 调用读取旧链第一格，第二次读取第二格。`useState`、`useRef`、`useEffect` 共用这一条链，没有单独的 state 链或 effect 链。第 13 章里条件调用会错位，原因就在这里：链表只知道第几格，不会按 Hook 的名字再搜一遍。

每一格都有 `memoizedState`、`queue`、`baseQueue` 和 `next`。不同 Hook 使用这些字段的方式不同：

- `useState` 把当前状态放在 `memoizedState`，用 `queue` 接收之后的 `setState`。
- `useRef` 把 `{ current }` 放在 `memoizedState`。更新时返回的仍是这个对象，这次传入的初始值被忽略，所以你后来写进 `current` 的值还在。
- `useMemo` 保存 `[计算结果, deps]`，`useCallback` 保存 `[函数, deps]`。
- `useEffect` 和 `useLayoutEffect` 也各占一格，`memoizedState` 是 `{ tag, create, destroy, deps }`。

`useContext` 不占这种格子。它经过 Dispatcher 进入 `readContext`，不调用 `mountWorkInProgressHook` 或 `updateWorkInProgressHook`。读到的 `{ context, memoizedValue }` 接到 `fiber.dependencies` 上，bailout 之前用它和现在的 `_currentValue` 比较。每次 `renderWithHooks` 开始时，这份依赖会清空，执行过程中再重新收集。

Effect 的提交也走这条 Hook 链。Commit 从 `memoizedState` 逐格向后，看到带 `create`、`deps`、`tag` 的格子才当作 effect，再用 tag 上的位区分 Layout 和 Passive。官方 React 还会把 effect 另外串到函数组件的 effect 队列里。两边都有 Hook 链，内部结构并不相同。

## 14.2 mount 新建链，update 对齐旧链

首次 render 没有旧链。组件每调用一次会占格子的 Hook，`mountWorkInProgressHook` 就新建一格并接到链尾：

```text
第一次调用：fiber.memoizedState = Hook0
第二次调用：Hook0.next = Hook1
第三次调用：Hook1.next = Hook2
```

`workInProgressHook` 始终指向刚接好的那一格。下一次调用直接写它的 `next`，不必从链表头再走一遍，所以每次挂接都是固定的几步。接好之后，`mountState`、`mountRef` 或 `mountEffect` 才往格子里填数据。链表操作决定「这是第几格」，具体 Hook 决定「这一格存什么」。

`mountState` 如果收到函数形式的初始值，只在这一次调用它，结果写入 `memoizedState`。同时创建 `queue`，`dispatch` 闭包抓住当前 Fiber 和这个 queue。更新时 `updateState` 不再看初始值参数，改去处理队列里的 action。队列怎样重放，下一章再讲。

更新 render 为本轮重新连接 Hook 节点，避免直接覆盖 current 链上的状态结果。`updateWorkInProgressHook` 一边读旧节点，一边给 WIP 做副本。状态队列对象仍会共享；为了让放弃的渲染能够重放更新，队列处理也会保留一份更新记录到 current Hook，下一章再说明这条路径：

```text
current Fiber:  old0 ─► old1 ─► old2
                   │       │       │
                   ▼       ▼       ▼
wip Fiber:      new0 ─► new1 ─► new2
```

三个指针一起动。`currentlyRenderingFiber` 是正在执行的函数组件 WIP。`currentHook` 记着旧链读到哪一格。`workInProgressHook` 记着新链刚接到哪一格。第一次调用从 `currentlyRenderingFiber.alternate.memoizedState` 取旧链表头，后面的调用沿 `currentHook.next` 前进。旧链已经没有下一格，却还在调用 Hook，就抛出 `Rendered more hooks than during the previous render`。

每读到一格，新节点复制 `memoizedState`、`baseQueue` 和 `queue`，`next` 先是 `null`，等后面的 Hook 再接。Hook 节点本身是新的。`useState` 的 `queue` 对象继续复用，所以上一轮那个 `setState` 函数还指向同一个队列，身份可以保持稳定。

`renderWithHooks` 在组件开始前已经把 `workInProgress.memoizedState` 清空，本轮 WIP 链从头构造。render 中断并被放弃时，这条半成品可以跟着 WIP 丢掉。下一次仍从已经提交的 current 链读取。

回到 `Profile`。第一次 `useState` 克隆 `old0`，如果队列里有更新，再算出新的 `name`。`useRef` 克隆 `old1`，取出同一个 `{ current }`。`useEffect` 克隆 `old2`，再比较新旧 deps。组件返回时，新链挂在 WIP Fiber 上，等 commit 之后成为下一轮的 current。

## 14.3 Dispatcher 划定 Hook 的执行边界

应用从 `react` 包调用的 `useState` 不认识 Fiber。公开函数只把参数交给当时的 Dispatcher：

```ts
export function useState(initialState) {
  return resolveDispatcher().useState(initialState);
}
```

`resolveDispatcher` 读 `ReactCurrentDispatcher.current`。这里是 `null`，就抛出第 13 章那个非法调用错误。react 包因此不必反向依赖 reconciler，真正的链表操作留在 `hooks.ts`。

Dispatcher 是一张函数表。首次 render 的表指向 mount 实现，更新时的表指向 update 实现：

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

`renderWithHooks` 先看 `current == null || current.memoizedState == null`。成立就装上 mount 表，否则装上 update 表，然后才执行 `Component(props)`。组件源码里的同一句 `useState(0)`，第一次会新建格子，更新时会读取旧链的对应格子。

```text
renderWithHooks
  → 设置 currentlyRenderingFiber，清空上一轮链表和游标
  → ReactCurrentDispatcher.current = mount 表或 update 表
  → 执行 Component(props)
  → finally 中清空 Dispatcher 和游标
```

清理放在 `finally` 里，组件抛错也会执行。组件外面没有 Dispatcher，也没有正在处理的 Fiber。

Dispatcher 只负责把公开 API 分到本轮的实现。它不选择任务优先级。`setState` 入队之后走哪一档 lane，是调度路径的事。

只调用 `useContext` 的组件没有普通 Hook 链，更新时条件仍然成立，还会选 mount 表。两张表的 `useContext` 都是 `readContext`，结果一样。官方 React 还有重渲染、开发期检查等别的 Dispatcher。这里只有 mount 和 update 两张表。

## 本章回顾

- Fiber 用一条单向 Hook 链保存组件里会占位的 Hook。本轮第 N 次调用对齐旧链第 N 格。
- mount 逐格把新节点接到链尾。update 复制旧节点，状态 Hook 的 `queue` 继续复用，所以 `setState` 的身份可以稳定。
- Dispatcher 让同一个公开 API 在首次 render 和更新 render 中进入不同实现，并把调用限制在组件执行期间。
- `useContext` 也走 Dispatcher，依赖记在 `fiber.dependencies` 上，不占普通 Hook 格。

阅读源码可以围绕 `hooks.ts` 里的 `mountWorkInProgressHook`、`updateWorkInProgressHook`、`renderWithHooks` 和 `readContext`，再回到 `ReactHooks.ts` 看 `resolveDispatcher`。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./13-函数组件的执行时机.md) · [下一章 →](./15-useState与更新队列.md)
