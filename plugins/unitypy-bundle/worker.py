#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UnityPy 解包 worker —— exec 运行时的 Python 侧（行 JSON 帧协议）。

协议（docs/设计/插件运行时与多语言.md §四）：
  父 → 子  {"id":1,"method":"canHandle","absPath":"…","size":123}
  子 → 父  {"id":1,"ok":true,"handled":true}
           {"id":1,"ok":true,"prefix":"vfs://…","entry":"entry.json",
            "files":[{"name":"a.png","tmpPath":"<插件临时目录>/a.png","size":123}]}

三条实现要点：
  ① 一行一个 JSON、UTF-8、flush —— 不 flush 的话父进程会一直等缓冲区
  ② 二进制**不进帧**：产物写临时目录，帧里只给路径与大小（20MB 包 base64 又慢又吃内存）
  ③ 临时目录要自己管：父进程是**惰性读**的（resolve 返回后才按需读盘），所以不能立刻删；
     按「保留最近 N 个解包结果」滚动清理，进程退出时全删。

TextAsset 的二进制还原（实测踩到的坑）：
  UnityPy 把 TextAsset 读成 `str`（不是 bytes），spine 的 .skel 是二进制 ⇒ 直接 .encode()
  会抛 UnicodeEncodeError 或损坏数据。正确做法是 `errors="surrogateescape"` 往返：
  UnityPy 内部就是用 surrogateescape 解码的（同一个包实测 3112 个 surrogate 字符，
  encode 回来 15606 字节，与 JS 插件产物 **sha256 完全一致**，已实测比对）。

结构：`resolve()` 只做编排；导出 / 页名对齐 / 入口判定各有自己的函数 ——
  三者能各自读、各自改，改一处不牵动另外两处。
"""
import atexit
import json
import os
import re
import shutil
import sys
import tempfile
import time
import traceback

# 保留最近多少个解包结果（父进程惰性读盘，删早了会读到空）
KEEP_RESULTS = 4
# 单次 resolve 的产物总字节上限（防止一个异常包把盘写满）
MAX_TOTAL_BYTES = 512 * 1024 * 1024

_result_dirs = []          # 最近的结果目录（新的在后）
_tmp_root = None


def _tmp_root_dir():
    """本进程专用的临时根（退出时整体删除）。"""
    global _tmp_root
    if _tmp_root is None:
        _tmp_root = tempfile.mkdtemp(prefix="unitypy-worker-")
        atexit.register(_cleanup_all)
    return _tmp_root


def _cleanup_all():
    """进程退出：删掉所有临时结果（父进程此时已不会再读）。"""
    for d in list(_result_dirs):
        shutil.rmtree(d, ignore_errors=True)
    _result_dirs.clear()
    if _tmp_root:
        shutil.rmtree(_tmp_root, ignore_errors=True)


def _rotate(keep=KEEP_RESULTS):
    """只保留最近 keep 个结果目录（更早的父进程已经读完或不会再读）。"""
    while len(_result_dirs) > keep:
        old = _result_dirs.pop(0)
        shutil.rmtree(old, ignore_errors=True)


def emit(obj):
    """写一帧：UTF-8 + 换行 + 立刻 flush（不 flush 父进程会一直等）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read_head(abs_path, n=8):
    """只读文件头 n 字节（canHandle 不许解析内容）。"""
    with open(abs_path, "rb") as f:
        return f.read(n)


def is_unity_container(head):
    """Unity 容器魔数判定（只看头，不解析）。

    UnityFS   —— 现代 AssetBundle（有压缩块）
    UnityWeb  —— 旧版 web 包
    UnityRaw  —— 旧版裸包
    判定写在插件里而不是宿主：认不认这类容器是**提供者的能力**，宿主不该内置游戏知识。
    """
    return head.startswith(b"UnityFS") or head.startswith(b"UnityWeb") or head.startswith(b"UnityRaw")


def text_asset_bytes(data):
    """把 TextAsset 还原成原始字节（surrogateescape 往返，见模块头注释）。"""
    script = getattr(data, "m_Script", None)
    if script is None:
        return None
    if isinstance(script, (bytes, bytearray)):
        return bytes(script)
    if isinstance(script, str):
        return script.encode("utf-8", errors="surrogateescape")
    return None


