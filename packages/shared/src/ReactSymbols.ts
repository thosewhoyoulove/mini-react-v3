/**
 * ReactElement 的运行时品牌。
 * Symbol.for 让不同包通过全局注册表拿到同一个值，reconciler 因而不必
 * 依赖 ReactElement 的构造函数，只检查 `$$typeof` 就能识别元素。
 */
export const REACT_ELEMENT_TYPE = Symbol.for('react.element');

/** 不产生宿主节点的透明父节点。 */
export const REACT_FRAGMENT_TYPE = Symbol.for('react.fragment');

/** createContext 返回值上的品牌。 */
export const REACT_CONTEXT_TYPE = Symbol.for('react.context');

/** memo(Component) 返回值上的品牌。 */
export const REACT_MEMO_TYPE = Symbol.for('react.memo');

/** forwardRef(render) 返回值上的品牌。 */
export const REACT_FORWARD_REF_TYPE = Symbol.for('react.forward_ref');

/** Suspense 组件类型上的品牌。 */
export const REACT_SUSPENSE_TYPE = Symbol.for('react.suspense');
