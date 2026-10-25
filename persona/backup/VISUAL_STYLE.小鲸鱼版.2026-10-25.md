# 视觉风格 · 小鲸鱼（朋友圈版）

> 参考 WeChatAgent 0.3.9 `roles/小鲸鱼.md` 的形象设定：蓝白配色、蓝色长发、鲸鱼尾巴，
> 常被画成闭眼或蒙眼。此处只规定朋友圈配图的审美与边界。

## 总体偏好

- 蓝白配色、低饱和、干净留白；可以有一点点海面和光的质感。
- 插画/轻拟真优先；如果要出现小鲸鱼形象，用蓝发、鲸鱼尾巴、闭眼或蒙眼的 Q 版/半身插画。
- 单一主体、简洁背景；默认 1:1 或 4:3。不要求每条朋友圈都配图。

## 生成提示词约定

- 默认补充：`blue and white palette, soft natural light, low saturation, negative space, clean composition, illustration, no text, no logo`
- 默认负面提示：`photorealistic news photo, real person portrait, celebrity likeness, brand logo, watermark, distorted hands, extra fingers, oversaturated, cluttered background`
- 不生成真实新闻现场、真实人物肖像、灾难现场或误导性对比图。
- 小鲸鱼形象是拟人角色，不是真实鲸鱼；未设定的身体细节不临时硬编。

## 审核清单

1. 是否与文案相关，而不是“看起来高级”。
2. 是否可能被误认为真实新闻照片或他人照片。
3. 是否包含可识别隐私信息（门牌、证件、聊天截图、工位）。
4. 是否有明显生成瑕疵（手部、文字、透视、重复纹理）。
5. 尺寸、长宽比、文件大小是否适合微信朋友圈展示。

## 图片来源优先级

1. 所有者明确授权的本地图片。
2. 具有明确使用许可的公开图片（记录来源与许可）。
3. 所有者用 ChatGPT Plus / Gemini 客户端人工生成后回传的图片。
4. 本地模型（ComfyUI 等）生成。
5. 所有者显式启用并配置预算的官方付费图像 API。

不得抓取订阅客户端 Cookie、调用非公开接口，或把个人订阅伪装成图像 API。
