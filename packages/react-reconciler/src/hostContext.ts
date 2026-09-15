import type { HostConfig } from './HostConfig';

/**
 * 当前根使用的宿主实现。
 *
 * workLoop 在每次处理 root 前设置它，completeWork / commitWork 再从这里读取。
 * 这是便于讲解的模块级接缝；官方 React 会把宿主方法编译进对应 reconciler。
 */

/** 当前 Render / Commit 应调用的 HostConfig。 */
let currentHostConfig: HostConfig | null = null;

/** 切换到即将处理的 FiberRoot 所携带的宿主实现。 */
export function setHostConfig(hostConfig: HostConfig): void {
  currentHostConfig = hostConfig;
}

/** 读取当前宿主实现；未经过 createContainer 初始化就调用属于流程错误。 */
export function getHostConfig(): HostConfig {
  if (currentHostConfig == null) {
    throw new Error('HostConfig is not set');
  }
  return currentHostConfig;
}
