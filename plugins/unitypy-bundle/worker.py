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
    """从 atlas 文本里取页名（每个纹理页 = 一个图片文件名 + 若干属性行）。

    spine atlas 的结构：页名单独一行，后面跟 size/format/filter… 直到下一个页名。
    这里只需要页名列表（用来把 Texture2D 对上号），不需要解析 region。
    """
    pages = []
    for raw in atlas_text.splitlines():
        line = raw.strip()
        if not line or ":" in line or line.startswith("#"):
            # 属性行形如 "size: 1024,1024"；页名本身不带冒号
            continue
        # 页名一般带扩展名（foo.png）—— 用这一条把页名与其它裸名字区分开
        if "." in line.split("/")[-1]:
            pages.append(line.split("/")[-1])
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


def _export_objects(env, out_dir, collector):
    """遍历对象表，把 TextAsset / Texture2D 导出到 out_dir。

    TextAsset 用原字节（含二进制 .skel）；Texture2D 用 Pillow 转 PNG。
    单个对象读不出来只跳过并记 stderr —— 一个坏对象不该让整包失败。
    @returns {{'texts': dict, 'textures': dict}} 名字 → 内容 / 落盘路径
    """
    texts = {}
    textures = {}
    for obj in env.objects:
        type_name = getattr(obj.type, "name", str(obj.type))
        try:
            data = obj.read()
        except Exception:
            sys.stderr.write(f"skip unreadable object {type_name}: {traceback.format_exc(limit=1)}\n")
            continue

        if type_name == "TextAsset":
            name = getattr(data, "m_Name", None) or f"asset-{obj.path_id}"
            payload = text_asset_bytes(data)
            if payload is None:
                continue
            texts[name] = payload
            dst = os.path.join(out_dir, name)
            if os.path.dirname(dst):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "wb") as f:
                f.write(payload)
            collector.add(name, dst, len(payload))

        elif type_name == "Texture2D":
            name = getattr(data, "m_Name", None) or f"tex-{obj.path_id}"
            # 先用**自己的名字 + .png** 落盘（Unity 里贴图名通常等于 atlas 页名去掉扩展名）。
            #   早前用 "__tex__<name>.png" 占位、只按第一个 atlas 改名，多 atlas 的包会把
            #   内部前缀漏给用户 —— 实现细节不该出现在产物里。
            dst = os.path.join(out_dir, f"{name}.png")
            size = texture_png(data, dst)
            if size is None:
                continue
            textures[name] = dst
            collector.add(f"{name}.png", dst, size)
    return {"texts": texts, "textures": textures}


def _rename_texture(src_path, final, collector):
    """把纹理改成 atlas 声明的页名，并同步产物清单里的条目。

    单独成函数，是为了把"改名 + 回写 files[]"这几层循环从 `_align_atlas_pages` 里挪出来 ——
    原来它和"遍历 atlas / 遍历页名"叠在一起是 7 层嵌套，读起来得数缩进。
    @returns {boolean} 是否（或本来就）已是目标名
    """
    if os.path.abspath(src_path) == os.path.abspath(final):
        return True                      # 名字本来就对，只需记下页名归属
    try:
        os.replace(src_path, final)
    except OSError:
        return False
    for item in collector.items:
        if item["tmpPath"] == src_path:
            item["name"] = os.path.basename(final)
            item["tmpPath"] = final
            item["size"] = os.path.getsize(final)
            break
    return True


def _align_atlas_pages(exported, out_dir, collector):
    """按**每个** atlas 声明的页名给纹理改名，返回 页名 → atlas 名。

    为什么不能只处理第一个 atlas：一个包里可能有多个（实测大厅包同时含
    "背景 + 角色"两套），只看第一个会让第二套贴图带着占位名漏给用户。
    前端是按 atlas 里写的页名去找 png 的，所以名字必须对齐。
    """
    texts, textures = exported["texts"], exported["textures"]
    page_to_atlas = {}
    existing = {f["name"] for f in collector.items}
    for tname in list(texts.keys()):
        if not tname.lower().endswith(".atlas"):
            continue
        try:
            pages = parse_atlas_pages(texts[tname].decode("utf-8", errors="replace"))
        except Exception:
            continue
        for page in pages:
            stem = page.rsplit(".", 1)[0] if "." in page else page
            if stem in textures:
                if _rename_texture(textures[stem], os.path.join(out_dir, page), collector):
                    page_to_atlas[page] = tname
            elif page in existing:
                page_to_atlas[page] = tname       # 贴图名本来就带扩展名
    return page_to_atlas


def _build_entry_doc(texts, collector, page_to_atlas):
    """按**包内资产构成**选入口，不看文件名（通用规则）。

    · 有 .skel + .atlas ⇒ spine 三件套（字段名与前端约定一致）
    · 有 model3.json   ⇒ Live2D（model3 自带引用）
    · 都没有            ⇒ None（调用方退化成文件表，如实反映"这里面没有模型定义"）
    """
    def ending_with(suffix):
        return [n for n in texts if n.lower().endswith(suffix)]

    skels = ending_with(".skel")
    atlases = ending_with(".atlas")
    model3s = ending_with("model3.json")

    if skels and atlases:
        # 一个包里可能有多个模型（实测大厅包 = 背景 + 角色）。选**数据量最大**的作主模型：
        #   通用判据（主角色/主场景的数据量通常远大于附属），不依赖任何名字约定。
        main_skel = max(skels, key=lambda n: len(texts.get(n) or b""))
        stem = main_skel.rsplit(".", 1)[0]
        main_atlas = next((a for a in atlases if a.rsplit(".", 1)[0] == stem), atlases[0])
        texs = [page for page, at in page_to_atlas.items() if at == main_atlas]
        if not texs:
            texs = [f["name"] for f in collector.items if f["name"].lower().endswith(".png")]
        doc = {"skeletonFile": main_skel, "atlasFile": main_atlas, "textureFiles": texs}
        if len(skels) > 1:
            # 同包内的其它模型（前端可忽略；列出是为了"不藏东西"）
            doc["otherSkeletons"] = [s for s in skels if s != main_skel]
        return doc
    if model3s:
        return {
            "model3File": model3s[0],
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
