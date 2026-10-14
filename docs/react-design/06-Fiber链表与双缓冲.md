# 第 6 章：Fiber 链表与双缓冲

[← 返回总目录](../../React设计与实现.md) · [上一章](./05-JSX与jsx-runtime与typeof.md) · [下一章 →](./07-副作用标记Flags.md)

---

第 2 章的 `mount` 要等整棵子树都 `appendChild` 完才能返回，中间没有「下一个节点」可以保存。ReactElement 的孩子嵌在 `props.children` 里，正好是这种树。本章把它改成链表，并准备两格节点：一格对应当前屏幕，一格留给这一轮计算。flags、工作循环的代码留到后面几章，这里先把结构走通。

## 本章书签

- [6.1 描述树为什么停不下来](#61-描述树为什么停不下来)
- [6.2 三条指针怎么走完一棵小树](#62-三条指针怎么走完一棵小树)
- [6.3 同一位置为什么有两格 Fiber](#63-同一位置为什么有两格-fiber)
- [面试复习](#面试复习)

---

## 6.1 描述树为什么停不下来

`packages/react-reconciler/src/fiber.ts` 文件头用了一棵很小的描述：

```js
createElement(
  'div',
  null,
  createElement('h1', null, 'Mini React'),
  createElement('p', null, 'count: 0'),
);
```

作为 ReactElement，它是嵌套对象。`div` 的孩子是数组，`h1` 的孩子是字符串 `'Mini React'`。用递归去走，调用栈要等 `h1` 和它的文本都处理完，才会回到 `div` 再去看 `p`。想在「`h1` 做完了」这个时刻停下来，栈上没有一个变量指向 `p`。

Fiber 把同一层关系写成三根指针：

```text
child    第一个子节点
sibling  下一个兄弟
return   父节点
```

父指针不叫 `parent`，是为了避开 JavaScript 的关键字。没有 `prevSibling`。要找前一个兄弟，只能从父节点的 `child` 再往后数。后面提交时寻找插入位置，也是顺着这条链走。

工作循环每次只拿一个 Fiber。有 `child` 就走向孩子，没有就做完自己，再看 `sibling`，兄弟也没有就沿 `return` 回到父节点。停下来时，只要记住「下一个是谁」。这就是第 2 章说的可暂停：停在节点边界上，而不是停在一次递归的半中间。

## 6.2 三条指针怎么走完一棵小树

这棵描述对应的链表是：

```text
HostRoot
  │ child
  ▼
div
  │ child
  ▼
h1 ──sibling──► p
 │ child          │ child
 ▼                ▼
"Mini React"      "count: 0"
```

`HostRoot` 不来自任何 JSX。`createRoot` 时先放这一格，它的孩子才是 `render` 交进来的那棵描述。从 `div` 出发可以核对三根指针：`child` 是 `h1`，`h1.sibling` 是 `p`，`p.return` 回到 `div`。

按「先孩子，再兄弟，再父节点」走一遍。这一顺序和第 8 章的工作循环相同，现在先当成人手移动的路线：

```text
HostRoot → div → h1 → "Mini React"
完成文本，完成 h1，下一个是 p
p → "count: 0"
完成文本，完成 p，回到 div，再回到 HostRoot
```

假如时间在完成 `"Mini React"` 之后用完，下一个要处理的是 `p`。把这个 Fiber 记下来，下一拍从 `p` 继续。`div` 还没做完，因为它的右兄弟还没走。屏幕上的 DOM 还不动：这条链是内存里的工作结构。

节点用 `tag` 区分种类，数字和官方源码对齐，方便以后对照。第一次读这棵树，认准四个就够：

| tag | 值 | 这棵树上的谁 |
| --- | --- | --- |
| `FunctionComponent` | 0 | `createElement(App, null)` 这种，`type` 是函数 |
| `HostRoot` | 3 | `createRoot` 创建的根，没有对应标签 |
| `HostComponent` | 5 | `'div'`、`'h1'`、`'p'` |
| `HostText` | 6 | `'Mini React'`、`'count: 0'` |

文本不是 ReactElement，不会走 `createFiberFromElement`，而走 `createFiberFromText`。元素则按 `type` 选 tag：函数是 `FunctionComponent`，普通字符串是 `HostComponent`。`Fragment`、`Context.Provider`、`memo`、`forwardRef`、`Suspense` 也各有 tag，由同一个 `tagFromType` 识别。第 9 章按 tag 分发时再展开。认不出的 tag 在 `beginWork` 里当作叶子，返回 `null`。

其余字段先知道放什么，用到时再回来：

| 字段 | 先记住的含义 |
| --- | --- |
| `stateNode` | 宿主节点上的 DOM；`HostRoot` 上是 `FiberRoot`；函数组件这里一般是 `null` |
| `pendingProps` | 这一轮新拿到的 props |
| `memoizedProps` | 上一轮用过的 props |
| `memoizedState` | 函数组件的 Hook 链表头，第 14 章 |
| `flags` | 这个节点待提交的副作用，第 7 章 |

整棵应用还有一个入口不在链表里。`FiberRoot` 的 `containerInfo` 指向页面上的 `#root`，`current` 指向那棵已经提交的 `HostRoot`。`HostRoot.stateNode` 指回这个 `FiberRoot`。从任意 Fiber 沿着 `return` 走到根，就能找到容器。

## 6.3 同一位置为什么有两格 Fiber

第 2 章的约束是：正在算的结构不能就是屏幕上那一棵。Fiber 用 `alternate` 把同一位置的两格连起来：

```text
current.alternate        === workInProgress
workInProgress.alternate === current
```

`current` 对应当前已经提交的界面。`workInProgress` 是这一轮正在写的那一格。比较、打标记、创建还没插进文档的实例，都落在后者。提交成功后，`commitWork.ts` 里执行 `root.current = finishedWork`。刚才算完的那一格变成新的 `current`，原先的 `current` 留到下一轮当新的工作格。

因此一个位置上是两格可以反复使用的 Fiber，不是每点一次按钮就新建一整棵，也不是内存里有两套 DOM。`stateNode` 上的 DOM 节点会跟着被复用的那一格走。

配对的函数是 `createWorkInProgress`。它不负责把整棵树克隆一遍，只处理「当前这一格」：

```ts
export function createWorkInProgress(current: Fiber, pendingProps: any): Fiber {
  let wip = current.alternate;
  if (wip == null) {
    wip = createFiber(current.tag, pendingProps, current.key);
    wip.type = current.type;
    wip.stateNode = current.stateNode;
    wip.alternate = current;
    current.alternate = wip; // 1. 还没有另一格：新建并互相指向
  } else {
    wip.pendingProps = pendingProps;
    wip.flags = NoFlags;
    wip.subtreeFlags = NoFlags;
    wip.deletions = null; // 2. 沿用另一格，清掉上一轮的副作用
  }

  wip.type = current.type;
  wip.child = current.child; // 3. 先沿用 current 的孩子
  wip.memoizedProps = current.memoizedProps;
  wip.memoizedState = current.memoizedState;
  wip.updateQueue = current.updateQueue;
  wip.sibling = current.sibling;
  wip.index = current.index;
  wip.lanes = current.lanes;
  wip.childLanes = current.childLanes;
  wip.ref = current.ref;
  wip.dependencies = current.dependencies;
  wip.return = null; // 3. 还没挂回父节点，接上链表时再写
  return wip;
}
```

两条路径的差别是：

1. **另一格还不存在。** 按 `tag` / `key` 新建，抄上 `type` 和 `stateNode`，两格互相指向。`createContainer` 先放了一个空的 `HostRoot` 作为 `current`。第一次 `render` 时 `prepareFreshStack` 对它调用这个函数，根上的两格就配好了。
2. **另一格已经在。** 不新建。写上这次的 `pendingProps`，把 `flags`、`subtreeFlags`、`deletions` 清掉，避免上一轮的「要插入」「要删除」残留到这一轮。
3. **两条路径最后都从 `current` 抄状态。** `child` 先指向 `current` 的孩子。孩子没变时，这条链可以继续用；变了，调和时再换成新的 `child`。`memoizedState` 先抄过来，函数组件里的 Hook 链表才不会丢。`return` 先写成 `null`，因为这一格还没决定挂到哪个父节点下面。

子节点的出生时间和根不一样。第一次渲染时，`h1`、文本这些 Fiber 由 `createFiberFromElement` / `createFiberFromText` 新建，`alternate` 仍是 `null`。下一次更新再走到它们，才进入上面的第 1 步，配上第二格。之后就一直是这两格交换角色。

半成品停在 `workInProgress` 上。这一轮如果被丢掉，`current` 仍是上次提交的结果，屏幕保持完整。怎样丢掉、从哪一格重新开始，等调度那一篇再看。下一章先看这些节点上的 `flags`：计算阶段为什么只打标记，不直接改 DOM。

## 面试复习

### 一句话结论

Fiber 用 `child` / `sibling` / `return` 把一次递归遍历变成可以在节点之间停下的链表。`alternate` 连接同一位置的两格，让正在计算的那一格和已经显示的那一格分开。

### 面试回答

ReactElement 的孩子嵌在 `props.children` 里。递归走进去之后，必须等子树返回才知道下一个兄弟是谁，所以无法在节点边界暂停。Fiber 把第一个孩子、下一个兄弟和父节点写成指针。做完 `h1` 的文本，下一个可以明确是 `p`。为了暂停时不改屏幕，每个位置保留两格，用 `alternate` 互指。`createWorkInProgress` 第一次新建另一格，之后复用并清掉副作用标记，再从 `current` 抄来孩子和 Hook 状态。提交时把 `root.current` 换成刚算完的那一格。DOM 只有提交过的那一份，函数组件本身也没有对应的 DOM 节点。

### 常见追问

**1. 三根指针怎样代替递归？**

有 `child` 就往下。没有就完成当前节点，有 `sibling` 就横着走，否则沿 `return` 向上。这和函数调用进去、返回、再执行下一句的顺序一致，只是进度写在指针上。

**2. `alternate` 是上一帧的快照吗？**

它是同一位置的另一格工作槽。提交之后两格交换「谁是 current」。下一次更新复用原来的那一格，不是再复制一棵永久留存的树。

**3. 第一帧是不是每个节点都已经有两格？**

不是。`HostRoot` 在 `createRoot` 时就有一格，第一次 render 给它配对。孩子在第一次调和时新建，`alternate` 还是 `null`，下一次更新才配对。

**4. Fiber 和 DOM 一一对应吗？**

宿主标签和文本通常有 `stateNode`。函数组件、Fragment 没有自己的 DOM 节点。`HostRoot` 的 `stateNode` 是 `FiberRoot`，容器在 `FiberRoot.containerInfo`。

### 容易说错

- Fiber 是主线程上的数据结构。它让遍历可以暂停，自己不是一条线程。
- 两格 Fiber 不是两套 DOM。还没提交的修改留在工作格上。
- `current` 和 `workInProgress` 会交换。`alternate` 并不固定指向「旧的那棵」。

### 源码入口

- `packages/react-reconciler/src/fiber.ts`：三根指针、`createWorkInProgress`、`createFiberFromElement`。
- `packages/react-reconciler/src/workLoop.ts`：`prepareFreshStack` 给根配对。
- `packages/react-reconciler/src/commitWork.ts`：`root.current = finishedWork`。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./05-JSX与jsx-runtime与typeof.md) · [下一章 →](./07-副作用标记Flags.md)
