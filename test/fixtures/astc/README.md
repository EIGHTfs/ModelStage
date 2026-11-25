# ASTC 解码器夹具（test/astc-decoder.test.mjs 用）

## 这里有什么

```
astc_6x6_440_build_char_010_chen.astc    87,616 B   ASTC 压缩块（440x440，块 6x6）
astc_6x6_440_build_char_010_chen.png    191,130 B   参考实现解出的图（显示方向、RGBA）
astc_5x5_1024_char_010_chen_2b.astc    672,400 B   ASTC 压缩块（1024x1024，块 5x5）
astc_5x5_1024_char_010_chen_2b.png   1,118,425 B   同上
```

来源：明日方舟 `chararts/char_010_chen.ab` 里的两张纹理
（Unity `TextureFormat` 50 = `ASTC_RGB_6x6`、49 = `ASTC_RGB_5x5`）。

## 为什么这两组二进制入库（与 test/fixtures/spine-bundle 的口径不同）

那份 README 的规则是"二进制样本不入库、用例按路径引用外部样本、样本不在就 skip"，理由是大包
（19MB）会把仓库撑大且随时可从源目录再生。这里的取舍不同：

- **新解码器的回归不能靠 skip**：ASTC 解码是"错一个位序就整片花屏"的那类代码，用例一旦在
  没有游戏资源的机器上静默 skip，等于这道门禁不存在。夹具入库后 `node test/astc-decoder.test.mjs`
  在任何机器上都能跑。
- **体积有界**：两张合计 1.86MB，且是一次性静态数据（不会再涨）。

## 怎么重新生成（可复制）

参考图（权威实现：UnityPy 内部用 Texture2DDecoder 解码，再交给 PIL 存 PNG）：

```
PYTHONPATH=<unitypy-deps 目录> <python3.14> -c "
import UnityPy
env = UnityPy.load('<chararts/char_010_chen.ab 绝对路径>')
for obj in env.objects:
    if obj.type.name != 'Texture2D': continue
    d = obj.read()
    fmt = d.m_TextureFormat
    fmt = int(fmt.value) if hasattr(fmt, 'value') else int(fmt)
    if fmt not in (49, 50): continue
    safe = ''.join(c if c.isalnum() or c in '-_' else '_' for c in d.m_Name)
    d.image.save(f'ref_{fmt}_{safe}.png')
"
```

压缩块数据（与插件运行期同一条路径：容器 → 对象表 → Texture2D 的 `m_StreamData` 切片）：

```
node -e "/* 用 plugins/unity-spine-bundle/lib 的 unityfs+serialized+extract 取 textureCompressedBytes */"
```

取出的块数据按 `<宽>x<高>` 与块边长喂给 `decodeAstc` 即可对照；`test/astc-decoder.test.mjs`
里的 `bgraMd5` 常量就是"与 Texture2DDecoder 逐字节一致"时的指纹。
