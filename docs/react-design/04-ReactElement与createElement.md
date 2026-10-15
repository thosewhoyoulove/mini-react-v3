# 第 4 章：ReactElement 与 `createElement`

[← 返回总目录](../../React设计与实现.md) · [上一章](./03-mini-react包结构与依赖方向.md) · [下一章 →](./05-JSX与jsx-runtime与typeof.md)

---

第 3 章停在 `createElement(App, null)`：为什么这一行既不执行 `App`，也不创建 DOM？因为它只返回一份描述。本章用 `ListDemo` 里最小的一次调用拆开这份对象，看每一格交给谁。Fiber 要到第 6 章才出现。

## 4.1 一次调用得到的对象

`demos/hello-dom/src/main.ts` 的列表项是这样写的：

```js
createElement('li', { key: item }, item);
```

`item` 为 `'A'` 时，返回值是：

```js
{
  $$typeof: Symbol.for('react.element'),
  type: 'li',
  key: 'A',
  ref: null,
  props: { children: 'A' },
}
```

返回值只有这五个字段。它不是 `HTMLLIElement`，也没有记录「插到谁前面」。调和进行到 `completeWork` 时，宿主实现才创建尚未挂载的 DOM；Commit 阶段随后把它插入文档。

同一页的按钮也会变成同样的对象，只是 `props` 多了事件：

```js
createElement(
  'button',
  { onClick: () => setItems((list) => list.slice().reverse()) },
  'reverse',
);
```

```js
{
  $$typeof: Symbol.for('react.element'),
  type: 'button',
  key: null,
  ref: null,
  props: { onClick: fn, children: 'reverse' },
}
```

把 `type` 换成函数，对象形状仍然不变。`createElement(App, null)` 只是把函数 `App` 放进 `type`，再给出一个空的 `props`。后面的工作循环处理这个元素时才会调用 `App`。

这份结构定义在 `packages/shared/src/ReactTypes.ts`。`react` 负责创建它，调和器负责读取它，因此类型放在 `shared`，不必让两个包为了声明互相依赖：

```ts
export interface ReactElement {
  $$typeof: symbol | number;
  type: Type;
  key: Key;
  ref: Ref;
  props: Props;
}
```

`$$typeof` 的类型允许 `symbol | number`，实际创建元素时只会写入 `Symbol.for('react.element')`，没有数字回退。它相当于元素的运行时标记，第 5 章会解释为什么使用 Symbol。

## 4.2 `createElement` 如何整理参数

回到开头的调用，`{ key: item }` 为什么没有原样成为 `props`？答案在 `packages/react/src/ReactElement.ts`：

```ts
export function createElement(
  type: Type,
  config: Props | null,
  ...children: unknown[]
): ReactElement {
  let key: Key = null;
  let ref: Ref = null;
  const props: Props = {};

  if (config != null) {
    if (hasValidKey(config)) {
      key = '' + config.key; // 1
    }
    if (hasValidRef(config)) {
      ref = config.ref; // 1
    }
    for (const propName in config) {
      if (
        Object.prototype.hasOwnProperty.call(config, propName) &&
        propName !== 'key' &&
        propName !== 'ref'
      ) {
        props[propName] = config[propName]; // 2
      }
    }
  }

  const childrenLength = children.length;
  if (childrenLength === 1) {
    props.children = children[0]; // 3
  } else if (childrenLength > 1) {
    props.children = children; // 3
  }

  return {
    $$typeof: REACT_ELEMENT_TYPE,
    type,
    key,
    ref,
    props,
  }; // 4
}
```

函数先从 `config` 取出 `key` 和 `ref`。判断条件是值不等于 `undefined`，所以 `key={0}` 和 `key=""` 都是有效 key，其中 `0` 会转成字符串 `'0'`；漏写或显式传入 `undefined` 才会保留 `null`。`ref` 使用相同的有效性判断，但不会转成字符串。

接着，它把 `config` 的其余自有字段复制到一个新的 `props`。调用方传入的对象不会被修改，`key` 和 `ref` 也不会混进组件收到的参数。

剩余参数决定 `children` 的形态。只有一个孩子时直接保存原值，`'A'` 仍是字符串；两个或更多孩子才组成数组；没有孩子时，`props` 上连 `children` 字段都没有。最后，函数把整理好的五个字段放进一个普通对象并返回，调和器此时还没有开始工作。

把规则代回列表容器，就能直接看出两个 `li` 会组成数组：

```js
createElement(
  'ul',
  null,
  createElement('li', { key: 'A' }, 'A'),
  createElement('li', { key: 'B' }, 'B'),
);
```

外层 `ul` 的 `props.children` 长度为 2；每个 `li` 的孩子仍是单个字符串。调和器之后会据此选择单节点或列表路径，第 10 章再展开这处分支。

这里有一个容易产生误解的边界：五字段结构是本仓库实际返回的结果。官方 React 的开发构建还可能保存 owner、源码位置和调试信息，并执行额外检查。

## 4.3 这些字段后来交给谁

这五个字段会沿着不同路径继续流动：

| 字段 | 这一格记什么 | 后面谁读 |
| --- | --- | --- |
| `$$typeof` | 这份对象是 ReactElement | 调和孩子时先校验，不靠构造函数 |
| `type` | 字符串标签，或组件函数 | 决定建成哪一种 Fiber |
| `key` | 同层里的哪一项 | 和 `type` 一起判断复用还是新建 |
| `ref` | 提交完成后要写入的引用 | Layout 阶段写到实例或 Fiber |
| `props` | 属性、事件、孩子 | 函数组件的参数；宿主节点的属性和子描述 |

`key` 与 `props` 分开，首先是因为读者不同。调和器用 `element.key` 判断「这一项是否还是上一轮那个 `A`」；组件函数只接收业务输入。这样，组件不会把用于同层匹配的 key 当作自己的普通属性。

`ref` 也不是需要画到界面上的数据。`createElement` 执行时，对应的 DOM 通常还不存在，所以元素只保存这个引用。等 DOM 准备好后，`commitAttachRef` 才会写入对象 ref 的 `current`，或调用函数 ref。`useRef()` 返回的是 Hook 保存的稳定对象；把它传给 `ref` 后，元素记录的正是这个对象。

函数组件和宿主标签在元素层没有两套结构。`beginWork` 读到函数类型才调用组件，读到 `'li'` 才按宿主标签处理。在此之前，它们都只是可供读取的描述。

JSX 会走另一条创建入口。虽然 `jsx()` 的参数位置不同，返回的仍是这五个字段。

## 本章回顾

`createElement` 把 `type`、配置和孩子整理成 ReactElement。它不调用组件，也不创建 DOM。`key` 标识同层位置，`ref` 留给提交阶段，普通属性和孩子进入 `props`；单个孩子保持原值，多个孩子才组成数组。

源码可从 `packages/react/src/ReactElement.ts` 和 `packages/shared/src/ReactTypes.ts` 开始，再沿着 `createFiberFromElement`、`commitAttachRef` 查看这些字段如何被消费。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./03-mini-react包结构与依赖方向.md) · [下一章 →](./05-JSX与jsx-runtime与typeof.md)