def texture_png(data, out_path):
    """Texture2D → PNG 落盘，返回字节数。

    用 Pillow 存（UnityPy 的 .image 已经是 PIL Image，各种压缩格式它自己解过了）。
    """
    img = getattr(data, "image", None)
    if img is None:
        return None
    # 统一成 RGBA：atlas 的页可能是 RGB，但渲染侧按 RGBA 处理更稳（含 alpha 通道）
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    img.save(out_path, format="PNG")
    return os.path.getsize(out_path)


def parse_atlas_pages(atlas_text):
    """从 atlas 文本里取每个页的**页名 + 声明的尺寸**：`[{page, w, h}]`。

    spine atlas 的结构：页名单独一行，后面跟 `size: W,H` / format / filter… 直到下一个页名。

    为什么要连 `size` 一起取：同角色多套外观会有**同名不同尺寸**的贴图
    （实测两份 `char_010_chen`：256x256 与 512x512），而两份 atlas 也都声明
    页名 `char_010_chen.png`。只按名字对号 ⇒ 会把 256² 的图贴到按 512² 算的
    region 坐标上 ⇒ 错位/缺图。尺寸是这两边唯一能互相印证的东西。
    """
    pages = []
    cur = None
    for raw in atlas_text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("size:"):
            if cur is not None and cur["w"] is None:
                parts = line.split(":", 1)[1].split(",")
                try:
                    cur["w"] = int(parts[0].strip())
                    cur["h"] = int(parts[1].strip())
                except (ValueError, IndexError):
                    pass
            continue
        if ":" in line:
            continue          # format / filter / repeat / pma / scale 等属性行
        # 页名一般带扩展名（foo.png）—— 用这一条把页名与其它裸名字区分开
        if "." in line.split("/")[-1]:
            cur = {"page": line.split("/")[-1], "w": None, "h": None}
            pages.append(cur)
    return pages


class _Progress:
    """进度帧发送器（契约 §四·⑦⑧⑩ 的插件侧）。

    只做两件事：算出"自收到请求起过了多少毫秒"、并按频率上限决定发不发。
    当前只有 read / resolve / write 三档，间隔远大于 200ms；节流是为"将来细分到
    对象级/每 N 个文件一档"预留的保险 —— 真按对象发帧会把 stdout 打满、反而拖慢解包。

    **请求没有 id 时一律不发**：进度必须挂在某个请求上，没有 id 的帧主进程无处归属。
    """

    MIN_INTERVAL_MS = 200

    def __init__(self, req_id, clock=None):
        self.req_id = req_id
        self._clock = clock or time.monotonic
        self._t0 = self._clock()
        self._last_ms = None

    def elapsed_ms(self):
        return int((self._clock() - self._t0) * 1000)

    def emit(self, phase):
        """发一帧进度。被节流跳过时返回 False（对请求本身没有任何影响）。"""
        if self.req_id is None:
            return False
        ms = self.elapsed_ms()
        if self._last_ms is not None and ms - self._last_ms < self.MIN_INTERVAL_MS:
            return False
        self._last_ms = ms
        emit({"id": self.req_id, "progress": {"phase": phase, "ms": ms}})
        return True


class _FileCollector:
    """产物清单 + 单次 resolve 的总字节上限。

    抽成小类而不是闭包 nonlocal：`add` 会在导出阶段被反复调用，
    用对象持有 total 更直白，也把"上限检查"这一条规则收在一处。
    """

    def __init__(self, max_total=MAX_TOTAL_BYTES):
        self.items = []
        self.total = 0
        self.max_total = max_total

    def add(self, name, payload_path, size):
        self.total += int(size or 0)
        if self.total > self.max_total:
            raise RuntimeError(f"产物超过上限（{self.max_total} 字节），已中止")
        self.items.append({"name": name, "tmpPath": payload_path, "size": int(size or 0)})


