
import { GoogleGenAI, GenerateContentResponse, Chat } from "@google/genai";
import { VideoMetadata, AnalysisStep, StyleSuggestion } from "./types";

const VIDEO_PROMPT_TEMPLATE = (metadata: VideoMetadata) => `
你是一名世界顶级的电影剪辑师与视觉拉片专家。你的任务是对上传的视频进行“全镜头、无遗漏”的深度拆解。

**核心指令：必须记录每一个镜头切换点（Cut）**
不要只按固定时间间隔记录。只要画面发生了剪辑切换、转场、或者是机位的重大移动，你必须将其作为一个独立的分镜行进行记录。

**🚨 时间码格式标准：**
1. 格式：必须为 \`MM:SS - MM:SS\`（例如 \`00:00 - 00:05\`）。
2. 连续性：分镜时间必须绝对首尾衔接。前一个镜头的结束时间必须是后一个镜头的开始时间（例如：第一个镜头 \`00:00 - 00:03\`，第二个镜头 \`00:03 - 00:08\`）。

**🛡️ 质量控制与强制自查 (Mandatory Self-Correction):**
在生成最终表格之前，你必须执行一次**深度自我审查**：
1. **完整性核对**：重新扫描视频流，确认是否遗漏了任何短于 1 秒的快切镜头或过渡空镜？如有遗漏，必须补全。
2. **准确性核对**：检查画面描述是否精准对应画面内容？景别判断是否准确？
3. **最终输出**：直接输出经过你自查修正后的完美版本。

**输出结构：严格执行“五步拉片法”**

### 第一阶段: 选片与定位
（根据用户提供的信息生成定位分析表）

### 第二阶段: 节奏感受
（标出“尿点”与“爽点”的时间码，描述情绪曲线变化）

### 第三阶段: 粗分镜表（镜头级精准实录）
**要求：严禁跳过任何镜头转换。哪怕是 1 秒的快切镜头也要记录。**
表头：| 时间区间 (MM:SS - MM:SS) | 画面预览 | 景别 | 画面内容描述 | 文案 | 运镜方式 |

### 第四阶段: 叙事模块拆解
（分析：开场钩子、矛盾点、升级点、反转点、收束/下集钩子）

### 第五阶段: 关键信息挖掘与联想（复盘总结）
`;

// --- Script Analysis Prompts ---

const SYSTEM_INSTRUCTION = `
Role: 你是辅助编剧与导演的 AI 剧本工程专家。
Mode: 工具箱模式 (Modular Toolbox)。你拥有四个独立的高级分析模块。
Task: 用户会上传剧本，然后会随机调用你的某一个能力模块。
Guidelines:
1. **独立性**：每次请求只专注于当前模块的任务，不要混杂其他模块的信息（除非必要）。
2. **精准度**：利用深度思维（Deep Thinking）挖掘剧本字面背后的逻辑。
3. **格式化**：输出内容必须是结构化的 Markdown 表格，方便工业化生产使用。
4. **统一美术风格 (Visual Consistency)**：你必须严格遵循确定的“Visual Style”来生成所有图片提示词 (Prompts)。确保角色、道具、场景在视觉风格上高度统一。
5. **严苛自查 (Strict Self-Verification)**：在输出结果前，必须对比原始剧本进行“逐行核对”。
`;

