# 第 5 章：JSX、`jsx-runtime` 与 `$$typeof`

[← 返回总目录](../../React设计与实现.md) · [上一章](./04-ReactElement与createElement.md) · [下一章 →](./06-Fiber链表与双缓冲.md)

> 主文件：`packages/react/src/jsx.ts`、`packages/shared/src/ReactSymbols.ts`
> JSX 不是运行时语法，是编译期糖。编译产物和 `createElement` 一样，都是带 `$$typeof` 的 ReactElement。

本仓库 demo 手写 `createElement`，不经过 JSX。包本身已经按官方形状导出了 `jsx` / `jsxs` / `jsxDEV`，读源码或接打包器时要对得上。

## 本章书签

- [5.1 JSX 如何编译成 `createElement` / `jsx`](#51-jsx-如何编译成-createelement--jsx)
- [5.2 `$$typeof` 用 Symbol 防什么](#52-typeof-用-symbol-防什么)
- [5.3 `jsx` / `jsxs` / `jsxDEV` 导出各自给谁用](#53-jsx--jsxs--jsxdev-导出各自给谁用)
- [面试复习](#面试复习)

---

## 5.1 JSX 如何编译成 `createElement` / `jsx`

浏览器不认识 `<div />`。打包器（Babel / TypeScript / Vite）在编译期把它换成函数调用。历史上有两套 runtime：

**classic**（老默认）：每个文件要能看到 `React.createElement`。

```jsx
<button className="row" onClick={onPlus}>+1</button>
```

编成：

```js
React.createElement('button', { className: 'row', onClick: onPlus }, '+1');
```

孩子是第 3 个及以后的参数，和本仓库 `createElement(type, config, ...children)` 对齐。

**automatic**（现在的默认）：编译器自己 `import { jsx } from 'react/jsx-runtime'`，孩子已经在 `config.children` 里，`key` 是第三参数。

```js
import { jsx } from 'react/jsx-runtime';
jsx('button', { className: 'row', onClick: onPlus, children: '+1' });
```

有 `key` 时：

```js
jsx('li', { children: item }, item); // 第三个参数是 key
```

两条路径最后都 `return { $$typeof, type, key, ref, props }`。调和器不关心你从哪条入口进来，只认这个对象。

`jsx` 和 `createElement` 的差异集中在参数位置：

| | `createElement` | `jsx` |
| --- | --- | --- |
| children | 第 3 个及以后的 rest 参数 | 已在 `config.children` |
| key | 从 `config.key` 拆 | 优先第三参数 `maybeKey`，否则再看 `config.key` |
| 调用方 | 手写、classic JSX | automatic JSX |

本仓库 `jsx` 里：`maybeKey != null` 就用它；否则若 `config.key` 有值再补上。其余同样跳过 `key` / `ref` 再拷进 `props`。

## 5.2 `$$typeof` 用 Symbol 防什么

```ts
// packages/shared/src/ReactSymbols.ts
export const REACT_ELEMENT_TYPE = Symbol.for('react.element');
```

`isReactElement` 只认这一位：

```ts
(value as ReactElement).$$typeof === REACT_ELEMENT_TYPE
```

用 Symbol 而不是字符串 `'react.element'`，是为了挡住一类 XSS：服务端或接口返回的 JSON 被当成 children 渲染。

JSON 可以表达普通对象：

```json
{
  "type": "script",
  "props": { "dangerouslySetInnerHTML": { "__html": "..." } }
}
```

`JSON.parse` 之后它看起来很像 ReactElement，但 **JSON 无法表达 Symbol**。解析结果没有 `$$typeof`，或即便有人写了 `"$$typeof": "react.element"`，那也是字符串，对不上 `Symbol.for('react.element')`。

`Symbol.for` 而不是 `Symbol()`：跨 realm（iframe、多份 React）只要描述字符串相同，取到的是同一个 symbol。合法 Element 在不同副本之间仍能被认出来。

教学版没有 `dangerouslySetInnerHTML`，这个坑不会真的爆；字段仍然按官方来，面试和对照源码时这就是标准答案。

## 5.3 `jsx` / `jsxs` / `jsxDEV` 导出各自给谁用

`packages/react/package.json` 的 exports：

```text
react                  → index.ts（createElement + hooks + jsx 再导出）
react/jsx-runtime      → jsx.ts    （生产：jsx / jsxs）
react/jsx-dev-runtime  → jsx.ts    （开发：jsxDEV）
```

官方三个函数职责不同：

| 导出 | 官方用途 | 本仓库 |
| --- | --- | --- |
| `jsx` | 静态孩子 ≤ 1 个 | 完整实现 |
| `jsxs` | 静态孩子 ≥ 2 个，编译器可标「孩子是静态数组」 | `export const jsxs = jsx` |
| `jsxDEV` | 开发态，多带 `fileName` / `lineNumber` 等调试信息 | `export const jsxDEV = jsx` |

教学版没有静态孩子优化，也没有源码定位，三个函数同一份实现就够。打包器无论编成 `jsx` 还是 `jsxs`，得到的 Element 形状一致。

读到这里可以对上两句话：

1. **JSX 是编译期语法，运行时只有函数调用。**
2. **Element 的身份证是 `$$typeof` 这个 Symbol，不是「长得像就行」。**

下一章离开「描述」，进入调和器真正的工作单元：Fiber 链表和双缓冲。

## 面试复习

### 一句话结论

JSX 在编译期变成 Element 工厂调用，`$$typeof` 的 Symbol 是运行时识别合法 ReactElement 的品牌标记，并非通用 XSS 防火墙。

### 面试回答

为什么 JSX 需要 runtime，Element 又需要 `$$typeof`？浏览器不能直接执行 JSX，所以 classic runtime 编译成 `createElement`，automatic runtime 编译成 `jsx/jsxs`；两条路径最终必须产出统一 Element 结构，reconciler 才无需关心语法来源。该结构用 `Symbol.for('react.element')` 作为品牌，`childFiber.ts` 先校验再按 Element 处理；JSON 不能表达 Symbol，因此服务端返回的普通 JSON 即使伪造 `type/props`，也不能仅靠字符串冒充合法 Element。本仓库的 `jsx/jsxs/jsxDEV` 共用实现，也没有 `dangerouslySetInnerHTML`；官方 React 的开发 runtime、Element Symbol 名称和值会随版本演进，并且真正的 XSS 防护还依赖文本转义、属性处理和禁止不可信代码执行，不能只归功于 `$$typeof`。

### 常见追问

**1. automatic runtime 比 classic runtime 改变了 React 原理吗？**

没有。主要改变编译产物的调用入口和参数布局，最终仍生成供 reconciler 消费的 Element。

**2. 为什么使用 `Symbol.for`，不是 `Symbol()`？**

全局 symbol registry 让同一 realm 中多份包通过相同 key 取得同一 Symbol，避免合法 Element 因模块副本不同而识别失败。

**3. 有 `$$typeof` 就绝对不会 XSS 吗？**

不是。它针对的是“把不可信 JSON 对象误认成 Element”这一条路径；不可信 HTML、URL、事件代码和服务端输出仍需各自的安全边界。

**4. `jsx`、`jsxs` 为什么能共用实现？**

教学版不做静态 children 优化，两者输入已经包含 children，产出的 Element 形状相同；官方可利用不同入口保留开发信息或优化提示。

### 容易说错

- 不要说 JSX 在浏览器运行时“解析成虚拟 DOM”；通常是构建阶段先编译成函数调用。
- 不要把 `$$typeof` 说成防住所有 XSS，它只是 Element 品牌校验机制的一部分。
- 不要把 `typeof element` 与 `element.$$typeof` 混淆；前者对普通对象只会得到 `"object"`。
- 不要把 `Symbol.for` 的共享范围扩大到跨进程或跨 Worker；它依赖同一 JS agent 内共享的全局 symbol registry。

### 源码入口

- `packages/react/src/ReactElement.ts`：classic `createElement` 路径。
- `packages/react/src/jsx.ts`：automatic runtime 的 `jsx/jsxs/jsxDEV`。
- `packages/react/package.json`：`jsx-runtime` 与 `jsx-dev-runtime` 导出。
- `packages/shared/src/ReactSymbols.ts`：Element 品牌 Symbol。
- `packages/react-reconciler/src/childFiber.ts`：`$$typeof` 身份校验入口。

---

[← 返回总目录](../../React设计与实现.md) · [上一章](./04-ReactElement与createElement.md) · [下一章 →](./06-Fiber链表与双缓冲.md)
