import type { DesktopExecutor, WeChatAgentAdapter } from '../types.js';

/** Geometry cannot read wxid. Use a freshly verified Reader/Hook identity, never a static config fallback. */
export function withVerifiedWechatAccount(
  desktop: DesktopExecutor,
  wechat: WeChatAgentAdapter | null,
): DesktopExecutor {
  return {
    health: () => desktop.health(),
    async status() {
      const status = await desktop.status();
      if (status.accountId !== null || !status.running || !status.loggedIn || wechat === null) return status;
      try {
        const before = await wechat.getAccount();
        const health = await (wechat.checkIdentityHealth ? wechat.checkIdentityHealth() : wechat.checkHealth());
        if (before === null || health.status !== 'ok') return status;
        const after = await wechat.getAccount();
        if (after === null || before.accountId !== after.accountId || before.ownWxid !== after.ownWxid) return status;
        return { ...status, accountId: after.accountId,
          notes: [...status.notes, '账号来源：Reader/Hook 实时校验通过'] };
      } catch {
        return status;
      }
    },
    prepare: (request) => desktop.prepare(request),
    publish: (request) => desktop.publish(request),
    verify: (attemptId) => desktop.verify(attemptId),
    cancel: (attemptId) => desktop.cancel(attemptId),
  };
}
