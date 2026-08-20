import type { HostConfig } from 'react-reconciler';
import type { Props } from 'shared';

const RESERVED_PROPS = new Set(['children', 'key', 'ref']);
const listeners = new WeakMap<HTMLElement, Map<string, EventListener>>();

function eventNameFromProp(key: string): string | null {
  if (!key.startsWith('on') || key.length < 3) {
    return null;
  }
  return key.slice(2).toLowerCase();
}

function setListener(
  domElement: HTMLElement,
  eventName: string,
  listener: EventListener | null,
): void {
  let map = listeners.get(domElement);
  if (map == null) {
    map = new Map();
    listeners.set(domElement, map);
  }
  const prev = map.get(eventName);
  if (prev != null) {
    domElement.removeEventListener(eventName, prev);
    map.delete(eventName);
  }
  if (listener != null) {
    domElement.addEventListener(eventName, listener);
    map.set(eventName, listener);
  }
}

function applyProps(
  domElement: HTMLElement,
  nextProps: Props,
  prevProps?: Props,
): void {
  if (prevProps != null) {
    for (const key in prevProps) {
      if (RESERVED_PROPS.has(key) || nextProps[key] !== undefined) {
        continue;
      }
      const eventName = eventNameFromProp(key);
      if (eventName != null) {
        setListener(domElement, eventName, null);
      } else if (key === 'className') {
        domElement.removeAttribute('class');
      } else if (key === 'style') {
        domElement.removeAttribute('style');
      } else {
        domElement.removeAttribute(key);
      }
    }
  }

  for (const key in nextProps) {
    if (RESERVED_PROPS.has(key)) {
      continue;
    }
    const value = nextProps[key];
    const eventName = eventNameFromProp(key);
    if (eventName != null) {
      setListener(
        domElement,
        eventName,
        typeof value === 'function' ? (value as EventListener) : null,
      );
      continue;
    }

    if (key === 'className') {
      domElement.setAttribute('class', String(value ?? ''));
      continue;
    }

    if (key === 'style' && value != null && typeof value === 'object') {
      Object.assign(domElement.style, value);
      continue;
    }

    if (value == null || value === false) {
      domElement.removeAttribute(key);
      continue;
    }

    if (value === true) {
      domElement.setAttribute(key, '');
      continue;
    }

    domElement.setAttribute(key, String(value));
  }
}

export const hostConfig: HostConfig<
  string,
  Props,
  Element,
  HTMLElement,
  Text
> = {
  createInstance(type, props) {
    const instance = document.createElement(type);
    applyProps(instance, props);
    return instance;
  },
  createTextInstance(text) {
    return document.createTextNode(text);
  },
  appendChild(parent, child) {
    parent.appendChild(child);
  },
  appendChildToContainer(container, child) {
    container.appendChild(child);
  },
  insertBefore(parent, child, before) {
    parent.insertBefore(child, before);
  },
  insertInContainerBefore(container, child, before) {
    container.insertBefore(child, before);
  },
  removeChild(parent, child) {
    parent.removeChild(child);
  },
  removeChildFromContainer(container, child) {
    container.removeChild(child);
  },
  commitUpdate(instance, _type, oldProps, newProps) {
    applyProps(instance, newProps, oldProps);
  },
  commitTextUpdate(textInstance, _oldText, newText) {
    textInstance.nodeValue = newText;
  },
};
