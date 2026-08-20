import type { HostConfig } from './HostConfig';

let currentHostConfig: HostConfig | null = null;

export function setHostConfig(hostConfig: HostConfig): void {
  currentHostConfig = hostConfig;
}

export function getHostConfig(): HostConfig {
  if (currentHostConfig == null) {
    throw new Error('HostConfig is not set');
  }
  return currentHostConfig;
}
