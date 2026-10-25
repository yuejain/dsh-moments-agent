/**
 * 时间窗口策略：安静时段、每日上限的本地日边界、确定性抖动。
 *
 * 所有计算显式使用配置时区（默认 Asia/Shanghai），不依赖宿主进程时区，
 * 避免用户出差或系统时区变化导致朋友圈在凌晨发布。
 */

export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 1 = 周一 ... 7 = 周日 */
  readonly weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  formatterCache.set(timeZone, created);
  return created;
}

export function assertValidTimeZone(timeZone: string): string {
  try {
    formatter(timeZone);
    return timeZone;
  } catch {
    throw new Error(`无效时区：${timeZone}`);
  }
}

export function zonedParts(now: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '0';
  const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: weekdayMap[get('weekday')] ?? 1,
  };
}

export function parseHhMm(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) throw new Error(`无效时间格式：${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesOfDay(now: Date, timeZone: string): number {
  const parts = zonedParts(now, timeZone);
  return parts.hour * 60 + parts.minute;
}

/** 安静时段支持跨午夜，例如 23:00–08:00。 */
export function isQuietHours(now: Date, quietHours: readonly [string, string], timeZone: string): boolean {
  const start = parseHhMm(quietHours[0]);
  const end = parseHhMm(quietHours[1]);
  if (start === end) return false;
  const current = minutesOfDay(now, timeZone);
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

/** 当前时区偏移（毫秒，东八区为 +8h）。 */
export function timeZoneOffsetMs(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    hour: '2-digit',
  }).formatToParts(now);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (match === null) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

/** 本地自然日 00:00 对应的 UTC 时刻。 */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const parts = zonedParts(now, timeZone);
  const offset = timeZoneOffsetMs(now, timeZone);
  const utcMidnight = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
  return new Date(utcMidnight - offset);
}

export function localDayKey(now: Date, timeZone: string): string {
  const parts = zonedParts(now, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/**
 * 确定性抖动：同一任务/同一天得到相同延迟，重启不会重复随机。
 * 用于把计划发布时间打散，避免固定整点。
 */
export function deterministicJitter(taskId: string, maxSeconds: number, now: Date): number {
  if (maxSeconds <= 0) return 0;
  let hash = 2166136261;
  const seed = `${taskId}:${now.toISOString().slice(0, 13)}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % (maxSeconds + 1);
}
