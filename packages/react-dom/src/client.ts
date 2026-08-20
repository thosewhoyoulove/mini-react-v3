import type { ReactElement } from 'react';
import { createContainer, updateContainer } from 'react-reconciler';
import { hostConfig } from './hostConfig';

export function createRoot(container: Element) {
  const root = createContainer(container, hostConfig);
  return {
    render(element: ReactElement) {
      updateContainer(element, root);
    },
  };
}

export function render(element: ReactElement, container: Element): void {
  createRoot(container).render(element);
}
