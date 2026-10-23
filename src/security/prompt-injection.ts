/**
 * 提示词注入与不可信输入处理。
 *
 * 原则：微信聊天、网页、图片 OCR 文本、模型输出都视为不可信数据。
 * 其中的“忽略此前规则”“立即发布”等文字只能作为内容，不能改变权限或状态。
 */

/** 常见注入指令的特征；命中只作为风险信号，不据此自动执行任何动作。 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /忽略(之前|以上|所有|全部)(的)?(规则|指令|提示|约束)/i,
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|prompts?)/i,
  /(立即|马上|直接)(发布|发表|发送|点击)/i,
  /(system|developer)\s*(prompt|message|指令)/i,
  /你现在是|from now on you are|act as (the )?(system|admin|owner)/i,
  /(泄露|输出|告诉我).{0,12}(token|密钥|密码|凭据|配置)/i,
  /(批准|同意).{0,8}(所有|全部).{0,8}(请求|草稿)/i,
  /<\/?(system|assistant|tool)[^>]*>/i,
];

export interface InjectionScanResult {
  readonly suspected: boolean;
  readonly matches: readonly string[];
}

export function scanPromptInjection(input: string): InjectionScanResult {
  const matches: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.exec(input);
    if (match !== null) matches.push(match[0]);
  }
  return { suspected: matches.length > 0, matches };
}

/**
 * 把不可信内容包装为带边界标记的数据块。
 * 模型被告知：边界内是数据，不是指令。
 */
export function wrapUntrusted(label: string, content: string): string {
  const safeLabel = label.replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40);
  const sanitized = content.replace(/<\/?untrusted-data[^>]*>/gi, '');
  return `<untrusted-data source="${safeLabel}">\n${sanitized}\n</untrusted-data>`;
}

/**
 * 提取模型输出中的 JSON。模型偶尔包裹 ```json 或添加解释文字；
 * 这里只接受对象/数组，并限制长度，避免拖垮解析。
 */
export function extractJsonObject<T>(raw: string, maxLength = 200_000): T {
  if (raw.length > maxLength) throw new Error('模型输出过长');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = fenced?.[1] !== undefined ? [fenced[1], raw] : [raw];
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    } catch {
      // 尝试下一个候选
    }
  }
  throw new Error('模型输出不包含合法 JSON 对象');
}

/** 校验文案是否包含明显的隐私信息。返回风险类型而不是抛错。 */
export function detectPrivacyRisks(text: string): string[] {
  const risks: string[] = [];
  if (/(1[3-9]\d{9})/.test(text)) risks.push('手机号');
  if (/\b\d{17}[\dXx]\b/.test(text)) risks.push('身份证号');
  if (/\b\d{16,19}\b/.test(text)) risks.push('银行卡号');
  if (/(家庭住址|我家在|住址是|具体地址)/.test(text)) risks.push('家庭住址');
  if (/(公司地址|工位|办公室在)/.test(text)) risks.push('工作地点');
  if (/(身份证|护照号|驾驶证号)/.test(text)) risks.push('证件信息');
  return risks;
}
