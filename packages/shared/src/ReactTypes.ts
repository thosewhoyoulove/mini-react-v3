/**
 * React 公共数据结构。
 *
 * `react` 负责创建 ReactElement，`react-reconciler` 只读取这些字段并把它们
 * 转成 Fiber。类型放进 shared，避免两个包为了共享声明而反向依赖。
 */

/** Element 的种类：教学版主要接受 DOM 标签字符串或函数组件。 */
export type Type = any;

/** 同级 Diff 的身份标记；没有显式 key 时为 null。 */
export type Key = string | null;

/** Commit 的 Layout 阶段写入；函数组件拿到 Fiber，宿主节点拿到真实实例。 */
export type Ref = any;

export interface Props {
  /** 普通属性使用开放索引，既容纳 DOM 属性也容纳函数组件 props。 */
  [key: string]: any;

  /** createElement 的第三个及后续参数会收进 children。 */
  children?: any;
}

export interface ReactElement {
  /** 用全局 Symbol 标明“这是 ReactElement”，避免把普通对象当成节点。 */
  $$typeof: symbol | number;

  /** DOM 标签字符串或函数组件本身。 */
  type: Type;

  /** 只参与同级 Diff，不会进入 props。 */
  key: Key;

  /** Layout 阶段写入。对象 ref 写 current，函数 ref 直接调用。 */
  ref: Ref;

  /** 组件输入或宿主属性，children 也存放在这里。 */
  props: Props;
}