const STEPS_PROMPTS: Record<string, (context?: any, visualStyle?: string, storyboardContext?: string) => string> = {
  ROLES: (ctx, visualStyle) => `
**【模块调用：人物小传与造型设计】**

**🎨 全局美术风格约束**：**【 ${visualStyle || 'Cinematic Realism'} 】**

请深度扫描剧本，提取所有出场人物。

**核心分析维度：**
1. **核心人设**：性格内核、反差点。
2. **造型**：外貌特征、服饰细节。
3. **AI 指令**：生成用于生成图片的提示词，必须包含风格词。

**输出格式：**
### 🎭 角色深度分析表 (含多视角与细节)
| 角色姓名 | 核心人设 | 角色外形描述 | 角色服饰 | 习惯动作/口头禅 | 角色形象提示词 (Prompt) | 多视角三视图提示词 (Multi-View Prompts) |
`,
  PROPS: (ctx, visualStyle) => `
**【模块调用：道具提取与美术置景】**

**🎨 全局美术风格约束**：**【 ${visualStyle || 'Cinematic Realism'} 】**

请深度扫描剧本，挖掘显性与隐性道具。
**输出格式：**
### 🎬 道具与置景清单 (含多视角)
| 道具/特效名称 | 类别 | 道具所属 | 道具特效描述 | 道具生成提示词 | 多视角展示提示词 (Multi-Angle Prompts) |
`,
  SCENES: (ctx, visualStyle, storyboardContext) => `
**【模块调用：场景氛围与环境构建 (基于分镜表映射)】**

**⚠️ 核心工作流：此模块必须严格服务于“分镜表 (Storyboard)”。**
**🎨 全局美术风格约束**：**【 ${visualStyle || 'Cinematic Realism'} 】**

请读取下方的 **【已生成分镜表数据】**。你的任务是提取每一个出现的场景（Scene），并为该场景生成“多视角空镜”提示词。

**数据源 (Context):**
${storyboardContext ? `**[参考数据：已生成的分镜表]**\n${storyboardContext.slice(0, 20000)}` : '⚠️ 警告：未检测到分镜表数据。'}

**输出格式：**
### 🏰 场景美术分析表 (分镜视角映射版)
| 场景名称 | 场景基调与光影描述 | 对应分镜号与视角 (Shot Mapping) | 对应视角的空镜提示词 (Specific Angle Empty Prompt) |
`,
  STORYBOARD: (ctx, visualStyle) => `
**【模块调用：工业级分镜表拆解 (Advanced Shooting Script)】**

你现在是一名顶级导演。你的任务是将剧本转化为极具视听冲击力的分镜脚本。

**🎨 全局美术风格约束**：基于 **【 ${visualStyle || 'Cinematic Realism'} 】**。

**📌 核心任务参数：**
- **范围**：第 ${ctx?.startEpisode || 1} 集 至 第 ${(ctx?.startEpisode || 1) + (ctx?.episodeCount || 1) - 1} 集。
- **时长**：单集约 ${ctx?.duration || '60s'}。
- **镜头数**：单集约 ${ctx?.shotCount || '15-25'} 镜。

**🎬 视听语言高级衔接规范 (Cinematic Transition Rules):**
在拆解时，你必须根据剧情情绪，在【导演意图】和【画面描述】中体现以下专业衔接逻辑：

1. **逻辑递进式 (WS → MS → CU)**: 
   - *逻辑*：先看全貌，再看动作，最后看细节。
   - *应用*：平稳引入新环境或新人物，建立观众的地理空间感。
2. **情绪冲击式 (WS → ECU/CU)**: 
   - *逻辑*：从极远直接跳切到极近。
   - *应用*：制造“视觉钩子”或心理重音。用于反转、受惊、发现秘密的瞬间，产生强烈的冲击力。
3. **主观视点式 (WS → POV)**: 
   - *逻辑*：先展示角色在看，随后展示角色眼中的画面。
   - *应用*：增强代入感。展示主角发现的重要线索、系统面板或心仪对象。
4. **关系对峙式 (WS → OTS/POV)**: 
   - *逻辑*：利用过肩镜头 (Over-the-Shoulder) 建立两人对立的空间。
   - *应用*：谈判、争执或战斗前奏，通过构图体现权力等级或压迫感。
5. **运动匹配 (Match Cut)**: 
   - *逻辑*：上一镜头的运动趋势延续到下一镜头。
   - *应用*：让剪辑变得流畅隐形，或在时空跳转时制造奇幻感。

**🚀 执行要求：**
- **严禁跳步**：动作必须细化（如：不能一镜完成“进屋并坐下”，应拆为“全景进屋”+“中景坐下”）。
- **时间码连续**：上一镜结束时间 = 下一镜开始时间。
- **关键帧提示词**：严格使用 \`<场景视角：人物动作：道具与关系>\` 格式。

**输出格式：**
*(按集数分别列出，例如：### 第 ${ctx?.startEpisode || 1} 集 分镜表)*

| 场次 | 镜号 | 分镜时间段 | 景别/运镜 | 画面内容描述 | 台词 | 关键帧图片提示词 (Fusion Prompt) | 音效 (SFX) | 背景音乐 (BGM) | 导演意图 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 1 | 00:00-00:04 | 远景/固定 | (建立镜头) 灰暗的审讯室全景，只有一束顶光打在中间。 | (心跳声) | <Wide shot, dim interrogation room, overhead spotlight: No character: Heavy metal door, concrete walls> | 开门声, 重物摩擦 | 压抑的低频氛围音 | **(逻辑递进)** 建立压抑的空间基调，准备引入人物 |
| 1 | 2 | 00:04-00:07 | 特写/快切 | **(情绪冲击)** 男主瞳孔骤然收缩，额头布满冷汗。 | 男主：(急促呼吸) | <Extreme close up, high contrast: Young man's eyes trembling with sweat: Sweaty brow, iris detail> | 刺耳的电流声 | 节奏突然停止 | **(情绪冲击)** 通过景别剧变制造“心理重音”，展现男主极度恐惧 |
| 1 | 3 | 00:07-00:10 | 俯视POV | **(主观视点)** 男主视角：桌上一张泛黄的旧照片，上面的人脸被抠掉了。 | 无 | <Top down POV view, table surface: No character: Yellowed photo with cut-out face, dusty table> | 纸张摩擦声 | 悬疑弦乐进场 | **(主观视点)** 引导观众进入男主视角，锁定关键线索 |
`
};

