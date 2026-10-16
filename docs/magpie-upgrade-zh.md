# 升级项目内的 Magpie

Rein 使用未经修改的 Magpie 可执行文件，Provider 协议、登录和 token 刷新由 Magpie 维护。
版本固定在 [`plugins/rein-router/magpie.lock.json`](../plugins/rein-router/magpie.lock.json)，
通过升级 PR 跟进上游；目前没有自动监测上游更新或自动创建升级 PR 的任务。
`magpie:setup` 只构建锁定版本，不会自动选择最新版。原生配置界面的自动更新也保持关闭。

以下命令适用于 macOS / Linux，在仓库根目录、同一个终端执行。
先完成[快速上手中的依赖安装](model-router-quickstart-zh.md#1-安装依赖)，确保 Git、Go、
受支持的 Node.js 和 pnpm 可用；已有项目工具链时执行：

```sh
export PATH="$PWD/.toolchain/node_modules/.bin:$PATH"
```

维护者按步骤 1–5 准备升级 PR。使用者应用已合并的升级时，先按步骤 1 备份旧版本，
再切换到包含升级的 Rein 版本，执行步骤 3 和 5；步骤 4 的兼容性回归由升级 PR 的 CI 验证，
也可以在本地复现。本流程不升级 OpenClaw，也不修改 `vendor/openclaw`。

## 1. 停止服务并备份旧版本

先停止使用该 Magpie 私有目录的 OpenClaw 网关和配置界面。前台运行的进程在启动终端按 Ctrl-C；
通过 OpenClaw 服务运行时，使用对应配置的 `pnpm run openclaw gateway stop`。
若使用其他进程管理器，还需暂停它的自动重启。确认进程已退出后再操作文件。

下面的备份包含 Magpie 私有账号、网关 Key、Router 配置、OpenClaw 状态以及旧二进制和校验凭据。
备份保存在 Git 忽略的 `runtime/backups` 下，不要提交或上传。
命令按已成功准备过 Magpie 的标准项目路径编写；自定义路径的部署需替换为实际路径。

```sh
set -e
umask 077
node scripts/magpie-dependency.mjs --check
test ! -e runtime/magpie/.rein-magpie.lock
MAGPIE_BACKUP_DIR="$PWD/runtime/backups/magpie-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$MAGPIE_BACKUP_DIR"
chmod 700 "$MAGPIE_BACKUP_DIR"
git rev-parse HEAD > "$MAGPIE_BACKUP_DIR/rein-revision.txt"
cp -p plugins/rein-router/magpie.lock.json "$MAGPIE_BACKUP_DIR/magpie.lock.json"
cp -p .toolchain/magpie-bin/magpie "$MAGPIE_BACKUP_DIR/magpie"
cp -p .toolchain/magpie-bin/magpie.json "$MAGPIE_BACKUP_DIR/magpie.json"
cp -a runtime/magpie "$MAGPIE_BACKUP_DIR/profile"
cp -a runtime/openclaw "$MAGPIE_BACKUP_DIR/openclaw"
printf '备份目录：%s\n' "$MAGPIE_BACKUP_DIR"
```

若仍有 `.rein-magpie.lock`，先按[进程恢复说明](unified-subscription-access.md#project-local-magpie-lifecycle)
核查所属进程；不要直接删除锁。备份不应包含运行中进程持有的锁。
记下备份目录；换终端后需要重新设置 `MAGPIE_BACKUP_DIR`。

## 2. 选择上游提交并更新版本锁定

在 [Magpie 上游仓库](https://github.com/yetone/magpie)选择已审查的发布版本或提交，
阅读当前版本到目标版本间的变更，关注网关接口、模型命名、认证存储、配置迁移和构建要求。
使用目标提交的完整 40 位 SHA，不能把 `main`、`latest` 或 tag 名直接写入锁定文件。

维护者先确认工作区无未处理改动，再创建升级分支：

```sh
git status --short
git switch -c tempest/upgrade-magpie
export MAGPIE_TARGET_REVISION='REPLACE_WITH_REVIEWED_40_CHARACTER_COMMIT_SHA'
```

替换占位符后执行以下命令。它核查项目内上游 checkout 的来源及清洁状态，获取目标提交，
从该提交的 `go.mod` 读取 Go 版本，然后更新锁定文件；此时还不会替换已安装的二进制。

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { magpiePaths, readMagpieLock } from './scripts/magpie-dependency.mjs';
const revision = process.env.MAGPIE_TARGET_REVISION;
assert.match(revision ?? '', /^[a-f0-9]{40}$/, '请填写已审查的完整提交 SHA');
const paths = magpiePaths();
const lock = readMagpieLock();
const git = args => execFileSync('git', ['-C', paths.source, ...args], { encoding: 'utf8' }).trim();
assert.equal(git(['remote', 'get-url', 'origin']), lock.repository);
assert.equal(git(['status', '--porcelain', '--untracked-files=all']), '', 'Magpie checkout 必须保持干净');
git(['fetch', '--depth=1', 'origin', revision]);
assert.equal(git(['rev-parse', 'FETCH_HEAD']), revision);
const mod = git(['show', `${revision}:go.mod`]);
assert.match(mod, /^module github\.com\/yetone\/magpie\s*$/m);
const goVersion = mod.match(/^go (\S+)$/m)?.[1];
assert.match(goVersion ?? '', /^\d+\.\d+\.\d+$/, '请核查新的 Go 版本格式');
const next = { ...lock, revision, version: `rein-${revision.slice(0, 12)}`, goVersion };
writeFileSync(paths.lock, JSON.stringify(next, null, 2) + '\n');
readMagpieLock();
console.log(`已锁定 Magpie ${next.version}，Go ${next.goVersion}`);
NODE
git diff -- plugins/rein-router/magpie.lock.json
```

`version` 是 Rein 构建标识，由提交 SHA 的前 12 位生成，不是上游发布标签。
`schemaVersion`、`repository` 和 `buildTags: ["nogui"]` 保持现有约定。
若上游不再满足这些约定，应在升级 PR 中调整构建及兼容层，不能绕过校验或改用全局安装。

## 3. 构建并校验项目内二进制

保持原网关与配置界面停止，执行：

```sh
pnpm run magpie:setup
node scripts/magpie-dependency.mjs --check
pnpm run magpie -- version
```

首次构建可能下载 Go 工具链和模块依赖。准备脚本检出锁定提交，以 `nogui`、`CGO_ENABLED=0`
构建到 `.toolchain/magpie-bin`，并写入包含提交、版本和 SHA-256 的 `magpie.json`。
显示的版本应与锁定文件一致；运行时会再次检查二进制与校验凭据。
不要手动编辑校验凭据来接受外部下载的二进制。

构建失败时保持服务停止，修复问题或执行步骤 6。不要假定失败后旧二进制仍与新的锁定文件匹配。

## 4. 运行兼容性回归并提交升级 PR

在已安装依赖并构建 OpenClaw 的开发环境执行：

```sh
pnpm run check
pnpm test
pnpm run eval:subscriptions
pnpm run verify:subscriptions
pnpm run verify:subscriptions:slack
pnpm run verify:subscriptions --magpie-checkout .toolchain/magpie
pnpm run verify:subscriptions:managed
REIN_RUN_NATIVE_MAGPIE_UI=1 node --test tests/magpie-ui-native.test.mjs
REIN_RUN_NATIVE_BAILIAN_SYNTHETIC=1 node --test tests/bailian-subscription-probe-native.test.mjs
git -C .toolchain/magpie status --porcelain --untracked-files=all
git -C vendor/openclaw status --porcelain
```

最后两个命令应无输出。这组检查使用隔离配置、合成凭据和本地端点，不连接真实 Discord / Slack，
不调用付费 Jev 或真实 Provider；构建过程仍可能访问依赖下载源。
覆盖模型切换、手动锁定、配置回退、思考强度、流式工具调用、Key 范围和进程生命周期。
这些检查不能代替真实账号的登录、刷新及计费验收。

升级 PR 还需通过 [OpenClaw integration CI](../.github/workflows/openclaw.yml)。其中包含上游
token 刷新和 Claude bridge 的离线测试；若上游更改测试名称或内部接口，需要更新夹具并确认
测试实际执行，不能仅删除失效检查。生产插件仍通过可执行文件和网关接口集成。

PR 应记录新旧 Magpie 提交、相关上游变更、兼容性结果、迁移要求及回滚办法。
只提交锁定文件、必要的 Rein 适配/测试和文档；私有备份及 `.toolchain` 保持忽略。

## 5. 检查配置并恢复使用

使用者应在升级 PR 合并后应用对应的 Rein 版本，再完成步骤 3。启动网关前检查模型目录：

```sh
pnpm run magpie -- --allow-subscription-accounts models
```

如果模型 ID 或路由目录发生变化，更新实际 Router 源 JSON，在网关停止时重新限定项目 Key：

```sh
pnpm run magpie:prepare-key --replace runtime/magpie/router.quickstart.local.json
```

该路径来自快速上手示例，按部署替换。重新生成并合并相应的
[Model Router](model-router-quickstart-zh.md#4-准备网关-key并生成-openclaw-配置片段)或
[Dynamic Router](model-router-quickstart-zh.md#2-生成-dynamic-router-配置片段)配置片段，
保留原 Agent、频道和工具配置；目录未变时不需要轮换 Key。
升级本身不应打开 `allowPaidUsage`、`allowPaidJev`，或增加未配置的 fallback。

需要登录或迁移账号时使用 `pnpm run magpie:ui` 的 Magpie 原生流程，结束后关闭界面。
在维护者准备升级 PR 时继续保持原服务停止；本地兼容性测试不要求启用真实账号。
使用者完成已合并升级后，按原部署方式恢复 OpenClaw。前台运行示例：

```sh
pnpm run openclaw plugins doctor
pnpm run openclaw gateway run
```

另开终端检查健康状态，`18791` 按实际网关端口替换：

```sh
pnpm run openclaw gateway health --port 18791
```

需要真实 Provider 验收时，另行按已配置的账号和计费开关安排小规模检查。
离线 CI 通过不表示所有真实账号都已验收。

## 6. 回滚

先按步骤 1 停止所有使用该私有目录的进程并暂停自动重启。
回到备份记录的 Rein 代码版本；正式回滚应撤销整个升级提交，包含必要的适配改动，
不能只回退 Magpie 却保留不兼容的插件代码。
如果上游已迁移私有存储格式，旧二进制也必须配合升级前的配置备份。

确认 `MAGPIE_BACKUP_DIR` 指向本次升级前的完整备份后，恢复旧锁定文件、二进制和校验凭据，
以及配套的 Magpie / OpenClaw 目录。失败版本的目录保留在 `runtime` 下便于检查：

```sh
set -e
test ! -e runtime/magpie/.rein-magpie.lock
test -f "$MAGPIE_BACKUP_DIR/magpie.lock.json"
test -f "$MAGPIE_BACKUP_DIR/magpie"
test -f "$MAGPIE_BACKUP_DIR/magpie.json"
test -d "$MAGPIE_BACKUP_DIR/profile"
test -d "$MAGPIE_BACKUP_DIR/openclaw"
MAGPIE_FAILED_SUFFIX="$(date +%Y%m%d-%H%M%S)"
mv runtime/magpie "runtime/magpie.failed-$MAGPIE_FAILED_SUFFIX"
mv runtime/openclaw "runtime/openclaw.failed-$MAGPIE_FAILED_SUFFIX"
cp -a "$MAGPIE_BACKUP_DIR/profile" runtime/magpie
cp -a "$MAGPIE_BACKUP_DIR/openclaw" runtime/openclaw
cp -p "$MAGPIE_BACKUP_DIR/magpie.lock.json" plugins/rein-router/magpie.lock.json
cp -p "$MAGPIE_BACKUP_DIR/magpie" .toolchain/magpie-bin/magpie
cp -p "$MAGPIE_BACKUP_DIR/magpie.json" .toolchain/magpie-bin/magpie.json
node scripts/magpie-dependency.mjs --check
pnpm run magpie -- version
```

校验通过后按步骤 5 恢复服务。也可以在回到旧锁定文件后运行 `pnpm run magpie:setup`
重新构建旧版本；重建二进制不会恢复私有存储，配置迁移仍需用备份回退。
恢复 OpenClaw 目录会回到备份时的 session 和状态，升级后产生的数据保留在失败版本目录中。
备份不能恢复已在远端撤销的 token / Key；若凭据失效，使用 Magpie 原生流程重新认证或准备 Key。
目前备份、升级和回滚均由维护者手动执行。
