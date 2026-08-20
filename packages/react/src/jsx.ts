import { REACT_ELEMENT_TYPE } from 'shared';
import type { Key, Props, ReactElement, Ref, Type } from 'shared';

export function jsx(
  type: Type,
  config: Props,
  maybeKey?: Key,
): ReactElement {
  let key: Key = maybeKey != null ? '' + maybeKey : null;
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

export const jsxs = jsx;
export const jsxDEV = jsx;
