# 第 1 章：声明式 UI 与命令式 DOM 的权衡

[← 返回总目录](../../React设计与实现.md) · [下一章：教学版框架要具备的核心能力 →](./02-教学版框架要具备的核心能力.md)

---

同一份列表，可以在点击回调里手写每一次 DOM 改动，也可以只交出「按当前状态，界面应该长什么样」。本章用 `demos/hello-dom` 里的 reverse 把这两条路走完。Fiber、Diff、调度先不展开；它们是后面用来付这一章账单的。

## 本章书签

- [1.1 命令式：每次点击都要自己把数据和 DOM 对齐](#11-命令式：每次点击都要自己把数据和-dom-对齐)
- [1.2 声明式：业务只交出下一份描述](#12-声明式：业务只交出下一份描述)
- [1.3 省下来的步骤会变成框架的账单](#13-省下来的步骤会变成框架的账单)
- [面试复习](#面试复习)

---

## 1.1 命令式：每次点击都要自己把数据和 DOM 对齐

命令式就是逐步告诉浏览器怎么做：找到节点、改文本、插入、清空。浏览器原生 API 全是这一套。

下面这段不是仓库里的文件。它把 hello-dom 的列表实验改写成纯 DOM，用来看痛点长在哪。列表一开始是 `A`、`B`、`C`。

```js
const countEl = document.querySelector('.count');
const listEl = document.querySelector('ul');
let count = 0;
let items = ['A', 'B', 'C'];

document.querySelector('.plus').onclick = () => {
  count += 1;
  countEl.textContent = 'count: ' + count;
};

document.querySelector('.add').onclick = () => {
  const item = 'item-' + items.length;
  items = items.concat(item);
  const li = document.createElement('li');
  li.textContent = item;
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

能跑。reverse 一写，问题就具体了：

1. **两套真相。** `items` 在 JS 里一份，`<li>` 在文档里又一份。reverse 里如果忘了 `innerHTML = ''`，数组已经倒过来，屏幕还是旧顺序。
2. **同一种「列表变了」，三条路径。** `+1` 改文本，`add` 只 append，`reverse` 清空再建。再加「删第一项」「改某一项文案」，每种交互都要新写一段 DOM 步骤。
3. **reverse 用清空换正确，把节点身份一起倒掉。** `innerHTML = ''` 会拆掉现有 `<li>`。某一项里如果有输入框，焦点和已经输入的文字一起没了。想留下原来的节点，就得自己记「`A` 对应哪个 DOM」，再算它该插到谁前面。这正是第 10 章要收进框架的事；在命令式里，它堆在按钮回调里。
4. **读代码时要模拟过程。** 看这个 onclick，要想的是会执行哪几条 DOM API，而不是点完以后列表是 `C B A`。

页面只有三个按钮时还能对得上。状态一交叉，漏同步就变成主要的 bug。

## 1.2 声明式：业务只交出下一份描述

声明式换一个问题：根据当前状态，界面现在应该长什么样。回调里不写「相对上一帧是 insert 还是 remove」。

仓库里对应的是 `ListDemo`（`demos/hello-dom/src/main.ts`）。下面只留状态、倒序按钮和列表，标题与断点提示省掉：

```js
function ListDemo() {
  const [items, setItems] = useState(['A', 'B', 'C']);

  return createElement(
    'section',
    { className: 'card' },
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

同一文件里的 `StateDemo` 是更小的同一形状：`count` 放在 `useState` 里，`+1` 只调用 `setCount((value) => value + 1)`，返回值里写 `'count: ' + count`。没有 `querySelector`，也没有 `textContent`。

函数的返回值是一棵 **ReactElement**，普通对象，还不是 DOM。`createElement` 怎么造这棵对象，第 4 章再拆。本章先把分工看清：

```text
items = ['C', 'B', 'A']          按钮只改这一份数据
        │
        ▼
ReactElement 树                  ListDemo 再次执行后的返回值
        │
        ▼
框架算出哪些 <li> 留下、移动、删除
        │
        ▼
真实 DOM
```

reverse 只把数组倒过来。下一次 `ListDemo` 按新数组再描述一遍。`<li>` 是移动还是拆掉重建，业务代码里没有答案；`key: item` 是交给后面调和器用的身份。第 10 章会看到，稳定的 `key` 让 `A` 还是原来那个 `A`。这里只要记住：声明式把「怎么改 DOM」从按钮里拿了出去，框架必须在别处把它做对。

页面入口在 `main.ts` 末尾，仍然很短：

```ts
createRoot(container).render(createElement(App, null));
```

`App` 把 `StateDemo`、`ListDemo` 等卡片拼在一起。第一次画到屏幕上，走的是 `render`；之后点 reverse，走的是 `setItems`。两条入口，同一种「交出下一份描述」。

## 1.3 省下来的步骤会变成框架的账单

声明式没有取消 DOM 操作，只是把它们从业务回调挪到框架里。相对「我知道这次只改一个 `textContent`」，每次更新至少多做三件事：再执行组件函数、得到一棵新的描述、再决定哪些真实节点要动。

| | 命令式回调 | 声明式组件 |
| --- | --- | --- |
| 作者要写对的事 | 这次点击的 DOM 步骤 | 当前状态对应的界面 |
| 漏一步的后果 | 数据和屏幕分叉，而且每种交互漏法不同 | 描述错了，这次更新就按错误描述走 |
| 性能上限 | 可以精确到一次 DOM 调用 | 取决于框架会不会把「描述变了」做成「DOM 全拆掉」 |
| 放弃的控制 | 没有 | 默认不再手写插入点；测量、焦点、媒体控制仍要自己做 |

「用了框架就会变慢」说得太满，「虚拟 DOM 一定更快」也不成立。精确改一次文本，常数成本更低。声明式先换来的是：倒序、追加、删除走同一条更新路径，不会在第三个按钮里偷偷 `innerHTML = ''`。它能不能接近手写 DOM 的成本，取决于后面几章做不做这三件事：复用已有节点、算到一半时不改屏幕、大树不要一次占满主线程。

命令式 API 还在。`document.createElement`、`appendChild` 会出现在 `packages/react-dom` 的宿主实现里，调用方从业务变成提交阶段。这些 API 仍然要会，只是不再散落在每个按钮上。

本章收到这里：应用代码保留「界面是什么」，框架接过「怎样改到那一步」。下一章看，如果框架用最省事的办法接——清空容器，再按描述重建——会立刻坏在哪三件事上。

## 面试复习

### 一句话结论

声明式把易漏的 DOM 同步从每个事件回调里拿出来，收成一条「状态 → 描述 → 更新 DOM」的路径。DOM API 还在，调用方换了。

### 面试回答

以列表倒序为例。命令式要自己把数组 reverse，再清空 `<ul>` 重建 `<li>`，清空会丢掉节点上的焦点和输入。声明式里 reverse 只调用 `setItems`，组件再返回一棵带 `key` 的元素描述，框架比较前后两份描述，决定移动还是新建。本仓库的 `ListDemo` 就是这样写的。真正碰到 `document` 的代码在 `react-dom` 的宿主实现里，不在按钮里。代价是每次更新都要重新描述界面。值不值，取决于更新路径是不是已经多到人会对不齐，而不是声明式的单次开销更小。

### 常见追问

**1. 声明式一定更快吗？**

不一定。手写一次 `textContent` 更便宜。它先解决的是多种交互下数据和屏幕分叉。快不快，要看后面的 Diff 和调度有没有把多余的 DOM 操作省掉。

**2. 为什么列表还要 `key`？**

描述只说下一帧有哪些项，不说「这一项是上一帧的哪一项」。`key` 补上这个身份。没有它，倒序很容易被当成每个位置的文本都变了。

**3. 业务代码还能碰 DOM 吗？**

能。焦点、测量、改 `document.title` 这类事，描述树覆盖不了。hello-dom 的 Effect 实验就直接改了标题。区别是普通的列表增删改，不再每人写一套同步步骤。

### 容易说错

- React 仍然操作 DOM。发生在提交阶段，经宿主实现调用。
- 组件函数又执行一次，不等于对应 DOM 全部拆掉重建。复用与否要等调和结果。
- 「虚拟 DOM 更快」不是这一章的结论。这一章的结论是更新路径统一了。

### 源码入口

- `demos/hello-dom/src/main.ts`：`ListDemo` 的 reverse，以及文件末尾的 `createRoot().render`。
- `packages/react/src/ReactElement.ts`：描述对象的工厂，第 4 章再拆。
- `packages/react-dom/src/hostConfig.ts`：DOM API 的实际调用点。

---

[← 返回总目录](../../React设计与实现.md) · [下一章：教学版框架要具备的核心能力 →](./02-教学版框架要具备的核心能力.md)
