# 第 1 章：声明式 UI 与命令式 DOM 的权衡

[← 返回总目录](../../React设计与实现.md) · [下一章：教学版框架要具备的核心能力 →](./02-教学版框架要具备的核心能力.md)

---

把列表从 `A、B、C` 倒过来，最直接的写法是修改数组，再逐步操作 DOM。可是在 `demos/hello-dom` 中，按钮只调用 `setItems`，没有告诉浏览器该移动哪个 `<li>`。少写的那些步骤去了哪里？先把两种写法放在一起看，才能理解声明式 UI 解决了什么，又把什么工作交给了框架。

## 1.1 命令式：每次点击都要自己把数据和 DOM 对齐

命令式代码逐步告诉浏览器怎么做：找到节点、清空内容、创建元素，再把元素插进去。下面不是项目源码，而是把 demo 的 reverse 改写成一段最小的原生 DOM 代码。假设页面已经有一个 `<ul>` 和一个 `.reverse` 按钮：

```js
const listEl = document.querySelector('ul');
let items = ['A', 'B', 'C'];

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

点击后，数组和页面都会变成 `C、B、A`。问题不在结果，而在应用同时维护了两份相同的信息：JS 里的 `items` 和文档里的 `<li>`。如果忘记清空或重建 DOM，数组已经更新，屏幕仍会停在旧顺序。

清空后重建虽然容易写对，却丢掉了原来的节点。假如列表项里有输入框，焦点和用户刚输入的内容也会随旧节点一起消失。若想保住节点，就要记录 `A` 对应哪个 DOM，再计算它应该移动到谁前面。追加、删除和倒序各有不同的操作步骤，交互越多，这些同步过程越容易散落在事件回调里。

## 1.2 声明式：业务只交出下一份描述

声明式写法换了一个问题：不再描述「这次怎样改」，而是回答「按照当前数据，界面应该是什么样」。`demos/hello-dom/src/main.ts` 里的 `ListDemo` 就采用这种写法。删去标题和调试提示后，主干如下：

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

点击 reverse 时，回调只生成倒序后的数组。组件再次执行，再根据新数组返回一组 `<li>` 描述。这里既没有 `querySelector`，也没有决定调用 `insertBefore` 还是 `appendChild`。

函数返回的是由 React Element 组成的描述树；这些元素仍是普通 JavaScript 对象，并非真实 DOM。数据、描述与页面之间的关系可以简化成：

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

`key: item` 给每一项提供稳定身份。框架比较前后两次描述时，才有机会认出新的第一项 `C` 就是原来的 `C`，并尽量移动已有节点，而不是把每个位置都当成全新内容。业务代码不必写移动算法，但框架必须补上这部分工作。

页面入口也延续同一种分工：

```ts
createRoot(container).render(createElement(App, null));
```

`App` 负责拼出首屏描述，`render` 把它交给根。之后点击 reverse，从 `setItems` 发起更新。入口不同，应用提供的仍是一份「现在应该显示什么」的描述。

## 1.3 省下来的步骤会变成框架的账单

声明式没有取消 DOM 操作，只把它们从各个业务回调集中到了框架内部。一次更新通常需要重新执行相关组件、得到新描述，再判断哪些真实节点应该保留、移动、修改或删除。最后仍然要由宿主实现调用 `document.createElement`、`appendChild` 等浏览器 API。

| | 命令式回调 | 声明式组件 |
| --- | --- | --- |
| 作者要写对的事 | 这次点击的 DOM 步骤 | 当前状态对应的界面 |
| 容易出错的位置 | 每种交互各自维护数据与 DOM 的同步 | 组件返回的描述是否正确 |
| 单次更新的成本 | 可以直接执行已知的最小 DOM 操作 | 还要生成描述并完成比较 |

所以「虚拟 DOM 一定更快」并不成立。已经知道只需修改一段文本时，手写一次 `textContent` 的成本更低。声明式首先换来的是统一更新路径：倒序、追加和删除都先改变状态，再由同一套机制把页面更新到目标结果。

它也不会禁止业务代码接触 DOM。焦点、尺寸测量、媒体控制和 `document.title` 都属于描述树之外的命令式操作，demo 的 Effect 实验就直接修改了标题。适合声明的部分交给组件，必须精确控制的外部操作仍可在合适的阶段执行。

## 本章回顾

- 命令式代码直接描述 DOM 操作，简单更新很精确，但数据和页面需要由每条交互路径分别保持同步。
- 声明式组件根据状态返回界面描述；列表项的稳定 `key` 帮助框架在两次描述之间识别同一项。
- DOM API 并未消失。框架集中承担比较与提交工作，换来统一的更新路径，也增加了生成和比较描述的成本。

---

[← 返回总目录](../../React设计与实现.md) · [下一章：教学版框架要具备的核心能力 →](./02-教学版框架要具备的核心能力.md)
