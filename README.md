# 名表（`names` 分支）

本分支只放名表数据，不含代码。主分支把 `config/names/` 忽略掉了 ——
名表体积大、且是手工维护的数据，不该混进代码历史。

## 内容（本分支根目录，无子目录）

```
碧蓝航线.json
棕色尘埃2.json
天命之子.json
NIKKE.json
```

分支根目录直接就是数据文件：克隆下来即可读、对比、增补，不必再进子目录。

## 发布改动（名表在项目里是 `config/names/`，被主分支忽略）

```
git clone --branch names --single-branch <repo-url> /tmp/names-pub
cp <项目>/config/names/*.json /tmp/names-pub/
cd /tmp/names-pub && git add -A
git commit -m "names(<游戏>): <改了什么>"
git push origin names
```

推送后把 `/tmp/names-pub/*.json` 反向同步回项目的 `config/names/`（两边内容必须一致，
服务读的是项目里那份）。NIKKE 名表由 `NikkeSpine/assets/names.json` 生成，
规则见主分支 `docs/设计/名表.md`。

文件名 = 游戏完整中文名（与 `resources.json` 里根的 `names` 字段逐字一致）。
格式见主分支 `docs/设计/名表.md`：`characters` 以角色 id 为键、`byAsset` 是「资源文件名 → 角色 id」，
`name` / `costume` 是多语言数组，`_meta.mergeBy` 声明归并字段。

## 取用

```bash
# 只把名表取到工作区（不影响当前分支）
git checkout names -- config/names

# 或直接克隆本分支
git clone -b names <repo> <dir>
```

## 修改

改完在本分支提交；**不要在 main 提交名表**。服务端按文件 mtime 自动失效缓存，存盘即生效，无需重启。
