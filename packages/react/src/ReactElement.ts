import { REACT_ELEMENT_TYPE } from 'shared';
import type { Key, Props, ReactElement, Ref, Type } from 'shared';

/**
 * 把用户写的 `type + config + children` 规范化为 ReactElement。
 *
 * ReactElement 只是不可执行的 UI 描述：这里不创建 Fiber，也不操作 DOM。
 * key / ref 是 React 自己消费的保留字段，所以会从 config 拆出，不留在 props。
 */

/** key 允许 0 和空字符串，因此只能判断是否为 undefined。 */
function hasValidKey(config: Props): boolean {
  return config.key !== undefined;
}

/** ref 与 key 遵循相同的“显式传入才算有效”规则。 */
function hasValidRef(config: Props): boolean {
  return config.ref !== undefined;
}

/**
 * 经典 JSX runtime 的元素工厂。
 *
 * 只做四步：
 *   1. 从 config 拆出 key / ref
 *   2. 把其余自有字段复制进新 props，避免修改用户传入对象
 *   3. 按 children 数量写入单值或数组
 *   4. 返回带 `$$typeof` 品牌的 ReactElement
 */
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
      key = '' + config.key; // 1. key 统一转字符串，后续 Map Diff 才能稳定比较
    }
    if (hasValidRef(config)) {
      ref = config.ref; // 1. 当前只保存，尚未实现 ref 的 Commit 语义
    }
    for (const propName in config) {
      if (
        Object.prototype.hasOwnProperty.call(config, propName) &&
        propName !== 'key' &&
        propName !== 'ref'
      ) {
        props[propName] = config[propName]; // 2. key / ref 不进入组件 props
      }
    }
  }

  const childrenLength = children.length;
  if (childrenLength === 1) {
    props.children = children[0]; // 3. 单孩子不额外套数组
  } else if (childrenLength > 1) {
    props.children = children; // 3. 多孩子保持调用顺序
  }

  return {
    $$typeof: REACT_ELEMENT_TYPE,
    type,
    key,
    ref,
    props,
  }; // 4. 到这里仍只是描述对象，beginWork 才会把它转成 Fiber
}
