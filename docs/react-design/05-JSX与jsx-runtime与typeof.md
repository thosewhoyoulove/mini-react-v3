# 第 5 章：JSX、`jsx-runtime` 与 `$$typeof`

[← 返回总目录](../../React设计与实现.md) · [上一章](./04-ReactElement与createElement.md) · [下一章 →](./06-Fiber链表与双缓冲.md)

---

demo 手写 `createElement`，是为了让调用在源码里可见。日常代码却常写 `<li>`：浏览器不认识这对尖括号，它为什么仍能运行？因为打包器在构建时先把 JSX 换成函数调用，运行时拿到的仍是第 4 章那个对象。

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

## 5.2 `$$typeof` 用来挡住长得像的对象

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

这里使用 `Symbol.for` 而非 `Symbol()` 也有实际作用。前者按名字从当前 JavaScript agent 的全局注册表取值，创建元素的包和检查元素的包能拿到同一个 Symbol；后者每次调用都会产生新值，分别创建便无法相等。

不过，`$$typeof` 解决的只是「普通对象被误认成元素」。它不替代文本转义，也不负责检查 URL 或事件中的不可信内容。本仓库没有实现 `dangerouslySetInnerHTML`，示例中的对象不会真的生成脚本节点；保留这个例子，是为了说明品牌检查所防守的边界。

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

从 `<button>` 到 ReactElement 的路径至此闭合了：JSX 在构建阶段消失，运行时执行的是元素工厂；工厂返回的对象还要通过 `$$typeof` 检查，不能只靠字段外形判断。

接下来，调和器会把这棵嵌套的描述树转换成便于逐节点处理的 Fiber 链表。

## 本章回顾

JSX 是编译期语法。classic runtime 生成 `createElement`，automatic runtime 生成 `jsx`、`jsxs` 或 `jsxDEV`，但这些入口最终提供同一种 ReactElement。`$$typeof === Symbol.for('react.element')` 是元素的运行时品牌；它能拒绝外形相似的普通 JSON，却不是一套完整的 XSS 防护。

阅读源码时，可以从 `packages/react/src/jsx.ts` 和 `packages/react/package.json` 确认入口，再到 `packages/shared/src/ReactSymbols.ts`、`packages/react-reconciler/src/childFiber.ts` 跟踪品牌的创建与检查。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./04-ReactElement与createElement.md) · [下一章 →](./06-Fiber链表与双缓冲.md)
