import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../client/web/app.js', import.meta.url), 'utf8');
const guide = source.slice(source.indexOf('  const SETUP_ROOT ='), source.indexOf('  // 让“复制命令”'));
function extract(name) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  function ', start + 1);
  return source.slice(start, end);
}
const sandbox = { state: { setup: { available: true } }, modeText: (value) => value, fmtRelative: () => '', fmtDateTime: () => '' };
vm.createContext(sandbox);
vm.runInContext(`${guide}\n${extract('emptySetupData')}\n${extract('normalizeSetupData')}\n${extract('computeSetupChecks')}\nthis.steps=SETUP_STEPS;this.ids=SETUP_STEP_IDS;`, sandbox);

test('explicitly saved completion survives older or partial progress', () => {
  const steps = Object.fromEntries(sandbox.ids.filter((id) => id !== 'model').map((id) => [id, true]));
  steps.proxy = true;
  assert.equal(sandbox.normalizeSetupData({ completed: true, steps }).completed, true);
});

test('setup does not treat publish permission as evidence of OCR or administrator readiness', () => {
  const checks = sandbox.computeSetupChecks({ info: { tokenFileExists: true },
    health: { database: 'ok', desktopExecutor: { status: 'degraded' }, wechatAgent: {} },
    status: { control: { publishMode: 'PREPARE_ONLY' } }, config: { desktopExecutor: { enabled: true } },
    executor: { embedded: true, health: { adminPrivilege: false, ocrAvailable: false, wechatVersion: '4.1.15.13' },
      status: { running: true, loggedIn: true, interactive: true, locked: false }, declaredVersion: '4.1.10.27' }, errors: [] });
  assert.equal(checks.find((item) => item.id === 'desktop-input').tone, 'fail');
  assert.equal(checks.find((item) => item.id === 'desktop-version').tone, 'warn');
  assert.equal(checks.find((item) => item.id === 'desktop-session').tone, 'ok');
  assert.equal(checks.some((item) => item.id === 'proxy'), false);
});

test('guide uses owner-supplied identity and EXE launch flow', () => {
  assert.equal(sandbox.steps.length, 6);
  assert.equal(/wxid_1a7|FengWo|Fake-IP|Clash|desktop\\server\.py --/.test(guide), false);
  assert.ok(sandbox.steps.find((step) => step.id === 'executor'));
  assert.equal(sandbox.steps.some((step) => step.id === 'firstpost'), false);
});
