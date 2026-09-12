# 第 10 章：子节点 Diff：单节点与列表 key

[← 返回总目录](../../React设计与实现.md) · [上一章](./09-beginWork按tag分发.md) · [下一章 →](./11-completeWork.md)

> 主文件：`packages/react-reconciler/src/childFiber.ts`
> `beginWork` 调 `reconcileChildren`；本章讲「新 children 怎么对成一条 Fiber sibling 链表，副作用只打 flags」。

声明式更新的核心成本，不在「再跑一遍组件函数」，而在「新旧两棵描述怎么对齐」。本章对着 `childFiber.ts`，把单节点与列表两条路径讲透：谁复用、谁新建、谁删除、列表里何时打 `Placement`（移动）。

## 本章书签

- [10.1 mount 与 update](#101-mount-与-update)
- [10.2 单文本 / 单元素](#102-单文本--单元素)
- [10.3 数组子节点](#103-数组子节点)
- [10.4 `lastPlacedIndex`](#104-lastplacedindex)
- [面试复习](#面试复习)

---

## 10.1 mount 与 update

`beginWork` 得到本节点的新 children（文本、单个 Element、或数组）之后，并不自己建链表，而是交给 `reconcileChildren`：

```ts
// packages/react-reconciler/src/childFiber.ts
export function reconcileChildren(
  current: Fiber | null,
  workInProgress: Fiber,
  nextChildren: unknown,
): void {
  if (current == null) {
    workInProgress.child = mountChildFibers(
      workInProgress,
      null,
      nextChildren,
    );
  } else {
    workInProgress.child = reconcileChildFibers(
      workInProgress,
      current.child,
      nextChildren,
    );
  }
}
```

对比的是两条链，产出第三条：

```text
旧：current.child → sibling → sibling → null
新：nextChildren（element / 文本 / 数组）
产出：wip.child → sibling → sibling → null
```

Render 阶段**不碰 DOM**。Diff 只在 Fiber 上打两类副作用：

| flag | 含义 |
| --- | --- |
| `Placement` | 新节点要插入，或列表里相对前移（移动） |
| `ChildDeletion` | 父节点 `deletions[]` 里记下要摘掉的旧孩子 |

真正的 `appendChild` / `removeChild` 留到 Commit（第 12 章）。

### 同一套逻辑，两套闭包

`mountChildFibers` 与 `reconcileChildFibers` 不是两份拷贝，而是同一个工厂 `ChildReconciler(shouldTrackSideEffects)`：

```ts
export const reconcileChildFibers = ChildReconciler(true);
export const mountChildFibers = ChildReconciler(false);
```

| | `mountChildFibers`（false） | `reconcileChildFibers`（true） |
| --- | --- | --- |
| 何时 | 当前正在处理的 Fiber 没有 current | 当前正在处理的 Fiber 已有 current |
| 旧孩子 | 传 `null` | `current.child` |
| 副作用 | **不打** Placement / deletions | 要打，Commit 才能改对 DOM |
| 为什么 | 这是刚新建 Fiber 的后代，可随宿主子树一起组装 | 必须精确记下「插 / 移 / 删」 |

`deleteChild`、`placeChild`、`placeSingleChild` 里都先看 `shouldTrackSideEffects`：mount 路径直接 return，避免无意义的删除记录，也避免新建子树内部每个后代都各打一遍插入标记。

### 首次 HostRoot 是关键例外

`reconcileChildren` 判断的是 `current == null`，不是 `current.child == null`。首次 `root.render` 时，HostRoot WIP 是由 current HostRoot 经 `createWorkInProgress` 产生的，因此 HostRoot 有 current：

```text
HostRoot：current != null，current.child == null
  → reconcileChildFibers(true)
  → 新建 App，并给 App 打 Placement

App：current == null
  → mountChildFibers(false)
  → 新建 App 的后代，不逐个打 Placement
```

所以 `mountChildFibers` 不能简单等同于「整个首次渲染」。它描述的是：**当前这个父 Fiber 本身也是新建的，没有旧 Fiber 可对照**。

总入口 `reconcileChildFibers`（工厂返回的那个函数）按**新 children 的形态**分派：

```text
string / number  → reconcileSingleTextNode  → placeSingleChild
ReactElement     → reconcileSingleElement   → placeSingleChild
array            → reconcileChildrenArray   （内部用 placeChild）
null / false …   → 旧孩子全删，返回 null
```

下面两节分别讲单节点与数组。

---

## 10.2 单文本 / 单元素

「能不能复用」看两样：**key** 与 **type**。key 对不上就不认是同一个人；key 对上了还要 type 相同（`div` 不能复用成 `span`，文本 Fiber 不能复用成元素）。

### 单文本：`reconcileSingleTextNode`

新 children 是字符串或数字时：

1. 旧链表头是 `HostText` → **复用**这一格，`pendingProps` 换成新字符串；它后面的兄弟一律多余，`deleteRemainingChildren`。
2. 否则（没有旧孩子，或头不是文本）→ 旧的**整段删除**，再 `createFiberFromText`。

```text
旧：'hello' → <span>多余</span>
新：'world'
→ 复用文本 Fiber，删掉 span
```

单节点路径最后走 `placeSingleChild`：只有**新建**（`alternate == null`）且在 update 路径上，才打 `Placement`。复用的文本已经在 DOM 上，不需要再插。

### 单元素：`reconcileSingleElement`

新 children 是单个 ReactElement 时，从旧链表头开始扫：

1. 取出新元素的 `key`。
2. **key 与 type 都对上** → 复用，删掉它后面的兄弟。
3. **key 对上但 type 变了** → 从当前起整段删除，break 去新建（同一个 key 不能同时对应两个 type）。
4. **key 对不上** → 当前这个记删除，继续往后找。
5. 整条链都没找到 → `createFiberFromElement`。

```text
旧：A(key=a) → B(key=b) → C(key=c)
新：单个 B(key=b)
→ 路过 A 记删除；命中 B 复用；C 及以后 deleteRemainingChildren
```

注意：单元素路径是「沿旧链表找可复用的那一个」，不是按下标一对一。列表场景（多个兄弟）要走下一节的数组路径，否则移动、插入会算错。

### 为何 key + type 成对出现

- 只比 type、不比 key：列表里两个 `<li>` 会糊成「同位置复用」，中间插入一项时大量节点被错误更新。
- 只比 key、不比 type：`<div key="x">` 变成 `<span key="x">` 时，DOM 标签对不上，必须拆掉重建。

本仓库的 `updateElement` 在「调用方已经用 key 对过位」之后，只再看 `current.type === element.type`。

---

## 10.3 数组子节点

新 children 是数组时走 `reconcileChildrenArray`。一边 Diff，一边把新 Fiber 接到 `previousNewFiber.sibling` 上，最后返回链表头。

可以记成**三轮**：

```text
第 1 轮：按下标对齐（updateSlot）
        同一位置 key 对得上就复用，对不上 break

第 2 轮：某一边先走完
        新列表更短 → 多出来的旧节点全删
        旧列表更短 → 多出来的新节点全新建

第 3 轮：两边都还有
        剩余旧节点进 Map，按 key（或 index）匹配
        Map 里最后剩下的 → 删
```

### 第 1 轮：`updateSlot` 试探「同位置」

对每个 `newIdx`，拿当前位置的旧 Fiber 和新 child 比：

- 新的是**文本**：旧节点若带 key，对不上（文本没有 key）；否则走 `updateTextNode`。
- 新的是**元素**：`newChild.key` 必须等于旧节点的 key，才 `updateElement`。
- 返回 `null` **不是**「这个新节点不要了」，而是告诉外层：**下标对齐已经失效，break 出去改走 Map**。

常见触发 break 的例子：旧 `[A, B, C]`，新 `[A, C, B]`——下标 1 处旧是 B、新是 C，key 不同，`updateSlot` 返回 null，结束第 1 轮。

### 第 2 轮：一边耗尽

- `newIdx === newChildren.length`：新列表走完，旧链表上剩下的全部 `deleteRemainingChildren`。
- `oldFiber == null`：旧链表走完，后面每个新 child `createChild` + `placeChild`（纯新增）。

### 第 3 轮：Map 按 key 找人

`mapRemainingChildren` 把还没匹配的旧孩子放进 `Map`：

- 有 `key` → 用 key 做键；
- 没有 → 用 `index` 做键（和 React 约定一致：没写 key 就按下标认人）。

然后对每个剩余的新 child 调 `updateFromMap`：用新节点的 key（或下标）到 Map 里取旧 Fiber，再交给 `updateTextNode` / `updateElement` 看 type。

复用成功时要从 Map 里 `delete` 掉，避免收尾时当成「没人要的旧节点」删掉。Map 里最后还在的，全部 `deleteChild`。

```text
旧：[A, B, C]（key 分别为 a,b,c）
新：[A, C, B]

第 1 轮：对齐 A；下一格 B≠C，break
第 3 轮：Map{b→B, c→C}
        新 C → 命中 c，复用
        新 B → 命中 b，复用
        Map 空，无删除
```

这就是「列表 reverse 尽量移动而不是重建」的来源：稳定 key 让 Map 能对上同一个人，DOM 节点跟着 Fiber 复用；是否**移动**由下一节的 `lastPlacedIndex` 决定。

### 没有 key 会怎样

没写 key 时，Map 用 index。倒序或中间插入时，大量「同下标不同内容」被当成同一个人去 `updateElement`，轻则错复用 props，重则焦点、内部状态错位。教学 demo 里列表用 `key: item`，就是为了把「认人」和「位置」拆开。

---

## 10.4 `lastPlacedIndex`

数组路径不用 `placeSingleChild`，而用 `placeChild`。它干两件事：给新链表写 `index`，以及判断**复用节点要不要打 `Placement`（相对前移）**。

核心变量：

> `lastPlacedIndex` = 已经「就地留下」的旧节点里，**最大的 old index**。

规则（update 路径）：

1. 给 `newFiber.index = newIndex`。
2. 有 `current`（复用）：
   - `oldIndex < lastPlacedIndex` → 相对已经放过的节点**前移**，打 `Placement`，`lastPlacedIndex` 不变；
   - 否则相对位置没乱，**就地留下**，`lastPlacedIndex = oldIndex`。
3. 没有 `current`（新建）→ 打 `Placement`，`lastPlacedIndex` 不变。
4. mount 路径不打 Placement，`lastPlacedIndex` 原样返回。首次 HostRoot 不是这条路径；它新建的首个应用 Fiber仍会打 `Placement`。

### 例子：旧 `[A, B, C]` → 新 `[A, C, B]`

| 步骤 | 操作 | oldIndex | lastPlacedIndex | Placement？ |
| --- | --- | --- | --- | --- |
| 放 A | 复用 | 0 | 0 → 更新为 0 | 否（就地） |
| 放 C | 复用 | 2 | 2 ≥ 0 → 更新为 2 | 否（就地） |
| 放 B | 复用 | 1 | 1 < 2 | **是**（挪到 C 后面） |

直观理解：已经按新顺序「确认过位置」的旧节点里，最靠右的那个下标是 2（C）。B 的旧下标是 1，比 2 小，说明在旧链表里 B 本来在 C **前面**，现在却要排到 C **后面**，所以必须移动。

再看「整段倒序」`[A, B, C]` → `[C, B, A]`：

| 步骤 | oldIndex | lastPlacedIndex | Placement？ |
| --- | --- | --- | --- |
| 放 C | 2 | 0 → 2 | 否 |
| 放 B | 1 | 1 < 2 | 是 |
| 放 A | 0 | 0 < 2 | 是 |

C 就地留下当锚点；B、A 相对它都要前移，打 Placement。Commit 阶段按 flags 做插入/移动即可，不必把三个 DOM 全拆再建。

### 和单节点 Placement 的差别

| | `placeSingleChild` | `placeChild` |
| --- | --- | --- |
| 场景 | 单个文本 / 单个元素 | 数组里的每一个 |
| 何时 Placement | 仅新建（无 alternate） | 新建，**或**复用但 `oldIndex < lastPlacedIndex` |
| 要不要编号 | 不维护列表 index 语义 | 写入 `fiber.index`，供下次 Diff 与移动判断 |

---

## 小结

1. **Diff 发生在 Render**：对成 wip 的 child 链表，只打 `Placement` / `ChildDeletion`，不改 DOM。
2. **mount / update 同一套算法**：`ChildReconciler(false/true)`，差别只在是否跟踪副作用；分叉条件是当前 Fiber 有无 current。
3. **单节点**：沿旧链找 **key + type**；命中则复用并删掉其余。
4. **数组**：先按下标试探，对不上再 **Map(key|index)**；剩余旧节点删除。
5. **`lastPlacedIndex`**：决定复用节点是「就地留下」还是「相对前移」；这是列表移动的最小信息。

写业务时记住一句：**稳定的 key 负责认人，Diff 负责算位置。** 下一章 `completeWork` 会在这棵打好 flags 的树上创建宿主实例，并把副作用向上冒泡，供 Commit 扫一遍落地。

---

## 面试复习

### 一句话结论

子节点 Diff 用 key 和 type 决定复用，用 `lastPlacedIndex` 决定移动，并通过 `ChildReconciler(false/true)` 控制是否记录副作用。

### 面试回答（可口述，为什么→机制→仓库落点→官方差异）

为什么需要子节点 Diff：声明式更新只给新 children，React 必须把它和旧 sibling 链对齐，才能复用状态与 DOM。机制上，单节点按 key + type 查找；数组先按位置试探，失配后把剩余旧节点放进 Map，再用 key 或 index 匹配；新建和相对前移打 `Placement`，删除记到父 Fiber。仓库落点是 `childFiber.ts`。教学版保留了核心启发式，但没有 Fragment、Portal、迭代器、开发态 key 警告等官方分支。

### 常见追问

**Q：为什么 key 相同还要比较 type？**
A：key 只标识列表身份；`div` 变成 `span` 时宿主实例类型不同，不能复用。

**Q：`lastPlacedIndex` 判断的是绝对位置吗？**
A：不是。它记录已确认可就地保留节点中的最大旧下标，用来判断后续复用节点是否发生相对移动。

**Q：首次渲染是否完全没有 `Placement`？**
A：否。首次 HostRoot 有 current，根层走 `reconcileChildFibers`，新建的首个应用 Fiber会打 `Placement`；其新建后代才走不跟踪副作用的 mount 路径。

### 容易说错

- 错：没写 key 就无法复用。对：会退化为按 index 匹配，但插入、重排容易状态错位。
- 错：数组 Diff 做全局最优移动。对：这是 O(n) 启发式，以稳定 key 和从左到右扫描为前提。
- 错：mount/update 由 `current.child` 是否为空决定。对：由当前 Fiber 的 `current` 是否为空决定。

### 源码入口

- `packages/react-reconciler/src/childFiber.ts`：`ChildReconciler`
- `packages/react-reconciler/src/childFiber.ts`：`reconcileChildrenArray`
- `packages/react-reconciler/src/childFiber.ts`：`placeChild`、`placeSingleChild`
- `packages/react-reconciler/src/beginWork.ts`：`reconcileChildren` 的调用点

[← 返回总目录](../../React设计与实现.md) · [上一章](./09-beginWork按tag分发.md) · [下一章 →](./11-completeWork.md)