def _disambiguated(orig, path_id):
    """同名资源的最终落盘名：`<stem>__<pathId><ext>`。

    为什么不用序号（`__2`）：序号落在哪一份取决于**对象遍历顺序**，同一包两次导出
    或换 UnityPy 版本就可能挂到另一份上 ⇒ 缓存指纹漂移、配对结论变化、排障时
    "昨天还好好的"。pathID 在同一 serialized file 内天然唯一，同一个对象永远
    同一个名字 ⇒ **顺序无关、可回溯**。
    """
    stem, ext = os.path.splitext(orig)
    return f"{stem}__{path_id}{ext}"


def _find_texture(textures, name, w=None, h=None):
    """按**原纹理名**查；同名多份时**优先尺寸匹配**，都对不上才回落第一份。

    为什么必须尺寸优先：同角色多套外观会有同名不同尺寸的贴图（实测两份
    `char_010_chen`：256x256 与 512x512），而两份 atlas 都声明页名
    `char_010_chen.png`。只按名字取第一份 ⇒ 把 256² 的图贴到按 512² 算的
    region 坐标上 ⇒ 错位/缺图。
    """
    cands = [t for t in textures if t["name"] == name]
    if not cands:
        return None
    if w and h:
        for t in cands:
            if t.get("w") == w and t.get("h") == h:
                return t
    return cands[0]                     # 尺寸对不上（或 atlas 没声明）⇒ 回落第一份


def _atlas_regions(payload):
    """atlas 文本里的 region 名：行首无缩进、且不是属性行/页名行。"""
    if not payload:
        return []
    out = []
    for raw in payload.decode("utf-8", errors="replace").replace("\r", "").split("\n"):
        line = raw.strip()
        if not line:
            continue
        if raw[:1] in (" ", "\t"):
            continue
        if re.match(r"^(size|format|filter|repeat|pma|scale):", line):
            continue
        if line.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            continue
        out.append(line)
    return out


def _pick_atlas_for_skel(skel, atlases):
    """按 **region 命中率** 选与 skel 匹配的 atlas。

    为什么不能按名字配对：同名覆盖后 `char_010_chen.skel` 与 `char_010_chen.atlas`
    名字永远对得上，哪怕它们来自不同的一套。只有"atlas 里的 region 名能否在 skel
    的 string table 里找到"才是内容层面的真判据。

    为什么不能要求唯一命中（100%/0%）：同一角色的多套外观（`char_x` 与 `build_char_x`）
    **会共享一部分 region 名**，实测有 1~2 个噪声。所以取"命中数最高"，
    并列时按 atlas 在对象表里的先后取第一个（**稳定**，不按 set 顺序）。
    """
    skel_bytes = skel.get("payload") or b""
    best = None
    best_hits = -1
    for a in atlases:
        hits = 0
        for r in _atlas_regions(a.get("payload")):
            if r and r.encode("utf-8") in skel_bytes:
                hits += 1
        if hits > best_hits:          # 严格大于 ⇒ 并列时保留先遇到的
            best, best_hits = a, hits
    return best or (atlases[0] if atlases else None)


