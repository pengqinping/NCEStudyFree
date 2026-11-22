/**
 * 朗读服务：后端可插拔的语音合成封装。
 *
 * 后端选择（initBackend）：
 *   1. Tauri Android 壳 → 原生 TTS 插件（nce-tts，系统 TextToSpeech）
 *   2. 其他环境（浏览器 / Tauri macOS 的 WKWebView）→ Web Speech API
 *
 * 对视图暴露的接口与旧版完全一致：
 *   getVoices / resolveVoice / speak / cancel / pause / resume / isSpeaking / subscribe
 */

function detectTauri() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

function isAndroidTauri() {
  return (
    detectTauri() &&
    typeof navigator !== 'undefined' &&
    /Android/i.test(navigator.userAgent || '')
  );
}

/** Tauri 事件监听：不依赖 @tauri-apps/api，直接使用运行时内部桥。 */
function tauriListen(event, handler) {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals?.invoke || !internals?.transformCallback) return Promise.resolve(() => {});
  const handlerId = internals.transformCallback((payload) => handler(payload));
  return internals
    .invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler: handlerId })
    .then(() => () => {
      internals.invoke('plugin:event|unlisten', { event, target: { kind: 'Any' }, handler: handlerId }).catch(() => {});
    });
}

/**
 * Android 原生 TTS 后端（插件：plugin:nce-tts）。
 * 插件通过事件 nce-tts://start / nce-tts://end / nce-tts://error 回报状态。
 */
export class NativeTtsBackend {
  constructor() {
    this.voices = [];
    this.generation = 0;
    this.current = null;
    this.supported = isAndroidTauri();
    this.unlisten = null;
    if (this.supported) {
      this.#bindEvents();
    }
  }

  async #bindEvents() {
    try {
      this.unlisten = await tauriListen('nce-tts://state', (payload) => {
        const current = this.current;
        if (!current) return;
        const phase = payload?.phase;
        if (phase === 'start') {
          current.onStart?.();
        } else if (phase === 'end') {
          if (this.current === current) this.current = null;
          current.onEnd?.();
        } else if (phase === 'error') {
          if (this.current === current) this.current = null;
          current.onError?.(new Error(payload?.message || '原生朗读失败'));
        }
      });
    } catch {
      this.supported = false;
    }
  }

  async refresh() {
    if (!this.supported) {
      this.voices = [];
      return;
    }
    try {
      const list = await window.__TAURI_INTERNALS__.invoke('plugin:nce-tts|voices');
      this.voices = Array.isArray(list)
        ? list.filter((voice) => String(voice?.lang || '').toLowerCase().startsWith('en'))
        : [];
    } catch {
      this.voices = [];
      this.supported = false;
    }
  }

  speak(text, options = {}) {
    const { rate = 1, voiceName = '', onStart, onEnd, onError } = options;
    if (!this.supported) {
      onError?.(new Error('原生朗读不可用'));
      return null;
    }
    if (!text || !String(text).trim()) return null;
    const generation = ++this.generation;
    const handle = { onStart, onEnd, onError };
    this.current = handle;
    window.__TAURI_INTERNALS__
      .invoke('plugin:nce-tts|speak', {
        text: String(text),
        rate: Math.min(1.5, Math.max(0.5, Number(rate) || 1)),
        voiceName: String(voiceName || ''),
        generation,
      })
      .catch((error) => {
        if (generation !== this.generation || this.current !== handle) return;
        this.current = null;
        onError?.(error);
      });
    return handle;
  }

  cancel() {
    this.generation += 1;
    const current = this.current;
    this.current = null;
    if (current) {
      current.onStart = null;
      current.onEnd = null;
      current.onError = null;
    }
    if (this.supported) {
      window.__TAURI_INTERNALS__?.invoke('plugin:nce-tts|stop').catch(() => {});
    }
  }

  pause() {
    /* Android TTS 不支持暂停，停止由 cancel 承担 */
  }

  resume() {
    /* 同上 */
  }

  isSpeaking() {
    return Boolean(this.current);
  }
}

/** Web Speech API 后端（浏览器与 Tauri 桌面 WKWebView）。 */
export class WebSpeechTtsBackend {
  constructor() {
    this.supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.voices = [];
    this.current = null;
    this.generation = 0;
    if (this.supported) {
      this.refresh();
      window.speechSynthesis.addEventListener?.('voiceschanged', () => this.refresh());
    }
  }

  refresh() {
    if (!this.supported) return;
    try {
      this.voices = window.speechSynthesis
        .getVoices()
        .filter((voice) => String(voice.lang || '').toLowerCase().startsWith('en'));
    } catch {
      this.voices = [];
    }
  }

