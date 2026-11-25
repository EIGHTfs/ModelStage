# 任务 · JS 移植 ASTC 解码器（只写解码器本体，不接 texdecode）

## 一、目标

在插件里新增一个**纯 JS 的 ASTC 解码器**，输出 RGBA，供后续接入 `texdecode`。
本批**只写解码器本体 + 单测**，不碰 `texdecode.js`（另一个成员正在改它，避免撞车）。

## 二、已有的关键条件（都实测过，不用重查）

### 2.1 参考实现可用（本机）

```
python3.14 + /volume1/VirtualDSM/unitypy-deps 里的 UnityPy 能完整解开明日方舟的包
生成参考 PNG 的命令（照抄可用）：

PYTHONPATH=/volume1/VirtualDSM/unitypy-deps /usr/local/bin/python3.14 -c "
import UnityPy
env = UnityPy.load('<包绝对路径>')
for obj in env.objects:
    if obj.type.name != 'Texture2D': continue
    d = obj.read()
    safe = ''.join(c if c.isalnum() or c in '-_' else '_' for c in d.m_Name)
    d.image.save(f'/tmp/ref_{safe}.png')
"
```

已生成的参考图（可直接用）：

```
/tmp/ref_build_char_010_chen.png   440x440   format=50 (ASTC_RGB_6x6)
（同包还有 format=49 (ASTC_RGB_5x5) 1024x1024，可用上面的命令再导出）
```

**注意**：`python3` 是 3.8、`python3.10` 缺 brotli，**只有 `python3.14` 能用**。

### 2.2 真实块尺寸

```
char_010_chen.ab 实测：format 50 → 6x6、format 49 → 5x5（用 m_CompleteImageSize 反推，唯一解）
⇒ 优先覆盖 4x4 / 5x5 / 6x6；8/10/12 可后续补，未实现要明确抛"未支持"
```

### 2.3 格式号（已核实）

```
45 ETC2_RGB      46 ETC2_RGBA1     47 ETC2_RGBA8
48 ASTC_RGB_4x4  49 ASTC_RGB_5x5   50 ASTC_RGB_6x6
51 ASTC_RGB_8x8  52 ASTC_RGB_10x10 53 ASTC_RGB_12x12
54~59 ASTC_RGBA_4x4 … 12x12
```

## 三、要做的事

```
新增 plugins/unity-spine-bundle/lib/astc.js
  · 导出 decodeAstc(data, width, height, blockW, blockH) → Uint8Array（RGBA，长度 w*h*4）
  · 纯函数、零依赖、不碰 DOM / 网络 / 文件
  · 未实现的块尺寸 / 块模式：抛带原因的错（不要返回半成品，不要静默填黑）
新增 plugins/unity-live2d-bundle/lib/astc.js
  · 与上面**逐字节相同**（parity）
新增 test/astc-decode.test.mjs
  · 用参考 PNG 做逐像素对照（容差 ±1；不允许整体偏移/镜像/色序错）
  · 至少覆盖 5x5 与 6x6 两个块尺寸
  · 先造红（未实现时必失败）
```

## 四、不要做的事

```
✗ 不改 texdecode.js（另一个成员正在改：FORMATS / expectedSize / DECODERS）
✗ 不改 plugin.json 的 files[]（等接入那一步一起改，避免与另一个成员冲突）
✗ 不改 package.json 的 version
✗ 不引第三方依赖（本任务就是要纯 JS）
✗ 不 push（可本地 commit）
```

## 五、实现要点（避免走弯路）

```
· ASTC 块固定 128 bit（16 字节）；块尺寸只影响最后的权重插值范围，不影响前面的解析
· 一个块内：分区(partition) → 颜色端点端点解量化 → 权重网格 + 权重插值 → 通道映射
· LDR / HDR 两种模式；样本里出现的是 LDR。HDR 若未实现，明确抛"未支持"
· 双平面（dual plane）模式在法线贴图里常见，样本可能不涉及；未实现要抛错
· 不要在 js 里做 flipY —— 现有 decode() 外层统一翻，你只负责按行序输出
```

## 六、验收判据

```
A 参考对照：/tmp/ref_build_char_010_chen.png（6x6）与解码结果逐像素一致（容差 ±1）
B 5x5：用包里 format=49 的那张生成参考图，同样逐像素一致
C 未支持路径：传入未实现的块尺寸/模式时抛可读错误（不返回半成品）
D 两处等长：输出长度必须 = w*h*4，尺寸不足时报错
E 两份 astc.js 逐字节相同（md5）
F 单测先造红：解码器未实现时用例必须失败（贴红/绿两次输出）
G 相关 node 套件绿（不跑 --all / --browser）
```

## 七、纪律

```
· 只用 edit（不许 sed）；改完 node --check
· 注释只写为什么/坑，不写规则号与对话残留
· 不写死包路径进代码与测试（路径从参数派生或用临时目录）
· 不设超时
· 报告只贴关键证据（对照差异统计、红绿输出、md5）
```
