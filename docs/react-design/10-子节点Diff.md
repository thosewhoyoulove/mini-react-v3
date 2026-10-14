# 第 10 章：子节点 Diff：key 怎样决定复用与移动

[← 返回总目录](../../React设计与实现.md) · [上一章](./09-beginWork按tag分发.md) · [下一章 →](./11-completeWork.md)

---

点击 reverse 后，新的 children 只是 `[C, B, A]`。框架怎样知道这三个 `<li>` 是原来的节点换了顺序，而不是三个全新节点？答案分两步：先用 key 和 type 认出同一项，再用旧下标判断谁需要移动。

## 本章书签

- [10.1 key 和 type 怎样认出同一个节点](#101-key-和-type-怎样认出同一个节点)
- [10.2 数组为什么先试位置再查 Map](#102-数组为什么先试位置再查-map)
- [10.3 lastPlacedIndex 怎样标记移动](#103-lastplacedindex-怎样标记移动)
- [面试复习](#面试复习)

---

## 10.1 key 和 type 怎样认出同一个节点

`reconcileChildren` 的输入和输出是：

```text
旧：current.child → sibling → sibling
新：nextChildren（文本、Element 或数组）
输出：workInProgress.child → sibling → sibling
```

当前父 Fiber 没有 current 时，走 `mountChildFibers(false)`，只建立新链，不记录插入和删除；父 Fiber 有 current 时，走 `reconcileChildFibers(true)`，和旧 child 链比较并打 flags。判断的是 `current == null`，不是 `current.child == null`。

单元素路径沿旧兄弟链找 `key + type` 都相同的 Fiber：

```text
旧：A(key=a) → B(key=b) → C(key=c)
新：B(key=b)
结果：复用 B；A、C 记入父节点的 deletions
```

key 回答「是不是同一项」，type 回答「能不能沿用这一种节点」。`<div key="x">` 变成 `<span key="x">` 时 key 没变，但宿主类型不同，必须新建。匹配成功后，`useFiber` 通过 `createWorkInProgress` 取出另一格 Fiber，并换上新的 props。

单文本更简单：旧链表头也是 HostText 就复用，否则删除旧孩子并新建文本。单节点只有在 update 路径且确实新建时，`placeSingleChild` 才打 `Placement`。

## 10.2 数组为什么先试位置再查 Map

数组 Diff 从左到右分三段执行：

```text
1. 同下标试探：key 对得上就继续
2. 一边先结束：删掉多余旧节点，或创建剩余新节点
3. 两边都还有：剩余旧节点进 Map，再按 key（无 key 时按 index）查找
```

用旧 `[A, B, C]`、新 `[A, C, B]` 走一遍：

```text
下标 0：A 对 A，复用
下标 1：B 对 C，key 不同，停止按位置试探

剩余旧节点：Map { b → B, c → C }
新 C：命中 c，复用并从 Map 删除
新 B：命中 b，复用并从 Map 删除
Map 为空：没有节点需要删除
```

先按位置走，是因为常见更新只改尾部或保持大部分顺序，不需要一开始就建 Map。失配后再把剩余旧节点放进 Map，仍能用稳定 key 找回原 Fiber 和 DOM 身份。

新 children 中的 `null`、`false` 或未知类型会被跳过，因此旧 Fiber 的 `index` 可能出现空洞。源码在第一轮用 `oldFiber.index > newIdx` 处理这种情况，不会把跳号误认为已经消耗了旧节点。

没有 key 时，Map 退化为用 index。尾部追加通常仍可复用；中间插入、删除或倒序时，框架更容易把「同位置」误当成「同一项」，组件状态、焦点或输入内容可能跟着位置走。key 需要在同一层稳定且唯一，但不要求全局唯一。

## 10.3 `lastPlacedIndex` 怎样标记移动

认出同一项后，还要决定 DOM 是否需要移动。`placeChild` 维护：

> `lastPlacedIndex`：已经按新顺序处理过、并可留在原位的旧节点中，最大的旧下标。

继续看 `[A, B, C] → [A, C, B]`：

| 新顺序 | 旧下标 | `lastPlacedIndex` | 结果 |
| --- | ---: | ---: | --- |
| A | 0 | 0 | 留在原位 |
| C | 2 | 2 | 留在原位 |
| B | 1 | 2 | `1 < 2`，打 `Placement` |

B 在旧顺序里位于 C 前面，在新顺序里却位于 C 后面，因此必须移动。`Placement` 只记录「Commit 时重新插入」，Render 不操作 DOM。

整段倒序 `[A, B, C] → [C, B, A]` 时，C 的旧下标 2 先成为锚点；B 和 A 的旧下标都小于 2，因此二者带 `Placement`。稳定 key 保证三个 DOM 可以复用，但不表示倒序只需要一次移动，也不表示算法会求全局最少操作。这是从左到右的 O(n) 启发式。

新建 Fiber 没有 alternate，也会得到 `Placement`。删除则不在被删节点上打标：父 Fiber 保存 `deletions[]` 并带 `ChildDeletion`。第 12 章会把这些标记真正落到宿主树。

## 面试复习

### 一句话结论

子节点 Diff 用 key 和 type 决定复用，用 `lastPlacedIndex` 判断复用节点是否需要移动；所有结果先写在 Fiber 上。

### 常见追问

**没写 key 就完全不能复用吗？**

不是。当前实现会按 index 匹配，但中间插入和重排容易让状态跟错节点。

**key 相同为什么还要比较 type？**

key 只表示同层身份。节点类型不同，宿主实例或组件语义不同，不能沿用。

**数组 Diff 会算出最少移动次数吗？**

不会保证。它以稳定 key 和从左到右扫描为前提，用 O(n) 启发式换取可预测成本。

### 源码入口

- `packages/react-reconciler/src/childFiber.ts`：`ChildReconciler`。
- `packages/react-reconciler/src/childFiber.ts`：`reconcileChildrenArray`。
- `packages/react-reconciler/src/childFiber.ts`：`placeChild`、`placeSingleChild`。
- `tests/run.ts`：keyed Diff 的复用、移动和删除测试。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./09-beginWork按tag分发.md) · [下一章 →](./11-completeWork.md)