def _export_objects(env, out_dir, collector):
    """遍历对象表，把 TextAsset / Texture2D 导出到 out_dir。

    TextAsset 用原字节（含二进制 .skel）；Texture2D 用 Pillow 转 PNG。
    单个对象读不出来只跳过并记 stderr —— 一个坏对象不该让整包失败。
    @returns {{'texts': dict, 'textures': dict}} 名字 → 内容 / 落盘路径
    """
    # `m_Name` 不保证唯一（实测单包 2 份 char_010_chen.skel / 2 份 char_010_chen.atlas）。
    #   拿它当 dict 键或文件名会让后写覆盖先写 ⇒ skel 与 atlas 可能来自不同套 ⇒ 渲染全黑。
    #
    # 两遍走：
    #   第一遍只收集（TextAsset 读字节、Texture2D 只留 obj 引用，省内存）
    #   第二遍才落盘 —— 因为"要不要加后缀"取决于**同名出现几次**，得先知道全量。
    pending_texts = []   # [{orig, payload, path_id}]
    pending_texs = []    # [{orig, obj, path_id}]
    for obj in env.objects:
        type_name = getattr(obj.type, "name", str(obj.type))
        if type_name == "TextAsset":
            try:
                data = obj.read()
            except Exception:
                sys.stderr.write(f"skip unreadable TextAsset: {traceback.format_exc(limit=1)}\n")
                continue
            payload = text_asset_bytes(data)
            if payload is None:
                continue
            orig = getattr(data, "m_Name", None) or f"asset-{obj.path_id}"
            pending_texts.append({"orig": orig, "payload": payload, "path_id": obj.path_id})
        elif type_name == "Texture2D":
            try:
                data = obj.read()
            except Exception:
                sys.stderr.write(f"skip unreadable Texture2D: {traceback.format_exc(limit=1)}\n")
                continue
            orig = getattr(data, "m_Name", None) or f"tex-{obj.path_id}"
            pending_texs.append({"orig": orig, "obj": obj, "path_id": obj.path_id})

    # 同名计数：texts 与 textures 合并统计（贴图占 `<name>.png`，与无扩展名的 TextAsset 不会撞，
    #   但同名贴图自己要能区分）
    counts = {}
    for it in pending_texts:
        counts[it["orig"]] = counts.get(it["orig"], 0) + 1
    for it in pending_texs:
        key = f'{it["orig"]}.png'
        counts[key] = counts.get(key, 0) + 1

    texts = []      # [{name, orig, payload, pathId}]
    textures = []   # [{name, file, path, pathId}]

    for it in pending_texts:
        name = it["orig"] if counts.get(it["orig"], 1) == 1 else _disambiguated(it["orig"], it["path_id"])
        dst = os.path.join(out_dir, name)
        if os.path.dirname(dst):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(it["payload"])
        texts.append({"name": name, "orig": it["orig"], "payload": it["payload"], "pathId": str(it["path_id"])})
        collector.add(name, dst, len(it["payload"]))

    for it in pending_texs:
        key = f'{it["orig"]}.png'
        name = key if counts.get(key, 1) == 1 else _disambiguated(key, it["path_id"])
        dst = os.path.join(out_dir, name)
        # 先用**自己的名字 + .png** 落盘（Unity 里贴图名通常等于 atlas 页名去掉扩展名）。
        #   早前用 "__tex__<name>.png" 占位、只按第一个 atlas 改名，多 atlas 的包会把
        #   内部前缀漏给用户 —— 实现细节不该出现在产物里。
        data = it["obj"].read()
        size = texture_png(data, dst)
        if size is None:
            continue
        # 记下宽高：同角色多套外观有同名不同尺寸的贴图，配对时靠它区分
        textures.append({
            "name": it["orig"], "file": name, "path": dst, "pathId": str(it["path_id"]),
            "w": int(getattr(data, "m_Width", 0) or 0),
            "h": int(getattr(data, "m_Height", 0) or 0),
        })
        collector.add(name, dst, size)

    return {"texts": texts, "textures": textures}


def _rename_texture(src_path, final, collector, path_id=None):
    """把纹理改成 atlas 声明的页名，并同步产物清单里的条目。

    单独成函数，是为了把"改名 + 回写 files[]"这几层循环从 `_align_atlas_pages` 里挪出来 ——
    原来它和"遍历 atlas / 遍历页名"叠在一起是 7 层嵌套，读起来得数缩进。

    目标名被**别的还在的文件**占用时（两份 atlas 声明同一个页名），改用 `<stem>__<pathId><ext>`，
    不能直接 replace —— 那会把先落盘的那份无声覆盖掉。
    @returns {string|null} 最终路径（失败为 None）
    """
    if os.path.abspath(src_path) == os.path.abspath(final):
        return src_path                  # 名字本来就对，只记下页名归属
    target = final
    if os.path.exists(final) and os.path.abspath(final) != os.path.abspath(src_path):
        # 撞名：用 pathID 区分（顺序无关、可复现），与 _export_objects 的命名口径一致
        if path_id is None:
            return None
        target = _disambiguated(final, path_id)
    try:
        os.replace(src_path, target)
    except OSError:
        return None
    final = target
    for item in collector.items:
        if item["tmpPath"] == src_path:
            item["name"] = os.path.basename(final)
            item["tmpPath"] = final
            item["size"] = os.path.getsize(final)
            break
    return final                         # 返回新路径：调用方要同步自己的记录


