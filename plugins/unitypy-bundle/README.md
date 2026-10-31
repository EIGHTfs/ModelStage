# unitypy-bundle —— 用 UnityPy 解 Unity 资源包（Python / exec 运行时）

**它是什么**：一个跑在**独立进程**里的解包插件。宿主按 `plugin.json` 的 `entry` 拉起
`worker.py`，双方用「一行一个 JSON」的帧协议通信；解包能力来自 [UnityPy](https://github.com/K0lb3/UnityPy)。

**为什么单独做一个**：现有两个 node 插件是自研 JS 解包器，它们的**纹理解码表**只覆盖
ETC2_RGBA8(47)/ETC2_RGBA1(48)/ETC2_RGB(45)/ETC1(34)/DXT(10/12)/BC4-5/RGBA32 等；
实测有一整类包（蔚蓝档案 `-mx-spinelobbies-*`、`-mx-spinebackground-*`）用的是
**ASTC(50)/PVRTC(49)**，JS 侧会抛 `ULB_ERR_TEX_FORMAT_UNSUPPORTED`。UnityPy 依赖
`texture2ddecoder`/`etcpak`/`astc-encoder-py` 等原生库，这些格式它都能解。

**它不抢现有插件的活**：`matchPriority = 5`（两个 node 插件是 20 / 10），
且宿主是"按清单顺序逐个尝试、失败才回退"，所以只有前两个插件解不了时才会走到这里。

---

## 一、依赖（**不在仓库里，部署端要自己装**）

| 项 | 值 |
|---|---|
| Python | `<python>`：3.10+ 均可（实测 3.14.7）；用哪个就把它写进 `plugin.json` 的 `interpreter` |
| UnityPy | **1.25.4** |
| 关键传递依赖 | numpy 2.5.4、Pillow 13.0.0、texture2ddecoder 1.0.6、etcpak 0.9.15、astc-encoder-py 0.1.12 |
| 依赖目录 | `<deps-dir>`：**由部署端自行决定**，配置项是 `plugin.json` 的 `depsDir`（写绝对路径） |

### 为什么依赖不放在 `plugins/unitypy-bundle/.deps`

本项目仓库目录常挂在 **CIFS** 上（`noexec, nounix`）。实测在那里装 UnityPy 会直接失败：

```
PermissionError: [Errno 1] Operation not permitted: '…/.deps2/_brotli.cpython-314-…so'
（pip 装 .so 后要 chmod/utime，CIFS 挂载不允许）
venv 也建不了：Error: [Errno 95] Operation not supported: 'lib' -> '…/.deps/lib64'（符号链接）
```

所以依赖装到**本地盘**（btrfs），由 `plugin.json` 的 `depsDir` 指过去；
`.gitignore` 已排除 `plugins/*/.deps/`、`__pycache__/`、`*.pyc`。

### 安装命令（部署端照抄，两个变量自己填）

```bash
# ① 先定两个变量：解释器与依赖目录（都要绝对路径，且目录要在**本地盘**上，别放 CIFS）
python=    # 例如 $(command -v python3)
deps_dir=  # 你机器上的本地盘目录（绝对路径；不要放在 CIFS/NFS 上）

# ② 装到该目录（--target，不用 venv：venv 在 CIFS 上会因 lib64 符号链接失败）
"$python" -m pip install \
  --target "$deps_dir" \
  --upgrade --timeout 120 --retries 8 \
  UnityPy==1.25.4 Pillow numpy
# ③ 自检（必须输出 IMPORT_OK）
PYTHONPATH="$deps_dir" "$python" \
  -c "import numpy,PIL,UnityPy,sys; print('IMPORT_OK', numpy.__version__, PIL.__version__, sys.version.split()[0])"

# ④ 把两件事写进插件清单：depsDir = "$deps_dir"，interpreter = "$python"
```

实测安装耗时约 75 秒、占盘 **142 MB**（首次下载受网络影响，可能更久）。

---

## 二、宿主门禁（exec 默认关闭）

`runtime:"exec"` 等于「允许宿主在本机执行第三方可执行文件」，所以**默认禁止**。
开启方式（二选一，配置在**数据根**下，测试实例与主实例互不影响）：

```bash
# ① 配置文件：<数据根>/config/plugin-runtime.json
{ "allowExecRuntime": true }
# ② 或环境变量
MODELSTAGE_ALLOW_EXEC_PLUGINS=1
```

未开启时插件**不会被装载**（`/api/plugins` 里仍在，但装载会明确报"未允许 exec 运行时"）。

---

## 三、帧协议（frameProtocol = 1）

父 → 子（stdin，一行一个 JSON）：

```json
{"id":1,"method":"canHandle","rootId":"assetbundls","rel":"a/b.bundle","absPath":"/abs/a/b.bundle","size":20205522}
{"id":2,"method":"resolve","rootId":"assetbundls","rel":"a/b.bundle","absPath":"/abs/a/b.bundle","size":20205522}
```

子 → 父（stdout，一行一个 JSON）：

```json
{"id":1,"ok":true,"handled":true}
{"id":2,"ok":true,"prefix":"vfs://unitypy-bundle/assetbundls/a/","entry":"entry.json",
 "files":[{"name":"x.skel","tmpPath":"<插件临时目录>/res-xxx/x.skel","size":566437}]}
{"id":2,"ok":false,"code":"ULB_ERR_NO_FILE","message":"文件不存在：…"}
```

**大 payload 走临时文件**：帧里只有 `{name, tmpPath, size}`，二进制从不进帧
（20MB 包 base64 又慢又吃内存）。父进程是**惰性读**的（`resolve` 返回后才按需读盘），
所以 worker 保留最近 `KEEP_RESULTS=4` 个结果目录，进程退出时全删。

**超时**：`plugin.json` 的 `requestTimeoutMs = 120000`（首帧含 python 启动 + `import UnityPy`，
实测冷启 1~3 秒；大包全量解包 4~6 秒）。超时由宿主 kill（SIGTERM → 3 秒 → SIGKILL）。

**空闲退出**：默认 60 秒无请求就退出（不留常驻 python）。

---

## 四、解包产物（entry.json 与前端约定一致）

```jsonc
// spine：字段名与两个 node 插件逐字相同
{ "skeletonFile": "CH0060_home.skel",
  "atlasFile": "CH0060_home.atlas",
  "textureFiles": ["CH0060_home.png"],
  "otherSkeletons": ["CH0060BG_home.skel"] }   // 同包内其它模型，前端可忽略
```

判定规则（**不看文件名**，只看包内资产构成）：

| 包内有什么 | entry |
|---|---|
| `.skel` + `.atlas` | spine 三件套（多个 skel 时取**数据量最大**的作主模型） |
| `model3.json` | Live2D（`model3File` + `textureFiles`） |
| 都没有 | `files.json`（只有文件表；前端会拒绝装载 —— 这是**如实**结果，不是失败伪装成功） |

**纹理命名**：先按 `Texture2D.m_Name + ".png"` 落盘，再按**每个** atlas 声明的页名对齐改名
（一个包里可能有多个 atlas，实测大厅包同时含"背景 + 角色"两套）。

---

## 五、实测记录（2026-10-31）

| 项 | 结果 |
|---|---|
| 目标包 | `-mx-spinelobbies-ch0060_home-…ffe95fa1…bundle`（JS 插件因 ASTC(50) 解不了） |
| 解包 | 7 个产物（2 个 skel + 2 个 atlas + 2 个 png + entry.json），耗时 **4.3~5.6 s** |
| 字节正确性 | 与 JS 插件解同一包（akane）**sha256 完全一致**：`ada5607c…`（skel）、`cb5d71b9…`（atlas） |
| 像素正确性 | 同一 PNG 与 JS 产物**逐像素相同**（1024×1024，sha256 `15654885e94b2dfb`）；仅 PNG 编码器不同（Pillow 更小） |
| 端到端 | 页面装载成功（`stageReady=1`、运行时 3.8、无错误） |
| 进程卫生 | python 残留 0（空闲退出生效） |

**踩到的两个真坑（写在这里免得下一个人重踩）**：

1. **TextAsset 是 `str` 不是 `bytes`**：spine 的 `.skel` 是二进制，直接 `.encode()` 会抛
   `UnicodeEncodeError` 或损坏数据。必须 `encode("utf-8", errors="surrogateescape")` 往返
   （UnityPy 内部就是这么解码的；实测 3112 个 surrogate 字符，还原后 sha256 与 JS 产物一致）。
2. **这些包的 skel 是 spine 3.8.96 格式**：开头是 `hash:readString + version:readString`
   （varint 长度**含 1 字节偏移**），而不是 4.x 的 `int32 hashLow + int32 hashHigh + version`。
   前端 `probeSkelVersion` 原先只认 4.x，读到 `len=67` 直接返回 null ⇒ 退化成"用最新运行时段 4.3"
   ⇒ 报 `String in string table must not be null`。已在 `src/web/app/model-actions.js` 补 3.8 分支。

---

## 六、边界与已知限制

- **只做容器解包**，不做渲染；产物交给前端现有的 spine/live2d 通路。
- **MonoBehaviour 里的自定义数据不导出**（如 Timeline/Playable 特效包里的资源）——
  那些包本来就不是模型，`entry.json` 会是 `files.json`。
- **不处理加密包**（UnityPy 对自定义加密无解，会报容器解析失败）。
- 依赖目录由 `plugin.json` 的 `depsDir` 单项决定（写绝对路径）：换机器/换目录只改那一处，
  本文档不含任何本机路径（部署端照上面第 ②③ 步填自己的 `<deps-dir>` 即可）。
- Unity 版本实测范围：2021.3.32f1 打包的包可解；更老/更新的 Unity 版本未逐一验证。
