
import React, { useState, useRef, useEffect } from 'react';
import { VideoMetadata, AnalysisState, VideoFile, ScriptState, HistoryItem, AnalysisStep, StyleSuggestion, FeishuConfig, OptimizationState } from './types';
import { analyzeVideo, initializeScriptChat, generateScriptStep, analyzeImageStyle, optimizeTable } from './geminiService';
import { Chat } from "@google/genai";
import * as mammoth from 'mammoth';

const LOADING_MESSAGES = ["正在读取媒体流...", "正在识别画面剪辑点...", "正在执行镜头级颗粒度解析...", "报告深度渲染中..."];

// --- Helper: Escape HTML ---
const escapeHtml = (text: string) => {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

// --- Helper: Parse Markdown Table to 2D Array ---
const parseMarkdownTable = (md: string): string[][] => {
  const lines = md.split('\n');
  let tableRows: string[][] = [];
  let isTable = false;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('|')) {
      isTable = true;
      const cells = t.split('|').map(c => c.trim().replace(/\*\*(.*?)\*\*/g, '$1')).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      if (cells.length && !t.includes('---')) {
        tableRows.push(cells);
      }
    } else if (isTable && t === '') {
      // End of a table block
      break; 
    }
  }
  return tableRows;
};

const ShotTable: React.FC<{ 
  headers: string[], 
  rows: string[][], 
  extractedFrames: Record<string, string>,
  normalizeTimeStr: (s: string) => string
}> = ({ headers, rows, extractedFrames, normalizeTimeStr }) => {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  
  // Logic updated: Only treat as preview image if it DOESN'T include "Prompt" or "提示词".
  // This ensures "Keyframe Image Prompt" columns render as text.
  const previewColIndex = headers.findIndex(h => 
    (h.includes('预览') || h.includes('Frame') || (h.includes('图片') && !h.includes('提示词') && !h.includes('Prompt')))
  );
  
  const timeColIndex = headers.findIndex(h => h.includes('时间') || h.includes('区间') || h.includes('Time'));

  const handleCopy = async () => {
    try {
      let htmlRows = '';
      rows.forEach(row => {
        if (row.join('').includes('---')) return;
        let cellsHtml = '';
        row.forEach((cell, cIdx) => {
          let content = cell.replace(/\*\*(.*?)\*\*/g, '$1');
          if (cIdx === previewColIndex && previewColIndex !== -1) {
            const timeRegex = /\d{1,2}:\d{1,2}(?::\d{1,2})?\s*-\s*\d{1,2}:\d{1,2}(?::\d{1,2})?/;
            const timeCell = row[timeColIndex] || "";
            const foundTime = timeCell.match(timeRegex) || row.join(' ').match(timeRegex);
            const normalizedTime = foundTime ? normalizeTimeStr(foundTime[0]) : '';
            const base64 = normalizedTime ? extractedFrames[normalizedTime] : null;
            content = base64 ? `<img src="${base64}" width="180" height="101" style="border:1px solid #000; display:block;"/>` : '[AI Visual]';
          } else {
             // Escape HTML for text content to preserve <Prompt> tags
             content = escapeHtml(content);
          }
          cellsHtml += `<td style="border:1px solid #c8c8c8; padding:8px; vertical-align:top; background-color:#ffffff;">${content}</td>`;
        });
        htmlRows += `<tr>${cellsHtml}</tr>`;
      });
      // Feishu friendly HTML table
      const fullHtml = `<table border="1" style="border-collapse:collapse; width:100%; border:1px solid #c8c8c8; font-family:sans-serif;"><thead><tr>${headers.map(h => `<th style="background-color:#f5f6f7; border:1px solid #c8c8c8; padding:8px; text-align:left; font-weight:bold;">${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${htmlRows}</tbody></table>`;
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([fullHtml], {type:'text/html'}), 'text/plain': new Blob([rows.map(r=>r.join('\t')).join('\n')], {type:'text/plain'}) })]);
      setCopyStatus('copied');
    } catch { setCopyStatus('error'); }
    setTimeout(() => setCopyStatus('idle'), 2000);
  };

  return (
    <div className="mb-12">
      <div className="flex justify-between items-center mb-4 px-1">
        <div className="flex items-center space-x-2">
          <div className="w-1 h-4 bg-indigo-600 rounded-sm"></div>
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Analysis Data Table</span>
        </div>
        <button onClick={handleCopy} className={`text-xs font-bold uppercase transition-all px-3 py-1.5 rounded-md border shadow-sm ${copyStatus === 'copied' ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-indigo-600'}`}>
          {copyStatus === 'copied' ? <span className="flex items-center gap-1"><i className="fas fa-check"></i> Copied</span> : <span className="flex items-center gap-1"><i className="far fa-copy"></i> Copy for Lark/Feishu</span>}
        </button>
      </div>
      <div className="overflow-x-auto rounded-xl shadow-sm ring-1 ring-slate-200 bg-white custom-scrollbar">
        <table className="w-full border-collapse table-fixed min-w-[1200px] shot-table">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              {headers.map((h, i) => {
                let width = "w-[150px]";
                const header = h.toLowerCase();
                
                if (header.includes('内容') || header.includes('description') || header.includes('提示词') || header.includes('prompt')) width = "w-[260px]";
                else if (header.includes('台词') || header.includes('dialogue') || header.includes('对白') || header.includes('人设') || header.includes('服饰') || header.includes('描述') || header.includes('意图') || header.includes('习惯') || header.includes('口头禅')) width = "w-[220px]";
                else if (header.includes('背景音乐') || header.includes('bgm') || header.includes('music')) width = "w-[180px]";
                else if (header.includes('效果') || header.includes('情绪') || header.includes('音频') || header.includes('audio') || header.includes('音效') || header.includes('备注')) width = "w-[160px]";
                else if (header.includes('预览') || header.includes('frame') || (header.includes('图片') && !header.includes('提示词'))) width = "w-[200px]";
                else if (header.includes('时长') || header.includes('景别') || header.includes('duration') || header.includes('运镜') || header.includes('类别') || header.includes('所属')) width = "w-[120px]";
                else if (header.includes('场次') || header.includes('镜号') || header.includes('no.')) width = "w-[80px]";
                else if (header.includes('名称') || header.includes('name')) width = "w-[140px]";
                else if (header.includes('视角') || header.includes('view') || header.includes('angle') || header.includes('mapping')) width = "w-[260px]"; 
                
                return (
                  <th key={i} className={`px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider whitespace-nowrap overflow-hidden ${width}`}>
                    {h}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, rIdx) => !row.join('').includes('---') && (
              <tr key={rIdx} className="hover:bg-slate-50/80 transition-colors group">
                {row.map((cell, cIdx) => (
                  <td key={cIdx} className="px-4 py-4 text-sm text-slate-700 align-top leading-6 break-words">
                    {previewColIndex !== -1 && cIdx === previewColIndex ? (
                      <div className="rounded-lg overflow-hidden bg-slate-100 aspect-video shadow-sm ring-1 ring-black/5 flex items-center justify-center">
                        {extractedFrames[normalizeTimeStr(row[timeColIndex] || row.join(' ').match(/\d{1,2}:\d{1,2}(?::\d{1,2})?\s*-\s*\d{1,2}:\d{1,2}(?::\d{1,2})?/)?.[0] || "")] ? (
                          <img src={extractedFrames[normalizeTimeStr(row[timeColIndex] || row.join(' ').match(/\d{1,2}:\d{1,2}(?::\d{1,2})?\s*-\s*\d{1,2}:\d{1,2}(?::\d{1,2})?/)?.[0] || "")]} className="w-full h-full object-cover" />
                        ) : <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">No Image</span>}
                      </div>
                    ) : (
                      <div className="max-h-[240px] overflow-y-auto pr-2 scrollbar-thin">
                        {cell.replace(/\*\*(.*?)\*\*/g, '$1')}
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// --- Feishu Sync Modal ---
const FeishuSyncModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  config: FeishuConfig | undefined;
  onSave: (cfg: FeishuConfig) => void;
  onSync: () => void;
  isSyncing: boolean;
}> = ({ isOpen, onClose, config, onSave, onSync, isSyncing }) => {
  const [localConfig, setLocalConfig] = useState<FeishuConfig>({ appId: '', appSecret: '', spreadsheetToken: '' });

  useEffect(() => {
    if (config) setLocalConfig(config);
    else {
        const saved = localStorage.getItem('feishu_config');
        if (saved) setLocalConfig(JSON.parse(saved));
    }
  }, [config, isOpen]);

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      let token = val;
      // Try to extract token from URL if pasted full URL
      // Matches spreadsheet token (shtcn...)
      const match = val.match(/(?:shtcn)[a-zA-Z0-9]{10,}/);
      if (match) {
          token = match[0];
      }
      setLocalConfig({...localConfig, spreadsheetToken: token});
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="bg-slate-50 px-6 py-4 border-b border-slate-100 flex justify-between items-center">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <span className="w-6 h-6 rounded bg-[#00d6b9] text-white flex items-center justify-center text-xs"><i className="fas fa-link"></i></span>
            飞书表格同步 (Beta)
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><i className="fas fa-times"></i></button>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-blue-50 text-blue-700 text-xs p-3 rounded-lg leading-relaxed">
            <i className="fas fa-info-circle mr-1"></i>
            <strong>API 同步仅支持飞书电子表格(Spreadsheet)</strong>。<br/>
            如果您使用的是 Wiki 文档，建议使用主界面的 <strong>“复制为飞书文档格式”</strong> 按钮，直接粘贴效果最佳。
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">飞书应用 ID (App ID)</label>
            <input type="text" value={localConfig.appId} onChange={e => setLocalConfig({...localConfig, appId: e.target.value})} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#00d6b9]/20 outline-none" placeholder="以 cli_ 开头..." />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">飞书应用密钥 (App Secret)</label>
            <input type="password" value={localConfig.appSecret} onChange={e => setLocalConfig({...localConfig, appSecret: e.target.value})} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#00d6b9]/20 outline-none" placeholder="查看飞书开放平台..." />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">多维表格链接或 Token (Spreadsheet Token)</label>
            <input type="text" value={localConfig.spreadsheetToken} onChange={handleUrlChange} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#00d6b9]/20 outline-none" placeholder="粘贴飞书多维表格的完整链接或 shtcn..." />
            <p className="text-[10px] text-slate-400 mt-1">自动识别链接中的 shtcn... Token</p>
          </div>
        </div>
        <div className="px-6 py-4 bg-slate-50 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-slate-500 text-sm font-bold hover:bg-slate-200 rounded-lg transition-colors">取消</button>
          <button 
            onClick={() => {
                localStorage.setItem('feishu_config', JSON.stringify(localConfig));
                onSave(localConfig);
                onSync();
            }} 
            disabled={isSyncing || !localConfig.appId}
            className="px-6 py-2 bg-[#00d6b9] text-white text-sm font-bold rounded-lg hover:bg-[#00bda3] transition-colors shadow-sm disabled:opacity-50 flex items-center gap-2"
          >
            {isSyncing ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> 同步中...</> : <><i className="fas fa-cloud-upload-alt"></i> 开始同步</>}
          </button>
        </div>
      </div>
    </div>
  );
}

const App: React.FC = () => {
  const [activeMode, setActiveMode] = useState<'video' | 'script' | 'optimization'>('video');
  const [metadata, setMetadata] = useState<VideoMetadata>({ title: '', source: '', purpose: '', targetAudience: '' });
  const [video, setVideo] = useState<VideoFile>({ file: null, previewUrl: null, base64: null, mimeType: null });
  const [status, setStatus] = useState<AnalysisState>({ isAnalyzing: false, progressMessage: '', report: null, error: null });
  
  const [scriptState, setScriptState] = useState<ScriptState>({ 
    inputText: '', 
    fileName: null, 
    isAnalyzing: false, 
    isChatReady: false,
    currentStep: 'ROLES', 
    stepResults: {},
    error: null,
    startEpisode: 1, // NEW: Start from episode 1
    episodeCount: 1,
    episodeDuration: '60s', 
    shotCountRange: '15-25', 
    visualStyle: null,
    suggestedStyles: [],
    isSelectingStyle: false
  });
  
  const [optState, setOptState] = useState<OptimizationState>({
    userInput: '',
    requirements: '',
    result: null,
    isOptimizing: false
  });
  
  const [extractedFrames, setExtractedFrames] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [refineInput, setRefineInput] = useState('');
  const [customStyle, setCustomStyle] = useState('');
  
  // Style Analysis State
  const [isAnalyzingStyle, setIsAnalyzingStyle] = useState(false);
  
  // Feishu Logic State
  const [showFeishuModal, setShowFeishuModal] = useState(false);
  const [isSyncingFeishu, setIsSyncingFeishu] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const styleImageInputRef = useRef<HTMLInputElement>(null);
  const scriptInputRef = useRef<HTMLInputElement>(null);
  const hiddenVideoRef = useRef<HTMLVideoElement>(null);
  const scriptChatRef = useRef<Chat | null>(null);

  const normalizeTimeStr = (str: string) => str.replace(/[\s\*]+/g, '').trim();

  useEffect(() => {
    const saved = localStorage.getItem('cineinsight_history');
    if (saved) {
      try { setHistory(JSON.parse(saved)); } catch (e) { console.error("Failed to parse history", e); }
    }
  }, []);

  useEffect(() => {
    setRefineInput('');
  }, [scriptState.currentStep]);

  const saveToHistory = (item: Omit<HistoryItem, 'id' | 'timestamp'>) => {
    const newItem: HistoryItem = { ...item, id: crypto.randomUUID(), timestamp: Date.now() };
    const updated = [newItem, ...history].slice(0, 50);
    setHistory(updated);
    localStorage.setItem('cineinsight_history', JSON.stringify(updated));
  };

  const deleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = history.filter(h => h.id !== id);
    setHistory(updated);
    localStorage.setItem('cineinsight_history', JSON.stringify(updated));
  };

  const loadHistoryItem = (item: HistoryItem) => {
    setActiveMode(item.type);
    if (item.type === 'video') {
      setStatus({ isAnalyzing: false, progressMessage: '', report: item.content, error: null });
      setExtractedFrames(item.extractedFrames || {});
      setMetadata(item.metadata || { title: '', source: '', purpose: '', targetAudience: '' });
    } else {
      setScriptState({ 
        ...scriptState, 
        fileName: item.title, 
        isAnalyzing: false, 
        isChatReady: true, // Allow direct access to dashboard
        currentStep: 'SUMMARY', // Default to summary
        stepResults: item.scriptData || { 'FULL_REPORT': item.content }, // Restore map or fallback
        error: null,
        visualStyle: item.visualStyle || null, // Restore style
        suggestedStyles: [],
        isSelectingStyle: false,
        episodeDuration: '60s',
        shotCountRange: '15-25'
      });
    }
    setShowHistory(false);
  };

  const saveScriptToHistory = () => {
    if (!scriptState.fileName || Object.keys(scriptState.stepResults).length === 0) {
        alert("暂无内容可保存");
        return;
    }
    
    // Create a summary content for the preview
    const summary = Object.entries(scriptState.stepResults)
      .map(([k, v]) => `## ${k}\n${(v as string).slice(0, 200)}...`)
      .join('\n\n');

    saveToHistory({
      type: 'script',
      title: scriptState.fileName,
      content: summary, // Preview content
      scriptData: scriptState.stepResults, // Full data map
      visualStyle: scriptState.visualStyle || undefined
    });
    
    alert("已保存到历史记录 (Saved to Memory)");
  };

  const handleVideoFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('video/')) {
      const reader = new FileReader();
      reader.onloadend = () => setVideo({ file, previewUrl: URL.createObjectURL(file), base64: (reader.result as string).split(',')[1], mimeType: file.type });
      reader.readAsDataURL(file);
    }
  };

  const captureFrame = (timeRangeStr: string): Promise<string> => {
    return new Promise((resolve) => {
      const videoEl = hiddenVideoRef.current;
      if (!videoEl || !video.previewUrl) return resolve('');
      const startStr = normalizeTimeStr(timeRangeStr).split('-')[0];
      const p = startStr.split(':').map(Number);
      const onSeeked = () => {
        const canvas = document.createElement('canvas');
        canvas.width = videoEl.videoWidth; canvas.height = videoEl.videoHeight;
        canvas.getContext('2d')?.drawImage(videoEl, 0, 0);
        videoEl.removeEventListener('seeked', onSeeked);
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      };
      videoEl.addEventListener('seeked', onSeeked);
      videoEl.currentTime = p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+p[1];
    });
  };

  const runVideoAnalysis = async () => {
    setStatus({ isAnalyzing: true, progressMessage: LOADING_MESSAGES[0], report: null, error: null });
    try {
      const result = await analyzeVideo(video.base64!, video.mimeType!, metadata, msg => setStatus(s => ({ ...s, progressMessage: msg })));
      const times = Array.from(new Set(result.match(/\d{1,2}:\d{1,2}(?::\d{1,2})?\s*-\s*\d{1,2}:\d{1,2}(?::\d{1,2})?/g) || []));
      const frames: Record<string, string> = {};
      for (const t of times) {
        setStatus(s => ({ ...s, progressMessage: `同步分镜：${t}` }));
        frames[normalizeTimeStr(t)] = await captureFrame(t);
      }
      setExtractedFrames(frames);
      setStatus({ isAnalyzing: false, progressMessage: '', report: result, error: null });
      saveToHistory({ type: 'video', title: metadata.title || '未命名视频拉片', content: result, metadata: metadata, extractedFrames: frames });
    } catch (e: any) { setStatus({ isAnalyzing: false, progressMessage: '', report: null, error: e.message }); }
  };

  const handleScriptUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setScriptState(s => ({ ...s, error: null }));
      
      if (file.name.toLowerCase().endsWith('.docx')) {
         const reader = new FileReader();
         reader.onload = async (ev) => {
             if (ev.target?.result) {
                 try {
                     const arrayBuffer = ev.target.result as ArrayBuffer;
                     // @ts-ignore
                     const result = await mammoth.extractRawText({ arrayBuffer });
                     setScriptState(s => ({ ...s, inputText: result.value, fileName: file.name }));
                 } catch (err: any) {
                     setScriptState(s => ({ ...s, error: `Word 文档解析失败: ${err.message}` }));
                 }
             }
         };
         reader.readAsArrayBuffer(file);
      } else {
        const reader = new FileReader();
        reader.onload = (ev) => setScriptState(s => ({ ...s, inputText: ev.target?.result as string, fileName: file.name }));
        reader.readAsText(file);
      }
    }
  };

  const initScriptAnalysis = async () => {
    if (!scriptState.inputText.trim()) return;
    setScriptState(s => ({ ...s, isAnalyzing: true, error: null }));
    
    try {
      // Receive suggested styles
      const { chat, suggestedStyles } = await initializeScriptChat(scriptState.inputText);
      scriptChatRef.current = chat;
      
      // Script Mode: Require Style Selection
      setScriptState(s => ({ 
          ...s, 
          isAnalyzing: false, 
          isSelectingStyle: true,
          suggestedStyles: suggestedStyles,
          isChatReady: false 
      }));
    } catch (e: any) {
      setScriptState(s => ({ ...s, isAnalyzing: false, error: e.message, isChatReady: false }));
    }
  };

  const handleStyleSelection = (style: string) => {
      setScriptState(s => ({
          ...s,
          visualStyle: style,
          isSelectingStyle: false,
          isChatReady: true,
          currentStep: 'STORYBOARD' // WORKFLOW CHANGE: Auto-navigate to Storyboard first
      }));
  };

  const handleStyleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setIsAnalyzingStyle(true);
      try {
          const reader = new FileReader();
          reader.onloadend = async () => {
              const base64 = (reader.result as string).split(',')[1];
              const mimeType = file.type;
              const styleDesc = await analyzeImageStyle(base64, mimeType);
              setCustomStyle(styleDesc);
              setIsAnalyzingStyle(false);
          };
          reader.readAsDataURL(file);
      } catch (e) {
          alert("风格提取失败，请重试");
          setIsAnalyzingStyle(false);
      }
  };

  const runSpecificAnalysis = async (step: AnalysisStep, instruction?: string) => {
    const chat = scriptChatRef.current;
    if (!chat) return;

    setScriptState(s => ({ ...s, isAnalyzing: true, currentStep: step }));
    try {
      // PASS STORYBOARD CONTEXT: If we are running Scenes, pass the storyboard result if it exists
      const storyboardResult = scriptState.stepResults['STORYBOARD'];

      const result = await generateScriptStep(
          chat, 
          step, 
          { 
              startEpisode: scriptState.startEpisode, // NEW PARAMETER
              episodeCount: scriptState.episodeCount,
              duration: scriptState.episodeDuration, // Pass duration constraint
              shotCount: scriptState.shotCountRange // Pass shot count constraint
          }, 
          instruction, 
          scriptState.visualStyle || undefined,
          storyboardResult
      );
      
      setScriptState(s => ({ 
        ...s, 
        isAnalyzing: false, 
        stepResults: { ...s.stepResults, [step]: result }
      }));
      if (instruction) setRefineInput('');
    } catch (e: any) {
      setScriptState(s => ({ ...s, isAnalyzing: false, error: e.message }));
    }
  };

  const runTableOptimization = async () => {
      if (!optState.userInput.trim()) {
          alert("请先粘贴表格内容");
          return;
      }
      
      setOptState(s => ({...s, isOptimizing: true}));
      try {
          const result = await optimizeTable(optState.userInput, optState.requirements);
          setOptState(s => ({...s, result, isOptimizing: false}));
      } catch (e: any) {
          alert("优化失败: " + e.message);
          setOptState(s => ({...s, isOptimizing: false}));
      }
  };

  const resetScriptState = () => {
      setScriptState(s => ({ 
          ...s, 
          isChatReady: false, 
          currentStep: 'ROLES', 
          stepResults: {}, 
          inputText: '', 
          fileName: null,
          isAnalyzing: false,
          visualStyle: null,
          suggestedStyles: [],
          isSelectingStyle: false,
          startEpisode: 1, // RESET
          episodeCount: 1,
          episodeDuration: '60s',
          shotCountRange: '15-25'
      }));
      setCustomStyle('');
      scriptChatRef.current = null;
  }

  // --- FEATURE: Sync to Feishu (Experimental) ---
  const handleFeishuSync = async () => {
      const cfg = scriptState.feishuConfig || JSON.parse(localStorage.getItem('feishu_config') || '{}');
      if (!cfg.appId || !cfg.appSecret || !cfg.spreadsheetToken) {
          alert("请完善飞书配置");
          return;
      }

      setIsSyncingFeishu(true);
      try {
          const tokenRes = await fetch('/api/feishu-proxy/auth', { 
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ "app_id": cfg.appId, "app_secret": cfg.appSecret })
          }).catch(() => null);

          await new Promise(r => setTimeout(r, 1500));
          throw new Error("浏览器安全策略限制：无法直接从前端访问飞书 API。\n\n解决方案：\n1. 请使用「导出 Excel」功能，然后导入飞书。\n2. 若您有后端代理，请配置代理地址。\n3. 如果是 Wiki 文档，请直接使用“复制为飞书文档格式”按钮粘贴。");

      } catch (e: any) {
          alert(e.message || "同步失败");
          setIsSyncingFeishu(false);
      }
  };

  const handleCopyFullReport = async () => {
    // UPDATED: Include VIDEO_PROMPTS
    const sections = ['ROLES', 'PROPS', 'SCENES', 'STORYBOARD', 'VIDEO_PROMPTS'];
    let fullHtml = '<html><head><meta charset="UTF-8"></head><body>';
    let fullText = '';
    
    sections.forEach(section => {
        const md = scriptState.stepResults[section];
        if (!md) return;
        const titles: Record<string, string> = { 'ROLES': '角色深度分析', 'PROPS': '道具清单', 'SCENES': '场景美术分析', 'STORYBOARD': '分镜表', 'VIDEO_PROMPTS': '视频生成提示词' };
        fullHtml += `<h1>${titles[section] || section}</h1>`;
        fullText += `\n\n# ${titles[section] || section}\n\n`;

        const tableRows = parseMarkdownTable(md);
        
        if (tableRows.length > 1) {
             const headers = tableRows[0];
             const rows = tableRows.slice(1);
             let rowsHtml = '';
             rows.forEach(r => {
                 rowsHtml += `<tr>${r.map(c => `<td style="border:1px solid #c8c8c8; padding:8px; vertical-align:top;">${escapeHtml(c)}</td>`).join('')}</tr>`;
             });
             fullHtml += `<table border="1" style="border-collapse:collapse; width:100%; margin-bottom:20px; border:1px solid #c8c8c8; font-family:sans-serif;"><thead><tr>${headers.map(h => `<th style="background-color:#f5f6f7; border:1px solid #c8c8c8; padding:8px; text-align:left; font-weight:bold;">${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
        }
        fullText += md;
    });
    
    fullHtml += '</body></html>';
    
    try {
        await navigator.clipboard.write([
            new ClipboardItem({ 
                'text/html': new Blob([fullHtml], {type:'text/html'}),
                'text/plain': new Blob([fullText], {type:'text/plain'})
            })
        ]);
        alert("已复制所有表格数据！\n格式已优化，请直接粘贴到飞书文档 (Ctrl+V)");
    } catch (e) {
        alert("复制失败，请重试");
        console.error(e);
    }
  };

  const renderMarkdown = (text: string) => {
    if (!text) return null;
    const elements: React.ReactNode[] = [];
    const lines = text.split('\n');
    let tableRows: string[][] = [];

    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('|')) {
        const cells = t.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
        if (cells.length) tableRows.push(cells);
      } else {
        if (tableRows.length > 1) {
          elements.push(<ShotTable key={`tbl-${i}`} headers={tableRows[0]} rows={tableRows.slice(1)} extractedFrames={extractedFrames} normalizeTimeStr={normalizeTimeStr} />);
          tableRows = [];
        } else { tableRows = []; }
        if (t.startsWith('# ')) elements.push(<h1 key={i} className="text-3xl font-bold mb-6 mt-10 text-slate-900 tracking-tight">{t.slice(2)}</h1>);
        else if (t.startsWith('## ')) elements.push(<h2 key={i} className="text-xl font-bold mb-4 mt-8 text-slate-800 flex items-center"><span className="w-1 h-5 bg-indigo-500 rounded-full mr-3"></span>{t.slice(3)}</h2>);
        else if (t.startsWith('### ')) elements.push(<h3 key={i} className="text-lg font-semibold mb-3 mt-6 text-slate-700">{t.slice(4)}</h3>);
        else if (t.startsWith('* ')) elements.push(<li key={i} className="ml-5 mb-1 text-slate-600 list-disc">{t.slice(2)}</li>);
        else if (t) elements.push(<p key={i} className="mb-4 text-slate-600 leading-7 text-base" dangerouslySetInnerHTML={{ __html: t.replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold text-slate-900">$1</strong>') }} />);
      }
    });
    if (tableRows.length > 1) elements.push(<ShotTable key="last-tbl" headers={tableRows[0]} rows={tableRows.slice(1)} extractedFrames={extractedFrames} normalizeTimeStr={normalizeTimeStr} />);
    return elements;
  };

  const renderTabButton = (step: AnalysisStep, label: string, icon: string) => {
    const isActive = scriptState.currentStep === step;
    const hasData = step === 'SUMMARY' 
        ? Object.keys(scriptState.stepResults).length > 0
        : !!scriptState.stepResults[step];
    
    // NEW LOGIC: Lock other steps until Storyboard is done
    const isStoryboardDone = !!scriptState.stepResults['STORYBOARD'];
    const isLocked = step !== 'STORYBOARD' && step !== 'SUMMARY' && !isStoryboardDone;

    return (
        <button 
            onClick={() => !isLocked && setScriptState(s => ({ ...s, currentStep: step }))}
            disabled={isLocked}
            className={`flex items-center p-3 rounded-xl transition-all w-full space-x-3 text-left relative
                ${isActive ? 'bg-indigo-600 text-white shadow-md' : isLocked ? 'bg-transparent text-slate-300 cursor-not-allowed' : 'bg-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-900'}
            `}
        >
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm ${isActive ? 'bg-white/20' : 'bg-slate-100'}`}>
                {isLocked ? <i className="fas fa-lock text-slate-300"></i> : hasData && !isActive ? <i className="fas fa-check text-emerald-500"></i> : <i className={`fas ${icon}`}></i>}
            </div>
            <span className="text-sm font-semibold">{label}</span>
            {isLocked && <div className="absolute right-3 text-[10px] bg-slate-100 text-slate-400 px-1.5 py-0.5 rounded">Wait</div>}
        </button>
    );
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#f8fafc] text-slate-900 relative overflow-x-hidden font-sans">
      <video ref={hiddenVideoRef} className="hidden" muted playsInline />
      
      <FeishuSyncModal 
        isOpen={showFeishuModal} 
        onClose={() => setShowFeishuModal(false)}
        config={scriptState.feishuConfig}
        onSave={(cfg) => setScriptState(s => ({...s, feishuConfig: cfg}))}
        onSync={handleFeishuSync}
        isSyncing={isSyncingFeishu}
      />

      {/* Navigation */}
      <nav className="bg-white border-b border-slate-200 sticky top-0 z-50 px-6 lg:px-12 h-16 flex items-center justify-between shadow-sm/50 backdrop-blur-md bg-white/90">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-indigo-200 shadow-lg text-white"><i className="fas fa-play text-xs"></i></div>
            <h1 className="text-lg font-bold tracking-tight text-slate-900">CineInsight <span className="text-indigo-600 font-extrabold">Pro</span></h1>
          </div>
          <div className="hidden md:flex bg-slate-100 p-1 rounded-lg">
            <button onClick={() => {setActiveMode('video'); setStatus(s=>({...s, report: null}));}} className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${activeMode === 'video' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>视频分析</button>
            <button onClick={() => {setActiveMode('script'); setScriptState(s=>({...s, result: null}));}} className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${activeMode === 'script' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>剧本拆解</button>
            <button onClick={() => {setActiveMode('optimization');}} className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${activeMode === 'optimization' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>分镜优化</button>
          </div>
        </div>
        <div>
          <button onClick={() => setShowHistory(!showHistory)} className="flex items-center gap-2 text-slate-500 hover:text-slate-900 transition-colors px-3 py-2 rounded-lg hover:bg-slate-50">
            <i className="fas fa-history text-sm"></i>
            <span className="text-xs font-semibold">历史记录</span>
          </button>
        </div>
      </nav>

      {/* Sidebar History Logic */}
      {showHistory && <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm z-[60]" onClick={() => setShowHistory(false)}></div>}
      <aside className={`fixed right-0 top-0 h-full w-[360px] bg-white z-[70] shadow-2xl transform transition-transform duration-300 ease-out ${showHistory ? 'translate-x-0' : 'translate-x-full'} flex flex-col border-l border-slate-100`}>
         {/* History Content */}
         <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <h3 className="text-base font-bold text-slate-800">分析记录</h3>
          <button onClick={() => setShowHistory(false)} className="text-slate-400 hover:text-slate-700 w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-200/50 transition-all"><i className="fas fa-times"></i></button>
        </div>
        <div className="flex-grow overflow-y-auto p-4 space-y-3">
          {history.map(item => (
            <div key={item.id} onClick={() => loadHistoryItem(item)} className="group bg-white p-4 rounded-xl shadow-sm border border-slate-200 hover:border-indigo-400 hover:ring-1 hover:ring-indigo-400/20 transition-all cursor-pointer relative">
               <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${item.type === 'video' ? 'bg-indigo-50 text-indigo-600' : 'bg-amber-50 text-amber-600'}`}>{item.type}</span>
                </div>
                <button onClick={(e) => deleteHistoryItem(item.id, e)} className="text-slate-300 hover:text-red-500 transition-colors"><i className="fas fa-trash-alt text-xs"></i></button>
              </div>
              <h4 className="font-semibold text-slate-800 line-clamp-1 text-sm mb-1">{item.title}</h4>
              <p className="text-[10px] text-slate-400">{new Date(item.timestamp).toLocaleString()}</p>
            </div>
          ))}
        </div>
      </aside>

      <main className="flex-grow max-w-[1600px] mx-auto w-full px-6 py-8 lg:px-12">
        {activeMode === 'video' ? (
          // --- VIDEO MODE ---
          !status.report && !status.isAnalyzing ? (
             <div className="grid lg:grid-cols-2 gap-12 lg:gap-24 items-center animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="space-y-10">
                   <header className="space-y-5">
                      <div className="inline-flex items-center gap-2 bg-indigo-50 px-3 py-1 rounded-full text-indigo-700 text-xs font-bold uppercase tracking-wider border border-indigo-100">
                         <span className="w-2 h-2 rounded-full bg-indigo-600"></span> Video Analysis
                      </div>
                      <h2 className="text-5xl md:text-6xl font-extrabold text-slate-900 tracking-tight leading-[1.1]">
                         像素级解构 <br/><span className="text-indigo-600">视听语言</span>
                      </h2>
                      <p className="text-slate-500 text-lg leading-relaxed max-w-lg">
                         采用专业拉片法，自动识别分镜切点，生成包含景别、运镜、构图及叙事节奏的深度分析报告。
                      </p>
                   </header>
                   <div className="space-y-6 bg-white p-8 rounded-3xl shadow-xl shadow-slate-200/50 border border-slate-100">
                      <div className="space-y-2">
                         <label className="text-xs font-bold text-slate-500 uppercase tracking-wider ml-1">视频标题</label>
                         <input type="text" value={metadata.title} onChange={e=>setMetadata({...metadata, title: e.target.value})} placeholder="输入视频名称..." className="w-full bg-slate-50 border border-slate-200 rounded-xl py-4 px-5 text-base font-semibold outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all placeholder:text-slate-400" />
                      </div>
                      <div className="space-y-2">
                         <label className="text-xs font-bold text-slate-500 uppercase tracking-wider ml-1">分析目标</label>
                         <textarea value={metadata.purpose} onChange={e=>setMetadata({...metadata, purpose: e.target.value})} rows={3} placeholder="例如：分析反转节奏、学习运镜技巧..." className="w-full bg-slate-50 border border-slate-200 rounded-xl py-4 px-5 text-base font-medium resize-none outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all placeholder:text-slate-400" />
                      </div>
                      <button onClick={runVideoAnalysis} disabled={!video.base64} className="w-full py-4 rounded-xl font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all text-base disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                         <i className="fas fa-bolt"></i> <span>开始深度拉片</span>
                      </button>
                   </div>
                </div>
                <div onClick={() => fileInputRef.current?.click()} className="group bg-slate-50 border-2 border-dashed border-slate-300 rounded-[40px] flex flex-col items-center justify-center cursor-pointer hover:bg-indigo-50/50 hover:border-indigo-400 transition-all aspect-[4/3] relative overflow-hidden">
                   {video.previewUrl ? <video src={video.previewUrl} className="w-full h-full object-cover" /> : <div className="text-center p-8"><i className="fas fa-cloud-upload-alt text-3xl text-indigo-500 mb-6 block"></i><span className="text-slate-900 font-bold text-xl block mb-2">点击上传视频</span></div>}
                   <input type="file" ref={fileInputRef} onChange={handleVideoFile} accept="video/*" className="hidden" />
                </div>
             </div>
          ) : status.isAnalyzing ? (
             <div className="py-32 text-center space-y-8 animate-in fade-in duration-700">
                <div className="w-20 h-20 border-4 border-slate-100 border-t-indigo-600 rounded-full animate-spin mx-auto"></div>
                <h2 className="text-3xl font-bold text-slate-900 mb-2">AI 视觉分析进行中</h2>
                <p className="text-indigo-600 font-medium text-lg animate-pulse">{status.progressMessage}</p>
             </div>
          ) : (
             <div className="bg-white rounded-[32px] shadow-xl border border-slate-100 p-8 lg:p-16 animate-in zoom-in-95 duration-500">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 gap-6 border-b border-slate-100 pb-8">
                   <h2 className="text-3xl font-extrabold text-slate-900">拉片分析报告</h2>
                   <div className="flex gap-3"><button onClick={() => window.print()} className="px-5 py-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 font-bold">打印</button><button onClick={() => setStatus({ ...status, report: null })} className="bg-indigo-600 text-white px-5 py-2.5 rounded-xl font-bold">新分析</button></div>
                </div>
                <div className="markdown-content max-w-5xl mx-auto">{renderMarkdown(status.report!)}</div>
             </div>
          )
        ) : activeMode === 'optimization' ? (
          // --- TABLE OPTIMIZATION MODE ---
          <div className="h-[calc(100vh-140px)] animate-in fade-in">
                <header className="mb-8 text-center">
                     <div className="inline-flex items-center gap-2 bg-purple-50 px-3 py-1 rounded-full text-purple-700 text-xs font-bold uppercase tracking-wider border border-purple-100 mb-4">
                       <span className="w-2 h-2 rounded-full bg-purple-600"></span> Script Doctor
                     </div>
                     <h2 className="text-4xl font-extrabold text-slate-900 tracking-tight">智能分镜优化</h2>
                     <p className="text-slate-500 mt-2">粘贴飞书表格或粗略分镜，AI 将根据您的指令进行专业级润色与补全。</p>
                </header>

                <div className="flex flex-col lg:flex-row gap-6 h-full pb-10">
                    {/* Left: Input */}
                    <div className="w-full lg:w-1/3 flex flex-col gap-4">
                        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex-grow flex flex-col">
                             <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">原始表格数据 (支持飞书/Excel直接粘贴)</label>
                             <textarea 
                                className="flex-grow w-full bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm focus:ring-2 focus:ring-indigo-500/20 outline-none resize-none mb-4"
                                placeholder="请在此处粘贴表格内容..."
                                value={optState.userInput}
                                onChange={(e) => setOptState(s => ({...s, userInput: e.target.value}))}
                             />
                             
                             <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">优化需求指令</label>
                             <textarea 
                                className="h-32 w-full bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm focus:ring-2 focus:ring-indigo-500/20 outline-none resize-none"
                                placeholder="例如：\n1. 丰富画面描述，增加赛博朋克光影细节。\n2. 补充运镜方式，多用推拉镜头。\n3. 将台词翻译成英文..."
                                value={optState.requirements}
                                onChange={(e) => setOptState(s => ({...s, requirements: e.target.value}))}
                             />
                             
                             <button 
                                onClick={runTableOptimization}
                                disabled={optState.isOptimizing || !optState.userInput.trim()}
                                className="mt-4 w-full py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-indigo-600 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                             >
                                {optState.isOptimizing ? <><i className="fas fa-circle-notch animate-spin"></i> 优化中...</> : <><i className="fas fa-magic"></i> 开始优化</>}
                             </button>
                        </div>
                    </div>

                    {/* Right: Output */}
                    <div className="w-full lg:w-2/3 bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
                        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                            <span className="text-sm font-bold text-slate-700">优化结果</span>
                            <div className="flex gap-2">
                                {optState.result && (
                                  <>
                                    <button onClick={() => setShowFeishuModal(true)} className="px-3 py-1.5 rounded-lg bg-[#00d6b9] text-white text-xs font-bold hover:bg-[#00bda3] flex items-center gap-1"><i className="fas fa-cloud-upload-alt"></i> 飞书同步</button>
                                    <button onClick={() => {navigator.clipboard.writeText(optState.result!); alert('已复制Markdown');}} className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600 text-xs font-bold hover:text-indigo-600"><i className="fas fa-copy"></i> 复制</button>
                                  </>
                                )}
                            </div>
                        </div>
                        <div className="flex-grow overflow-y-auto p-6 custom-scrollbar bg-slate-50/30">
                            {optState.result ? (
                               <div className="markdown-content">{renderMarkdown(optState.result)}</div>
                            ) : (
                               <div className="h-full flex flex-col items-center justify-center text-slate-300">
                                  <i className="fas fa-table text-4xl mb-4 opacity-30"></i>
                                  <p className="text-sm">等待优化结果...</p>
                                  <p className="text-xs mt-2 opacity-60">AI 将保留原有表格结构，仅针对内容进行升级。</p>
                               </div>
                            )}
                        </div>
                    </div>
                </div>
          </div>
        ) : (
          // --- SHARED SCRIPT CONTEXT ---
          <>
            {scriptState.isSelectingStyle ? (
             // Style Selection UI
             <div className="max-w-4xl mx-auto space-y-12 animate-in zoom-in-95 duration-500 pt-10">
                <header className="text-center space-y-4">
                  <div className="inline-flex items-center gap-2 bg-indigo-50 px-3 py-1 rounded-full text-indigo-700 text-xs font-bold uppercase tracking-wider border border-indigo-100">
                     <span className="w-2 h-2 rounded-full bg-indigo-600"></span> AI Art Director
                  </div>
                  <h2 className="text-4xl md:text-5xl font-extrabold text-slate-900 tracking-tight">
                    确立剧本 <span className="text-indigo-600">视觉风格</span>
                  </h2>
                  <p className="text-slate-500 text-lg max-w-xl mx-auto">
                    AI 已根据剧本内容分析出以下最适合的美术风格。请选择一种，以确保后续生成的所有画面提示词风格统一。
                  </p>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {scriptState.suggestedStyles.map((style, idx) => (
                        <button 
                            key={idx}
                            onClick={() => handleStyleSelection(style.en)}
                            className="group relative bg-white border border-slate-200 rounded-3xl p-8 hover:border-indigo-500 hover:ring-2 hover:ring-indigo-500/20 hover:shadow-xl transition-all text-left"
                        >
                            <div className="absolute top-6 right-6 w-8 h-8 rounded-full border-2 border-slate-200 group-hover:border-indigo-600 group-hover:bg-indigo-600 flex items-center justify-center transition-all">
                                <i className="fas fa-check text-white opacity-0 group-hover:opacity-100 transform scale-50 group-hover:scale-100 transition-all"></i>
                            </div>
                            <h3 className="text-xl font-black text-slate-900 mb-1 group-hover:text-indigo-600 transition-colors">{style.en}</h3>
                            <p className="text-sm font-bold text-indigo-600 mb-3">{style.zh}</p>
                            <p className="text-xs text-slate-400 font-medium">Click to apply this visual style to all prompt generations.</p>
                        </button>
                    ))}
                    
                    {/* Custom Style Input */}
                    <div className="md:col-span-2 bg-slate-50 border border-slate-200 rounded-3xl p-8 flex flex-col md:flex-row items-center gap-6">
                         <div className="flex-grow w-full">
                            <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Or define your own style</label>
                            <div className="relative">
                                <input 
                                    type="text" 
                                    value={customStyle} 
                                    onChange={(e) => setCustomStyle(e.target.value)}
                                    placeholder={isAnalyzingStyle ? "正在分析图片风格..." : "例如：宫崎骏水彩风格, 赛博朋克霓虹..."}
                                    disabled={isAnalyzingStyle}
                                    className="w-full bg-white border border-slate-300 rounded-xl px-4 py-3 pr-12 text-slate-900 font-bold focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all disabled:bg-slate-50 disabled:text-slate-500"
                                />
                                <button 
                                    onClick={() => styleImageInputRef.current?.click()}
                                    disabled={isAnalyzingStyle}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all disabled:opacity-50"
                                    title="上传参考图提取风格"
                                >
                                    {isAnalyzingStyle ? <i className="fas fa-circle-notch animate-spin text-indigo-600"></i> : <i className="fas fa-camera"></i>}
                                </button>
                                <input type="file" ref={styleImageInputRef} className="hidden" accept="image/*" onChange={handleStyleImageUpload} />
                            </div>
                         </div>
                         <button 
                            onClick={() => handleStyleSelection(customStyle)}
                            disabled={!customStyle.trim() || isAnalyzingStyle}
                            className="w-full md:w-auto px-8 py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg whitespace-nowrap"
                         >
                            使用自定义风格
                         </button>
                    </div>
                </div>

                <div className="text-center">
                    <button onClick={resetScriptState} className="text-slate-400 text-sm font-bold hover:text-slate-600 underline decoration-2 underline-offset-4">
                        取消并重新上传
                    </button>
                </div>
             </div>
            ) : (!scriptState.isChatReady && !(activeMode === 'script' && scriptState.currentStep === 'COMPLETED')) ? (
              // Shared Upload UI with dynamic text
              <div className="max-w-4xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-4">
                <header className="text-center space-y-4">
                     <>
                        <div className="inline-flex items-center gap-2 bg-amber-50 px-3 py-1 rounded-full text-amber-700 text-xs font-bold uppercase tracking-wider border border-amber-100">
                           <span className="w-2 h-2 rounded-full bg-amber-500"></span> Script Analysis
                        </div>
                        <h2 className="text-5xl md:text-6xl font-extrabold text-slate-900 tracking-tight">
                          剧本全要素 <span className="text-indigo-600">拆解</span>
                        </h2>
                        <p className="text-slate-500 text-lg max-w-xl mx-auto">
                          上传剧本，AI 将构建智能索引，为您提供人物小传、道具清单、场景氛围及分镜脚本的模块化输出。
                        </p>
                     </>
                </header>
                <div className="bg-white p-10 rounded-[40px] shadow-xl shadow-slate-200/50 border border-slate-100 space-y-8">
                  <div className="flex gap-4">
                    <button onClick={() => scriptInputRef.current?.click()} className="flex-grow py-6 rounded-2xl border-2 border-dashed border-slate-200 text-slate-400 font-bold text-lg hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50/30 transition-all flex items-center justify-center gap-3">
                      <i className="fas fa-file-upload"></i>
                      <span>{scriptState.fileName ? `已加载：${scriptState.fileName}` : "上传剧本文档 (.txt/.md/.docx)"}</span>
                    </button>
                    <input type="file" ref={scriptInputRef} onChange={handleScriptUpload} accept=".txt,.md,.docx" className="hidden" />
                  </div>
                  <div className="relative group">
                    <textarea value={scriptState.inputText} onChange={e=>setScriptState({...scriptState, inputText: e.target.value})} rows={12} placeholder="或者直接在此粘贴剧本内容..." className="w-full bg-slate-50 border border-slate-200 rounded-3xl py-6 px-8 text-base text-slate-800 leading-relaxed focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all outline-none resize-none" />
                  </div>
                  
                  {scriptState.error && (
                    <div className="bg-red-50 text-red-600 p-4 rounded-xl flex items-center gap-3 border border-red-100">
                      <i className="fas fa-exclamation-triangle"></i>
                      <span className="text-sm font-semibold">{scriptState.error}</span>
                    </div>
                  )}

                  <button onClick={initScriptAnalysis} disabled={!scriptState.inputText.trim() || scriptState.isAnalyzing} className="w-full py-5 rounded-2xl font-bold text-white bg-slate-900 hover:bg-indigo-600 shadow-xl transition-all text-lg disabled:opacity-50 flex items-center justify-center gap-3">
                    {scriptState.isAnalyzing ? (
                      <>
                          <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                          <span>AI 正在深度通读剧本...</span>
                      </>
                    ) : (
                       <><i className="fas fa-magic"></i><span>建立剧本索引并开始</span></>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              // Script Dashboard (Original)
              <div className="flex flex-col lg:flex-row gap-6 h-[calc(100vh-140px)] animate-in zoom-in-95 duration-500">
                  {/* Sidebar / Tools */}
                  <div className="w-full lg:w-72 flex flex-col gap-4 shrink-0">
                      {/* Visual Style Indicator */}
                      <div className="bg-slate-900 p-5 rounded-2xl shadow-lg border border-slate-800 text-white relative overflow-hidden group">
                          <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500 rounded-full blur-2xl opacity-20 group-hover:opacity-30 transition-opacity"></div>
                          <div className="relative z-10">
                              <h3 className="text-[10px] font-black uppercase tracking-widest text-indigo-300 mb-1">Global Art Style</h3>
                              <div className="text-lg font-bold leading-tight">{scriptState.visualStyle || "Detecting..."}</div>
                          </div>
                      </div>

                      <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
                          <h3 className="text-xs font-extrabold text-slate-400 uppercase tracking-widest mb-4 px-1">分析模块</h3>
                          <div className="flex flex-col gap-2">
                               {/* REORDERED: Storyboard first to encourage flow */}
                              {renderTabButton('STORYBOARD', '分镜拆解 (优先)', 'fa-film')}
                              {renderTabButton('VIDEO_PROMPTS', '视频提示词', 'fa-video')}
                              {renderTabButton('SCENES', '场景拆解', 'fa-dungeon')}
                              {renderTabButton('ROLES', '人物拆解', 'fa-user-astronaut')}
                              {renderTabButton('PROPS', '道具拆解', 'fa-hat-wizard')}
                              <div className="my-2 border-t border-slate-100"></div>
                              {renderTabButton('SUMMARY', '汇总导出', 'fa-file-export')}
                              <button 
                                  onClick={saveScriptToHistory}
                                  className="flex items-center p-3 rounded-xl transition-all w-full space-x-3 text-left bg-transparent text-slate-500 hover:bg-slate-50 hover:text-indigo-600 mt-2 border-t border-slate-100 pt-3"
                              >
                                  <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm bg-slate-100">
                                      <i className="fas fa-save"></i>
                                  </div>
                                  <span className="text-sm font-semibold">保存记录 (Memory)</span>
                              </button>
                          </div>
                      </div>
                      
                      {scriptState.currentStep === 'STORYBOARD' && (
                          <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 animate-in fade-in">
                              <h3 className="text-xs font-extrabold text-slate-400 uppercase tracking-widest mb-4 px-1">分镜设置</h3>
                              
                              {/* Start Episode Input (NEW) */}
                              <div className="flex items-center justify-between mb-4">
                                  <span className="text-sm font-semibold text-slate-700">起始集数</span>
                                  <div className="flex items-center gap-2 bg-slate-50 rounded-lg p-1 border border-slate-200">
                                      <button 
                                          onClick={() => setScriptState(s => ({...s, startEpisode: Math.max(1, s.startEpisode - 1)}))}
                                          className="w-7 h-7 flex items-center justify-center bg-white rounded shadow-sm text-slate-600 hover:text-indigo-600 font-bold transition-all text-sm border border-slate-100"
                                      >-</button>
                                      <span className="w-8 text-center text-sm font-bold text-slate-800">E{scriptState.startEpisode}</span>
                                      <button 
                                          onClick={() => setScriptState(s => ({...s, startEpisode: s.startEpisode + 1}))}
                                          className="w-7 h-7 flex items-center justify-center bg-white rounded shadow-sm text-slate-600 hover:text-indigo-600 font-bold transition-all text-sm border border-slate-100"
                                      >+</button>
                                  </div>
                              </div>

                              <div className="flex items-center justify-between mb-4">
                                  <span className="text-sm font-semibold text-slate-700">拆解集数 (数量)</span>
                                  <div className="flex items-center gap-2 bg-slate-50 rounded-lg p-1 border border-slate-200">
                                      <button 
                                          onClick={() => setScriptState(s => ({...s, episodeCount: Math.max(1, s.episodeCount - 1)}))}
                                          className="w-7 h-7 flex items-center justify-center bg-white rounded shadow-sm text-slate-600 hover:text-indigo-600 font-bold transition-all text-sm border border-slate-100"
                                      >-</button>
                                      <span className="w-8 text-center text-sm font-bold text-slate-800">{scriptState.episodeCount}</span>
                                      <button 
                                          onClick={() => setScriptState(s => ({...s, episodeCount: Math.min(10, s.episodeCount + 1)}))}
                                          className="w-7 h-7 flex items-center justify-center bg-white rounded shadow-sm text-slate-600 hover:text-indigo-600 font-bold transition-all text-sm border border-slate-100"
                                      >+</button>
                                  </div>
                              </div>
                              
                              {/* Duration Input */}
                              <div className="space-y-1 mb-3">
                                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">单集预估时长</label>
                                  <input 
                                      type="text" 
                                      value={scriptState.episodeDuration}
                                      onChange={(e) => setScriptState(s => ({...s, episodeDuration: e.target.value}))}
                                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-bold text-slate-700 focus:border-indigo-500 outline-none"
                                      placeholder="例如: 60s, 3分钟"
                                  />
                              </div>

                              {/* Shot Count Input */}
                              <div className="space-y-1 mb-4">
                                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">单集镜头数范围</label>
                                  <input 
                                      type="text" 
                                      value={scriptState.shotCountRange}
                                      onChange={(e) => setScriptState(s => ({...s, shotCountRange: e.target.value}))}
                                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-bold text-slate-700 focus:border-indigo-500 outline-none"
                                      placeholder="例如: 15-30"
                                  />
                              </div>

                              {scriptState.stepResults['STORYBOARD'] && (
                                  <button 
                                      onClick={() => runSpecificAnalysis('STORYBOARD')}
                                      className="w-full py-2.5 bg-indigo-50 text-indigo-600 rounded-xl text-xs font-bold uppercase tracking-wide hover:bg-indigo-100 transition-all flex items-center justify-center gap-2"
                                  >
                                      <i className="fas fa-sync-alt"></i>
                                      <span>按新设置重生成</span>
                                  </button>
                              )}
                          </div>
                      )}

                      <div className="mt-auto">
                          <button onClick={resetScriptState} className="w-full py-3 rounded-xl font-semibold text-slate-500 hover:text-red-600 hover:bg-red-50 transition-all text-xs flex items-center justify-center gap-2">
                              <i className="fas fa-arrow-left"></i><span>更换剧本</span>
                          </button>
                      </div>
                  </div>

                  {/* Main Content Area */}
                  <div className="flex-grow bg-white rounded-[32px] shadow-xl shadow-slate-200/50 border border-slate-100 overflow-hidden flex flex-col relative h-full">
                      {/* Header for Content */}
                      <div className="px-8 py-6 border-b border-slate-50 flex justify-between items-center bg-white/95 backdrop-blur z-20 sticky top-0">
                          <div>
                               <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-3">
                                  {scriptState.currentStep === 'ROLES' && <><i className="fas fa-user-astronaut text-indigo-500"></i> 角色深度分析</>}
                                  {scriptState.currentStep === 'PROPS' && <><i className="fas fa-hat-wizard text-indigo-500"></i> 道具与置景清单</>}
                                  {scriptState.currentStep === 'SCENES' && <><i className="fas fa-dungeon text-indigo-500"></i> 场景氛围构建</>}
                                  {scriptState.currentStep === 'STORYBOARD' && <><i className="fas fa-film text-indigo-500"></i> 工业级分镜表</>}
                                  {scriptState.currentStep === 'VIDEO_PROMPTS' && <><i className="fas fa-video text-indigo-500"></i> 视频生成提示词</>}
                                  {scriptState.currentStep === 'COMPLETED' && <><i className="fas fa-check-circle text-emerald-500"></i> 剧本拆解总览</>}
                                  {scriptState.currentStep === 'SUMMARY' && <><i className="fas fa-file-export text-indigo-500"></i> 汇总导出</>}
                               </h2>
                               <p className="text-xs text-slate-400 font-medium mt-1 ml-8">
                                  {scriptState.fileName || "Untitled Script"}
                               </p>
                          </div>
                          <div className="flex gap-3">
                               {scriptState.currentStep === 'SUMMARY' ? (
                                  <>
                                      <button onClick={() => setShowFeishuModal(true)} className="px-4 py-2 rounded-lg bg-[#00d6b9] text-white text-xs font-bold hover:bg-[#00bda3] shadow-md transition-all flex items-center gap-2">
                                          <i className="fas fa-cloud-upload-alt"></i> 飞书同步(Beta)
                                      </button>
                                      <button onClick={handleCopyFullReport} className="px-4 py-2 rounded-lg bg-slate-100 text-slate-600 text-xs font-bold hover:bg-slate-200 transition-all flex items-center gap-2">
                                          <i className="fas fa-copy"></i> 复制为飞书文档格式 (HTML)
                                      </button>
                                  </>
                               ) : scriptState.stepResults[scriptState.currentStep] && (
                                  <button onClick={() => {navigator.clipboard.writeText(scriptState.stepResults[scriptState.currentStep]); alert('已复制')}} className="px-4 py-2 rounded-lg bg-slate-50 text-slate-500 text-xs font-bold hover:bg-indigo-600 hover:text-white transition-all flex items-center gap-2"><i className="fas fa-copy"></i> 复制内容</button>
                               )}
                          </div>
                      </div>

                      {/* Scrollable Content */}
                      <div className="flex-grow overflow-y-auto p-8 lg:p-10 custom-scrollbar bg-slate-50/30">
                          {scriptState.isAnalyzing ? (
                              <div className="h-full flex flex-col items-center justify-center space-y-6 opacity-80">
                                  <div className="w-16 h-16 border-4 border-slate-200 border-t-indigo-600 rounded-full animate-spin"></div>
                                  <p className="font-bold text-slate-400 text-sm tracking-widest uppercase animate-pulse">AI Thinking...</p>
                              </div>
                          ) : !scriptState.stepResults[scriptState.currentStep] && scriptState.currentStep !== 'COMPLETED' && scriptState.currentStep !== 'SUMMARY' ? (
                              <div className="h-full flex flex-col items-center justify-center space-y-6">
                                  <div className="w-24 h-24 bg-white rounded-3xl flex items-center justify-center text-slate-300 shadow-sm border border-slate-100">
                                      <i className={`fas ${
                                          scriptState.currentStep === 'ROLES' ? 'fa-users' : 
                                          scriptState.currentStep === 'PROPS' ? 'fa-box-open' :
                                          scriptState.currentStep === 'SCENES' ? 'fa-image' : 
                                          scriptState.currentStep === 'VIDEO_PROMPTS' ? 'fa-video' : 'fa-film'
                                      } text-4xl`}></i>
                                  </div>
                                  <div className="text-center max-w-sm">
                                      <h3 className="text-lg font-bold text-slate-900 mb-2">
                                        {scriptState.currentStep === 'STORYBOARD' ? "准备就绪" : "等待分镜表"}
                                      </h3>
                                      <p className="text-slate-500 text-sm leading-relaxed">
                                          {scriptState.currentStep === 'STORYBOARD' 
                                            ? "点击下方按钮，AI 将专注于剧本的此维度进行深度挖掘与结构化输出。"
                                            : "请先完成「分镜拆解」。人物、道具和场景分析需要依赖分镜表来保持上下文一致性。"}
                                      </p>
                                  </div>
                                  <button onClick={() => runSpecificAnalysis(scriptState.currentStep)} className="px-8 py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-indigo-600 hover:shadow-lg transition-all flex items-center gap-2">
                                      <i className="fas fa-play text-xs"></i><span>运行此模块</span>
                                  </button>
                              </div>
                          ) : (
                              <div className="script-report-content pb-20 max-w-5xl mx-auto">
                                  <div className="markdown-content">
                                      {scriptState.currentStep === 'SUMMARY' ? (
                                          <div className="space-y-12">
                                              {['STORYBOARD', 'VIDEO_PROMPTS', 'SCENES', 'ROLES', 'PROPS'].map(step => (
                                                  scriptState.stepResults[step] && (
                                                      <div key={step} className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm">
                                                          <div className="mb-6 flex items-center gap-3 border-b border-slate-50 pb-4">
                                                              <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600">
                                                                  <i className={`fas ${
                                                                    step === 'STORYBOARD' ? 'fa-film' : 
                                                                    step === 'VIDEO_PROMPTS' ? 'fa-video' :
                                                                    step === 'SCENES' ? 'fa-dungeon' : 
                                                                    step === 'ROLES' ? 'fa-user-astronaut' : 'fa-hat-wizard'
                                                                  }`}></i>
                                                              </div>
                                                              <h3 className="text-xl font-bold text-slate-800 m-0 p-0">
                                                                  {step === 'STORYBOARD' ? '分镜表' : 
                                                                   step === 'VIDEO_PROMPTS' ? '视频生成提示词' :
                                                                   step === 'SCENES' ? '场景分析' : 
                                                                   step === 'ROLES' ? '角色设定' : '道具清单'}
                                                              </h3>
                                                          </div>
                                                          {renderMarkdown(scriptState.stepResults[step])}
                                                      </div>
                                                  )
                                              ))}
                                              {Object.keys(scriptState.stepResults).length === 0 && (
                                                  <div className="text-center text-slate-400 py-10">
                                                      暂无数据，请先运行左侧的分析模块。
                                                  </div>
                                              )}
                                          </div>
                                      ) : (
                                          renderMarkdown(scriptState.stepResults[scriptState.currentStep] || scriptState.stepResults['FULL_REPORT'])
                                      )}
                                  </div>
                                  
                                  {scriptState.currentStep !== 'COMPLETED' && scriptState.currentStep !== 'SUMMARY' && (
                                      <div className="mt-12 bg-white rounded-2xl p-6 border border-slate-200 shadow-sm">
                                          <h4 className="text-xs font-extrabold text-slate-500 uppercase tracking-wider mb-4 flex items-center">
                                              <i className="fas fa-sliders-h mr-2"></i>
                                              Refine Output
                                          </h4>
                                          <div className="flex gap-3">
                                              <input
                                                  type="text"
                                                  value={refineInput}
                                                  onChange={(e) => setRefineInput(e.target.value)}
                                                  placeholder={`输入调整指令，例如：${scriptState.currentStep === 'ROLES' ? "让反派更具悲剧色彩..." : "场景增加赛博朋克风格..."}`}
                                                  className="flex-grow bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-900 focus:ring-2 focus:ring-indigo-500/20 outline-none focus:border-indigo-500 transition-all"
                                                  onKeyDown={(e) => e.key === 'Enter' && runSpecificAnalysis(scriptState.currentStep, refineInput)}
                                              />
                                              <button
                                                  onClick={() => runSpecificAnalysis(scriptState.currentStep, refineInput)}
                                                  disabled={!refineInput.trim() || scriptState.isAnalyzing}
                                                  className="px-6 py-2 bg-slate-900 text-white rounded-xl font-bold text-sm hover:bg-indigo-600 transition-all disabled:opacity-50 whitespace-nowrap shadow-sm"
                                              >
                                                  调整重成
                                              </button>
                                          </div>
                                      </div>
                                  )}
                              </div>
                          )}
                      </div>
                  </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default App;
