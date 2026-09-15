import type { ReactElement } from 'react';
import { createContainer, updateContainer } from 'react-reconciler';
import { hostConfig } from './hostConfig';

/**
 * ReactDOM 的根入口。
 *
 * createRoot 把真实 DOM 容器和 DOM HostConfig 交给 reconciler；之后 render
 * 只负责提交新的 ReactElement，所有 Fiber 工作都留在 react-reconciler。
 */

/** 创建可重复 render 的根；闭包中的 FiberRoot 在多次更新之间保持不变。 */
export function createRoot(container: Element) {
  const root = createContainer(container, hostConfig);
  return {
    render(element: ReactElement) {
      updateContainer(element, root);
    },
  };
}

/** 兼容教学用的简写入口；每次调用都会创建一个新根。 */
export function render(element: ReactElement, container: Element): void {
  createRoot(container).render(element);
}
