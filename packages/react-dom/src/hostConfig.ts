import type { HostConfig } from 'react-reconciler';
import type { Props } from 'shared';

/**
 * DOM 宿主实现：把 reconciler 的抽象操作翻译成浏览器 DOM API。
 *
 * completeWork 会调用 create* 创建离屏节点；Commit 再调用 append/insert/remove
 * 和 commit* 修改已挂载树。事件采用逐节点监听，是明确的教学简化。
 */

/** React 自己消费、不能直接写到 DOM attribute 的字段。 */
const RESERVED_PROPS = new Set(['children', 'key', 'ref']);

/** 每个元素当前注册的原生监听器，用于更新时精确移除旧函数。 */
const listeners = new WeakMap<HTMLElement, Map<string, EventListener>>();

/** 把 onClick 一类 prop 转成小写原生事件名；普通 prop 返回 null。 */
function eventNameFromProp(key: string): string | null {
  if (!key.startsWith('on') || key.length < 3) {
    return null;
  }
  return key.slice(2).toLowerCase();
}

/**
 * 替换一个原生事件监听器。
 *
 * 1. 取得当前元素的监听器表
 * 2. 有旧函数就先 removeEventListener
 * 3. 有新函数再 addEventListener 并记下
 */
function setListener(
  domElement: HTMLElement,
  eventName: string,
  listener: EventListener | null,
): void {
  let map = listeners.get(domElement);
  if (map == null) {
    map = new Map();
    listeners.set(domElement, map); // 1. 首次见到这个元素，建立监听器表
  }
  const prev = map.get(eventName);
  if (prev != null) {
    domElement.removeEventListener(eventName, prev); // 2. 函数身份可能已变，先摘旧的
    map.delete(eventName);
  }
  if (listener != null) {
    domElement.addEventListener(eventName, listener); // 3. 教学版直接绑节点，不做根委托
    map.set(eventName, listener);
  }
}

/**
 * 把 props 应用到 DOM。
 *
 * 1. 更新路径先删除 oldProps 中已经消失的字段
 * 2. 跳过 children / key / ref
 * 3. onXxx、className、style 分别走专门分支
 * 4. null / false 删除，true 写空 attribute，其余值转字符串
 */
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
        setListener(domElement, eventName, null); // 1. 删除已经消失的事件
      } else if (key === 'className') {
        domElement.removeAttribute('class'); // 1. className 对应真实 class attribute
      } else if (key === 'style') {
        domElement.removeAttribute('style'); // 1. 整个 style prop 消失时清空行内样式
      } else {
        domElement.removeAttribute(key); // 1. 普通 attribute 消失
      }
    }
  }

  for (const key in nextProps) {
    if (RESERVED_PROPS.has(key)) {
      continue; // 2. children 由 Fiber 子树处理，key/ref 不属于 DOM props
    }
    const value = nextProps[key];
    const eventName = eventNameFromProp(key);
    if (eventName != null) {
      setListener(
        domElement,
        eventName,
        typeof value === 'function' ? (value as EventListener) : null,
      );
      continue; // 3. 事件不能当字符串 attribute 写入
    }

    if (key === 'className') {
      domElement.setAttribute('class', String(value ?? ''));
      continue; // 3. 浏览器 attribute 名是 class
    }

    if (key === 'style' && value != null && typeof value === 'object') {
      Object.assign(domElement.style, value);
      continue; // 3. 教学版只做浅合并，不做单个旧样式键删除
    }

    if (value == null || value === false) {
      domElement.removeAttribute(key);
      continue; // 4. null / undefined / false 表示不保留 attribute
    }

    if (value === true) {
      domElement.setAttribute(key, '');
      continue; // 4. 布尔 attribute 只需要存在
    }

    domElement.setAttribute(key, String(value));
  }
}

/** Reconciler 实际使用的 DOM HostConfig。 */
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
