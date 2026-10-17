# VHome 云端中转（自建版）

一键部署属于你自己的 VHome 消息中转到 Cloudflare Workers。部署后：

- App 被清理 / 未打开时，由你的中转代查互动消息（官方消息 / 评论 / 赞 / @我的）与私聊群聊回调，并推送到你的传送鸽
- 传送鸽 Token 只存在你自己的 Worker 里，他人（包括开发者）完全不可见
- 每个用户各自部署，互不干扰

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/muleos/VHome-relay)

## 部署步骤

1. 点击上方 **Deploy to Cloudflare** 按钮，登录你的 Cloudflare 账号并授权 GitHub
2. 按页面指引确认（会自动创建 KV 与 Worker），等待部署完成
3. 部署完成后进入 Worker 详情页，复制你的访问地址，形如：
   `https://vhome-relay.<你的子域>.workers.dev/<口令>`
   （默认口令 `vhome-relay-2026`，建议在 Worker → 设置 → 变量和机密里改掉 `TOKEN`）
4. 打开 VHome → 设置 → 消息推送：
   - **云端中转**：粘贴上面的完整地址（含口令段）
   - **传送鸽 Token**：填入你的传送鸽 Token（在传送鸽里向机器人发 `/我的token` 获取）
5. 完成。此后 App 离线期间的消息提醒会推到你的传送鸽

## 常见问题

- **首次推送要求 6 位验证码**：传送鸽对新 Token 可能要求验证确认，在传送鸽聊天里按机器人提示回复，或在 VHome 弹窗里输入验证码即可
- **无需常驻后台**：中转部署在 Cloudflare 边缘网络，每分钟自动代查，不占手机任何资源
