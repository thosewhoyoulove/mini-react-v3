/**
 * 教学调试通道：把 Render / Commit / Scheduler 中分散的过程统一成结构化事件。
 *
 * 默认关闭，所以正常运行不产生额外输出；打开后每条记录都带阶段、时间、Fiber
 * 身份和 updateId，既可以直接打印，也可以替换 sink 收集成 Demo 面板的数据。
 */

/** 调试输出的严重程度；级别越靠后，信息越细。 */
export type DebugLogLevel = 'off' | 'error' | 'warn' | 'info' | 'trace';

/** 调试事件所在的 React 更新阶段。 */
export type DebugPhase =
  | 'element'
  | 'scheduleUpdate'
  | 'render'
  | 'beginWork'
  | 'completeWork'
  | 'commit'
  | 'mutation'
  | 'layoutEffect'
  | 'passiveEffect';

/** 一条可被 Demo、测试或控制台消费的结构化调试记录。 */
export type DebugLogEntry = {
  /** 记录产生的时间，单位为 performance.now() 的毫秒。 */
  timestamp: number;

  /** 记录所在阶段。 */
  phase: DebugPhase;

  /** 当前记录的级别。 */
  level: Exclude<DebugLogLevel, 'off'>;

  /** 面向人的简短说明。 */
  message: string;

  /** 组件或宿主标签名，没有时为 null。 */
  component: string | null;

  /** Fiber tag 的教学名称，没有对应 Fiber 时为 null。 */
  fiberTag: string | null;

  /** 当前更新使用的 lane 位图。 */
  lane: number | null;

  /** 当前 Fiber 携带的 flags 位图。 */
  flags: number | null;

  /** Fiber 在树中的深度；无法计算时为 null。 */
  depth: number | null;

  /** 贯穿一次更新的调试编号。 */
  updateId: number | null;

  /** 当前并发切片已经执行的 Fiber 工作单元数量。 */
  workUnits?: number;

  /** 当前并发切片是否因为 shouldYield 暂停。 */
  didYield?: boolean;
};

/** 调试配置；sink 适合接到 Demo 的日志面板。 */
export type DebugConfig = {
  /** off 表示完全关闭。 */
  level: DebugLogLevel;

  /** 接收结构化记录的函数。 */
  sink: (entry: DebugLogEntry) => void;
};

/** 默认关闭；只有显式配置 level 后才把记录交给 sink。 */
const defaultConfig: DebugConfig = {
  level: 'off',
  sink: (entry) => {
    console.log(
      `[mini-react:${entry.phase}] ${entry.message}`,
      entry,
    );
  },
};

/** 当前进程内共享的调试配置。只保存配置，不保存 Fiber 或 DOM。 */
let debugConfig: DebugConfig = defaultConfig;

/** 下一次更新的调试编号。 */
let nextUpdateId = 1;

/** 级别顺序，供 shouldLog 比较开关是否允许当前记录。 */
const levelOrder: Record<Exclude<DebugLogLevel, 'off'>, number> = {
  error: 1,
  warn: 2,
  info: 3,
  trace: 4,
};

/**
 * 替换调试配置。
 *
 * 传入 null 会恢复默认关闭状态；sink 不传时继续使用当前 sink，方便只切换级别。
 */
export function configureDebug(
  config: Partial<DebugConfig> | null = null,
): void {
  if (config == null) {
    debugConfig = defaultConfig;
    return;
  }
  debugConfig = {
    level: config.level ?? debugConfig.level,
    sink: config.sink ?? debugConfig.sink,
  };
}

/** 读取当前调试配置，返回新对象避免外部直接改内部状态。 */
export function getDebugConfig(): DebugConfig {
  return { ...debugConfig };
}

/** 为一次 setState 或 root.render 分配可以串起日志的 updateId。 */
export function createDebugUpdateId(): number {
  const updateId = nextUpdateId;
  nextUpdateId += 1;
  return updateId;
}

/** 当前配置是否允许输出某个级别。 */
function shouldLog(level: Exclude<DebugLogLevel, 'off'>): boolean {
  if (debugConfig.level === 'off') {
    return false;
  }
  return levelOrder[level] <= levelOrder[debugConfig.level];
}

/**
 * 发送一条结构化日志。
 *
 * 调试通道只接收普通数据，不认识 Fiber、DOM 或 Scheduler，避免破坏包边界。
 */
export function debugLog(
  level: Exclude<DebugLogLevel, 'off'>,
  entry: Omit<DebugLogEntry, 'timestamp' | 'level'>,
): void {
  if (!shouldLog(level)) {
    return;
  }
  debugConfig.sink({
    ...entry,
    timestamp: performance.now(),
    level,
  });
}
