/**
 * ReactElement 的运行时品牌。
 * Symbol.for 让不同包通过全局注册表拿到同一个值，reconciler 因而不必
 * 依赖 ReactElement 的构造函数，只检查 `$$typeof` 就能识别元素。
 */
export const REACT_ELEMENT_TYPE = Symbol.for('react.element');