def _align_atlas_pages(exported, out_dir, collector):
    """按**每个** atlas 声明的页名给纹理改名，返回 页名 → atlas 名。

    为什么不能只处理第一个 atlas：一个包里可能有多个（实测大厅包同时含
    "背景 + 角色"两套），只看第一个会让第二套贴图带着占位名漏给用户。
    前端是按 atlas 里写的页名去找 png 的，所以名字必须对齐。
    """
    texts, textures = exported["texts"], exported["textures"]
    # 用 list 而不是 dict：两份同名 atlas 都要能各自登记自己的页，dict 会让后者覆盖前者。
    page_to_atlas = []          # [{page, atlas}]
    existing = {f["name"] for f in collector.items}
    for t in texts:
        tname = t["name"]
        if not tname.lower().endswith(".atlas"):
            continue
        try:
            pages = parse_atlas_pages(t["payload"].decode("utf-8", errors="replace"))
        except Exception:
            continue
        for pg in pages:
            page, pw, ph = pg["page"], pg["w"], pg["h"]
            stem = page.rsplit(".", 1)[0] if "." in page else page
            # 按 atlas 声明的尺寸找同尺寸的那份（同名多份时唯一能互相印证的判据）
            tex = _find_texture(textures, stem, pw, ph)
            if tex is not None:
                moved = _rename_texture(tex["path"], os.path.join(out_dir, page), collector, tex.get("pathId"))
                if moved:
                    tex["path"] = moved             # 同步：后续按新路径取
                    tex["file"] = os.path.basename(moved)
                    page_to_atlas.append({"page": os.path.basename(moved), "atlas": tname})
            elif page in existing:
                page_to_atlas.append({"page": page, "atlas": tname})   # 贴图名本来就带扩展名
    return page_to_atlas


def _build_entry_doc(texts, collector, page_to_atlas):
    """按**包内资产构成**选入口，不看文件名（通用规则）。

    · 有 .skel + .atlas ⇒ spine 三件套（字段名与前端约定一致）
    · 有 model3.json   ⇒ Live2D（model3 自带引用）
    · 都没有            ⇒ None（调用方退化成文件表，如实反映"这里面没有模型定义"）
    """
    def ending_with(suffix):
        return [t for t in texts if t["name"].lower().endswith(suffix)]

    skels = ending_with(".skel")
    atlases = ending_with(".atlas")
    model3s = ending_with("model3.json")

    if skels and atlases:
        # 一个包里可能有多个模型（实测大厅包 = 背景 + 角色）。选**数据量最大**的作主模型：
        #   通用判据（主角色/主场景的数据量通常远大于附属），不依赖任何名字约定。
        #   注意：只有修掉同名覆盖后这里才是完整候选集（否则少一份，max 可能选错套）。
        main_skel = max(skels, key=lambda t: len(t.get("payload") or b""))
        # 配对按内容（region 命中率），**不按名字** —— 名字在同名覆盖下永远"对得上"，
        #   却可能把两套不同的资源拼在一起。
        main_atlas = _pick_atlas_for_skel(main_skel, atlases)
        atlas_name = main_atlas["name"] if main_atlas else None
        texs = [p["page"] for p in page_to_atlas if p["atlas"] == atlas_name]
        if not texs:
            texs = [f["name"] for f in collector.items if f["name"].lower().endswith(".png")]
        doc = {"skeletonFile": main_skel["name"], "atlasFile": atlas_name, "textureFiles": texs}
        if len(skels) > 1:
            # 同包内的其它模型（前端可忽略；列出是为了"不藏东西"）
            doc["otherSkeletons"] = [t["name"] for t in skels if t is not main_skel]
        return doc
    if model3s:
        return {
            "model3File": model3s[0]["name"],
            "textureFiles": [f["name"] for f in collector.items if f["name"].lower().endswith(".png")],
        }
    return None


