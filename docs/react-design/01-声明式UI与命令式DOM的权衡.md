# 第 1 章：声明式 UI 与命令式 DOM 的权衡

[← 返回总目录](../../React设计与实现.md) · [下一章：教学版框架要具备的核心能力 →](./02-教学版框架要具备的核心能力.md)

---

前端框架要解决的，往往不是「能不能改 DOM」，而是「状态变了之后，DOM 该怎么跟着变，而且别写乱」。本章用同一类需求，对比命令式与声明式两条路，并说明教学版 React 站在哪一侧、代价是什么。

## 本章书签

- [1.1 命令式操作 DOM 的痛点](#11-命令式操作-dom-的痛点)
- [1.2 声明式：用数据描述界面，把「怎么改 DOM」交给框架](#12-声明式用数据描述界面把怎么改-dom交给框架)
- [1.3 性能、心智负担与可控性之间的取舍](#13-性能心智负担与可控性之间的取舍)

---

## 1.1 命令式操作 DOM 的痛点

命令式的意思是：你逐步告诉浏览器**怎么做**——找到节点、改文本、插子节点、绑事件。浏览器原生 API 全是这一套。

假设页面上有一个计数和一串列表，要点按钮加一、追加一项、或把列表倒序。纯命令式大致是这样：

```js
const countEl = document.querySelector('.count');
const listEl = document.querySelector('ul');
let count = 0;
let items = ['Fiber', 'Diff', 'Hooks'];

document.querySelector('.plus').onclick = () => {
  count += 1;
  countEl.textContent = 'count: ' + count;
};

document.querySelector('.add').onclick = () => {
  items = items.concat('item-' + items.length);
  const li = document.createElement('li');
  li.textContent = items[items.length - 1];
  listEl.appendChild(li);
};

document.querySelector('.reverse').onclick = () => {
  items = items.slice().reverse();
  listEl.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    listEl.appendChild(li);
  }
};
```

这段代码能跑，但有几处很快会疼：

1. **状态与 DOM 两套真相。** `count` / `items` 在 JS 里一份，屏幕上又一份。每次改状态都要手写「同步到 DOM」的步骤；漏一步，界面就和数据对不上。
2. **更新路径随交互分裂。** `+1` 只改文本，`add` 只 append，`reverse` 却清空再建。同一种「列表变了」，三种写法；需求再多一点（删除中间项、改某一项文案），分支会继续膨胀。
3. **复用与移动难写对。** reverse 用 `innerHTML = ''` 最省事，但会拆掉已有 DOM、丢掉焦点和内部状态。若要「尽量移动已有节点」，就得自己维护 key、找旧节点、算插入位置——这正是后面 Diff 章要解决的问题，命令式里全堆在业务代码里。
4. **心智负担在「过程」。** 读代码时要想的是「这次点击会执行哪几条 DOM API」，而不是「点完之后界面应该长什么样」。

小页面还能扛；组件一多、状态交叉一多，命令式同步就会变成主要的 bug 来源。

## 1.2 声明式：用数据描述界面，把「怎么改 DOM」交给框架

声明式换了一种问法：你只描述**现在应该长什么样**（由当前状态推导出的 UI 树），不写「相对上一帧该 insert 还是 remove」。框架负责对比前后两次描述，再去改 DOM。

用本仓库 demo 里同款需求，声明式写法是（见 `demos/hello-dom/src/main.ts`）：

```js
function App() {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState(['Fiber', 'Diff', 'Hooks']);

  return createElement(
    'div',
    { className: 'app' },
    createElement('p', null, 'count: ' + count),
    createElement('button', { onClick: () => setCount((v) => v + 1) }, '+1'),
    createElement(
      'button',
      { onClick: () => setItems((list) => list.concat('item-' + list.length)) },
      'add',
    ),
    createElement(
      'button',
      { onClick: () => setItems((list) => list.slice().reverse()) },
      'reverse',
    ),
    createElement(
      'ul',
      null,
      ...items.map((item) => createElement('li', { key: item }, item)),
    ),
  );
}
```

注意几点：

- **没有** `querySelector`、`appendChild`、`innerHTML`。函数的返回值是一棵 **ReactElement 树**（数据），不是已经挂好的 DOM。
- 三个按钮都只改状态：`setCount` / `setItems`。下一次渲染时，`App` 再跑一遍，根据**新的** `count`、`items` 重新描述整棵子树。
- 「列表倒序时节点是移动还是重建」不写在业务里，而由调和器按 `key` + `type` 去算（第 10 章）。业务侧只保证：同一项用稳定的 `key`。

可以把关系写成：

```text
状态 (count, items)
    │
    ▼
UI 描述 (ReactElement 树)     ← 你写的是这一层
    │
    ▼
框架：Diff + 打 flags + Commit
    │
    ▼
真实 DOM
```

从第 4 章起会看到：`createElement` 造的是带 `$$typeof` 的普通对象；真正碰 `document` 发生在 Commit。声明式并不是「不用 DOM」，而是**把 DOM 操作收进框架的固定管线**，让应用代码只关心状态到视图的映射。

## 1.3 性能、心智负担与可控性之间的取舍

声明式不是免费的。框架至少多做三件事：维护组件树 / Fiber、对比新旧描述、再批量改 DOM。相对「我精确知道只改这一个 `textContent`」，多了一层间接。

常见取舍可以摊开看：

| 维度 | 命令式 | 声明式（React 这类） |
| --- | --- | --- |
| 心智负担 | 每次更新要想清 DOM 步骤 | 想清「状态 → UI」；更新细节交给框架 |
| 正确性 | 易漏同步、易出现半更新 | 同一套 reconcile / commit，路径统一 |
| 性能上限 | 可以精确到单次 DOM 操作 | 依赖 Diff 与批更新；写不好会多渲染 |
| 可控性 | 每一步都手控 | 默认放弃细粒度 DOM 操控；特殊需求要靠 escape hatch |

几点澄清，避免把「声明式」神化：

1. **声明式也可以很快。** 慢通常不是因为「用了框架」，而是描述变了却做了不必要的子树重算，或列表没有稳定 `key` 导致大量误删误建。本仓库的 keyed Diff、双缓冲、时间切片，都是在声明式前提下把成本压回去。
2. **命令式并没有消失。** HostConfig 里照样 `createElement`、`appendChild`、改属性；只是调用方从业务变成了 reconciler 的 commit 阶段。学原理时，命令式 DOM 知识仍然有用，只是出场位置变了。
3. **教学版站在「可讲清」一侧。** mini-react 刻意走完整的「描述 → 调和 → 提交」路径，而不是在业务里手写最小 DOM 补丁。这样后面讲 Fiber、flags、Hooks 时，有一条统一故事线；代价是实现量和运行时开销都大于「几十行直接操作 DOM 的 demo」。

第 1 章的结论可以收成一句话：**声明式把「界面是什么」留给应用，把「怎么改到那一步」留给框架；框架的设计，就是在心智负担、正确性与性能之间做可持续的权衡。** 下一章会具体说：为了撑住这条路径，教学版至少要具备可中断更新、双缓冲、宿主无关这几块能力。

---

[← 返回总目录](../../React设计与实现.md) · [下一章：教学版框架要具备的核心能力 →](./02-教学版框架要具备的核心能力.md)
