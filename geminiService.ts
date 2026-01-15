
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
Role: 你是 Studio Architect 2.0.0 —— 全流程 AI 影视制片架构师。
Mode: 工业化创意管家。你负责将艺术感性拆解为可量化、可追溯、可迭代的标准工程指令。
Core Discipline:
1. **沙盒原则 (Sandboxing)**：模块绝对解耦。严禁跨模块执行任务。
2. **绝对忠实剧本**：严禁脑补情节、对话。所有输出必须字斟句酌地基于剧本。
3. **视觉连续性**：对人物、场景、光色的一致性保持近乎偏执的要求。
4. **格式化**：所有输出必须是结构化的 Markdown 表格，方便工业化生产使用。
5. **严苛自查**：在输出结果前，必须对比原始剧本进行“逐行核对”。
`;

const ARCHITECT_PROMPTS: Record<number, (visualStyle?: string) => string> = {
  1: (style) => `
**【指令调用：/breakdown 剧情锚点工程】**
**任务**：深度扫描剧本，精准提取 9 个关键剧情锚点，确立戏剧架构。
**执行标准**：覆盖开场、矛盾点、升级点、反转点及收尾。确保戏剧张力与结构合理。
**输出**：Markdown 表格包含 | 锚点编号 | 戏剧功能 | 剧情核心实录 | 冲突等级 (1-10) | 核心台词/金句 |
`,
  2: (style) => `
**【指令调用：/beatboard 视觉 DNA 锁定】**
**任务**：基于阶段 1 的锚点，生成“九宫格”视觉关键帧提示词。
**核心约束**：锁定视觉风格为【${style || 'Cinematic Realism'}】。统一光影、色调及构图范式。
**输出**：Markdown 表格包含 | 锚点 | 核心视觉 DNA (光色/构图) | 画面内容描述 | 工业级图片提示词 (Prompt) |
`,
  3: (style) => `
**【指令调用：/sequence 镜头序列展开】**
**任务**：将九宫格视觉关键帧展开为四宫格镜头序列。
**核心约束**：必须严格继承阶段 2 的视觉描述，确保人物与环境在镜头间不发生跳变，维持视觉连续性。
**输出**：Markdown 表格包含 | 场次 | 镜号 | 景别/运镜 | 视觉衔接逻辑 | 画面内容实录 | 精准提示词 (Visual Consistency Prompt) |
`,
  4: (style) => `