def _write_entry(out_dir, entry_doc, collector):
    """落 entry.json（有模型定义）或 files.json（只有文件表），返回入口文件名。"""
    if entry_doc is not None:
        path = os.path.join(out_dir, "entry.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(entry_doc, f, ensure_ascii=False, indent=2)
        collector.add("entry.json", path, os.path.getsize(path))
        return "entry.json"
    # 没有可识别的模型定义：仍返回文件表（让用户看到包里有什么），但入口不伪装成模型。
    #   前端会因为没有 skeletonFile 而拒绝装载 —— 这是**如实**的结果。
    path = os.path.join(out_dir, "files.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"files": [f["name"] for f in collector.items]}, f, ensure_ascii=False, indent=2)
    collector.add("files.json", path, os.path.getsize(path))
    return "files.json"


def _make_prefix(root_id, rel):
    """prefix（契约 §1.2）：vfs://<providerId>/<rootId>/<rel 的 dirname>/"""
    dir_part = os.path.dirname(str(rel).replace("\\", "/"))
    dir_seg = f"{dir_part}/" if dir_part and dir_part != "." else ""
    return f"vfs://unitypy-bundle/{root_id}/{dir_seg}"


def resolve(msg):
    """真解包：UnityPy 打开容器 → 导出文件表 + entry.json（只做编排）。"""
    import UnityPy  # 懒 import：canHandle 路径不需要它（冷启更快）

    abs_path = msg.get("absPath")
    if not abs_path or not os.path.isfile(abs_path):
        return {"ok": False, "code": "ULB_ERR_NO_FILE", "message": f"文件不存在：{abs_path}"}

    progress = _Progress(msg.get("id"))

    # ① read：把包字节读进内存
    #   为什么自己读（而不是让 UnityPy.load 传路径）：只有自己读完才有"字节已就绪"这个边界，
    #   否则读与解析在 UnityPy.load 内部合成一步，进度永远只能在"全部做完"时发（等于没进度）。
    #   代价是峰值多一份包大小（实测 8MB 包 +8MB；estimateMemory 给的内存预算约 100MB，够用）。
    with open(abs_path, "rb") as f:
        raw = f.read()
    progress.emit("read")

    # ② resolve：UnityPy 解析容器 + 对象表
    env = UnityPy.load(raw)
    _ = list(env.objects)      # 枚举即触发对象表解析（此时还没 read 任何对象的数据）
    progress.emit("resolve")

    out_dir = tempfile.mkdtemp(prefix="res-", dir=_tmp_root_dir())
    _result_dirs.append(out_dir)
    _rotate()

    collector = _FileCollector()
    exported = _export_objects(env, out_dir, collector)
    page_to_atlas = _align_atlas_pages(exported, out_dir, collector)
    entry_doc = _build_entry_doc(exported["texts"], collector, page_to_atlas)
    entry_name = _write_entry(out_dir, entry_doc, collector)
    progress.emit("write")      # ③ write：全部产物已落盘

    if not collector.items:
        return {"ok": False, "code": "ULB_ERR_EMPTY_RESULT", "message": "UnityPy 未从该包导出任何文件"}

    return {
        "ok": True,
        "prefix": _make_prefix(str(msg.get("rootId") or ""), str(msg.get("rel") or "")),
        "entry": entry_name,
        "files": collector.items,
    }


def handle(msg):
    method = msg.get("method")
    if method == "canHandle":
        abs_path = msg.get("absPath")
        if not abs_path or not os.path.isfile(abs_path):
            return {"ok": True, "handled": False}
        try:
            head = read_head(abs_path)
        except OSError:
            return {"ok": True, "handled": False}
        return {"ok": True, "handled": is_unity_container(head)}
    if method == "resolve":
        return resolve(msg)
    return {"ok": False, "code": "EXEC_UNKNOWN_METHOD", "message": f"未知方法：{method}"}


def main():
    # 帧循环：一行一帧；坏行只记 stderr，不中断（子进程不能因为一行脏数据就死）
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            sys.stderr.write(f"bad frame (not json): {line[:200]}\n")
            continue
        req_id = msg.get("id")
        try:
            resp = handle(msg)
        except Exception as e:
            sys.stderr.write(traceback.format_exc())
            resp = {"ok": False, "code": "EXEC_INTERNAL", "message": f"{type(e).__name__}: {e}"}
        resp["id"] = req_id
        emit(resp)


if __name__ == "__main__":
    main()
