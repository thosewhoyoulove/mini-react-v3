import { REACT_ELEMENT_TYPE } from 'shared';
import type { Key, Props, ReactElement, Ref, Type } from 'shared';

function hasValidKey(config: Props): boolean {
  return config.key !== undefined;
}

function hasValidRef(config: Props): boolean {
  return config.ref !== undefined;
}

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
      key = '' + config.key;
    }
    if (hasValidRef(config)) {
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

  const childrenLength = children.length;
  if (childrenLength === 1) {
    props.children = children[0];
  } else if (childrenLength > 1) {
    props.children = children;
  }

  return {
    $$typeof: REACT_ELEMENT_TYPE,
    type,
    key,
    ref,
    props,
  };
}
