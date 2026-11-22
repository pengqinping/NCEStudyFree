/**
 * 本地学习状态：进度、生词 SRS、错题、笔记、设置、每日统计。
 * 所有数据只保存在浏览器 localStorage，不上传服务器。
 */
import {
  createCard,
  dueLabel,
  gradeCard,
  isDue,
  sortByDue,
} from './srs.js';
import { toContentId } from './content/content-id.js';

export const STORAGE_KEY = 'nce-study:v1';
export const STATE_VERSION = 2;

export function dayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function defaultState() {
  return {
    version: STATE_VERSION,
    settings: {
      theme: 'system',
      fontSize: 'md',
      ttsRate: 1,
      ttsVoice: '',
      showZh: true,
      autoPlay: false,
    },
    progress: {},
    favorites: [],
    srs: {},
    mistakes: {},
    notes: {},
    daily: {},
    streak: { current: 0, best: 0, lastDay: '' },
    lastLesson: '',
    lastLessonMeta: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function mergeState(raw, onSanitize = null) {
  const base = defaultState();
  const parsed = isObject(raw) ? raw : {};
  let dropped = 0;
  const lastLessonMeta = isObject(parsed.lastLessonMeta) ? parsed.lastLessonMeta : null;
  const state = {
    ...base,
    version: STATE_VERSION,
    // 旧课号 b1-u01 迁移为稳定内容 ID nce1:u01（进度与资源包版本解耦）
    lastLesson: typeof parsed.lastLesson === 'string' ? toContentId(parsed.lastLesson) : '',
    lastLessonMeta: lastLessonMeta
      ? { ...lastLessonMeta, id: toContentId(lastLessonMeta.id) }
      : null,
    createdAt: Number.isFinite(parsed.createdAt) ? parsed.createdAt : base.createdAt,
    updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : base.updatedAt,
  };

  const settings = isObject(parsed.settings) ? parsed.settings : {};
  state.settings = {
    theme: ['system', 'light', 'dark'].includes(settings.theme) ? settings.theme : base.settings.theme,
    fontSize: ['sm', 'md', 'lg'].includes(settings.fontSize) ? settings.fontSize : base.settings.fontSize,
    ttsRate: clampNumber(settings.ttsRate, 0.5, 1.5, base.settings.ttsRate),
    ttsVoice: typeof settings.ttsVoice === 'string' ? settings.ttsVoice : '',
    showZh: typeof settings.showZh === 'boolean' ? settings.showZh : true,
    autoPlay: typeof settings.autoPlay === 'boolean' ? settings.autoPlay : false,
  };

  state.streak = {
    current: Math.max(0, Math.floor(clampNumber(parsed.streak?.current, 0, 1e6, 0))),
    best: Math.max(0, Math.floor(clampNumber(parsed.streak?.best, 0, 1e6, 0))),
    lastDay: typeof parsed.streak?.lastDay === 'string' ? parsed.streak.lastDay : '',
  };

  state.progress = {};
  if (parsed.progress !== undefined && !isObject(parsed.progress)) dropped += 1;
  for (const [id, progress] of Object.entries(isObject(parsed.progress) ? parsed.progress : {})) {
    if (typeof id !== 'string' || !isObject(progress)) {
      dropped += 1;
      continue;
    }
    state.progress[toContentId(id)] = {
      ...progress,
      status: ['new', 'learning', 'done'].includes(progress.status) ? progress.status : 'new',
      visits: Math.max(0, Math.floor(clampNumber(progress.visits, 0, 1e9, 0))),
      bestScore: clampNumber(progress.bestScore, 0, 1, 0),
    };
  }

  state.srs = {};
  if (parsed.srs !== undefined && !isObject(parsed.srs)) dropped += 1;
  for (const [id, card] of Object.entries(isObject(parsed.srs) ? parsed.srs : {})) {
    if (
      typeof id !== 'string' ||
      !isObject(card) ||
      typeof card.word !== 'string' ||
      !card.word ||
      Number.isNaN(new Date(card.due).getTime())
    ) {
      dropped += 1;
      continue;
    }
    state.srs[toContentId(id)] = {
      ...card,
      id: typeof card.id === 'string' ? toContentId(card.id) : toContentId(id),
      lessonId: toContentId(card.lessonId || ''),
      phonetic: typeof card.phonetic === 'string' ? card.phonetic : '',
      pos: typeof card.pos === 'string' ? card.pos : '',
      meaning: typeof card.meaning === 'string' ? card.meaning : '',
      usage: typeof card.usage === 'string' ? card.usage : '',
      ease: clampNumber(card.ease, 1.3, 3, 2.5),
      interval: Math.max(0, clampNumber(card.interval, 0, 3650, 1)),
      reps: Math.max(0, Math.floor(clampNumber(card.reps, 0, 1e6, 0))),
      lapses: Math.max(0, Math.floor(clampNumber(card.lapses, 0, 1e6, 0))),
    };
  }

  state.mistakes = {};
  if (parsed.mistakes !== undefined && !isObject(parsed.mistakes)) dropped += 1;
  for (const [id, mistake] of Object.entries(isObject(parsed.mistakes) ? parsed.mistakes : {})) {
    if (
      typeof id !== 'string' ||
      !isObject(mistake) ||
      !isObject(mistake.question) ||
      typeof mistake.question.id !== 'string' ||
      !mistake.question.id ||
      typeof mistake.lessonId !== 'string'
    ) {
      dropped += 1;
      continue;
    }
    state.mistakes[toContentId(id)] = {
      ...mistake,
      lessonId: toContentId(mistake.lessonId),
      question: { ...mistake.question, id: toContentId(mistake.question.id) },
      lessonMeta: isObject(mistake.lessonMeta)
        ? { ...mistake.lessonMeta, id: toContentId(mistake.lessonMeta.id) }
        : mistake.lessonMeta,
    };
  }

  state.notes = {};
  if (parsed.notes !== undefined && !isObject(parsed.notes)) dropped += 1;
  for (const [id, note] of Object.entries(isObject(parsed.notes) ? parsed.notes : {})) {
    if (typeof id !== 'string' || typeof note !== 'string') {
      dropped += 1;
      continue;
    }
    state.notes[toContentId(id)] = note;
  }

  state.daily = {};
  if (parsed.daily !== undefined && !isObject(parsed.daily)) dropped += 1;
  for (const [day, entry] of Object.entries(isObject(parsed.daily) ? parsed.daily : {})) {
    if (typeof day !== 'string' || !isObject(entry)) {
      dropped += 1;
      continue;
    }
    state.daily[day] = {
      seconds: Math.max(0, Math.floor(clampNumber(entry.seconds, 0, 86400, 0))),
      answered: Math.max(0, Math.floor(clampNumber(entry.answered, 0, 1e6, 0))),
      correct: Math.max(0, Math.floor(clampNumber(entry.correct, 0, 1e6, 0))),
      lessons: Array.isArray(entry.lessons)
        ? entry.lessons.filter((id) => typeof id === 'string').map(toContentId)
        : [],
    };
  }

  state.favorites = Array.isArray(parsed.favorites)
    ? [...new Set(parsed.favorites.filter((id) => typeof id === 'string').map(toContentId))]
    : [];

  onSanitize?.(dropped);
  return state;
}

export class Store {
  constructor({ storage = globalThis.localStorage, key = STORAGE_KEY } = {}) {
    this.storage = storage;
    this.key = key;
    this.state = defaultState();
    this.listeners = new Set();
    this.saveTimer = null;
    this.lastError = null;
    this.errorNotified = false;
    this.onError = null;
  }

  load() {
    let raw = null;
    try {
      raw = this.storage?.getItem(this.key) ?? null;
    } catch (error) {
      this.notifyError(error);
    }
    if (!raw) {
      this.state = defaultState();
      return this.state;
    }
    try {
      const parsed = JSON.parse(raw);
      this.state = mergeState(parsed, (dropped) => {
        if (!dropped) return;
        try {
          this.storage?.setItem(`${this.key}:corrupt:${Date.now()}`, raw);
        } catch {
          /* 忽略备份失败 */
        }
      });
    } catch (error) {
      this.notifyError(error);
      try {
        this.storage?.setItem(`${this.key}:corrupt:${Date.now()}`, raw);
      } catch {
        /* 忽略备份失败 */
      }
      this.state = defaultState();
      this.save(true);
    }
    return this.state;
  }

  notifyError(error) {
    this.lastError = error;
    if (this.errorNotified) return;
    this.errorNotified = true;
    this.onError?.(error);
  }

  setKey(key, { saveCurrent = true } = {}) {
    if (!key || key === this.key) return this.state;
    if (saveCurrent) this.save(true);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.key = key;
    this.state = defaultState();
    this.load();
    this.emit();
    return this.state;
  }

  reload() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.state = defaultState();
    this.load();
    this.emit();
    return this.state;
  }

  save(immediate = false) {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const write = () => {
      try {
        this.state.updatedAt = Date.now();
        this.storage?.setItem(this.key, JSON.stringify(this.state));
        this.lastError = null;
        this.errorNotified = false;
      } catch (error) {
        this.notifyError(error);
      }
    };
    if (immediate) {
      write();
    } else {
      this.saveTimer = setTimeout(write, 250);
    }
  }

  commit() {
    this.state.updatedAt = Date.now();
    this.save();
    this.emit();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 接收另一个标签页写入的状态（storage 事件）。 */
  applyExternalState(raw) {
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      if (!isObject(parsed)) return false;
      const next = mergeState(parsed);
      if ((next.updatedAt || 0) < (this.state.updatedAt || 0)) return false;
      this.state = next;
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  watchExternalChanges() {
    if (typeof window === 'undefined') return () => {};
    const onStorage = (event) => {
      if (event.key !== this.key || !event.newValue) return;
      this.applyExternalState(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }

  emit() {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        /* 单个订阅者失败不影响其他订阅者 */
      }
    }
  }

  updateSettings(patch) {
    this.state.settings = { ...this.state.settings, ...patch };
    this.commit();
  }

  getSettings() {
    return this.state.settings;
  }

  // ---------- 进度 ----------
  // 所有课号统一归一化为稳定内容 ID（nce1:u01），兼容旧 b1-u01 传参
  getProgress(lessonId) {
    const progress = this.state.progress[toContentId(lessonId)];
    return progress
      ? { status: 'new', visits: 0, bestScore: 0, ...progress }
      : { status: 'new', visits: 0, bestScore: 0 };
  }

  markVisit(lessonId, meta = null) {
    lessonId = toContentId(lessonId);
    const progress = this.getProgress(lessonId);
    progress.visits = (progress.visits || 0) + 1;
    progress.lastVisit = Date.now();
    if (progress.status === 'new') progress.status = 'learning';
    if (meta) {
      progress.meta = meta;
      this.state.lastLessonMeta = meta;
    }
    this.state.progress[lessonId] = progress;
    this.state.lastLesson = lessonId;
    const day = this.touchDay();
    if (!day.lessons.includes(lessonId)) day.lessons.push(lessonId);
    this.commit();
  }

  setStatus(lessonId, status) {
    lessonId = toContentId(lessonId);
    const progress = this.getProgress(lessonId);
    progress.status = status;
    if (status === 'done') {
      progress.completedAt = Date.now();
      if (!progress.bestScore) progress.bestScore = 1;
    } else {
      delete progress.completedAt;
    }
    this.state.progress[lessonId] = progress;
    this.commit();
  }

  markScore(lessonId, score) {
    lessonId = toContentId(lessonId);
    const progress = this.getProgress(lessonId);
    progress.bestScore = Math.max(progress.bestScore || 0, score);
    if (score >= 0.8 && progress.status !== 'done') {
      progress.status = 'done';
      progress.completedAt = Date.now();
    }
    this.state.progress[lessonId] = progress;
    this.commit();
  }

  toggleFavorite(lessonId) {
    lessonId = toContentId(lessonId);
    const index = this.state.favorites.indexOf(lessonId);
    if (index >= 0) this.state.favorites.splice(index, 1);
    else this.state.favorites.push(lessonId);
    this.commit();
    return this.state.favorites.includes(lessonId);
  }

  isFavorite(lessonId) {
    return this.state.favorites.includes(toContentId(lessonId));
  }

  // ---------- 每日统计与连续天数 ----------
  touchDay(now = new Date()) {
    const today = dayKey(now);
    if (!this.state.daily[today]) {
      this.state.daily[today] = { seconds: 0, answered: 0, correct: 0, lessons: [] };
    }
    const streak = this.state.streak;
    if (streak.lastDay !== today) {
      const yesterday = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
      streak.current = streak.lastDay === yesterday ? (streak.current || 0) + 1 : 1;
      streak.best = Math.max(streak.best || 0, streak.current);
      streak.lastDay = today;
    }
    return this.state.daily[today];
  }

  recordStudySeconds(seconds) {
    if (!seconds || seconds <= 0) return;
    const day = this.touchDay();
    day.seconds = Math.round((day.seconds || 0) + seconds);
    this.commit();
  }

  recordAnswer(lessonId, question, correct, responseText = '', lessonMeta = null) {
    lessonId = toContentId(lessonId);
    const questionId = toContentId(question?.id);
    const day = this.touchDay();
    day.answered = (day.answered || 0) + 1;
    if (correct) day.correct = (day.correct || 0) + 1;
    if (!day.lessons.includes(lessonId)) day.lessons.push(lessonId);

    if (!correct) {
      const existing = this.state.mistakes[questionId] || {
        question,
        lessonId,
        wrong: 0,
        correctStreak: 0,
      };
      existing.question = { ...question, id: questionId };
      existing.lessonId = lessonId;
      if (lessonMeta) existing.lessonMeta = { ...lessonMeta, id: toContentId(lessonMeta.id) };
      existing.wrong = (existing.wrong || 0) + 1;
      existing.lastWrong = Date.now();
      existing.lastAnswer = responseText;
      existing.correctStreak = 0;
      this.state.mistakes[questionId] = existing;
    } else if (this.state.mistakes[questionId]) {
      const mistake = this.state.mistakes[questionId];
      mistake.correctStreak = (mistake.correctStreak || 0) + 1;
      if (mistake.correctStreak >= 2) delete this.state.mistakes[questionId];
    }
    this.commit();
  }

  getToday() {
    return this.touchDay();
  }

  // ---------- 生词 SRS ----------
  addSrs(vocab, lessonId) {
    const card = createCard(vocab, toContentId(lessonId));
    if (this.state.srs[card.id]) return false;
    this.state.srs[card.id] = card;
    this.commit();
    return true;
  }

  hasSrs(vocab, lessonId) {
    return Boolean(this.state.srs[`${toContentId(lessonId)}:${vocab.word}`]);
  }

  removeSrs(cardId) {
    delete this.state.srs[cardId];
    this.commit();
  }

  gradeSrs(cardId, grade) {
    const card = this.state.srs[cardId];
    if (!card) return null;
    const next = gradeCard(card, grade);
    this.state.srs[cardId] = next;
    this.touchDay();
    this.commit();
    return next;
  }

  dueSrs(now = Date.now()) {
    return sortByDue(Object.values(this.state.srs).filter((card) => isDue(card, now)));
  }

  allSrs() {
    return Object.values(this.state.srs);
  }

  srsDueLabel(card) {
    return dueLabel(card);
  }

  // ---------- 笔记 ----------
  getNote(lessonId) {
    return this.state.notes[toContentId(lessonId)] || '';
  }

  saveNote(lessonId, text) {
    const value = String(text || '').trimEnd();
    if (value.trim()) this.state.notes[toContentId(lessonId)] = value;
    else delete this.state.notes[toContentId(lessonId)];
    this.commit();
  }

  // ---------- 备份 ----------
  exportData() {
    return JSON.stringify(
      {
        ...this.state,
        exportedAt: new Date().toISOString(),
        app: 'NCEStudyFree',
      },
      null,
      2,
    );
  }

  importData(raw) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isObject(parsed)) throw new Error('备份内容不是有效对象');
    if (!isObject(parsed.progress) || !isObject(parsed.settings)) {
      throw new Error('备份缺少 progress 或 settings');
    }
    this.state = mergeState(parsed);
    this.commit();
    return true;
  }

  reset() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.state = defaultState();
    try {
      this.storage?.removeItem(this.key);
    } catch {
      /* 忽略 */
    }
    this.emit();
  }

  storageBytes() {
    try {
      return new Blob([JSON.stringify(this.state)]).size;
    } catch {
      return JSON.stringify(this.state).length;
    }
  }
}

export const store = new Store();
