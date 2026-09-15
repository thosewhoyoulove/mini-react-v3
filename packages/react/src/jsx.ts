import { REACT_ELEMENT_TYPE } from 'shared';
import type { Key, Props, ReactElement, Ref, Type } from 'shared';

/**
 * automatic JSX runtime 的元素工厂。
 *
 * 编译器已经把 children 放进 config，因此这里不像 createElement 那样接收
 * 剩余参数；其余规则相同：拆 key/ref、复制 props、返回 ReactElement 描述。
 */
export function jsx(
  type: Type,
  config: Props,
  maybeKey?: Key,
): ReactElement {
  let key: Key = maybeKey != null ? '' + maybeKey : null;
  // 编译器单独传入的 maybeKey 优先于 config.key
  let ref: Ref = null;
  const props: Props = {};

  if (config != null) {
    if (config.key !== undefined && key === null) {
      key = '' + config.key;
    }
    if (config.ref !== undefined) {
      ref = config.ref;
    }
    for (const propName in config) {
      if (
        Object.prototype.hasOwnProperty.call(config, propName) &&
        propName !== 'key' &&
        propName !== 'ref'
      ) {
        props[propName] = config[propName];
      }
    }
  }

  return {
    $$typeof: REACT_ELEMENT_TYPE,
    type,
    key,
    ref,
    props,
  };
}

/** 多静态 children 的编译入口；教学版与 jsx 共用实现。 */
export const jsxs = jsx;

/** 开发模式 JSX 的编译入口；教学版不额外保存 source / self。 */
export const jsxDEV = jsx;
