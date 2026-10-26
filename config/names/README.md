# 名表（`names` 分支）

本分支只放名表数据，不含代码。主分支把 `config/names/` 忽略掉了 ——
名表体积大、且是手工维护的数据，不该混进代码历史。

## 内容

```
config/names/azurlane.json   碧蓝航线
config/names/bd2.json        棕色尘埃2
config/names/dcg.json        天命之子
```

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
