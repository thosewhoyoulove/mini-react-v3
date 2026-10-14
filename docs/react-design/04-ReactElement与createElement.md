# 第 4 章：ReactElement 与 `createElement`

[← 返回总目录](../../React设计与实现.md) · [上一章](./03-mini-react包结构与依赖方向.md) · [下一章 →](./05-JSX与jsx-runtime与typeof.md)

---

第 3 章停在 `createElement(App, null)`：为什么这一行既不执行 `App`，也不创建 DOM？因为它只返回一份描述。本章用 `ListDemo` 里最小的一次调用拆开这份对象，看每一格交给谁。Fiber 要到第 6 章才出现。

## 本章书签

- [4.1 一次调用得到的对象](#41-一次调用得到的对象)
- [4.2 createElement 做的四件事](#42-createelement-做的四件事)
- [4.3 这些字段后来交给谁](#43-这些字段后来交给谁)
- [面试复习](#面试复习)

---

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

五格就这些。没有 `HTMLLIElement`，也没有「插到谁前面」这种步骤。本仓库处理到 `completeWork` 时才由宿主实现创建尚未挂载的 DOM；Commit 再把它插入文档。

同一页上的按钮是同一种对象，只是 `props` 里多了事件：

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

`type` 换成函数时，对象形状不变。`createElement(App, null)` 的 `type` 就是 `App` 这个函数，`props` 是空对象。`App` 要等后面的工作循环调用，不在 `createElement` 这一行执行。

类型定义在 `packages/shared/src/ReactTypes.ts`，`react` 和调和器共用这一份，避免两个包为了同一个声明互相依赖：

```ts
export interface ReactElement {
  $$typeof: symbol | number;
  type: Type;
  key: Key;
  ref: Ref;
  props: Props;
}
```

类型声明允许 `symbol | number`，但本仓库只创建 `Symbol.for('react.element')`，没有数字形式的回退路径。为什么这里选择 Symbol，下一章再说。现在先把它当成「这是一份合法描述」的标记。

## 4.2 createElement 做的四件事

实现在 `packages/react/src/ReactElement.ts`。函数只做四步：拆出 `key` / `ref`，复制其余字段，收孩子，返回带标记的对象。

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

1. **`key` 和 `ref` 从 config 里搬出去。** `hasValidKey` 只判断 `config.key !== undefined`。所以 `key={0}` 和 `key=""` 都算显式传入，`0` 会变成字符串 `'0'`。漏写 `key` 时字段保持 `null`，和传入 `undefined` 是同一结果。`ref` 用同一条规则，原样保存，不转成字符串。
2. **其余自有字段复制进新的 `props`。** 复制是为了不改调用方传入的那个对象。`key` 和 `ref` 在循环里被跳过，所以它们不会再从 `props` 里读到。
3. **第三个参数及以后收成 `children`。** 一个孩子直接放进去，上面的 `'A'` 就是字符串，不再套一层数组。两个及以上才收成数组，顺序与参数顺序相同。一个孩子都没有时，`props` 上没有 `children` 这一格。
4. **返回描述对象。** 到这一行，工作结束。调和器之后才读它。

用这个规则看列表容器。两个孩子会变成数组：

```js
createElement(
  'ul',
  null,
  createElement('li', { key: 'A' }, 'A'),
  createElement('li', { key: 'B' }, 'B'),
);
```

`props.children` 是长度为 2 的数组。每个 `li` 自己的 `props.children` 仍是字符串 `'A'` 或 `'B'`。孩子的形态后面会决定调和走单节点还是列表，第 10 章再分叉。本章只要能从一次调用推出 `children` 是单值还是数组。

这里讲的是本仓库的 `createElement`。官方 React 在开发构建中还可能保存 owner、源码位置或调试信息，也会做额外告警；不要把这五格当成所有 React 版本的完整内部对象。

## 4.3 这些字段后来交给谁

五格的分工可以收成一张表。现在看不懂「谁用」那一列里的函数名也没关系，它们是后文的入口：

| 字段 | 这一格记什么 | 后面谁读 |
| --- | --- | --- |
| `$$typeof` | 这份对象是 ReactElement | 调和孩子时先校验，不靠构造函数 |
| `type` | 字符串标签，或组件函数 | 决定建成哪一种 Fiber |
| `key` | 同层里的哪一项 | 和 `type` 一起判断复用还是新建 |
| `ref` | 提交完成后要写入的引用 | Layout 阶段写到实例或 Fiber |
| `props` | 属性、事件、孩子 | 函数组件的参数；宿主节点的属性和子描述 |

`key` 必须离开 `props`，因为这两边的读者不同。调和器比较的是「这一项还是不是上一轮那个 `A`」，读的是 `element.key`。组件函数如果能读到 `props.key`，业务代码会把它当成自己的输入，下一次渲染又和调和器各看各的。拆开之后，组件参数里没有 `key`。

`ref` 离开 `props` 是同一原因：它不是画在界面上的数据。`createElement` 执行时，对应的 DOM 通常还不存在，所以这里只把引用存下来。提交阶段 DOM 已经准备好，再写 `ref.current`，或调用函数形式的 ref。`useRef()` 返回的 `{ current }` 是 Hook 里那个稳定对象；把它放进 `ref={...}` 时，元素上保存的就是这个对象。两条路径在本章先分开记，写入发生在 `packages/react-reconciler/src/commitWork.ts` 的 `commitAttachRef`。

函数组件和宿主标签在这一层长得一样。`beginWork` 看到 `type` 是函数，才会去调用它；看到 `'li'`，才会把它当成要创建的标签。调用时机在第 9 章和第 13 章。在那之前，两种元素都只是描述。

下一章补另一条入口。打包器把 JSX 编成 `jsx()`，参数位置和 `createElement` 不同，产出的对象相同。

## 面试复习

### 一句话结论

`createElement` 把一次 UI 描述收成普通对象：`type` 是种类，`key` 是同层身份，`props` 是输入和孩子。它不创建 DOM，也不执行组件函数。

### 面试回答

以 `createElement('li', { key: 'A' }, 'A')` 为例。返回值里 `key` 是字符串 `'A'`，`props` 只有 `children: 'A'`。`key` 和 `ref` 被拆出去，是因为它们交给调和器和提交阶段，不交给组件当参数。一个孩子保持原值，多个孩子才收成数组，后面据此选择单节点还是列表调和。`$$typeof` 用来认出这个对象。组件函数要等工作循环按 `type` 调用；宿主节点在 `completeWork` 创建，Commit 才把它挂进文档。

### 常见追问

**1. 为什么不在 `createElement` 里直接创建 DOM？**

这一行还不知道它是整棵树的哪一个位置，也不知道上一轮有没有可以复用的节点。描述先作为数据留下，调和完再决定创建、移动还是删除。

**2. `key={0}` 和没写 `key` 一样吗？**

不一样。`0 !== undefined`，会变成 `'0'`。没写，或者显式传入 `undefined`，`key` 才是 `null`。

**3. 孩子为什么有时是值，有时是数组？**

一个孩子不再套数组，多个孩子保持调用顺序收成数组。调和器按这个形态分支。

### 容易说错

- ReactElement 是描述对象。Fiber 在调和时另建；本仓库在 `completeWork` 创建离屏 DOM，在 Commit 修改已挂载的文档。
- `key` 不会出现在组件的 `props` 里。本仓库复制属性时会跳过它。
- `createElement(App)` 不会调用 `App`。调用发生在处理函数组件的那一步。

### 源码入口

- `packages/react/src/ReactElement.ts`：四步工厂。
- `packages/shared/src/ReactTypes.ts`：五格字段的类型。
- `packages/react-reconciler/src/fiber.ts`：`createFiberFromElement` 读取 `type` / `key` / `props` / `ref`。
- `packages/react-reconciler/src/commitWork.ts`：`commitAttachRef` 写入 ref。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./03-mini-react包结构与依赖方向.md) · [下一章 →](./05-JSX与jsx-runtime与typeof.md)
