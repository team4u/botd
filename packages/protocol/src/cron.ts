/**
 * 标准 5 段式 Cron 表达式工具（分 时 日 月 周），纯函数、零依赖。
 * 时间均按服务器本地时区、分钟粒度求值；周字段 0 与 7 均表示周日。
 */

interface CronFieldRange {
  min: number;
  max: number;
}

const FIELD_RANGES: readonly CronFieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week（0/7 = 周日）
];

interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  domRestricted: boolean;
  months: Set<number>;
  dows: Set<number>;
  dowRestricted: boolean;
}

const isDigits = (value: string): boolean => /^\d+$/.test(value);

/** 解析单个字段为取值集合；非法返回 undefined。isDow 时 0/7 归一化为 0（周日） */
const parseCronField = (field: string, { min, max }: CronFieldRange, isDow: boolean): Set<number> | undefined => {
  const values = new Set<number>();
  for (const item of field.split(',')) {
    if (item.length === 0) return undefined;
    let base = item;
    let step = 1;
    const slashIdx = item.indexOf('/');
    if (slashIdx !== -1) {
      base = item.slice(0, slashIdx);
      const stepStr = item.slice(slashIdx + 1);
      if (!isDigits(stepStr)) return undefined;
      step = parseInt(stepStr, 10);
      if (step < 1) return undefined;
    }
    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = min;
      hi = max;
    } else {
      const dashIdx = base.indexOf('-');
      if (dashIdx === -1) {
        if (!isDigits(base)) return undefined;
        lo = parseInt(base, 10);
        hi = lo;
      } else {
        const aStr = base.slice(0, dashIdx);
        const bStr = base.slice(dashIdx + 1);
        if (!isDigits(aStr) || !isDigits(bStr)) return undefined;
        lo = parseInt(aStr, 10);
        hi = parseInt(bStr, 10);
      }
      if (lo < min || hi > max || lo > hi) return undefined;
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(isDow ? v % 7 : v);
    }
  }
  return values;
};

/** 解析 5 段式表达式；非法返回 undefined */
const parseCronExpr = (expr: string): CronSchedule | undefined => {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseCronField(f, FIELD_RANGES[i], i === 4));
  if (!minute || !hour || !dom || !month || !dow) return undefined;
  return {
    minutes: minute,
    hours: hour,
    doms: dom,
    domRestricted: fields[2] !== '*',
    months: month,
    dows: dow,
    dowRestricted: fields[4] !== '*',
  };
};

/** 校验 5 段式 Cron 表达式（支持星号、步进、区间、逗号列表及其组合） */
export const isValidCronExpr = (expr: string): boolean => parseCronExpr(expr) !== undefined;

/** 判断表达式是否命中给定时间（服务器本地时区、分钟粒度）。
 *  标准语义：日(dom)与周(dow)同时受限时命中任一即匹配；仅其一时按该字段匹配。 */
export const cronMatches = (expr: string, date: Date): boolean => {
  const schedule = parseCronExpr(expr);
  if (!schedule) return false;
  if (!schedule.minutes.has(date.getMinutes())) return false;
  if (!schedule.hours.has(date.getHours())) return false;
  if (!schedule.months.has(date.getMonth() + 1)) return false;
  const domMatch = schedule.doms.has(date.getDate());
  const dowMatch = schedule.dows.has(date.getDay());
  if (schedule.domRestricted && schedule.dowRestricted) {
    if (!domMatch && !dowMatch) return false;
  } else if (schedule.domRestricted) {
    if (!domMatch) return false;
  } else if (schedule.dowRestricted) {
    if (!dowMatch) return false;
  }
  return true;
};

/** 常见模式给出简短中文提示，其余原样返回表达式 */
export const describeCronExpr = (expr: string): string => {
  const s = expr.trim();
  let m = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(s);
  if (m) return `每 ${m[1]} 分钟`;
  m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(s);
  if (m) return `每天 ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+1-5$/.exec(s);
  if (m) return `每个工作日 ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
  return expr;
};

/**
 * 解析延时表达式为正整数秒数；支持纯数字（秒）或带单位后缀 s/m/h/d（例如 "30s", "15m", "2h", "1d"）。
 * 非法或 <= 0 时返回 null。
 */
export const parseDelayDuration = (input: string | number): number | null => {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input > 0 ? Math.floor(input) : null;
  }
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?$/.exec(trimmed);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2] || 's';
  let multiplier = 1;
  if (unit.startsWith('m')) multiplier = 60;
  else if (unit.startsWith('h')) multiplier = 3600;
  else if (unit.startsWith('d')) multiplier = 86400;
  const seconds = Math.round(value * multiplier);
  return seconds > 0 ? seconds : null;
};

