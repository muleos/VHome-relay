# VHome 云端中转（自建版）

一键部署属于你自己的 VHome 消息中转到 Cloudflare Workers。部署后：

- App 被清理 / 未打开时，由你的中转代查互动消息（官方消息 / 评论 / 赞 / @我的）与私聊群聊回调，并推送到你的传送鸽
- 传送鸽 Token 只存在你自己的 Worker 里，他人（包括开发者）完全不可见
- 每个用户各自部署，互不干扰

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/muleos/VHome-relay)

## 部署步骤（新版 Deploy to Cloudflare 流程）

1. 点击上方 **Deploy to Cloudflare** 按钮，登录你的 Cloudflare 账号
2. 进入「设置您的应用」后，会看到 **「克隆一个仓库」** 页面 —— 这是新版流程的正常步骤，不是报错：
   - Git 仓库 URL 已预填 `https://github.com/muleos/VHome-relay`，**直接点「继续」**
3. 首次使用会要求 **连接 GitHub 账号**：按提示登录 GitHub 并安装/授权 Cloudflare 的 GitHub App（新版流程会把仓库克隆一份到你自己的 GitHub 账号下，之后可在你自己的仓库里继续修改）
4. 配置页会自动读取仓库里的 `wrangler.toml`：
   - **KV 会自动创建**并回填 id（无需手动改占位符）
   - Worker 名称默认 `vhome-relay`，每分钟一次的定时任务（cron）自动带上
   - 确认无误后点 **「部署」**
5. 等待构建部署完成，进入 Worker 详情页，复制你的访问地址，形如：
   `https://vhome-relay.<你的子域>.workers.dev/<口令>`
   （默认口令 `vhome-relay-2026`，建议在 Worker → 设置 → 变量和机密里改掉 `TOKEN`，保存后自动重新部署）
6. 打开 VHome → 设置 → 消息推送：
   - **云端中转**：粘贴上面的完整地址（含口令段）
   - **传送鸽 Token**：填入你的传送鸽 Token（在传送鸽里向机器人发 `/我的token` 获取）；保存后首次推送时，传送鸽机器人会自动发送绑定成功提示
7. 完成。此后 App 离线期间的消息提醒会推到你的传送鸽

## 常见问题

- **「克隆一个仓库」页不知道怎么走**：仓库 URL 保持预填值不动，直接点「继续」；若提示连接 GitHub，按第 3 步授权即可
- **部署页面打不开 / 一直转圈**：`deploy.workers.cloudflare.com` 与 GitHub 在国内网络环境下通常需要代理，请先开启代理再打开部署链接
- **部署成功但 App 收不到离线推送**：`workers.dev` 域名在国内被墙，App 直连可能不通。解决办法：Worker → 设置 → 域和路由 → 添加**自定义域**（绑定一个你自己的域名），App 里改填你的自定义域地址
- **无需常驻后台**：中转部署在 Cloudflare 边缘网络，每分钟自动代查，不占手机任何资源