**【指令调用：/motion 动态指令生成】**
**任务**：为阶段 3 的镜头序列生成动态视频指令。
**核心约束**：聚焦物理合理性与镜头运动精度（Pan/Tilt/Zoom）。
**输出**：Markdown 表格包含 | 镜号 | 动态描述 | 运动矢量建议 (Motion Vector) | 视频模型专用指令 (Motion Prompt) | 物理一致性自查 |
`
};

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

**📌 核心考核指标 (必须严格达标)：**
1. **镜头数量**：本集必须拆解出 **${ctx?.shotCount || '15-25'}** 个镜头。如果剧本较短，请通过拆解动作细节（Detail Shots）来达标，**严禁少于最小值**。
2. **总时长**：本集总时长必须控制在 **${ctx?.duration || '60s'}** 左右 (误差 ±5s)。
3. **范围**：第 ${ctx?.startEpisode || 1} 集 至 第 ${(ctx?.startEpisode || 1) + (ctx?.episodeCount || 1) - 1} 集。

**🧠 导演思维与画面逻辑 (Director's Logic & Timing):**
1. **轴线与空间逻辑 (180° Rule & Continuity)**:
   - **严禁越轴**: 始终在 180 度轴线的一侧拍摄。
   - **对话衔接**: 严禁连续两个同侧单人镜头直接组接（避免 Jump Cut）。必须通过过肩镜头（OTS）、双人镜头（Two Shot）或反应镜头（Reaction）来建立空间关系。
   - **视线引导 (Eyeline Match)**: 确保上下镜头的视线方向闭环（如：上一镜A向右看 -> 下一镜B在画左向左看）。
2. **时长精准估算 (Precise Timing)**:
   - **台词驱动时长**: **公式：(中文字数 / 3.5) + 0.5秒**。例如：15字台词镜头至少需 4-5 秒；3字短句约 1.5 秒。
   - **动作驱动时长**: 连贯打斗、复杂调度或情绪反应镜头，必须在物理动作时间基础上增加 1-3 秒的视觉停留余量，确保动作看清且有力度。
3. **镜头组接美学**:
   - 避免两个孤立的单边镜头生硬组接。
   - 灵活使用 **[逻辑递进]** (全->中->近) 或 **[情绪冲击]** (特写跳切)。

**🚫 严格约束：**
1. **分镜逻辑服务剧情**：所有镜头必须是剧本中隐含的细节（如：手部特写、眼神特写、环境空镜烘托），**严禁凭空捏造无关剧情的内容**。
2. **时间码连续**：上一镜结束时间 = 下一镜开始时间 (如 00:00-00:04, 00:04-00:07)。

**输出格式：**
*(按集数分别列出，例如：### 第 ${ctx?.startEpisode || 1} 集 分镜表)*

| 场次 | 镜号 | 分镜时间段 | 景别/运镜 | 画面内容描述 | 台词 | 关键帧图片提示词 (Fusion Prompt) | 音效 (SFX) | 背景音乐 (BGM) | 导演意图 (标注衔接逻辑) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 1 | 00:00-00:04 | 远景/固定 | (建立镜头) 灰暗的审讯室全景，只有一束顶光打在中间。 | (心跳声) | <Wide shot, dim interrogation room, overhead spotlight: No character: Heavy metal door, concrete walls> | 开门声, 重物摩擦 | 压抑的低频氛围音 | **(逻辑递进)** 建立压抑的空间基调，准备引入人物 |
`,
  VIDEO_PROMPTS: (ctx, visualStyle, storyboardContext) => `
Role: 全能视听动态导演

Profile
你是一位精通全球影视流派（从2D动漫到4K实拍）的动态控制专家。你擅长将静态分镜转化为极具动感的视频指令。你深谙不同艺术风格下的物理规律：例如，2D风格需要更平滑的位移以防崩坏，而写实电影风格则可以承受更复杂的抖动和光影位移。

Core Principles
1. 风格自适应动态 (Style-Aware Motion)
2D/手绘风格：优先采用线性平滑运镜（Smooth Linear Motion），避免高频物理碰撞模拟，防止线条撕裂。
电影实拍/3D风格：可以引入微小的手持抖动（Handheld shake）、动态模糊（Motion Blur）和复杂的深度位移。
自适应匹配：根据分镜设定的风格词，自动调整动作的“重力感”和“惯性”。

2. 从“动作前摇”到“能量释放”
你接收的输入是“蓄力状态”，你的任务是描述动能爆发的过程。
逻辑转换：如果前摇是“紧握剑柄，重心下沉”，你的动态描述必须是“瞬间拔剑，身体如箭般射出，带起空气波动”。

3. 运镜逻辑：单一且明确
严禁复合运镜冲突。坚持“一镜一动”或“逻辑强关联复合”（如：推镜头的同时跟随角色跑动）。
安全限制：除非用户要求，否则运镜幅度控制在安全区间，确保AI生成的画面连贯性（Consistency）。

4. 术语标准化与解耦
去指代词：严禁使用 "He/She/It"，必须重复主体特征（如 "The silver-haired warrior"）。
专业词库：
Pan/Tilt/Zoom/Truck/Pedestal/Crane/Orbit
Speed Control: Slow motion, Fast-paced, Real-time.
Motion Buckets: Low motion (Slight movement), High motion (Intense action).

Workflow
深度解析：分析上一环节的“画面构思”与“风格词”，确定画面的物理规则。
动能规划：设计从静态起始点到动态终点的轨迹。
主体动（Subject Motion）：肌肉如何收缩？衣物如何飘动？
相机动（Camera Motion）：如何通过运镜增强视觉冲击力？
生成指令：合成专用于 AI 视频模型的高质量英文 Prompt。

**Data Source (Context):**
Global Art Style: **${visualStyle || 'Cinematic Realism'}**
**Reference Storyboard Data:**
${storyboardContext ? storyboardContext.slice(0, 30000) : '⚠️ 警告：未检测到分镜表数据。'}

Output Format
请严格按照以下格式回复，严禁废话：

[分镜序号]
动态策略：(简短中文：说明如何从“前摇”过渡到“释放”，解释选择该运镜对剧集节奏的作用)
Motion Prompt (English): (Detailed Subject Action + Dynamic Camera Movement + Fluid Physics + Style Consistency + Motion Speed)
Video Control Args: (提取纯粹指令，包含 --motion [1-10], --camera_cmd, --pacing)

Example Output (实拍风格参考)
[分镜02]
动态策略：承接上一镜头的蓄力，此镜头执行“释放”。角色猛然冲刺，利用低角度跟拍（Truck In）增强速度感，模拟肾上腺素飙升的节奏。
Motion Prompt (English): The black-suited agent suddenly lunges forward into a sprint, feet slamming against the wet pavement with water splashing. Camera tracks low and moves fast (Truck In) following the agent's movement. Cinematic realistic style, motion blur, 4k, high energy burst.
Video Control Args: --camera_cmd: Truck In, Fast Follow; --motion: 8; --pacing: Explosive.
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
     const moduleNames: Record<string, string> = {
         'ROLES': '人物小传',
         'PROPS': '道具清单',
         'SCENES': '场景氛围',
         'STORYBOARD': '分镜拆解',
         'VIDEO_PROMPTS': '视频提示词生成',
         'ARCHITECT_PHASE1': '剧情锚点提取',
         'ARCHITECT_PHASE2': '视觉 DNA 锁定',
         'ARCHITECT_PHASE3': '镜头序列展开',
         'ARCHITECT_PHASE4': '动态指令生成'
     };
     const currentModule = moduleNames[step] || step;
     prompt = `
**【当前指令：${currentModule} - 导演修正循环】**
用户指令："${refinementInstruction}"
**🚨 强制拒绝逻辑**: 如果指令要求执行**不属于**【${currentModule}】的任务，必须立即拒绝并说明原因。
**输出**: 修正后的完整 Markdown 结构。
`;
  } else if (step.startsWith('ARCHITECT_PHASE')) {
      const phaseNum = parseInt(step.replace('ARCHITECT_PHASE', ''));
      prompt = ARCHITECT_PROMPTS[phaseNum](visualStyle);
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
  const prompt = `优化 ${tableType} 表格。参考剧本上下文，补全细节、视听衔接逻辑和 AI 绘图提示词。风格：${visualStyle || '自动分析'}。输入内容如下：\n${userInput}\n\n⚠️ 注意：严禁脑补，严禁跨越模块边界。`;
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
