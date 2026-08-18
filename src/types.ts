
export interface VideoMetadata {
  title: string;
  source: string;
  purpose: string;
  targetAudience: string;
}

export interface AnalysisState {
  isAnalyzing: boolean;
  progressMessage: string;
  report: string | null;
  error: string | null;
}

export interface VideoFile {
  file: File | null;
  previewUrl: string | null;
  base64: string | null;
  mimeType: string | null;
}

export type AnalysisStep = 'IDLE' | 'ROLES' | 'PROPS' | 'SCENES' | 'STORYBOARD' | 'VIDEO_PROMPTS' | 'COMPLETED' | 'SUMMARY';

export interface StyleSuggestion {
  en: string;
  zh: string;
}

export interface AiRuntimeConfig {
  apiKey: string;
  modelName: string;
  baseUrl?: string;
}

export interface ScriptState {
  inputText: string;
  fileName: string | null;
  isAnalyzing: boolean;
  isChatReady: boolean; // Indicates if script is loaded and AI is primed
  currentStep: AnalysisStep; // Acts as the "Active Tab"
  stepResults: Record<string, string>; // Store result for each step
  error: string | null;
  startEpisode: number; // NEW: Which episode number to start from
  episodeCount: number; // How many episodes to breakdown
  episodeDuration: string; // NEW: Duration constraint per episode (e.g., "60s")
  shotCountRange: string; // NEW: Shot count constraint per episode (e.g., "15-25")
  visualStyle: string | null; // Stores the finalized visual art style
  suggestedStyles: StyleSuggestion[]; // NEW: List of AI-recommended styles with EN/ZH
  isSelectingStyle: boolean; // NEW: UI state for showing the selection modal
}

export interface OptimizationState {
  targetType: 'STORYBOARD' | 'SCENES'; // Identify what we are generating
  userInput: string;
  requirements: string;
  visualStyle: string; // New: Selected style for optimization
  result: string | null;
  isOptimizing: boolean;
}

export interface HistoryItem {
  id: string;
  type: 'video' | 'script';
  title: string;
  timestamp: number;
  content: string; // For script, this will be the combined markdown
  metadata?: VideoMetadata;
  extractedFrames?: Record<string, string>;
  scriptData?: Record<string, string>; // Stores individual step results for scripts
  visualStyle?: string; // Stores the visual style used
}
