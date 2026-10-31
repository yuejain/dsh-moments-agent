import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTestContext } from '../helpers/mock.mjs';
import { makeRuntime } from '../helpers/flow.mjs';

test('桌面连接必须鉴权成功，保存后重建运行时仍生效', async () => {
  const ctx = await createTestContext({ config: { desktopExecutor: { enabled: false } } });
  const token = 'desktop-test-token';
  writeFileSync(path.join(ctx.dir, 'desktop-token.txt'), token);
  const service = http.createServer((req, res) => {
    res.writeHead(req.headers['x-moments-token'] === token ? 200 : 401, {'content-type':'application/json'});
    res.end(JSON.stringify({ok:true, driver:'geometry', ocrAvailable:true, wechatInstalled:true}));
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  try {
    const runtime = makeRuntime(ctx);
    const url = `http://127.0.0.1:${service.address().port}`;
    await assert.rejects(runtime.updateDesktopConnection({enabled:true,baseUrl:'http://example.com'}));
    assert.equal(runtime.desktopConnectionView().enabled, false);
    const saved = await runtime.updateDesktopConnection({enabled:true,baseUrl:url});
    assert.equal(saved.enabled,true);
    assert.equal(makeRuntime(ctx).desktopConnectionView().baseUrl,url);
    assert.equal(runtime.publishModeView().mode,'PREPARE_ONLY');
    await runtime.updateDesktopConnection({enabled:false});
    assert.equal(makeRuntime(ctx).desktopConnectionView().enabled,false);
  } finally { await new Promise(resolve => service.close(resolve)); ctx.cleanup(); }
});
