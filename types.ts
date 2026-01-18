
export type VoiceName = 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';

export interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
  timestamp: number;
}

export interface AgentConfig {
  name: string;
  voice: VoiceName;
  systemInstruction: string;
}

export interface FileData {
  name: string;
  content: string;
  size: number;
}
