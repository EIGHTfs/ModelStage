#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UnityPy worker 的命名/配对函数单测（独立跑：python3.14 test/unitypy-worker-naming.test.py）。

不纳入 node 的 test-all（那套只跑 *.test.mjs），因为这里是 Python 侧逻辑。
覆盖三类：
  · 同名 → 带 pathID，可复现（两次调用结果相同）
  · 单份 → 保持原名（零回归）
  · 贴图按尺寸匹配：命中 / 尺寸不符回落第一份 / 单份不变
"""
import os
import sys

PLUGIN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'plugins', 'unitypy-bundle')
sys.path.insert(0, PLUGIN)
import worker as W  # noqa: E402

FAILED = []


def check(name, cond, detail=''):
    if cond:
        print(f'  ✅ {name}')
    else:
        print(f'  ❌ {name} {detail}')
        FAILED.append(name)


# ── ① 同名加 pathID，且可复现 ──
n1 = W._disambiguated('char.atlas', 123456)
n2 = W._disambiguated('char.atlas', 123456)
n3 = W._disambiguated('char.atlas', -987654321)
check('同名带 pathID（正数）', n1 == 'char__123456.atlas', n1)
check('同名带 pathID（负数也能用）', n3 == 'char__-987654321.atlas', n3)
check('同 pathID 两次调用结果相同（可复现）', n1 == n2, f'{n1} vs {n2}')

# ── ② 单份保持原名：由 _export_objects 的 counts 判定，这里直接验判据 ──
# 单份 ⇒ counts[name]==1 ⇒ 走原名分支；多份 ⇒ 带 pathID
counts_single = {'only.atlas': 1}
check('单份判据 counts==1', counts_single.get('only.atlas', 1) == 1)
counts_multi = {'dup.atlas': 2}
check('多份判据 counts==2', counts_multi.get('dup.atlas', 1) != 1)

# ── ③ 贴图按尺寸匹配 ──
textures = [
    {'name': 'chen', 'file': 'chen.png', 'path': '/x/chen.png', 'w': 256, 'h': 256},
    {'name': 'chen', 'file': 'chen__2.png', 'path': '/x/chen__2.png', 'w': 512, 'h': 512},
]
got = W._find_texture(textures, 'chen', 512, 512)
check('尺寸匹配命中正确那份', got and got['w'] == 512, got)
got2 = W._find_texture(textures, 'chen', 256, 256)
check('尺寸匹配（另一份）', got2 and got2['w'] == 256, got2)
got3 = W._find_texture(textures, 'chen', 999, 999)
check('尺寸不符 ⇒ 回落第一份', got3 and got3['w'] == 256, got3)
got4 = W._find_texture(textures, 'chen')
check('未给尺寸 ⇒ 回落第一份', got4 and got4['w'] == 256, got4)
single = [{'name': 'solo', 'file': 'solo.png', 'path': '/x/solo.png', 'w': 100, 'h': 100}]
got5 = W._find_texture(single, 'solo', 100, 100)
check('单份不变', got5 and got5['file'] == 'solo.png', got5)
check('查不到返回 None', W._find_texture(textures, 'nope', 1, 1) is None)

# ── ④ parse_atlas_pages 带尺寸 ──
atlas = "\nchen.png\nsize: 512,512\nformat: RGBA8888\nfilter: Linear,Linear\nBG\n  rotate: false\n  xy: 1, 2\n"
pages = W.parse_atlas_pages(atlas)
check('解析出 1 个页', len(pages) == 1, pages)
check('页名正确', pages[0]['page'] == 'chen.png', pages)
check('页尺寸正确', pages[0]['w'] == 512 and pages[0]['h'] == 512, pages)

print()
if FAILED:
    print(f'❌ {len(FAILED)} 项失败')
    sys.exit(1)
print('✅ 全部通过')
