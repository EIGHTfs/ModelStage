# 插件清单 effects 校验 · 测试样本（契约 §九 / §9.6）

这些目录**不是真插件**，是 `tool/check-plugin.mjs` 与运行期 `registry.mjs` 的校验样本。
两组实现必须给出**同一结论**（契约 §9.6 要求同口径），`test/check-plugin.test.mjs` 会同时跑两条路径断言。

## 为什么不写进 `plugins/`

`plugins/` 下每个目录都会被服务端扫描并注册；非法样本放进去会让 `/api/plugins` 天天报错。
所以样本放这里，由测试脚本按需读取（`--src` 指向样本目录，或直接调 `readPlugins`）。

## 为什么 `plugin.json` 里没有注释

`tool/check-plugin.mjs` 走 `parseJsonc`（能吃注释），但**运行期** `registry.mjs` 用的是
`JSON.parse`（不吃注释）。样本要同时喂给两条路径，所以 JSON 保持纯净；
每个样本"验什么"写在同目录的 `index.js` 头部注释与下表里。

## 样本清单

| 目录 | 期望 | 验的是 |
|---|---|---|
| `ok-basic/` | ✅ 通过 | 合法 effects（id/label/params 齐全，key 以 `u_` 开头，default 在区间内） |
| `bad-no-id/` | ❌ | `effects[].id` 必填（缺 id ⇒ 报错，不许静默补） |
| `bad-dup-a/` + `bad-dup-b/` | a ✅ / b ❌ | effects id **跨插件**全局唯一（先扫到的占位，后扫到的必须报重复） |
| `bad-param-key/` | ❌ | `params[].key` 必须以 `u_` 开头（uniform 命名空间） |
| `bad-default-range/` | ❌ | `params[].default` 必须落在 [min, max] 内 |
| `bad-panel-no-effects/` | ❌ | 声明 `panel` 角色却没声明 effects（控件必须对应一个效果） |
| `bad-no-register-call/` | ❌ | 声明了 effects 但脚本里 grep 不到 `registerEffect(` |

> `bad-dup-a` 单看是合法的（它只是"先占用 dup_effect 这个 id"）；必须与 `bad-dup-b` 一起跑才能验出跨插件唯一性。

## 一个容易误读的地方

`node tool/check-plugin.mjs --all test/fixtures/plugin-effects` 里**每个样本的整体结论都会是"不通过"**，
连 `ok-basic` 也是 —— 因为样本只写了 `index.js` 里的最小代码，B 段（vm 垫片里 register / canHandle 等）
本来就跑不完整。**这些样本只用来断言 A7（effects 校验）那一行**，
`test/check-plugin.test.mjs` 也是按 `code === 'A7'` 取行断言的，不看整体 rc。