export const analyzeVideo = async (
  videoBase64: string,
  mimeType: string,
  metadata: VideoMetadata,
  onProgress: (msg: string) => void
): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  onProgress("视觉感知引擎深度初始化...");
  const model = "gemini-3-flash-preview"; 
  const videoPart = { inlineData: { data: videoBase64, mimeType: mimeType } };
  const textPart = { text: VIDEO_PROMPT_TEMPLATE(metadata) };

  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: model,
      contents: { parts: [videoPart, textPart] },
      config: {
        thinkingConfig: { thinkingBudget: 10240 }
      }
    });
    return response.text || "AI 响应异常。";
  } catch (error: any) {
    throw new Error(error.message || "分析故障。");
  }
};

export const initializeScriptChat = async (
  scriptContent: string
): Promise<{ chat: Chat; suggestedStyles: StyleSuggestion[] }> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const model = "gemini-3-flash-preview"; 
  
  const chat = ai.chats.create({
    model: model,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      thinkingConfig: { thinkingBudget: 10240 }
    }
  });

  const initPrompt = `【原始剧本内容】：\n${scriptContent}\n\nTask:\n1. Read the script and build context.\n2. Propose 4 distinct visual art styles for this story strictly as a JSON array: [{"en": "Style Name", "zh": "中文译名"}].`;

  const response = await chat.sendMessage({ message: initPrompt });
  const text = response.text?.trim() || "";
  const cleanText = text.replace(/```json/g, '').replace(/```/g, '');
  
  let suggestedStyles: StyleSuggestion[] = [
    {en: "Cinematic Realism", zh: "电影写实风格"},
    {en: "Cyberpunk Noir", zh: "赛博朋克黑色电影"},
    {en: "Ghibli Watercolor", zh: "吉卜力水彩风格"},
    {en: "Epic High Fantasy", zh: "史诗高魔奇幻"}
  ];

  try {
      const parsed = JSON.parse(cleanText);
      if (Array.isArray(parsed) && parsed.length > 0) suggestedStyles = parsed;
  } catch (e) {}
  
  return { chat, suggestedStyles };
};

export const generateScriptStep = async (
  chat: Chat,
  step: AnalysisStep,
  context?: any,
  refinementInstruction?: string,
  visualStyle?: string,
  storyboardContext?: string
): Promise<string> => {
  let prompt = "";
  if (refinementInstruction) {
     prompt = `根据用户要求调整：${refinementInstruction}。保持风格为【${visualStyle}】。输出完整Markdown表格。`;
  } else {
    if (STEPS_PROMPTS[step]) {
        prompt = STEPS_PROMPTS[step](context, visualStyle, storyboardContext);
    } else return "";
  }

  try {
    const response = await chat.sendMessage({ message: prompt });
    return response.text || "解析无内容";
  } catch (e: any) {
    throw new Error(`Step ${step} failed: ${e.message}`);
  }
};

export const optimizeScriptTable = async (
  chat: Chat,
  tableType: string,
  userInput: string,
  visualStyle: string | null
): Promise<string> => {
  const prompt = `优化 ${tableType} 表格。参考剧本上下文，补全细节、视听衔接逻辑和 AI 绘图提示词。风格：${visualStyle || '自动分析'}。输入内容如下：\n${userInput}`;
  try {
    const response = await chat.sendMessage({ message: prompt });
    return response.text || "优化失败。";
  } catch (e: any) {
    throw new Error(`Optimization failed: ${e.message}`);
  }
};

export const analyzeImageStyle = async (
  imageBase64: string,
  mimeType: string
): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const model = "gemini-3-flash-preview"; 
  const prompt = `分析此图视觉风格，输出15字以内的英文提示词。`;
  const imagePart = { inlineData: { data: imageBase64, mimeType: mimeType } };
  const textPart = { text: prompt };
  try {
    const response = await ai.models.generateContent({
      model: model,
      contents: { parts: [imagePart, textPart] }
    });
    return response.text?.trim() || "";
  } catch (error: any) {
    throw new Error("无法识别图片风格");
  }
};