  speak(text, options = {}) {
    const { rate = 1, voiceName = '', onStart, onEnd, onError } = options;
    if (!this.supported) {
      onError?.(new Error('当前浏览器不支持语音朗读'));
      return null;
    }
    if (!text || !String(text).trim()) return null;
    const generation = ++this.generation;
    this.cancelSpeech();
    const utterance = new SpeechSynthesisUtterance(String(text));
    const voice = this.resolveVoice(voiceName);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = 'en-US';
    }
    utterance.rate = Math.min(1.5, Math.max(0.5, Number(rate) || 1));
    utterance.pitch = 1;
    utterance.onstart = () => {
      if (generation !== this.generation) return;
      onStart?.();
    };
    utterance.onend = () => {
      if (generation !== this.generation) return;
      if (this.current === utterance) this.current = null;
      onEnd?.();
    };
    utterance.onerror = (event) => {
      if (generation !== this.generation) return;
      if (this.current === utterance) this.current = null;
      onError?.(event.error || event);
    };
    this.current = utterance;
    try {
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      this.current = null;
      onError?.(error);
      return null;
    }
    return utterance;
  }

  resolveVoice(name) {
    const voices = this.getVoices();
    if (name) {
      const exact = voices.find((voice) => voice.name === name);
      if (exact) return exact;
    }
    return voices[0] || null;
  }

  getVoices() {
    return [...this.voices].sort((a, b) => {
      const score = (voice) => {
        const lang = String(voice.lang || '').toLowerCase();
        if (lang === 'en-gb') return 0;
        if (lang === 'en-us') return 1;
        return 2;
      };
      return score(a) - score(b) || a.name.localeCompare(b.name);
    });
  }

  cancelSpeech() {
    const current = this.current;
    this.current = null;
    if (current) {
      // 解绑旧回调，避免 cancel() 触发的 onend/onerror 作用到新播放
      current.onstart = null;
      current.onend = null;
      current.onerror = null;
    }
    if (!this.supported) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* 忽略 */
    }
  }

  cancel() {
    this.generation += 1;
    this.cancelSpeech();
  }

  pause() {
    if (this.supported) window.speechSynthesis.pause();
  }

  resume() {
    if (this.supported) window.speechSynthesis.resume();
  }

  isSpeaking() {
    return this.supported && window.speechSynthesis.speaking;
  }
}

export class TTS {
  constructor() {
    this.backend = new WebSpeechTtsBackend();
    if (isAndroidTauri()) {
      this.backend = new NativeTtsBackend();
      // 原生语音列表异步就绪
      this.backend.refresh?.();
    }
    this.voices = this.backend.voices || [];
    this.listeners = new Set();
  }

  /** 供测试与壳环境注入后端。 */
  useBackend(backend) {
    this.backend = backend;
    this.voices = backend.voices || [];
    this.emit();
  }

  refresh() {
    const result = this.backend.refresh?.();
    if (result?.then) {
      result.then(() => {
        this.voices = this.backend.voices || [];
        this.emit();
      });
    } else {
      this.voices = this.backend.voices || [];
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    if (this.backend instanceof NativeTtsBackend) this.refresh();
    return () => this.listeners.delete(listener);
  }

  emit() {
    this.voices = this.backend.voices || [];
    for (const listener of this.listeners) {
      try {
        listener(this.voices);
      } catch {
        /* 单个订阅者失败不影响其他订阅者 */
      }
    }
  }

  getVoices() {
    this.emit();
    if (this.backend.resolveVoice) return this.backend.getVoices();
    return [...this.voices].sort((a, b) => {
      const score = (voice) => {
        const lang = String(voice.lang || '').toLowerCase();
        if (lang === 'en-gb') return 0;
        if (lang === 'en-us') return 1;
        return 2;
      };
      return score(a) - score(b) || a.name.localeCompare(b.name);
    });
  }

  resolveVoice(name) {
    if (this.backend.resolveVoice) return this.backend.resolveVoice(name);
    const voices = this.getVoices();
    if (name) {
      const exact = voices.find((voice) => voice.name === name);
      if (exact) return exact;
    }
    return voices[0] || null;
  }

  speak(text, options = {}) {
    const handle = this.backend.speak(text, {
      ...options,
      voiceName: options.voiceName ?? '',
    });
    return handle;
  }

  cancel() {
    this.backend.cancel?.();
  }

  cancelSpeech() {
    this.backend.cancel?.();
  }

  pause() {
    this.backend.pause?.();
  }

  resume() {
    this.backend.resume?.();
  }

  isSpeaking() {
    return Boolean(this.backend.isSpeaking?.());
  }
}

export const tts = new TTS();
