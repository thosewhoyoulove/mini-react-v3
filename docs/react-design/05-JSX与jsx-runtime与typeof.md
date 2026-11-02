# 第 5 章：JSX、`jsx-runtime` 与 `$$typeof`

[← 返回总目录](../../React设计与实现.md) · [上一章](./04-ReactElement与createElement.md) · [下一章 →](./06-Fiber链表与双缓冲.md)

---

demo 手写 `createElement`，方便直接查看参数和返回值。日常代码更常写成 `<button>`。浏览器最终执行的仍然是 JavaScript：构建工具会先把 JSX 转成函数调用，再由这些调用创建上一章的 ReactElement。本章沿这条转换路径，说明 `jsx-runtime` 的入口，以及运行时怎样识别元素。

## 5.1 JSX 在打包时就被换成函数调用

先看同一颗按钮的 JSX 写法：

```jsx
<button onClick={onReverse}>reverse</button>
```

界面会出现文字为 `reverse` 的按钮，点击时调用 `onReverse`。但 JavaScript 引擎不会直接执行上面的尖括号，Babel、TypeScript 或构建工具会先把它转换掉。常见转换方式有两种。

classic runtime 生成 `React.createElement` 调用，因此当前文件必须能访问 `React`。孩子从第三个参数开始，与上一章的手写调用完全对齐：

```js
React.createElement('button', { onClick: onReverse }, 'reverse');
```

automatic runtime 则由编译器补上导入，并把孩子放进 config。源文件不必再为了 JSX 专门引入 `React`：

```js
import { jsx } from 'react/jsx-runtime';

jsx('button', { onClick: onReverse, children: 'reverse' });
```

列表项的 `key` 通常单独出现在第三个参数：

```js
jsx('li', { children: item }, item);
```

采用哪种 runtime 取决于工具链配置。对本仓库而言，两条入口的主要差别只是参数位置：

| | `createElement` | `jsx` |
| --- | --- | --- |
| 孩子 | 第三个参数及以后 | 已经在 `config.children` |
| `key` | 从 `config.key` 拆出 | 先用第三个参数；没有再利用 `config.key` |
| 谁调用 | 手写，或 classic 编译结果 | automatic 编译结果 |

`packages/react/src/jsx.ts` 把第三个参数叫作 `maybeKey`。它不为 `null` 或 `undefined` 时优先采用，并转成字符串；否则再尝试读取 `config.key`。`ref` 仍从 config 中拆出，其他字段复制到新的 `props`。最终结果还是熟悉的五个字段：

```ts
return {
  $$typeof: REACT_ELEMENT_TYPE,
  type,
  key,
  ref,
  props,
};
```

所以调和器不必追查这份描述来自手写调用还是 JSX，只需读取统一的 ReactElement。

## 5.2 `$$typeof` 怎样识别元素

现在可以回答另一个问题：为什么有 `type` 和 `props` 还不够？`packages/react-reconciler/src/childFiber.ts` 的识别条件是：

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

考虑一段来自接口或服务端的 JSON：

```json
{
  "type": "script",
  "props": { "dangerouslySetInnerHTML": { "__html": "..." } }
}
```

解析后，它在外形上很像元素，却不能携带 Symbol。即使 JSON 里出现 `"$$typeof": "react.element"`，得到的也只是字符串，不会等于 `Symbol.for('react.element')`。`isReactElement` 因而会拒绝这个对象，不让它进入元素调和路径。

这里使用 `Symbol.for` 而非 `Symbol()`，是为了让不同模块按同一个名字取得同一个值。`Symbol.for` 会查询 JavaScript 的全局 Symbol 注册表；`Symbol()` 则每次创建一个新值。如果元素工厂和调和器各用一次 `Symbol()`，创建出的标记就无法相等。

这个检查区分的是约定好的元素与普通数据。JSON 不能直接表示 Symbol，页面中的 JavaScript 代码却可以自己调用 `Symbol.for('react.element')`，所以该标记不提供调用方身份验证。文本转义、URL 检查和事件回调中的数据处理，也需要各自的规则。

本项目没有实现 `dangerouslySetInnerHTML`。这里的 JSON 只是说明：对象即使具有 `type` 和 `props`，也不会自动获得 ReactElement 的身份。这条检查本身不能概括完整的 XSS 防护，也不能保证把一个合法标记补上就能安全渲染任意数据。

## 5.3 三个导出名共用一份实现

`packages/react/package.json` 把两个子路径入口都指到 `jsx.ts`：

```text
react/jsx-runtime      生产构建使用的 jsx、jsxs
react/jsx-dev-runtime  开发构建使用的 jsxDEV
```

生产编译时，零个或一个静态孩子通常对应 `jsx`，多个静态孩子对应 `jsxs`；开发编译则使用 `jsxDEV`。在官方实现里，开发入口还会携带文件名、行号等调试信息。

本仓库把三个名字都落到同一份实现：

```ts
export const jsxs = jsx;
export const jsxDEV = jsx;
```

因此这里没有针对静态孩子的额外优化，也不记录源码位置。无论编译器选择哪个导出，调和器拿到的元素形状都与 `createElement` 的结果一致。

从 `<button>` 到 ReactElement 的路径至此完整了：构建工具先转换 JSX，运行时调用元素工厂，调和器再检查对象上的类型标记。`createElement`、`jsx`、`jsxs` 和 `jsxDEV` 的调用形式不同，但交给调和器的是同一种描述。

## 本章回顾

JSX 是编译期语法。classic runtime 生成 `createElement`，automatic runtime 生成 `jsx`、`jsxs` 或 `jsxDEV`，但这些入口最终提供同一种 ReactElement。`$$typeof === Symbol.for('react.element')` 是元素的运行时品牌；它能拒绝外形相似的普通 JSON，却不是一套完整的 XSS 防护。

阅读源码时，可以从 `packages/react/src/jsx.ts` 和 `packages/react/package.json` 确认入口，再到 `packages/shared/src/ReactSymbols.ts`、`packages/react-reconciler/src/childFiber.ts` 跟踪品牌的创建与检查。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./04-ReactElement与createElement.md) · [下一章 →](./06-Fiber链表与双缓冲.md)
