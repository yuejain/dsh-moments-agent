/**
 * 全局控制状态：Kill Switch、暂停、发布模式覆盖。
 *
 * - Kill Switch / 暂停立即生效，且持久化到 SQLite，重启后保持；
 * - 恢复必须显式操作（所有者命令/管理页），不会因重启自动恢复；
 * - 发布模式只能由配置或受保护的控制面修改，Agent 工具无权修改。
 */
import type { MomentsStore } from '../storage/store.js';

export const SETTING_KILL_SWITCH = 'kill_switch';
export const SETTING_PAUSED = 'paused';
export const SETTING_PAUSED_REASON = 'paused_reason';
export const SETTING_PAUSED_AT = 'paused_at';

export class ControlState {
  constructor(private readonly store: MomentsStore) {}

  get killSwitch(): boolean {
    return this.store.getSetting(SETTING_KILL_SWITCH) === 'true';
  }

  get paused(): boolean {
    return this.store.getSetting(SETTING_PAUSED) === 'true';
  }

  get pauseReason(): string {
    return this.store.getSetting(SETTING_PAUSED_REASON) ?? '';
  }

  setKillSwitch(value: boolean, actor: string, reason: string): void {
    this.store.setSetting(SETTING_KILL_SWITCH, value ? 'true' : 'false');
    this.store.appendAudit({
      at: new Date().toISOString(),
      actor,
      action: value ? 'kill_switch_enabled' : 'kill_switch_disabled',
      taskId: null,
      previousState: null,
      nextState: null,
      reason,
      metadata: {},
    });
  }

  setPaused(value: boolean, actor: string, reason: string): void {
    this.store.setSetting(SETTING_PAUSED, value ? 'true' : 'false');
    this.store.setSetting(SETTING_PAUSED_REASON, value ? reason : '');
    this.store.setSetting(SETTING_PAUSED_AT, value ? new Date().toISOString() : '');
    this.store.appendAudit({
      at: new Date().toISOString(),
      actor,
      action: value ? 'paused' : 'resumed',
      taskId: null,
      previousState: null,
      nextState: null,
      reason,
      metadata: {},
    });
  }

  /** 任何外部副作用前的最后检查。 */
  assertOperational(action: string): void {
    if (this.killSwitch) throw new Error(`KILL_SWITCH_ACTIVE:${action}`);
    if (this.paused) throw new Error(`PAUSED:${action}`);
  }
}
