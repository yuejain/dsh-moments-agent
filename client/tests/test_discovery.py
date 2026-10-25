import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from client.discovery import discover, local_url, profile_settings


class DiscoveryTest(unittest.TestCase):
    def test_profile_only_reads_literal_fields_from_target_plugin(self):
        with tempfile.TemporaryDirectory() as tmp:
            patch=Path(tmp)/'cordis.patch.yml'
            patch.write_text('- id: other\n  config:\n    dataDir: wrong\n- id: dsh-moments-agent\n  config:\n    dataDir: custom-data\n    wechatAgent:\n      readerBaseUrl: "http://127.0.0.1:5031"\n      hookBaseUrl: http://127.0.0.1:30001\n      readerConfigPath: !!js doNotExecute()\n      token: PRIVATE\n- id: after\n  config:\n    dataDir: wrong-again\n')
            found=profile_settings(patch)
            self.assertEqual(found['dataDir'],'custom-data')
            self.assertEqual(found['hookBaseUrl'],'http://127.0.0.1:30001')
            self.assertNotIn('readerConfigPath',found)
            self.assertNotIn('PRIVATE',json.dumps(found))
    def test_detects_running_programs_registered_plugin_and_redacts_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plugin = root / '.dsh/profiles/desktop/node_modules/dsh-moments-agent'
            plugin.mkdir(parents=True)
            (plugin/'package.json').write_text(json.dumps({'name':'dsh-moments-agent'}))
            (plugin/'data').mkdir()
            (plugin/'data/admin-token.txt').write_text('PRIVATE_ADMIN_TOKEN')
            dsh = root/'dsh/DeepSeek Harness.exe'; dsh.parent.mkdir();dsh.touch()
            agent = root/'wechat/app/WeChatAgent.exe';agent.parent.mkdir(parents=True);agent.touch()
            config = agent.parent.parent/'data/workspace/state/wechat-io-config.json'
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({'reader_base_url':'http://127.0.0.1:5031', 'onebot_ws_url':'ws://localhost:30001/ws',
                'reader_token':'PRIVATE_READER_TOKEN','self_wxid':'PRIVATE_ACCOUNT'}))
            found = discover(root,user_home=root,processes=[SimpleNamespace(name='DeepSeek Harness.exe',exe_path=str(dsh)),
                SimpleNamespace(name='WeChatAgent.exe',exe_path=str(agent))],environment={})
            self.assertEqual(found['dsh'][0]['path'],str(dsh))
            self.assertEqual(found['suggestedClientConfig']['dataDir'],str(plugin/'data'))
            self.assertEqual(found['wechatConnections'][0]['readerBaseUrl'],'http://127.0.0.1:5031')
            self.assertNotIn('hookBaseUrlCandidate',found['wechatConnections'][0])
            self.assertNotIn('PRIVATE_',json.dumps(found))

    def test_multiple_registered_plugins_do_not_choose_automatically(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for name in ('one','two'):
                plugin=root/'.dsh/profiles'/name/'node_modules/dsh-moments-agent'
                plugin.mkdir(parents=True);(plugin/'package.json').write_text('{"name":"dsh-moments-agent"}')
                (plugin/'data').mkdir();(plugin/'data/admin-token.txt').touch()
            self.assertIsNone(discover(root,user_home=root,processes=[],environment={})['suggestedClientConfig'])

    def test_unsafe_urls_and_credentials_are_not_returned(self):
        for url in ('https://127.0.0.1:99','http://user:secret@127.0.0.1','http://remote.example','http://127.0.0.1:bad'):
            self.assertIsNone(local_url(url))
        self.assertEqual(local_url('http://127.0.0.1:5031?token=PRIVATE'),'http://127.0.0.1:5031')
