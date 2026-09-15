/**
 * 调度器教学开关。
 * true 时 callback 会立即执行，方便只调试 Fiber 主线；默认 false，保留
 * MessageChannel 宏任务和 5ms 时间切片的真实行为。
 */
export const enableSchedulerDebugging = false;
