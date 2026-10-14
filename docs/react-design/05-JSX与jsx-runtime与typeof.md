# 第 5 章：JSX、`jsx-runtime` 与 `$$typeof`

[← 返回总目录](../../React设计与实现.md) · [上一章](./04-ReactElement与createElement.md) · [下一章 →](./06-Fiber链表与双缓冲.md)

---

demo 手写 `createElement`，是为了让调用在源码里可见。日常写的 `<li>` 浏览器并不认识。打包器在构建时把它换成函数调用，运行时拿到的仍是第 4 章那个对象。

## 本章书签

- [5.1 JSX 在打包时就被换成函数调用](#51-jsx-在打包时就被换成函数调用)
- [5.2 $$typeof 用来挡住长得像的对象](#52-typeof-用来挡住长得像的对象)
- [5.3 三个导出名共用一份实现](#53-三个导出名共用一份实现)
- [面试复习](#面试复习)

---

## 5.1 JSX 在打包时就被换成函数调用

同一颗按钮，源码里可以写成：

```jsx
<button onClick={onReverse}>reverse</button>
```

编译器有两套常见产物。

classic 要求当前文件能看见 `React.createElement`。孩子从第三个参数开始，和第 4 章的手写调用对齐：

```js
React.createElement('button', { onClick: onReverse }, 'reverse');
```

automatic 是现在的默认。编译器自己写上导入，孩子已经放进 config，文件里不必出现 `React` 这个名字：

```js
import { jsx } from 'react/jsx-runtime';

jsx('button', { onClick: onReverse, children: 'reverse' });
```

列表项上的 `key` 在 automatic 里常常是第三个参数，不放在 config 里：

```js
jsx('li', { children: item }, item);
```

本仓库的 `jsx` 在 `packages/react/src/jsx.ts`。它和 `createElement` 的差别主要是参数放在哪：

| | `createElement` | `jsx` |
| --- | --- | --- |
| 孩子 | 第三个参数及以后 | 已经在 `config.children` |
| `key` | 从 `config.key` 拆出 | 先用第三个参数；没有再利用 `config.key` |
| 谁调用 | 手写，或 classic 编译结果 | automatic 编译结果 |

`maybeKey != null` 时用第三个参数，并转成字符串。否则若 `config.key !== undefined`，再补上。`ref` 仍从 config 搬出。其余字段复制进新的 `props`，`key` 和 `ref` 同样跳过。返回值还是五格：

```ts
return {
  $$typeof: REACT_ELEMENT_TYPE,
  type,
  key,
  ref,
  props,
};
```

调和器因此不用知道描述来自手写还是 JSX。它只读这个对象。

## 5.2 `$$typeof` 用来挡住长得像的对象

识别写在 `packages/react-reconciler/src/childFiber.ts`：

```ts
function isReactElement(value: unknown): value is ReactElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ReactElement).$$typeof === REACT_ELEMENT_TYPE
  );
}
```

标记本身是：

```ts
export const REACT_ELEMENT_TYPE = Symbol.for('react.element');
```

用 Symbol，是为了挡住一种伪装。接口或服务端若返回这样的 JSON：

```json
{
  "type": "script",
  "props": { "dangerouslySetInnerHTML": { "__html": "..." } }
}
```

`JSON.parse` 之后它像一份元素：有 `type`，有 `props`。JSON 表达不了 Symbol。解析结果没有 `$$typeof`。就算有人写成 `"$$typeof": "react.element"`，那也是字符串，和 `Symbol.for('react.element')` 不相等。`isReactElement` 会拒绝它，调和器不会按元素去创建节点。

`Symbol.for` 按名字到全局表里取同一个 Symbol。`react` 包创建元素、调和器再来检查时，哪怕它们是两份加载进来的代码，名字相同就对得上。`Symbol()` 每次都会造出一个新值，合法元素也会被拒掉。

这只封住「把不可信的普通对象当成元素」这一条。文本怎么转义、URL 和事件能不能执行，要靠宿主实现和业务数据各自把关。本仓库没有 `dangerouslySetInnerHTML`，上面的 JSON 不会真的变成脚本；字段仍按这个规则检查，读官方源码时对得上。

## 5.3 三个导出名共用一份实现

`packages/react/package.json` 把两条约口都指到 `jsx.ts`：

```text
react/jsx-runtime      生产构建使用的 jsx、jsxs
react/jsx-dev-runtime  开发构建使用的 jsxDEV
```

编译器按孩子数量选名字。静态子节点一个或零个时调用 `jsx`，两个及以上调用 `jsxs`。开发构建调用 `jsxDEV`，官方会多带上文件名和行号。

本仓库三个名字是同一个函数：

```ts
export const jsxs = jsx;
export const jsxDEV = jsx;
```

没有静态孩子的特殊优化，也不保存源码位置。打包器无论选哪个名字，得到的元素形状都和 `createElement` 一致。

到这里，描述层可以收成两句。JSX 是构建阶段的写法，运行时只剩函数调用。一份对象要被当成元素，靠的是 `$$typeof` 这个 Symbol，不是「字段看起来像」。

下一章离开描述。调和器要把嵌套对象改成可以在节点之间停下的链表。

## 面试复习

### 一句话结论

JSX 在构建时变成 `createElement` 或 `jsx`。两条路返回同一种对象，`$$typeof` 上的 Symbol 用来拒绝长得像元素的普通数据。

### 面试回答

浏览器不能执行 `<button>`。classic 编译成 `createElement`，孩子在第三个参数；automatic 编译成 `jsx`，孩子已经在 config 里，`key` 常常单独作为第三个参数。调和器只检查 `$$typeof === Symbol.for('react.element')`。JSON 无法携带 Symbol，所以一段看起来有 `type` 和 `props` 的响应数据不会被当成元素。本仓库的 `jsx`、`jsxs`、`jsxDEV` 是同一个函数，区别留在编译器选择哪个名字。

### 常见追问

**1. automatic runtime 改变了调和过程吗？**

没有。它改变的是编译产物的函数名和参数位置。进入调和器之前，对象已经是同一种 ReactElement。

**2. 为什么用 `Symbol.for`，不用 `Symbol()`？**

`Symbol.for` 按字符串取出全局表里的同一个值，创建元素的包和检查元素的包对得上。`Symbol()` 每次都是新值。

**3. 有了 `$$typeof` 就不会有 XSS 吗？**

它拒绝的是把不可信对象误认成元素。文本、链接和事件里的不可信内容，还要在各自的写入点处理。

### 容易说错

- JSX 在构建阶段变成函数调用。浏览器运行时看到的是调用结果，不是尖括号模板。
- `typeof element` 对这个对象得到 `"object"`。元素种类看 `element.$$typeof` 和 `element.type`。
- `Symbol.for` 的全局表属于当前这个 JS agent。不要把它说成跨进程、跨 Worker 也共享。

### 源码入口

- `packages/react/src/jsx.ts`：`jsx` / `jsxs` / `jsxDEV`。
- `packages/react/package.json`：`jsx-runtime` 与 `jsx-dev-runtime` 的导出。
- `packages/shared/src/ReactSymbols.ts`：`REACT_ELEMENT_TYPE`。
- `packages/react-reconciler/src/childFiber.ts`：`isReactElement`。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./04-ReactElement与createElement.md) · [下一章 →](./06-Fiber链表与双缓冲.md)
