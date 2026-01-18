import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { AgentConfig, ChatMessage, FileData, VoiceName } from './types';
import { createBlob, decode, decodeAudioData } from './utils/audioHelpers';
import FileUploader from './components/FileUploader';
import AgentDisplay from './components/AgentDisplay';

const App: React.FC = () => {
  // --- State ---
  const [config, setConfig] = useState<AgentConfig>({
    name: "Sophie",
    voice: "Kore",
    systemInstruction: "You are Sophie, a professional appointment setter for 'Test Water Information', a premium in-home water testing company. Your goal is to be friendly, helpful, and persuasive. You should answer questions about water quality and try to schedule a free in-home test. Use the uploaded knowledge base to provide specific details about the company's services."
  });
  const [files, setFiles] = useState<FileData[]>([]);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [transcriptions, setTranscriptions] = useState<ChatMessage[]>([]);
  const [currentInput, setCurrentInput] = useState("");
  const [currentOutput, setCurrentOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);

  // --- Refs ---
  const sessionRef = useRef<any>(null);
  const audioContextsRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const analysersRef = useRef<{ input: AnalyserNode; output: AnalyserNode } | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  
  // Accumulators for live transcription text
  const inputAccumulator = useRef("");
  const outputAccumulator = useRef("");

  // --- Volume Tracking Loop ---
  useEffect(() => {
    let animationFrame: number;
    const updateVolume = () => {
      if (!analysersRef.current || !isSessionActive) {
        setVolume(0);
        return;
      }

      const { input, output } = analysersRef.current;
      
      const inputData = new Uint8Array(input.frequencyBinCount);
      input.getByteFrequencyData(inputData);
      const inputAvg = inputData.reduce((a, b) => a + b, 0) / inputData.length;

      const outputData = new Uint8Array(output.frequencyBinCount);
      output.getByteFrequencyData(outputData);
      const outputAvg = outputData.reduce((a, b) => a + b, 0) / outputData.length;

      // Normalize average (0-255 range) to 0-1 with a slight boost for better visual impact
      const currentMax = Math.min(1, Math.max(inputAvg, outputAvg) / 128);
      setVolume(currentMax);
      
      animationFrame = requestAnimationFrame(updateVolume);
    };

    if (isSessionActive) {
      animationFrame = requestAnimationFrame(updateVolume);
    } else {
      setVolume(0);
    }

    return () => cancelAnimationFrame(animationFrame);
  }, [isSessionActive]);

  // --- Helpers ---
  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextsRef.current) {
      audioContextsRef.current.input.close();
      audioContextsRef.current.output.close();
      audioContextsRef.current = null;
    }
    analysersRef.current = null;
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    setIsSessionActive(false);
    nextStartTimeRef.current = 0;
    inputAccumulator.current = "";
    outputAccumulator.current = "";
    setCurrentInput("");
    setCurrentOutput("");
    setVolume(0);
  }, []);

  const startSession = async () => {
    try {
      setError(null);
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      // Create Analysers
      const inputAnalyser = inputAudioContext.createAnalyser();
      inputAnalyser.fftSize = 256;
      inputAnalyser.smoothingTimeConstant = 0.4;

      const outputAnalyser = outputAudioContext.createAnalyser();
      outputAnalyser.fftSize = 256;
      outputAnalyser.smoothingTimeConstant = 0.4;
      
      audioContextsRef.current = { input: inputAudioContext, output: outputAudioContext };
      analysersRef.current = { input: inputAnalyser, output: outputAnalyser };

      // GUIDELINE: Initialize exactly with { apiKey: process.env.API_KEY }
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      const knowledgeContext = files.length > 0 
        ? "\n\nKnowledge Base Context:\n" + files.map(f => `FILE [${f.name}]:\n${f.content}`).join("\n")
        : "";

      const finalInstruction = config.systemInstruction + knowledgeContext;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } },
          },
          systemInstruction: finalInstruction,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsSessionActive(true);
            const source = inputAudioContext.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(inputAnalyser); 
            inputAnalyser.connect(scriptProcessor); 
            scriptProcessor.connect(inputAudioContext.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Audio Output Handling
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && audioContextsRef.current && analysersRef.current) {
              const { output: outputCtx } = audioContextsRef.current;
              const { output: outputAnalyser } = analysersRef.current;
              
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              
              source.connect(outputAnalyser);
              outputAnalyser.connect(outputCtx.destination);
              
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
              });
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            // Interruption Handling
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => {
                try { s.stop(); } catch(e) {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            // Transcription Handling
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              inputAccumulator.current += text;
              setCurrentInput(inputAccumulator.current);
            }
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              outputAccumulator.current += text;
              setCurrentOutput(outputAccumulator.current);
            }

            // Turn Completion
            if (message.serverContent?.turnComplete) {
              const finalInput = inputAccumulator.current;
              const finalOutput = outputAccumulator.current;

              setTranscriptions(prev => {
                const updated = [...prev];
                if (finalInput) updated.push({ role: 'user', text: finalInput, timestamp: Date.now() });
                if (finalOutput) updated.push({ role: 'agent', text: finalOutput, timestamp: Date.now() });
                return updated;
              });

              inputAccumulator.current = "";
              outputAccumulator.current = "";
              setCurrentInput("");
              setCurrentOutput("");
            }
          },
          onerror: (e) => {
            console.error("Gemini Live Error", e);
            setError("The session encountered an error. This usually happens if the API key is invalid or quota is exceeded.");
            stopSession();
          },
          onclose: () => {
            setIsSessionActive(false);
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Could not start microphone session.");
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans selection:bg-indigo-100">
      <nav className="bg-white/80 backdrop-blur-md border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 w-10 h-10 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-200">
            <i className="fa-solid fa-droplet text-white text-lg"></i>
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight text-slate-800 leading-none">Sophie</h1>
            <p className="text-[10px] uppercase font-bold text-indigo-500 tracking-widest mt-1">Water Analytics AI</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          {!isSessionActive ? (
            <button 
              onClick={startSession}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-2.5 rounded-full font-bold transition-all shadow-xl shadow-indigo-100 flex items-center gap-2 hover:scale-[1.02] active:scale-95"
            >
              <i className="fa-solid fa-phone text-xs"></i>
              Start Consultation
            </button>
          ) : (
            <button 
              onClick={stopSession}
              className="bg-red-500 hover:bg-red-600 text-white px-8 py-2.5 rounded-full font-bold transition-all shadow-xl shadow-red-100 flex items-center gap-2 hover:scale-[1.02] active:scale-95"
            >
              <i className="fa-solid fa-phone-slash text-xs"></i>
              End Call
            </button>
          )}
        </div>
      </nav>

      {error && (
        <div className="mx-6 mt-6 p-4 bg-red-50 border border-red-100 text-red-800 rounded-2xl flex items-center justify-between animate-in zoom-in-95">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center text-red-600">
              <i className="fa-solid fa-circle-exclamation text-sm"></i>
            </div>
            <span className="text-sm font-semibold">{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-red-500 transition-colors">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
      )}

      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-8 max-w-[1440px] mx-auto w-full overflow-hidden">
        <aside className="lg:col-span-4 flex flex-col gap-8 overflow-y-auto custom-scrollbar pr-2">
          <section className="bg-white p-8 rounded-3xl shadow-sm border border-slate-200/60 space-y-6">
            <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2.5">
              <i className="fa-solid fa-sliders text-indigo-500"></i>
              Agent Persona
            </h2>
            
            <div className="space-y-4">
              <div className="group">
                <label className="block text-[10px] font-black text-slate-400 uppercase mb-2 ml-1 tracking-widest group-focus-within:text-indigo-500 transition-colors">Identification</label>
                <input 
                  type="text" 
                  value={config.name}
                  onChange={(e) => setConfig({ ...config, name: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none text-sm font-medium transition-all"
                />
              </div>

              <div className="group">
                <label className="block text-[10px] font-black text-slate-400 uppercase mb-2 ml-1 tracking-widest group-focus-within:text-indigo-500 transition-colors">Voice Synthesis</label>
                <select 
                  value={config.voice}
                  onChange={(e) => setConfig({ ...config, voice: e.target.value as VoiceName })}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none text-sm font-medium transition-all"
                >
                  <option value="Kore">Kore (Neutral Professional)</option>
                  <option value="Zephyr">Zephyr (Bright & Friendly)</option>
                  <option value="Puck">Puck (Energetic)</option>
                  <option value="Charon">Charon (Deep & Calm)</option>
                  <option value="Fenrir">Fenrir (Deep Authority)</option>
                </select>
              </div>

              <div className="group">
                <label className="block text-[10px] font-black text-slate-400 uppercase mb-2 ml-1 tracking-widest group-focus-within:text-indigo-500 transition-colors">Behavioral Directives</label>
                <textarea 
                  rows={8}
                  value={config.systemInstruction}
                  onChange={(e) => setConfig({ ...config, systemInstruction: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none text-sm leading-relaxed transition-all resize-none"
                ></textarea>
              </div>
            </div>
          </section>

          <FileUploader files={files} onFilesChange={setFiles} />
        </aside>

        <section className="lg:col-span-8 flex flex-col h-[calc(100vh-140px)] min-h-[600px]">
          <AgentDisplay 
            isActive={isSessionActive} 
            transcriptions={transcriptions} 
            currentInput={currentInput}
            currentOutput={currentOutput}
            volume={volume}
          />
        </section>
      </main>
    </div>
  );
};

export default App;