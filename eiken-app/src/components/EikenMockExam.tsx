import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Bookmark,
  BookmarkCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Flag,
  Headphones,
  KeyRound,
  Languages,
  LayoutGrid,
  ListChecks,
  MinusCircle,
  Pause,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { DoorMascot } from './DoorMascot';
import { subjectTheme } from '../data/subjectTheme';
import { EIKEN_GRADES, type EikenGrade } from '../eiken/config';
import { ALL_LISTENING_EXAMS } from '../eiken/materials/listening-booklets';
import { WRITTEN_BOOKLETS } from '../eiken/materials/written-booklets';
import { LISTENING_AUDIO_URLS } from '../eiken/listeningAudio.generated';
import { LISTENING_IMAGE_URLS } from '../eiken/listeningImages.generated';
import {
  LISTENING_BLUEPRINTS,
  type ListeningAudioUnit,
  type ListeningExamRound,
  type ListeningPartId,
} from '../eiken/listeningExamCore';
import { getGradeListeningPartSpecs, listeningUnitToProblem } from '../eiken/listeningPractice';
import { bookletItemToProblem, getGradeDaimonSpecs, WRITTEN_SECTION_LABELS } from '../eiken/writtenPractice';
import {
  countEnglishWords,
  WRITTEN_BLUEPRINTS,
  type WrittenExam,
  type WrittenItem,
  type WrittenSection,
} from '../eiken/writtenExamCore';
import {
  emptyMockState,
  formatDuration,
  mockStorageKey,
  parseMockState,
  scoreListeningMockExam,
  scoreMockExam,
  SECTION_LABELS,
  type MockProgressState,
  type MockSubmittedRecord,
  type MockWritingEntry,
} from '../eiken/mockProgress';
import { parseWriting, writingKey, type WritingDraft } from '../eiken/writingProgress';
import { splitEikenDialogueTurns } from './eikenClozePageModel';
import { ListeningAudioPlayer } from './ListeningAudioPlayer';
import { ListeningMaterials } from './ListeningMaterials';
import { stopSpeech } from '../utils/listeningSpeech';
import { notify } from '../utils/dialog';
import { markProblemSolved } from '../utils/progress';
import { saveQuestionNote } from '../utils/questionNote';
import { captureWrongAnswers, type WrongAnswerInput } from '../utils/reviewList';
import { readJsonArray, safeLocalStorage } from '../utils/safeLocalStorage';
import { UNIT_STATUS_LABEL } from '../utils/unitStats';
import './unit-select.css';
import './unit-card.css';
import './eiken-mock-exam.css';

const BATCH_CLOZE_PER_PAGE = 5;

export type MockExamKind = 'written' | 'listening';

export interface ExamUnit {
  id: string;
  section: WrittenSection;
  kind: 'choice' | 'writing';
  batchCloze?: boolean;
  passage?: WrittenItem['passage'];
  items: { item: WrittenItem; qNo: number }[];
}

export function buildExamUnits(exam: WrittenExam, sectionFilter: 'all' | WrittenSection = 'all'): ExamUnit[] {
  const units: ExamUnit[] = [];
  exam.items.forEach((item, idx) => {
    if (sectionFilter !== 'all' && item.section !== sectionFilter) return;
    const qNo = idx + 1;
    if (item.kind === 'choice' && item.passage) {
      const prev = units[units.length - 1];
      if (prev && prev.kind === 'choice' && prev.passage?.id === item.passage.id && prev.section === item.section) {
        prev.items.push({ item, qNo });
        return;
      }
      units.push({
        id: `passage_${item.passage.id}_${item.section}`,
        section: item.section,
        kind: 'choice',
        passage: item.passage,
        items: [{ item, qNo }],
      });
      return;
    }

    // 短文の語句空所補充・会話文の空所補充は1ページに最大5問ずつまとめて見渡せるようにする
    if (item.kind === 'choice' && (item.section === 'short' || item.section === 'conversation')) {
      const prev = units[units.length - 1];
      if (prev && prev.batchCloze && prev.section === item.section && prev.items.length < BATCH_CLOZE_PER_PAGE) {
        prev.items.push({ item, qNo });
        return;
      }
      units.push({
        id: `batch_${item.section}_${qNo}`,
        section: item.section,
        kind: 'choice',
        batchCloze: true,
        items: [{ item, qNo }],
      });
      return;
    }

    units.push({
      id: item.id,
      section: item.section,
      kind: item.kind,
      passage: item.passage,
      items: [{ item, qNo }],
    });
  });
  return units;
}

/** 英文中の `(     )` または `( ___ )` を下線空所ボックスとして描画し、選択語句があれば差し込む */
function PromptWithInlineBlank({
  prompt,
  filled,
  tone,
}: {
  prompt: string;
  filled: string;
  tone?: 'right' | 'wrong';
}) {
  const match = prompt.match(/\(\s*_{0,6}\s*\)/);
  if (!match || match.index === undefined) {
    return <>{prompt}</>;
  }
  const before = prompt.slice(0, match.index);
  const after = prompt.slice(match.index + match[0].length);
  return (
    <>
      {before}
      <span className="em-inline-blank" data-filled={filled ? true : undefined} data-tone={tone}>
        {filled || '\u00A0'}
      </span>
      {after}
    </>
  );
}

/** 対話（`A: ...\nB: ...`）か通常文かを自動判定して見やすく描画 */
function MockCompactStem({
  qNo,
  prompt,
  filled,
}: {
  qNo: number;
  prompt: string;
  filled: string;
}) {
  const turns = splitEikenDialogueTurns(prompt);
  if (turns) {
    return (
      <div className="em-dialogue-stem">
        <div className="em-dialogue-top">
          <span className="em-compact-no" aria-hidden="true">
            {qNo}
          </span>
          <span className="sr-only">問{qNo} </span>
          <span className="em-dialogue-kicker">対話</span>
        </div>
        <div className="em-dialogue-lines">
          {turns.map((t, i) => (
            <div key={i} className="em-dialogue-line">
              <span className="em-speaker-pill" data-speaker={t.speaker} aria-hidden="true">
                {t.speaker}
              </span>
              <span className="sr-only">{t.speaker}: </span>
              <span className="em-dialogue-text" lang="en">
                <PromptWithInlineBlank prompt={t.text} filled={filled} />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <p className="em-compact-sentence">
      <span className="em-compact-no" aria-hidden="true">
        {qNo}
      </span>
      <span className="sr-only">問{qNo} </span>
      <span lang="en">
        <PromptWithInlineBlank prompt={prompt} filled={filled} />
      </span>
    </p>
  );
}

/**
 * 長文の語句空所補充（cloze）・Eメール返信の下線部（`__...__`）をリッチに描画する本文コンポーネント。
 * 長文空所 `( 21 )` などは、すでに選んだ選択肢があればその語句も並記し、クリックすると設問カードへスクロールする。
 */
function PassageBodyRich({
  text,
  section,
  unitItems,
  answers,
  onJumpToQuestionNo,
}: {
  text: string;
  section: WrittenSection;
  unitItems: { item: WrittenItem; qNo: number }[];
  answers: Record<string, number>;
  onJumpToQuestionNo?: (qNo: number) => void;
}) {
  if (section === 'cloze') {
    const parts = text.split(/(\(\s*\d+\s*\))/g);
    return (
      <div className="em-passage-body" lang="en">
        {parts.map((part, idx) => {
          const m = part.match(/^\(\s*(\d+)\s*\)$/);
          if (!m) return <React.Fragment key={idx}>{part}</React.Fragment>;
          const num = Number(m[1]);
          const matched = unitItems.find(u => u.qNo === num);
          const pickedIdx = matched ? answers[matched.item.id] : undefined;
          const pickedWord =
            matched && Number.isInteger(pickedIdx) ? matched.item.choices?.[pickedIdx!] ?? '' : '';
          return (
            <button
              key={idx}
              type="button"
              className={`em-passage-cloze-slot ${pickedWord ? 'is-filled' : ''}`}
              onClick={() => onJumpToQuestionNo?.(num)}
              title={pickedWord ? `空所(${num})：${pickedWord}（クリックで設問へ）` : `空所(${num})の設問へ移動`}
            >
              <span className="em-slot-num">({num})</span>
              {pickedWord && <span className="em-slot-word">{pickedWord}</span>}
            </button>
          );
        })}
      </div>
    );
  }

  // Eメール課題などの `__How long did you skate there?__` 下線強調を綺麗に表示
  if (text.includes('__')) {
    const segments = text.split(/(__[^_]+__)/g);
    return (
      <div className="em-passage-body" lang="en">
        {segments.map((seg, idx) => {
          if (seg.startsWith('__') && seg.endsWith('__') && seg.length > 4) {
            return (
              <u key={idx} className="em-passage-underline">
                {seg.slice(2, -2)}
              </u>
            );
          }
          return <React.Fragment key={idx}>{seg}</React.Fragment>;
        })}
      </div>
    );
  }

  return (
    <div className="em-passage-body" lang="en">
      {text}
    </div>
  );
}

function estimateSectionMinutes(grade: EikenGrade, sectionFilter: 'all' | WrittenSection): number {
  const fullMin = WRITTEN_BLUEPRINTS[grade]?.minutes ?? 60;
  if (sectionFilter === 'all') return fullMin;
  const spec = WRITTEN_BLUEPRINTS[grade]?.sections.find(s => s.id === sectionFilter);
  if (!spec) return 15;
  if (spec.id === 'short') return Math.max(12, spec.count);
  if (spec.id === 'conversation' || spec.id === 'reorder') return Math.max(8, spec.count * 2);
  if (spec.id === 'cloze') return Math.max(12, spec.count * 3);
  if (spec.id === 'reading') return Math.max(20, spec.count * 3);
  if (spec.kind === 'writing') return 20;
  return 15;
}

function estimateListeningMinutes(grade: EikenGrade, partFilter: 'all' | ListeningPartId): number {
  const bp = LISTENING_BLUEPRINTS[grade];
  if (!bp) return 25;
  if (partFilter === 'all') return bp.minutes;
  const part = bp.parts.find(p => p.id === partFilter);
  if (!part) return 10;
  return Math.max(6, Math.round((bp.minutes * part.questionCount) / Math.max(1, bp.totalQuestions)));
}

function sessionRecordKey(examId: string, scopeFilter: string): string {
  return scopeFilter === 'all' ? examId : `${examId}__${scopeFilter}`;
}

function readMock(uid: string): MockProgressState {
  const ls = safeLocalStorage();
  if (!ls) return emptyMockState();
  return parseMockState(ls.getItem(mockStorageKey(uid)));
}

function writeMock(uid: string, next: MockProgressState): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(mockStorageKey(uid), JSON.stringify(next));
  } catch {
    /* ignore quota errors */
  }
}

function syncSubmittedMockToStudyLedger(
  uid: string,
  exam: WrittenExam,
  answers: Record<string, number>,
  writing: Record<string, MockWritingEntry>,
  sectionFilter: 'all' | WrittenSection = 'all',
): void {
  const wrongInputs: WrongAnswerInput[] = [];
  const gradeLabel = EIKEN_GRADES.find(g => g.id === exam.grade)?.label ?? exam.grade;
  const inScope = (item: WrittenItem) => sectionFilter === 'all' || item.section === sectionFilter;

  // 1) 短文・会話・整序の進捗 & 誤答連携
  exam.items.forEach((item, idx) => {
    if (!inScope(item) || item.kind !== 'choice') return;
    const picked = answers[item.id];
    const qNo = idx + 1;
    if (!item.passage) {
      const chapterId = `${exam.id}_${item.section}`;
      if (picked === item.answer) {
        markProblemSolved(uid, chapterId, item.id, 1);
      } else if (Number.isInteger(picked)) {
        wrongInputs.push({
          chapterId,
          chapterTitle: `${gradeLabel} 筆記 第${exam.round}回｜${SECTION_LABELS[item.section]}`,
          questionIndex: 0,
          questionId: item.id,
          subQuestionId: `${item.id}_answer`,
          subLabel: `問${qNo}`,
          questionText: item.prompt,
          correctAnswer: `${item.answer! + 1}. ${item.choices![item.answer!]}`,
          wrongAnswer: `${picked + 1}. ${item.choices![picked]}`,
        });
      }
    }
  });

  // 2) 長文空所・長文読解（パッセージ単位の Problem ID と一致させる）
  const passageGroups = new Map<string, { section: WrittenSection; items: { item: WrittenItem; qNo: number }[] }>();
  exam.items.forEach((item, idx) => {
    if (inScope(item) && item.kind === 'choice' && item.passage) {
      const key = `${item.section}::${item.passage.id}`;
      const cur = passageGroups.get(key) ?? { section: item.section, items: [] };
      cur.items.push({ item, qNo: idx + 1 });
      passageGroups.set(key, cur);
    }
  });
  for (const [, group] of passageGroups) {
    const first = group.items[0].item;
    const chapterId = `${exam.id}_${group.section}`;
    const problemId = `${exam.id}_${first.passage!.id}`;
    let groupScore = 0;
    for (const { item, qNo } of group.items) {
      const picked = answers[item.id];
      if (picked === item.answer) {
        groupScore += 1;
      } else if (Number.isInteger(picked)) {
        wrongInputs.push({
          chapterId,
          chapterTitle: `${gradeLabel} 筆記 第${exam.round}回｜${SECTION_LABELS[group.section]}`,
          questionIndex: 0,
          questionId: problemId,
          subQuestionId: `${item.id}_answer`,
          subLabel: `問${qNo}`,
          questionText: `${first.passage!.title} — ${item.prompt}`,
          correctAnswer: `${item.answer! + 1}. ${item.choices![item.answer!]}`,
          wrongAnswer: `${picked + 1}. ${item.choices![picked]}`,
        });
      }
    }
    if (groupScore >= 1) {
      markProblemSolved(uid, chapterId, problemId, groupScore);
    }
  }

  if (wrongInputs.length > 0) {
    captureWrongAnswers(uid, wrongInputs);
  }

  // 3) ライティング下書きを EikenWriting の保存領域にも連携（空欄で既存を上書きしない）
  const ls = safeLocalStorage();
  if (ls) {
    try {
      const roundLetter = String.fromCharCode(96 + exam.round);
      const currentWriting = parseWriting(ls.getItem(writingKey(uid)));
      let changed = false;
      for (const item of exam.items) {
        if (!inScope(item) || item.kind !== 'writing') continue;
        const entry = writing[item.id];
        if (!entry || !entry.text.trim()) continue;
        const wKey = `${exam.grade}_writing_round${roundLetter}${item.section}`;
        const existing: WritingDraft | undefined = currentWriting.drafts[wKey];
        const checked = Array.isArray(entry.checked) ? entry.checked : existing?.checked ?? [];
        currentWriting.drafts[wKey] = {
          text: entry.text,
          checked,
          reviewed: checked.length === (item.rubric?.length ?? 4),
          updatedAt: Date.now(),
        };
        changed = true;
      }
      if (changed) {
        ls.setItem(writingKey(uid), JSON.stringify(currentWriting));
      }
    } catch {
      /* ignore writing sync errors */
    }
  }
}

function syncSubmittedListeningMockToStudyLedger(
  uid: string,
  exam: ListeningExamRound,
  answers: Record<string, number>,
  partFilter: 'all' | ListeningPartId = 'all',
): void {
  const wrongInputs: WrongAnswerInput[] = [];
  const gradeLabel = EIKEN_GRADES.find(g => g.id === exam.grade)?.label ?? exam.grade;
  const blueprint = LISTENING_BLUEPRINTS[exam.grade];

  for (const unit of exam.units) {
    if (partFilter !== 'all' && unit.part !== partFilter) continue;
    const partSpec = blueprint?.parts.find(p => p.id === unit.part);
    const chapterId = `${exam.id}_${unit.part}`;
    const chapterTitle = `${gradeLabel} リスニング 第${exam.round}回｜${partSpec?.label ?? unit.part}`;
    let unitScore = 0;

    for (const q of unit.questions) {
      const picked = answers[q.id];
      if (picked === q.answer) {
        unitScore += 1;
      } else if (Number.isInteger(picked) && picked >= 0 && picked < q.choices.length) {
        wrongInputs.push({
          chapterId,
          chapterTitle,
          questionIndex: unit.unitIndex - 1,
          questionId: unit.audioId,
          subQuestionId: `${q.id}_answer`,
          subLabel: `No.${q.questionNumber}`,
          questionText: q.questionPrompt || `${partSpec?.label ?? unit.part} No.${q.questionNumber}`,
          correctAnswer: `${q.answer + 1}. ${q.choices[q.answer]}`,
          wrongAnswer: `${picked + 1}. ${q.choices[picked]}`,
        });
      }
    }

    if (unitScore >= 1) {
      markProblemSolved(uid, chapterId, unit.audioId, unitScore);
    }
  }

  if (wrongInputs.length > 0) {
    captureWrongAnswers(uid, wrongInputs);
  }
}

export function EikenMockExam({
  uid,
  grade: initialGrade,
  onGrade,
  onBack,
  onRunningChange,
  initialExamKind,
  backLabel = '学習へ',
}: {
  uid: string;
  grade: EikenGrade;
  onGrade: (grade: EikenGrade) => void;
  onBack: () => void;
  onRunningChange?: (running: boolean) => void;
  initialExamKind?: MockExamKind;
  backLabel?: string;
}) {
  const [examKind, setExamKind] = useState<MockExamKind>(() => {
    if (initialExamKind) return initialExamKind;
    if (initialGrade === 'eiken_1') return 'listening';
    return 'written';
  });

  useEffect(() => {
    if (initialExamKind) {
      setExamKind(initialExamKind);
    }
  }, [initialExamKind]);

  const writtenAvailableGrades = useMemo(
    () => EIKEN_GRADES.filter(g => g.available && WRITTEN_BOOKLETS.some(b => b.grade === g.id)),
    [],
  );
  const listeningAvailableGrades = useMemo(
    () => EIKEN_GRADES.filter(g => g.available && ALL_LISTENING_EXAMS.some(b => b.grade === g.id)),
    [],
  );
  const availableGrades = examKind === 'listening' ? listeningAvailableGrades : writtenAvailableGrades;
  const grade: EikenGrade = availableGrades.some(g => g.id === initialGrade)
    ? initialGrade
    : examKind === 'listening'
    ? 'eiken_5'
    : 'eiken_3';
  const gradeLabel = availableGrades.find(g => g.id === grade)?.label ?? '英検3級';
  const theme = subjectTheme(grade);
  const blueprint = WRITTEN_BLUEPRINTS[grade];
  const gradeExams = useMemo(
    () => WRITTEN_BOOKLETS.filter(b => b.grade === grade && b.review === 'approved').sort((a, b) => a.round - b.round),
    [grade],
  );

  const gradeDaimons = useMemo(() => getGradeDaimonSpecs(grade), [grade]);
  const [scopeSection, setScopeSection] = useState<'all' | WrittenSection>('all');

  useEffect(() => {
    if (scopeSection !== 'all' && !gradeDaimons.some(d => d.section === scopeSection)) {
      setScopeSection('all');
    }
  }, [gradeDaimons, scopeSection]);

  const activeDaimonSpec = useMemo(
    () => (scopeSection === 'all' ? null : gradeDaimons.find(d => d.section === scopeSection) ?? null),
    [gradeDaimons, scopeSection],
  );

  // Listening specs & exams
  const listeningBlueprint = LISTENING_BLUEPRINTS[grade];
  const gradeListeningExams = useMemo(
    () => ALL_LISTENING_EXAMS.filter(e => e.grade === grade && e.review === 'approved').sort((a, b) => a.round - b.round),
    [grade],
  );
  const gradeListeningParts = useMemo(() => getGradeListeningPartSpecs(grade), [grade]);
  const [scopePart, setScopePart] = useState<'all' | ListeningPartId>('all');

  useEffect(() => {
    if (scopePart !== 'all' && !gradeListeningParts.some(p => p.partId === scopePart)) {
      setScopePart('all');
    }
  }, [gradeListeningParts, scopePart]);

  const activePartSpec = useMemo(
    () => (scopePart === 'all' ? null : gradeListeningParts.find(p => p.partId === scopePart) ?? null),
    [gradeListeningParts, scopePart],
  );

  const [mockState, setMockState] = useState<MockProgressState>(() => readMock(uid));
  const [phase, setPhase] = useState<'select' | 'running' | 'result'>('select');
  const [timedMode, setTimedMode] = useState<boolean>(true);
  const [activeExamId, setActiveExamId] = useState<string | null>(null);

  // Running state
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [writing, setWriting] = useState<Record<string, MockWritingEntry>>({});
  const [flags, setFlags] = useState<string[]>([]);
  const [unitIndex, setUnitIndex] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [paused, setPaused] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  // Result state
  const [resultFilter, setResultFilter] = useState<'all' | 'wrong' | 'flagged'>('all');
  const [submittedRecord, setSubmittedRecord] = useState<MockSubmittedRecord | null>(null);
  const [savedNotes, setSavedNotes] = useState<Record<string, boolean>>(() => {
    const existing = readJsonArray<{ questionId?: string }>(`notes_${uid || 'guest'}`);
    const map: Record<string, boolean> = {};
    for (const n of existing) {
      if (n?.questionId) map[n.questionId] = true;
    }
    return map;
  });

  const activeWrittenExam = useMemo(
    () => (examKind === 'written' ? WRITTEN_BOOKLETS.find(b => b.id === activeExamId) ?? null : null),
    [examKind, activeExamId],
  );
  const activeListeningExam = useMemo(
    () => (examKind === 'listening' ? ALL_LISTENING_EXAMS.find(e => e.id === activeExamId) ?? null : null),
    [examKind, activeExamId],
  );
  const activeExam = activeWrittenExam;
  const hasActiveExam = examKind === 'listening' ? Boolean(activeListeningExam) : Boolean(activeWrittenExam);

  const units = useMemo(
    () => (activeWrittenExam ? buildExamUnits(activeWrittenExam, scopeSection) : []),
    [activeWrittenExam, scopeSection],
  );
  const listeningUnits = useMemo<readonly ListeningAudioUnit[]>(
    () =>
      activeListeningExam
        ? scopePart === 'all'
          ? activeListeningExam.units
          : activeListeningExam.units.filter(u => u.part === scopePart)
        : [],
    [activeListeningExam, scopePart],
  );

  const scopedMinutes =
    examKind === 'listening'
      ? estimateListeningMinutes(activeListeningExam ? activeListeningExam.grade : grade, scopePart)
      : estimateSectionMinutes(activeWrittenExam ? activeWrittenExam.grade : grade, scopeSection);
  const limitSec = scopedMinutes * 60;
  const activeStorageSlot =
    examKind === 'listening'
      ? activeListeningExam
        ? sessionRecordKey(activeListeningExam.id, scopePart)
        : ''
      : activeWrittenExam
      ? sessionRecordKey(activeWrittenExam.id, scopeSection)
      : '';

  useEffect(() => {
    onRunningChange?.(phase === 'running');
    return () => onRunningChange?.(false);
  }, [phase, onRunningChange]);

  // Stop speech when leaving running/result or switching unit
  useEffect(() => {
    if (phase === 'select') {
      stopSpeech();
    }
    return () => stopSpeech();
  }, [phase, unitIndex]);

  // Tick timer every second while running and not paused
  useEffect(() => {
    if (phase !== 'running' || paused || !hasActiveExam) return;
    const id = window.setInterval(() => {
      setElapsedSec(prev => prev + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, paused, hasActiveExam]);

  // Persist in-progress session automatically
  const latestSessionRef = useRef({ answers, writing, flags, elapsedSec, timedMode, limitSec, unitIndex });
  latestSessionRef.current = { answers, writing, flags, elapsedSec, timedMode, limitSec, unitIndex };

  useEffect(() => {
    if (phase !== 'running' || !hasActiveExam || !activeStorageSlot) return;
    const cur = readMock(uid);
    const next: MockProgressState = {
      ...cur,
      sessions: {
        ...cur.sessions,
        [activeStorageSlot]: {
          examId: activeStorageSlot,
          answers,
          writing,
          flags,
          elapsedSec,
          timed: timedMode,
          limitSec,
          currentIndex: unitIndex,
          updatedAt: Date.now(),
        },
      },
    };
    writeMock(uid, next);
    setMockState(next);
  }, [phase, hasActiveExam, activeStorageSlot, answers, writing, flags, unitIndex, timedMode, limitSec, uid]);

  // Also save elapsedSec every 5s without re-rendering heavy structures unnecessarily
  useEffect(() => {
    if (phase !== 'running' || !hasActiveExam || !activeStorageSlot || elapsedSec === 0 || elapsedSec % 5 !== 0) return;
    const cur = readMock(uid);
    const s = latestSessionRef.current;
    const next: MockProgressState = {
      ...cur,
      sessions: {
        ...cur.sessions,
        [activeStorageSlot]: {
          examId: activeStorageSlot,
          answers: s.answers,
          writing: s.writing,
          flags: s.flags,
          elapsedSec: s.elapsedSec,
          timed: s.timedMode,
          limitSec: s.limitSec,
          currentIndex: s.unitIndex,
          updatedAt: Date.now(),
        },
      },
    };
    writeMock(uid, next);
  }, [elapsedSec, phase, hasActiveExam, activeStorageSlot, uid]);

  const startExam = (exam: WrittenExam, resume: boolean, targetScope: 'all' | WrittenSection = scopeSection) => {
    const slot = sessionRecordKey(exam.id, targetScope);
    const savedSession = resume ? mockState.sessions[slot] : undefined;
    setExamKind('written');
    setScopeSection(targetScope);
    setActiveExamId(exam.id);
    if (savedSession) {
      setAnswers(savedSession.answers);
      setWriting(savedSession.writing);
      setFlags(savedSession.flags);
      setElapsedSec(savedSession.elapsedSec);
      setTimedMode(savedSession.timed);
      setUnitIndex(Math.min(savedSession.currentIndex, Math.max(0, buildExamUnits(exam, targetScope).length - 1)));
    } else {
      setAnswers({});
      setWriting({});
      setFlags([]);
      setElapsedSec(0);
      setUnitIndex(0);
    }
    setPaused(false);
    setPaletteOpen(false);
    setConfirmSubmit(false);
    setPhase('running');
    window.scrollTo(0, 0);
  };

  const startListeningExam = (
    exam: ListeningExamRound,
    resume: boolean,
    targetScope: 'all' | ListeningPartId = scopePart,
  ) => {
    const slot = sessionRecordKey(exam.id, targetScope);
    const savedSession = resume ? mockState.sessions[slot] : undefined;
    const targetUnits = targetScope === 'all' ? exam.units : exam.units.filter(u => u.part === targetScope);
    setExamKind('listening');
    setScopePart(targetScope);
    setActiveExamId(exam.id);
    if (savedSession) {
      setAnswers(savedSession.answers);
      setWriting({});
      setFlags(savedSession.flags);
      setElapsedSec(savedSession.elapsedSec);
      setTimedMode(savedSession.timed);
      setUnitIndex(Math.min(savedSession.currentIndex, Math.max(0, targetUnits.length - 1)));
    } else {
      setAnswers({});
      setWriting({});
      setFlags([]);
      setElapsedSec(0);
      setUnitIndex(0);
    }
    setPaused(false);
    setPaletteOpen(false);
    setConfirmSubmit(false);
    setPhase('running');
    window.scrollTo(0, 0);
  };

  const openLatestResult = (exam: WrittenExam, targetScope: 'all' | WrittenSection = scopeSection) => {
    const slot = sessionRecordKey(exam.id, targetScope);
    const last = mockState.history[slot]?.[0];
    if (!last) return;
    setExamKind('written');
    setScopeSection(targetScope);
    setActiveExamId(exam.id);
    setAnswers(last.answers);
    setWriting(last.writing ?? {});
    setFlags(last.flags ?? []);
    setSubmittedRecord(last);
    setResultFilter('all');
    setPhase('result');
    window.scrollTo(0, 0);
  };

  const openLatestListeningResult = (
    exam: ListeningExamRound,
    targetScope: 'all' | ListeningPartId = scopePart,
  ) => {
    const slot = sessionRecordKey(exam.id, targetScope);
    const last = mockState.history[slot]?.[0];
    if (!last) return;
    setExamKind('listening');
    setScopePart(targetScope);
    setActiveExamId(exam.id);
    setAnswers(last.answers);
    setWriting({});
    setFlags(last.flags ?? []);
    setSubmittedRecord(last);
    setResultFilter('all');
    setPhase('result');
    window.scrollTo(0, 0);
  };

  const submitExam = () => {
    if (!hasActiveExam || !activeStorageSlot) return;
    stopSpeech();
    if (examKind === 'listening' && activeListeningExam) {
      const summary = scoreListeningMockExam(activeListeningExam, answers, scopePart);
      const record: MockSubmittedRecord = {
        examId: activeStorageSlot,
        correct: summary.correct,
        total: summary.total,
        writingDone: 0,
        writingTotal: 0,
        elapsedSec,
        timed: timedMode,
        answers,
        writing: {},
        flags,
        submittedAt: Date.now(),
      };
      const cur = readMock(uid);
      const nextSessions = { ...cur.sessions };
      delete nextSessions[activeStorageSlot];
      const prevHistory = cur.history[activeStorageSlot] ?? [];
      const next: MockProgressState = {
        version: 1,
        sessions: nextSessions,
        history: {
          ...cur.history,
          [activeStorageSlot]: [record, ...prevHistory].slice(0, 5),
        },
      };
      writeMock(uid, next);
      setMockState(next);
      syncSubmittedListeningMockToStudyLedger(uid, activeListeningExam, answers, scopePart);
      setSubmittedRecord(record);
      setConfirmSubmit(false);
      setPaletteOpen(false);
      setResultFilter('all');
      setPhase('result');
      window.scrollTo(0, 0);
      return;
    }

    if (!activeWrittenExam) return;
    const summary = scoreMockExam(activeWrittenExam, answers, writing, scopeSection);
    const record: MockSubmittedRecord = {
      examId: activeStorageSlot,
      correct: summary.correct,
      total: summary.total,
      writingDone: summary.writingDone,
      writingTotal: summary.writingTotal,
      elapsedSec,
      timed: timedMode,
      answers,
      writing,
      flags,
      submittedAt: Date.now(),
    };
    const cur = readMock(uid);
    const nextSessions = { ...cur.sessions };
    delete nextSessions[activeStorageSlot];
    const prevHistory = cur.history[activeStorageSlot] ?? [];
    const next: MockProgressState = {
      version: 1,
      sessions: nextSessions,
      history: {
        ...cur.history,
        [activeStorageSlot]: [record, ...prevHistory].slice(0, 5),
      },
    };
    writeMock(uid, next);
    setMockState(next);
    syncSubmittedMockToStudyLedger(uid, activeWrittenExam, answers, writing, scopeSection);
    setSubmittedRecord(record);
    setConfirmSubmit(false);
    setPaletteOpen(false);
    setResultFilter('all');
    setPhase('result');
    window.scrollTo(0, 0);
  };

  const toggleFlag = (itemId: string) => {
    setFlags(prev => (prev.includes(itemId) ? prev.filter(x => x !== itemId) : [...prev, itemId]));
  };

  const handleSaveMockItemNote = (exam: WrittenExam, item: WrittenItem, qNo: number) => {
    if (savedNotes[item.id] || item.kind !== 'choice') return;
    try {
      const problem = bookletItemToProblem(exam, item);
      saveQuestionNote({
        uid: uid || 'guest',
        question: problem,
        chapter: {
          id: `${exam.id}_${item.section}`,
          abstractTitle: `第${exam.round}回（${SECTION_LABELS[item.section]}）`,
          realTitle: `${gradeLabel} 一次筆記`,
        },
        questionIndex: qNo,
      });
      setSavedNotes(prev => ({ ...prev, [item.id]: true }));
      notify(
        uid === 'guest'
          ? 'ノートに保存しました！（ゲスト利用のため、この端末にだけ保存されます）'
          : 'ノートに保存しました！',
      );
    } catch {
      notify('保存に失敗しました。');
    }
  };

  // =========================================================================
  // 1. SELECT SCREEN（大問別演習 ChapterSelection と同じ世界観・構造に統一：筆記105回＋リスニング120回）
  // =========================================================================
  if (phase === 'select' || !hasActiveExam) {
    const scopeTabsCount = (examKind === 'listening' ? gradeListeningParts.length : gradeDaimons.length) + 1;
    const scopeGridClass =
      scopeTabsCount >= 7
        ? 'sm:grid-cols-4 lg:!grid lg:!grid-cols-7'
        : scopeTabsCount === 6
        ? 'sm:grid-cols-3 lg:!grid lg:!grid-cols-6'
        : scopeTabsCount === 5
        ? 'sm:grid-cols-3 lg:!grid lg:!grid-cols-5'
        : 'sm:grid-cols-2 lg:!grid lg:!grid-cols-4';

    const completedRoundsCount =
      examKind === 'listening'
        ? gradeListeningExams.filter(exam => {
            const slot = sessionRecordKey(exam.id, scopePart);
            return (mockState.history[slot]?.length ?? 0) > 0;
          }).length
        : gradeExams.filter(exam => {
            const slot = sessionRecordKey(exam.id, scopeSection);
            return (mockState.history[slot]?.length ?? 0) > 0;
          }).length;

    return (
      <div
        className="mtb-page chapter-route em-select-page flex h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom))] min-h-0 w-full flex-col overflow-hidden notebook-paper p-3 pb-[calc(5.75rem+env(safe-area-inset-bottom))] sm:p-5 sm:pb-[calc(5.75rem+env(safe-area-inset-bottom))] md:p-6 md:pb-[calc(5.75rem+env(safe-area-inset-bottom))] relative"
        data-mock-select
        data-mock-kind={examKind}
        style={theme.accent ? ({ '--unit-accent': theme.accent } as React.CSSProperties) : undefined}
      >
        {/* 大問別演習と同一のヘッダー（戻るピル ＋ 見出し ＋ 区分切替 ＋ とびら君ミニ） */}
        <header className="chapter-route-heading unit-head shrink-0">
          <button type="button" onClick={onBack} className="unit-head-back" aria-label={`${backLabel}戻る`}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>{backLabel}</span>
          </button>
          <div className="unit-head-title">
            <h2>
              {gradeLabel} {examKind === 'listening' ? 'リスニング 通し演習' : '一次筆記 通し演習'}
            </h2>
            <p>
              {examKind === 'listening'
                ? '全パート本番模試も、第1部〜第4部ごとの通し演習も選べます'
                : '全大問フル模試も、大問ごとの通し演習も選べます'}
            </p>
          </div>
          <div className="em-kind-switch" role="tablist" aria-label="模試の種別を選択" data-mock-kind-tabs>
            <button
              type="button"
              role="tab"
              aria-selected={examKind === 'written'}
              className={`em-kind-tab ${examKind === 'written' ? 'is-active' : ''}`}
              onClick={() => {
                setExamKind('written');
                if (initialGrade === 'eiken_1') onGrade('eiken_pre1');
                document.getElementById('mock-tab-panel')?.scrollTo({ top: 0 });
              }}
              data-mock-kind-tab="written"
            >
              <BookOpen size={14} aria-hidden="true" />
              <span>一次筆記（105回）</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={examKind === 'listening'}
              className={`em-kind-tab ${examKind === 'listening' ? 'is-active' : ''}`}
              onClick={() => {
                setExamKind('listening');
                document.getElementById('mock-tab-panel')?.scrollTo({ top: 0 });
              }}
              data-mock-kind-tab="listening"
            >
              <Headphones size={14} aria-hidden="true" />
              <span>リスニング（120回）</span>
            </button>
          </div>
          <DoorMascot subject={grade} showSpeech={false} size="mini" className="unit-head-mascot w-auto" />
        </header>

        <div className="chapter-workspace flex min-h-0 flex-1 flex-col gap-2 lg:!flex-col lg:!gap-2.5">
          {/* 級切り替えストリップ（温かな紙面になじむコンパクトピル） */}
          <div className="em-grade-strip shrink-0">
            <select
              aria-label="模試の級"
              className="sr-only"
              value={grade}
              onChange={e => onGrade(e.target.value as EikenGrade)}
            >
              {availableGrades.map(g => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
            <div className="em-grade-pills" role="tablist" aria-label="模試の級を選択">
              {availableGrades.map(g => {
                const active = g.id === grade;
                const count =
                  examKind === 'listening'
                    ? ALL_LISTENING_EXAMS.filter(e => e.grade === g.id && e.review === 'approved').length
                    : WRITTEN_BOOKLETS.filter(b => b.grade === g.id && b.review === 'approved').length;
                return (
                  <button
                    key={g.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`em-grade-pill ${active ? 'is-active' : ''}`}
                    onClick={() => {
                      onGrade(g.id);
                      document.getElementById('mock-tab-panel')?.scrollTo({ top: 0 });
                    }}
                  >
                    <span>{g.shortLabel}</span>
                    <small>{count}回</small>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 出題範囲タブ（ChapterSelection の .chapter-index [role="tab"] と同一デザイン） */}
          <div className="chapter-index shrink-0 border-b border-slate-200/70 lg:!w-full lg:!pr-0 lg:!mb-0 lg:!border-r-0">
            {examKind === 'written' ? (
              <div
                role="tablist"
                aria-label="出題する大問を選択"
                data-mock-scope-tabs
                className={`flex touch-pan-x snap-x snap-mandatory gap-1.5 overflow-x-auto overscroll-x-contain px-0.5 pb-2 [scrollbar-width:thin] sm:grid sm:overflow-x-visible sm:overscroll-auto ${scopeGridClass}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={scopeSection === 'all'}
                  onClick={() => {
                    setScopeSection('all');
                    document.getElementById('mock-tab-panel')?.scrollTo({ top: 0 });
                  }}
                  data-mock-scope="all"
                  className="flex h-full min-h-[3rem] w-[42vw] min-w-[8.5rem] max-w-[11rem] shrink-0 snap-center flex-col justify-center rounded-xl border px-2.5 py-2 text-left transition-all cursor-pointer sm:w-auto sm:min-w-0 sm:max-w-none sm:shrink"
                >
                  <span className="block text-xs font-bold leading-none" style={{ color: theme.accent }}>
                    本番形式・{gradeExams.length}回
                  </span>
                  <span className="mt-1 block text-xs sm:text-sm font-bold leading-snug break-words">
                    全大問通し
                  </span>
                </button>

                {gradeDaimons.map(d => {
                  const active = scopeSection === d.section;
                  return (
                    <button
                      key={d.section}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        setScopeSection(d.section);
                        document.getElementById('mock-tab-panel')?.scrollTo({ top: 0 });
                      }}
                      data-mock-scope={d.section}
                      className="flex h-full min-h-[3rem] w-[42vw] min-w-[8.5rem] max-w-[11rem] shrink-0 snap-center flex-col justify-center rounded-xl border px-2.5 py-2 text-left transition-all cursor-pointer sm:w-auto sm:min-w-0 sm:max-w-none sm:shrink"
                    >
                      <span className="block text-xs font-bold leading-none" style={{ color: theme.accent }}>
                        大問{d.daimonNo}・{d.countPerRound}
                        {d.kind === 'writing' ? '題' : '問'}
                      </span>
                      <span className="mt-1 block text-xs sm:text-sm font-bold leading-snug break-words [overflow-wrap:anywhere]">
                        {d.shortLabel}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div
                role="tablist"
                aria-label="出題するリスニング部を選択"
                data-mock-scope-tabs
                className={`flex touch-pan-x snap-x snap-mandatory gap-1.5 overflow-x-auto overscroll-x-contain px-0.5 pb-2 [scrollbar-width:thin] sm:grid sm:overflow-x-visible sm:overscroll-auto ${scopeGridClass}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={scopePart === 'all'}
                  onClick={() => {
                    setScopePart('all');
                    document.getElementById('mock-tab-panel')?.scrollTo({ top: 0 });
                  }}
                  data-mock-scope="all"
                  className="flex h-full min-h-[3rem] w-[42vw] min-w-[8.5rem] max-w-[11rem] shrink-0 snap-center flex-col justify-center rounded-xl border px-2.5 py-2 text-left transition-all cursor-pointer sm:w-auto sm:min-w-0 sm:max-w-none sm:shrink"
                >
                  <span className="block text-xs font-bold leading-none" style={{ color: theme.accent }}>
                    本番形式・全{listeningBlueprint?.totalQuestions ?? 30}問
                  </span>
                  <span className="mt-1 block text-xs sm:text-sm font-bold leading-snug break-words">
                    全パート通し
                  </span>
                </button>

                {gradeListeningParts.map(p => {
                  const active = scopePart === p.partId;
                  return (
                    <button
                      key={p.partId}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        setScopePart(p.partId);
                        document.getElementById('mock-tab-panel')?.scrollTo({ top: 0 });
                      }}
                      data-mock-scope={p.partId}
                      className="flex h-full min-h-[3rem] w-[42vw] min-w-[8.5rem] max-w-[11rem] shrink-0 snap-center flex-col justify-center rounded-xl border px-2.5 py-2 text-left transition-all cursor-pointer sm:w-auto sm:min-w-0 sm:max-w-none sm:shrink"
                    >
                      <span className="block text-xs font-bold leading-none" style={{ color: theme.accent }}>
                        第{p.partNo}部・{p.questionCount}問
                      </span>
                      <span className="mt-1 block text-xs sm:text-sm font-bold leading-snug break-words [overflow-wrap:anywhere]">
                        {p.shortLabel}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 回一覧パネル（ChapterSelection の #chapter-tab-panel ＋ .eiken-round-card と統一） */}
          <section
            id="mock-tab-panel"
            role="tabpanel"
            aria-label={`${gradeLabel}の模試一覧`}
            tabIndex={0}
            className="em-tab-panel min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-3 pb-6 sm:p-4 sm:pb-6 [-webkit-overflow-scrolling:touch] [scrollbar-gutter:stable]"
          >
            <div className="em-panel-head mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#e5dccc]/80 pb-2.5">
              <div className="min-w-0">
                <p className="text-xs font-bold" style={{ color: theme.accent }}>
                  {examKind === 'listening'
                    ? activePartSpec
                      ? `${gradeLabel} リスニング｜${activePartSpec.tabTitle}（1回${activePartSpec.questionCount}問・目安${scopedMinutes}分）`
                      : `${gradeLabel}｜リスニング全パート構成（目安${listeningBlueprint?.minutes ?? 25}分 ／ ${listeningBlueprint?.parts
                          .map(p => `${p.label} ${p.questionCount}問`)
                          .join(' ＋ ')}）`
                    : activeDaimonSpec
                    ? `${gradeLabel}｜${activeDaimonSpec.tabTitle}（1回${activeDaimonSpec.countPerRound}${
                        activeDaimonSpec.kind === 'writing' ? '題' : '問'
                      }・目安${scopedMinutes}分）`
                    : `${gradeLabel}｜一次筆記の全大問構成（目安${blueprint?.minutes ?? 60}分 ／ ${blueprint?.sections
                        .map(s => `${SECTION_LABELS[s.id]} ${s.count}${s.kind === 'writing' ? '題' : '問'}`)
                        .join(' ＋ ')}）`}
                </p>
              </div>
              <div className="em-timer-toggle" role="group" aria-label="タイマー設定">
                <button
                  type="button"
                  className={timedMode ? 'is-active' : ''}
                  aria-pressed={timedMode}
                  onClick={() => setTimedMode(true)}
                >
                  <Clock size={13} aria-hidden="true" />
                  <span>本番タイマー（{scopedMinutes}分）</span>
                </button>
                <button
                  type="button"
                  className={!timedMode ? 'is-active' : ''}
                  aria-pressed={!timedMode}
                  onClick={() => setTimedMode(false)}
                >
                  <span>制限なし</span>
                </button>
              </div>
            </div>

            <div className="chapter-route-list unit-card-list xl:!grid-cols-2">
              <h4 className="math-stage-heading col-span-full flex items-center justify-between gap-2" data-stage="booklet">
                <span>
                  {examKind === 'listening'
                    ? activePartSpec
                      ? `回別 ${activePartSpec.tabTitle} 通し演習`
                      : `回別 リスニング通し演習（全${gradeListeningExams.length}回）`
                    : activeDaimonSpec
                    ? `回別 ${activeDaimonSpec.tabTitle} 通し演習`
                    : '回別 一次筆記通し演習（全15回）'}
                </span>
                <small className="shrink-0 whitespace-nowrap">
                  受験済 {completedRoundsCount}/{examKind === 'listening' ? gradeListeningExams.length : gradeExams.length}回
                </small>
              </h4>

              {examKind === 'listening'
                ? gradeListeningExams.map((exam, idx) => {
                    const targetUnits =
                      scopePart === 'all' ? exam.units : exam.units.filter(u => u.part === scopePart);
                    const targetQuestions = targetUnits.flatMap(u => u.questions);
                    const recordedCount = targetUnits.filter(u => Boolean(LISTENING_AUDIO_URLS[u.audioId])).length;
                    const slot = sessionRecordKey(exam.id, scopePart);
                    const session = mockState.sessions[slot];
                    const history = mockState.history[slot] ?? [];
                    const best = history.reduce<MockSubmittedRecord | null>(
                      (acc, r) => (!acc || r.correct > acc.correct ? r : acc),
                      null,
                    );
                    const answeredInSession = session
                      ? targetQuestions.filter(q => Number.isInteger(session.answers[q.id])).length
                      : 0;
                    const number = String(idx + 1).padStart(2, '0');
                    const accuracy =
                      best && best.total > 0 ? Math.round((best.correct / best.total) * 100) : null;
                    const isPerfectDone = Boolean(best && best.total > 0 && best.correct === best.total);
                    const status: 'todo' | 'doing' | 'done' = session
                      ? 'doing'
                      : isPerfectDone
                      ? 'done'
                      : best
                      ? 'doing'
                      : 'todo';
                    const actionState: 'todo' | 'doing' | 'done' = session
                      ? 'doing'
                      : history.length > 0
                      ? 'done'
                      : 'todo';
                    const actionLabel = session ? '続きから' : history.length > 0 ? 'もう一度' : '通しで解く';
                    const subTitle = activePartSpec
                      ? `（全${targetQuestions.length}問・${targetUnits.length}音源）`
                      : `（全${targetQuestions.length}問・${exam.theme}）`;
                    const handleCardClick = () => {
                      startListeningExam(exam, Boolean(session), scopePart);
                    };

                    return (
                      <article
                        key={exam.id}
                        className="unit-card eiken-round-card"
                        data-status={status}
                        data-eiken-state={actionState}
                        data-mock-round={exam.id}
                        onClick={handleCardClick}
                        style={theme.accent ? ({ '--unit-accent': theme.accent } as React.CSSProperties) : undefined}
                      >
                        <div className="unit-card-row">
                          <div className="unit-card-main">
                            <span className="unit-card-title">
                              <b>{number}.</b>{' '}
                              <span className="eiken-round-name">第{exam.round}回</span>
                              <span className="eiken-round-sub">{subTitle}</span>
                            </span>
                            <span className="unit-card-meta">
                              <span className="mt-status" data-status={status}>
                                {session
                                  ? `中断 ${answeredInSession}/${targetQuestions.length}`
                                  : status === 'done'
                                  ? '達成'
                                  : best
                                  ? '受験済'
                                  : UNIT_STATUS_LABEL.todo}
                              </span>
                              {targetQuestions.length > 0 && (
                                <span className="mt-meter unit-card-meter" data-status={status} aria-hidden="true">
                                  <i
                                    style={{
                                      width: `${
                                        session
                                          ? Math.round(
                                              (answeredInSession / Math.max(1, targetQuestions.length)) * 100,
                                            )
                                          : accuracy ?? 0
                                      }%`,
                                    }}
                                  />
                                </span>
                              )}
                              <span className="unit-card-acc">
                                {session
                                  ? `経過 ${formatDuration(session.elapsedSec)}`
                                  : accuracy !== null
                                  ? `最高 ${best!.correct}/${best!.total}（${accuracy}%）`
                                  : `目安 ${scopedMinutes}分`}
                              </span>
                            </span>
                          </div>

                          <div className="eiken-round-actions">
                            {recordedCount > 0 && (
                              <span className="eiken-round-audio" title="専用リスニング音源収録">
                                <Headphones size={12} aria-hidden="true" />
                              </span>
                            )}
                            {history.length > 0 && (
                              <button
                                type="button"
                                className="eiken-round-audio em-round-history-btn"
                                title="前回の採点結果・台本解説を見る"
                                aria-label={`第${exam.round}回の前回の結果・台本解説を見る`}
                                onClick={e => {
                                  e.stopPropagation();
                                  openLatestListeningResult(exam, scopePart);
                                }}
                              >
                                <FileText size={12} aria-hidden="true" />
                              </button>
                            )}
                            {session && (
                              <button
                                type="button"
                                className="eiken-round-audio em-round-reset-btn"
                                title="最初から解き直す"
                                aria-label={`第${exam.round}回を最初から解き直す`}
                                onClick={e => {
                                  e.stopPropagation();
                                  startListeningExam(exam, false, scopePart);
                                }}
                              >
                                <RotateCcw size={12} aria-hidden="true" />
                              </button>
                            )}
                            <button
                              type="button"
                              className="unit-card-primary"
                              data-action-state={actionState}
                              data-start-mock={exam.id}
                              onClick={e => {
                                e.stopPropagation();
                                handleCardClick();
                              }}
                            >
                              {actionState === 'done' ? (
                                <RotateCcw size={11} aria-hidden="true" />
                              ) : (
                                <Play size={11} aria-hidden="true" />
                              )}
                              <span>{actionLabel}</span>
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })
                : gradeExams.map((exam, idx) => {
                const targetItems =
                  scopeSection === 'all' ? exam.items : exam.items.filter(i => i.section === scopeSection);
                const choiceCount = targetItems.filter(i => i.kind === 'choice').length;
                const writingCount = targetItems.filter(i => i.kind === 'writing').length;
                const slot = sessionRecordKey(exam.id, scopeSection);
                const session = mockState.sessions[slot];
                const history = mockState.history[slot] ?? [];
                const best = history.reduce<MockSubmittedRecord | null>(
                  (acc, r) => (!acc || r.correct > acc.correct ? r : acc),
                  null,
                );
                const answeredInSession = session
                  ? targetItems.filter(i =>
                      i.kind === 'choice'
                        ? Number.isInteger(session.answers[i.id])
                        : countEnglishWords(session.writing[i.id]?.text ?? '') > 0,
                    ).length
                  : 0;

                const number = String(idx + 1).padStart(2, '0');
                const accuracy =
                  best && best.total > 0 ? Math.round((best.correct / best.total) * 100) : null;
                const isPerfectDone = Boolean(best && best.total > 0 && best.correct === best.total);
                const status: 'todo' | 'doing' | 'done' = session
                  ? 'doing'
                  : isPerfectDone || (best && best.total === 0 && best.writingDone >= best.writingTotal)
                  ? 'done'
                  : best
                  ? 'doing'
                  : 'todo';
                const actionState: 'todo' | 'doing' | 'done' = session
                  ? 'doing'
                  : history.length > 0
                  ? 'done'
                  : 'todo';
                const actionLabel = session ? '続きから' : history.length > 0 ? 'もう一度' : '通しで解く';

                const subTitle = activeDaimonSpec
                  ? `（全${targetItems.length}${activeDaimonSpec.kind === 'writing' ? '題' : '問'}）`
                  : writingCount > 0
                  ? `（4択${choiceCount}問＋英作${writingCount}題）`
                  : `（リーディング4択${choiceCount}問）`;

                const handleCardClick = () => {
                  startExam(exam, Boolean(session), scopeSection);
                };

                return (
                  <article
                    key={exam.id}
                    className="unit-card eiken-round-card"
                    data-status={status}
                    data-eiken-state={actionState}
                    data-mock-round={exam.id}
                    onClick={handleCardClick}
                    style={theme.accent ? ({ '--unit-accent': theme.accent } as React.CSSProperties) : undefined}
                  >
                    <div className="unit-card-row">
                      <div className="unit-card-main">
                        <span className="unit-card-title">
                          <b>{number}.</b>{' '}
                          <span className="eiken-round-name">第{exam.round}回</span>
                          <span className="eiken-round-sub">{subTitle}</span>
                        </span>
                        <span className="unit-card-meta">
                          <span className="mt-status" data-status={status}>
                            {session
                              ? `中断 ${answeredInSession}/${targetItems.length}`
                              : status === 'done'
                              ? '達成'
                              : best
                              ? '受験済'
                              : UNIT_STATUS_LABEL.todo}
                          </span>
                          {choiceCount > 0 && (
                            <span className="mt-meter unit-card-meter" data-status={status} aria-hidden="true">
                              <i
                                style={{
                                  width: `${
                                    session
                                      ? Math.round((answeredInSession / Math.max(1, targetItems.length)) * 100)
                                      : accuracy ?? 0
                                  }%`,
                                }}
                              />
                            </span>
                          )}
                          <span className="unit-card-acc">
                            {session
                              ? `経過 ${formatDuration(session.elapsedSec)}`
                              : accuracy !== null
                              ? `最高 ${best!.correct}/${best!.total}（${accuracy}%）`
                              : best
                              ? `提出 ${best.writingDone}/${best.writingTotal}題`
                              : `目安 ${scopedMinutes}分`}
                          </span>
                        </span>
                      </div>

                      <div className="eiken-round-actions">
                        {history.length > 0 && (
                          <button
                            type="button"
                            className="eiken-round-audio em-round-history-btn"
                            title="前回の採点結果・解説を見る"
                            aria-label={`第${exam.round}回の前回の結果・解説を見る`}
                            onClick={e => {
                              e.stopPropagation();
                              openLatestResult(exam, scopeSection);
                            }}
                          >
                            <FileText size={12} aria-hidden="true" />
                          </button>
                        )}
                        {session && (
                          <button
                            type="button"
                            className="eiken-round-audio em-round-reset-btn"
                            title="最初から解き直す"
                            aria-label={`第${exam.round}回を最初から解き直す`}
                            onClick={e => {
                              e.stopPropagation();
                              startExam(exam, false, scopeSection);
                            }}
                          >
                            <RotateCcw size={12} aria-hidden="true" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="unit-card-primary"
                          data-action-state={actionState}
                          data-start-mock={exam.id}
                          onClick={e => {
                            e.stopPropagation();
                            handleCardClick();
                          }}
                        >
                          {actionState === 'done' ? (
                            <RotateCcw size={11} aria-hidden="true" />
                          ) : (
                            <Play size={11} aria-hidden="true" />
                          )}
                          <span>{actionLabel}</span>
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    );
  }

  // =========================================================================
  // 2A. RUNNING LISTENING EXAM SCREEN
  // =========================================================================
  if (phase === 'running' && examKind === 'listening' && activeListeningExam) {
    const currentUnit = listeningUnits[unitIndex] ?? listeningUnits[0];
    const currentProblem = listeningUnitToProblem(activeListeningExam, currentUnit);
    const currentBp = LISTENING_BLUEPRINTS[activeListeningExam.grade];
    const currentPartSpec = currentBp.parts.find(p => p.id === currentUnit.part);
    const remainingSec = limitSec - elapsedSec;
    const isOvertime = timedMode && remainingSec < 0;

    const allScopedQuestions = listeningUnits.flatMap(u =>
      u.questions.map(q => ({ q, unitAudioId: u.audioId })),
    );
    const totalAnswered = allScopedQuestions.filter(({ q }) => Number.isInteger(answers[q.id])).length;

    const partFirstUnit: {
      part: ListeningPartId;
      label: string;
      unitIdx: number;
      answered: number;
      total: number;
    }[] = [];
    listeningUnits.forEach((u, idx) => {
      if (!partFirstUnit.some(p => p.part === u.part)) {
        const pSpec = currentBp.parts.find(bpPart => bpPart.id === u.part);
        const pQs = listeningUnits.filter(lu => lu.part === u.part).flatMap(lu => lu.questions);
        partFirstUnit.push({
          part: u.part,
          label: pSpec?.label ?? u.part,
          unitIdx: idx,
          answered: pQs.filter(q => Number.isInteger(answers[q.id])).length,
          total: pQs.length,
        });
      }
    });

    const jumpToQuestionId = (qId: string) => {
      const targetIdx = listeningUnits.findIndex(u => u.questions.some(q => q.id === qId));
      if (targetIdx >= 0) {
        setUnitIndex(targetIdx);
        setPaletteOpen(false);
        window.scrollTo(0, 0);
      }
    };

    const resolvedImgUrl = LISTENING_IMAGE_URLS[currentUnit.audioId];
    const materialData = currentProblem.audioTracks?.[0]?.material;
    const hasLeftVisualPane = Boolean(materialData || resolvedImgUrl || currentUnit.image);
    const unansweredInUnit = currentUnit.questions.filter(q => !Number.isInteger(answers[q.id])).length;

    return (
      <main
        className="em-runner is-listening"
        data-mock-runner
        data-mock-kind="listening"
        style={theme.accent ? ({ '--unit-accent': theme.accent } as React.CSSProperties) : undefined}
      >
        <header className="em-runner-bar">
          <button
            type="button"
            className="em-runner-exit"
            onClick={() => setPhase('select')}
            title="解答は自動保存されます。あとで続きから再開できます"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>一覧へ戻る</span>
          </button>

          <div className="em-runner-center">
            <span className="em-runner-badge">リスニング通し</span>
            <strong className="em-runner-title">
              {gradeLabel} 第{activeListeningExam.round}回
              {activePartSpec ? `・第${activePartSpec.partNo}部` : ''}
            </strong>
          </div>

          <div className="em-runner-right">
            <span className="em-runner-progress">
              解答 <b>{totalAnswered}</b>/{allScopedQuestions.length}
            </span>

            <div className={`em-timer-chip ${isOvertime ? 'is-overtime' : ''}`} data-mock-timer>
              <Clock size={14} aria-hidden="true" />
              <span>
                {timedMode
                  ? isOvertime
                    ? `+${formatDuration(Math.abs(remainingSec))} 超過`
                    : `残り ${formatDuration(remainingSec)}`
                  : `経過 ${formatDuration(elapsedSec)}`}
              </span>
              <button
                type="button"
                className="em-pause-btn"
                onClick={() => setPaused(p => !p)}
                aria-label={paused ? 'タイマー再開' : 'タイマー一時停止'}
              >
                {paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
              </button>
            </div>

            <button
              type="button"
              className="em-palette-toggle"
              onClick={() => setPaletteOpen(o => !o)}
              aria-expanded={paletteOpen}
              data-mock-palette-toggle
            >
              <LayoutGrid size={15} aria-hidden="true" />
              <span>問題一覧</span>
            </button>

            <button
              type="button"
              className="em-submit-top-btn"
              onClick={() => setConfirmSubmit(true)}
              data-mock-open-submit
            >
              <Send size={14} aria-hidden="true" />
              <span>採点する</span>
            </button>
          </div>
        </header>

        {scopePart === 'all' && (
          <nav className="em-section-tabs" aria-label="リスニング部移動">
            {partFirstUnit.map(pt => {
              const active = currentUnit.part === pt.part;
              const complete = pt.total > 0 && pt.answered === pt.total;
              return (
                <button
                  key={pt.part}
                  type="button"
                  className={`em-section-tab ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''}`}
                  onClick={() => {
                    setUnitIndex(pt.unitIdx);
                    window.scrollTo(0, 0);
                  }}
                >
                  <span>{pt.label}</span>
                  <small className="em-sec-count">
                    {pt.answered}/{pt.total}
                  </small>
                </button>
              );
            })}
          </nav>
        )}

        {paletteOpen && (
          <section className="em-palette-drawer" aria-label="設問番号パレット">
            <div className="em-palette-legend">
              <span>設問番号をタップして直接移動できます</span>
              <div className="em-legend-items">
                <span className="is-answered">解答済</span>
                <span className="is-flagged">見直し</span>
                <span>未解答</span>
              </div>
            </div>
            <div className="em-palette-grid">
              {allScopedQuestions.map(({ q, unitAudioId }) => {
                const isAnswered = Number.isInteger(answers[q.id]);
                const isFlagged = flags.includes(q.id);
                const isCurrent = currentUnit.audioId === unitAudioId;
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => jumpToQuestionId(q.id)}
                    className={`em-palette-cell ${isAnswered ? 'is-answered' : ''} ${
                      isFlagged ? 'is-flagged' : ''
                    } ${isCurrent ? 'is-current' : ''}`}
                  >
                    {q.questionNumber}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {confirmSubmit && (
          <div className="em-modal-backdrop" role="dialog" aria-modal="true" aria-label="提出確認">
            <div className="em-modal">
              <h2>リスニング通し演習を採点しますか？</h2>
              <p>
                リスニング問題：<strong>{totalAnswered} / {allScopedQuestions.length} 問</strong> 解答済み
                {flags.length > 0 && (
                  <>
                    <br />
                    見直しチェック：<strong>{flags.length} 件</strong> 残っています
                  </>
                )}
              </p>
              {totalAnswered < allScopedQuestions.length && (
                <p className="em-modal-warn">
                  未解答の問題が {allScopedQuestions.length - totalAnswered} 問あります。そのまま採点すると未解答は不正解扱いになります。
                </p>
              )}
              <div className="em-modal-actions">
                <button type="button" className="em-ghost-btn" onClick={() => setConfirmSubmit(false)}>
                  問題に戻る
                </button>
                <button
                  type="button"
                  className="em-primary-btn"
                  onClick={submitExam}
                  data-mock-confirm-submit
                >
                  採点して結果を見る
                </button>
              </div>
            </div>
          </div>
        )}

        <section className="em-listening-deck" aria-label="リスニング音源プレーヤー">
          <ListeningAudioPlayer
            key={currentUnit.audioId}
            tracks={currentProblem.audioTracks ?? []}
            mode="practice"
            tone="light"
            readCount={currentUnit.readCount}
            playOnce={currentUnit.readCount === 1}
            title={`${currentPartSpec?.label ?? currentUnit.part}（${
              currentUnit.readCount === 2 ? '本番2回読み' : '本番1回読み'
            }）`}
          />
        </section>

        <div className={`em-workspace ${hasLeftVisualPane ? 'has-passage' : ''}`}>
          {hasLeftVisualPane && (
            <article className="em-passage-pane em-visual-pane">
              <div className="em-passage-head">
                <span className="em-section-badge">{currentPartSpec?.label ?? currentUnit.part}</span>
                <h2>
                  {materialData
                    ? materialData.title
                    : `No.${currentUnit.questions[0].questionNumber} 問題イラスト`}
                </h2>
              </div>
              {materialData ? (
                <ListeningMaterials material={materialData} />
              ) : resolvedImgUrl ? (
                <figure className="em-illustration-figure">
                  <img
                    src={resolvedImgUrl}
                    alt={
                      currentUnit.image?.sceneSummaryJa ||
                      `No.${currentUnit.questions[0].questionNumber}のイラスト`
                    }
                    className="em-illustration-img"
                  />
                </figure>
              ) : (
                <div className="em-scene-fallback">
                  <strong>【イラスト場面】</strong>
                  <p>{currentUnit.image?.sceneSummaryJa}</p>
                </div>
              )}
            </article>
          )}

          <div className="em-questions-pane">
            {currentUnit.questions.map((q, qIdx) => {
              const subQ = currentProblem.subQuestions[qIdx];
              const flagged = flags.includes(q.id);
              const picked = answers[q.id];
              const optionTexts =
                subQ?.optionTexts ??
                (q.choicePresentation === 'read-aloud'
                  ? q.choices.map((_, idx) => `選択肢 ${idx + 1}（音声から選ぶ）`)
                  : q.choices);

              return (
                <section
                  key={q.id}
                  className={`em-q-card ${Number.isInteger(picked) ? 'is-answered' : ''}`}
                  data-mock-q={q.questionNumber}
                  data-mock-item-id={q.id}
                >
                  <div className="em-q-head">
                    <div className="em-q-title">
                      <span className="em-q-num">No. {q.questionNumber}</span>
                      <span className="em-q-sec">{currentPartSpec?.label ?? currentUnit.part}</span>
                    </div>
                    <button
                      type="button"
                      className={`em-flag-btn ${flagged ? 'is-active' : ''}`}
                      onClick={() => toggleFlag(q.id)}
                      aria-pressed={flagged}
                    >
                      <Flag size={14} aria-hidden="true" />
                      <span>{flagged ? '見直し中' : '見直し'}</span>
                    </button>
                  </div>

                  <p className="em-q-prompt">
                    {q.choicePresentation === 'read-aloud'
                      ? resolvedImgUrl
                        ? 'イラストを見ながら音声を聞き、最も適切な番号を選んでください。'
                        : '音声を最後まで聞き、最も適切な応答の番号を選んでください。'
                      : q.questionPrompt}
                  </p>

                  <div className="em-choice-list" role="radiogroup" aria-label={`No.${q.questionNumber}の選択肢`}>
                    {optionTexts.map((choiceText, cIdx) => {
                      const selected = picked === cIdx;
                      return (
                        <button
                          key={cIdx}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={`em-choice-btn ${selected ? 'is-selected' : ''}`}
                          onClick={() =>
                            setAnswers(prev => {
                              const next = { ...prev };
                              if (next[q.id] === cIdx) delete next[q.id];
                              else next[q.id] = cIdx;
                              return next;
                            })
                          }
                          data-choice-idx={cIdx + 1}
                        >
                          <span className="em-choice-no">{cIdx + 1}</span>
                          <span className="em-choice-text" lang="en">
                            {choiceText}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>

        <footer className="em-runner-footer">
          <button
            type="button"
            className="em-nav-btn"
            disabled={unitIndex === 0}
            onClick={() => {
              setUnitIndex(i => Math.max(0, i - 1));
              window.scrollTo(0, 0);
            }}
          >
            <ChevronLeft size={18} aria-hidden="true" />
            <span>前の音源</span>
          </button>

          <div className="em-footer-status">
            <span className="em-unit-counter">
              音源 {unitIndex + 1} / {listeningUnits.length}
            </span>
            <span className={`em-unit-substatus ${unansweredInUnit === 0 ? 'is-done' : ''}`}>
              {unansweredInUnit === 0 ? 'この音源回答済み' : `この音源未回答 ${unansweredInUnit}`}
            </span>
          </div>

          {unitIndex < listeningUnits.length - 1 ? (
            <button
              type="button"
              className="em-nav-btn is-primary"
              onClick={() => {
                setUnitIndex(i => Math.min(listeningUnits.length - 1, i + 1));
                window.scrollTo(0, 0);
              }}
            >
              <span>次の音源</span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="em-nav-btn is-submit"
              onClick={() => setConfirmSubmit(true)}
            >
              <Send size={16} aria-hidden="true" />
              <span>採点・提出する</span>
            </button>
          )}
        </footer>
      </main>
    );
  }

  // =========================================================================
  // 2B. RUNNING WRITTEN EXAM SCREEN
  // =========================================================================
  if (phase === 'running' && activeExam) {
    const currentUnit = units[unitIndex] ?? units[0];
    const remainingSec = limitSec - elapsedSec;
    const isOvertime = timedMode && remainingSec < 0;
    const scopedExamItems = activeExam.items
      .map((item, fullIdx) => ({ item, qNo: fullIdx + 1 }))
      .filter(({ item }) => scopeSection === 'all' || item.section === scopeSection);
    const choiceItems = scopedExamItems.map(x => x.item).filter(i => i.kind === 'choice');
    const writingItems = scopedExamItems.map(x => x.item).filter(i => i.kind === 'writing');
    const answeredChoiceCount = choiceItems.filter(i => Number.isInteger(answers[i.id])).length;
    const answeredWritingCount = writingItems.filter(i => countEnglishWords(writing[i.id]?.text ?? '') > 0).length;
    const totalAnswered = answeredChoiceCount + answeredWritingCount;

    // Section quick jump tabs
    const examDaimonSpecs = getGradeDaimonSpecs(activeExam.grade);
    const sectionFirstUnit: {
      section: WrittenSection;
      label: string;
      unitIdx: number;
      answered: number;
      total: number;
    }[] = [];
    units.forEach((u, idx) => {
      if (!sectionFirstUnit.some(s => s.section === u.section)) {
        const dSpec = examDaimonSpecs.find(d => d.section === u.section);
        const label = dSpec ? `大問${dSpec.daimonNo} ${WRITTEN_SECTION_LABELS[u.section]}` : SECTION_LABELS[u.section];
        const secEntries = scopedExamItems.filter(e => e.item.section === u.section);
        const secAnswered = secEntries.filter(({ item }) =>
          item.kind === 'choice'
            ? Number.isInteger(answers[item.id])
            : countEnglishWords(writing[item.id]?.text ?? '') > 0,
        ).length;
        sectionFirstUnit.push({
          section: u.section,
          label,
          unitIdx: idx,
          answered: secAnswered,
          total: secEntries.length,
        });
      }
    });

    const jumpToItemId = (itemId: string) => {
      const targetUnitIdx = units.findIndex(u => u.items.some(entry => entry.item.id === itemId));
      if (targetUnitIdx >= 0) {
        setUnitIndex(targetUnitIdx);
        setPaletteOpen(false);
        window.requestAnimationFrame(() => {
          const el = document.querySelector(`[data-mock-item-id="${itemId}"]`);
          if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          else window.scrollTo(0, 0);
        });
      }
    };

    const jumpToQuestionNo = (qNo: number) => {
      const el = document.querySelector(`[data-mock-q="${qNo}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };

    const isBatchClozePage = Boolean(currentUnit.batchCloze);
    const currentRangeLabel =
      currentUnit.items.length > 1
        ? `問${currentUnit.items[0].qNo}〜${currentUnit.items[currentUnit.items.length - 1].qNo}`
        : currentUnit.items[0]?.item.kind === 'writing'
        ? SECTION_LABELS[currentUnit.section]
        : `問${currentUnit.items[0]?.qNo ?? 1}`;
    const unansweredInUnit = currentUnit.items.filter(({ item }) =>
      item.kind === 'choice'
        ? !Number.isInteger(answers[item.id])
        : countEnglishWords(writing[item.id]?.text ?? '') === 0,
    ).length;

    return (
      <main
        className="em-runner"
        data-mock-runner
        style={theme.accent ? ({ '--unit-accent': theme.accent } as React.CSSProperties) : undefined}
      >
        {/* Top Exam Sticky Bar（他の演習画面 QuizHeader / ToeicPageQuiz と同じ温かなクリーム帯） */}
        <header className="em-runner-bar">
          <button
            type="button"
            className="em-runner-exit"
            onClick={() => setPhase('select')}
            title="解答は自動保存されます。あとで続きから再開できます"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>一覧へ戻る</span>
          </button>

          <div className="em-runner-center">
            <span className="em-runner-badge">通し演習</span>
            <strong className="em-runner-title">
              {gradeLabel} 第{activeExam.round}回
              {activeDaimonSpec ? `・大問${activeDaimonSpec.daimonNo}` : ''}
            </strong>
          </div>

          <div className="em-runner-right">
            <span className="em-runner-progress">
              解答 <b>{totalAnswered}</b>/{scopedExamItems.length}
            </span>

            <div className={`em-timer-chip ${isOvertime ? 'is-overtime' : ''}`} data-mock-timer>
              <Clock size={14} aria-hidden="true" />
              <span>
                {timedMode
                  ? isOvertime
                    ? `+${formatDuration(Math.abs(remainingSec))} 超過`
                    : `残り ${formatDuration(remainingSec)}`
                  : `経過 ${formatDuration(elapsedSec)}`}
              </span>
              <button
                type="button"
                className="em-pause-btn"
                onClick={() => setPaused(p => !p)}
                aria-label={paused ? 'タイマー再開' : 'タイマー一時停止'}
                title={paused ? '再開' : '一時停止'}
              >
                {paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
              </button>
            </div>

            <button
              type="button"
              className="em-palette-toggle"
              onClick={() => setPaletteOpen(o => !o)}
              aria-expanded={paletteOpen}
              data-mock-palette-toggle
            >
              <LayoutGrid size={15} aria-hidden="true" />
              <span>問題一覧</span>
            </button>

            <button
              type="button"
              className="em-submit-top-btn"
              onClick={() => setConfirmSubmit(true)}
              data-mock-open-submit
            >
              <Send size={14} aria-hidden="true" />
              <span>採点する</span>
            </button>
          </div>
        </header>

        {/* Section Jump Tabs（全大問通しモード時のみ大問ごとの進捗チップ付きで表示） */}
        {scopeSection === 'all' && (
          <nav className="em-section-tabs" aria-label="大問セクション移動">
            {sectionFirstUnit.map(sec => {
              const active = currentUnit.section === sec.section;
              const complete = sec.total > 0 && sec.answered === sec.total;
              return (
                <button
                  key={sec.section}
                  type="button"
                  className={`em-section-tab ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''}`}
                  onClick={() => {
                    setUnitIndex(sec.unitIdx);
                    window.scrollTo(0, 0);
                  }}
                >
                  <span>{sec.label}</span>
                  <small className="em-sec-count">
                    {sec.answered}/{sec.total}
                  </small>
                </button>
              );
            })}
          </nav>
        )}

        {/* Collapsible Question Palette */}
        {paletteOpen && (
          <section className="em-palette-drawer" aria-label="設問番号パレット">
            <div className="em-palette-legend">
              <span>設問番号をタップして直接移動できます</span>
              <div className="em-legend-items">
                <span className="is-answered">解答済</span>
                <span className="is-flagged">見直し</span>
                <span>未解答</span>
              </div>
            </div>
            <div className="em-palette-grid">
              {scopedExamItems.map(({ item, qNo }) => {
                const isAnswered =
                  item.kind === 'choice'
                    ? Number.isInteger(answers[item.id])
                    : countEnglishWords(writing[item.id]?.text ?? '') > 0;
                const isFlagged = flags.includes(item.id);
                const isCurrent = currentUnit.items.some(e => e.item.id === item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => jumpToItemId(item.id)}
                    className={`em-palette-cell ${isAnswered ? 'is-answered' : ''} ${
                      isFlagged ? 'is-flagged' : ''
                    } ${isCurrent ? 'is-current' : ''}`}
                  >
                    {item.kind === 'writing' ? `英作` : qNo}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Submit Confirmation Modal */}
        {confirmSubmit && (
          <div className="em-modal-backdrop" role="dialog" aria-modal="true" aria-label="提出確認">
            <div className="em-modal">
              <h2>通し演習を採点しますか？</h2>
              <p>
                4択問題：<strong>{answeredChoiceCount} / {choiceItems.length} 問</strong> 解答済み
                {writingItems.length > 0 && (
                  <>
                    <br />
                    ライティング：<strong>{answeredWritingCount} / {writingItems.length} 題</strong> 入力済み
                  </>
                )}
                {flags.length > 0 && (
                  <>
                    <br />
                    見直しチェック：<strong>{flags.length} 件</strong> 残っています
                  </>
                )}
              </p>
              {answeredChoiceCount < choiceItems.length && (
                <p className="em-modal-warn">
                  未解答の4択問題が {choiceItems.length - answeredChoiceCount} 問あります。そのまま採点すると未解答は不正解扱いになります。
                </p>
              )}
              <div className="em-modal-actions">
                <button type="button" className="em-ghost-btn" onClick={() => setConfirmSubmit(false)}>
                  問題に戻る
                </button>
                <button
                  type="button"
                  className="em-primary-btn"
                  onClick={submitExam}
                  data-mock-confirm-submit
                >
                  採点して結果を見る
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Main Workspace */}
        <div
          className={`em-workspace ${currentUnit.passage ? 'has-passage' : ''} ${
            isBatchClozePage ? 'is-batch-cloze' : ''
          }`}
        >
          {currentUnit.passage && (
            <article className="em-passage-pane" data-passage-format={currentUnit.passage.format || 'article'}>
              <div className="em-passage-head">
                <span className="em-section-badge">{SECTION_LABELS[currentUnit.section]}</span>
                <h2>{currentUnit.passage.title}</h2>
              </div>
              <PassageBodyRich
                text={currentUnit.passage.text}
                section={currentUnit.section}
                unitItems={currentUnit.items}
                answers={answers}
                onJumpToQuestionNo={jumpToQuestionNo}
              />
            </article>
          )}

          <div
            className={`em-questions-pane ${isBatchClozePage ? 'is-batch-grid' : ''}`}
            data-batch-count={isBatchClozePage ? currentUnit.items.length : undefined}
          >
            {currentUnit.items.map(({ item, qNo }) => {
              const flagged = flags.includes(item.id);
              if (item.kind === 'choice') {
                const picked = answers[item.id];
                const filledText = Number.isInteger(picked) ? item.choices?.[picked] ?? '' : '';
                const singleColChoices = (item.choices ?? []).some(c => c.length > 20);

                if (isBatchClozePage) {
                  return (
                    <section
                      key={item.id}
                      className={`em-q-card em-compact-card is-compact-cloze ${
                        Number.isInteger(picked) ? 'is-answered' : ''
                      }`}
                      data-mock-q={qNo}
                      data-mock-item-id={item.id}
                    >
                      <div className="em-compact-top">
                        <MockCompactStem qNo={qNo} prompt={item.prompt} filled={filledText} />
                        <button
                          type="button"
                          className={`em-flag-icon-btn ${flagged ? 'is-active' : ''}`}
                          onClick={() => toggleFlag(item.id)}
                          aria-pressed={flagged}
                          aria-label={`問${qNo}を見直しチェック`}
                          title={flagged ? '見直し中' : '見直し'}
                        >
                          <Flag size={13} aria-hidden="true" />
                        </button>
                      </div>

                      <div
                        className={`em-compact-choices ${singleColChoices ? 'is-single' : ''}`}
                        role="radiogroup"
                        aria-label={`問${qNo}の選択肢`}
                        tabIndex={0}
                        onKeyDown={e => {
                          if (e.metaKey || e.ctrlKey || e.altKey) return;
                          const idx = ['1', '2', '3', '4', 'a', 'b', 'c', 'd'].indexOf(e.key.toLowerCase());
                          if (idx >= 0) {
                            const cIdx = idx % 4;
                            e.preventDefault();
                            setAnswers(prev => {
                              const next = { ...prev };
                              if (next[item.id] === cIdx) delete next[item.id];
                              else next[item.id] = cIdx;
                              return next;
                            });
                          }
                        }}
                      >
                        {item.choices!.map((choiceText, cIdx) => {
                          const selected = picked === cIdx;
                          return (
                            <button
                              key={cIdx}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              className={`em-compact-choice ${selected ? 'is-selected' : ''}`}
                              onClick={() =>
                                setAnswers(prev => {
                                  const next = { ...prev };
                                  if (next[item.id] === cIdx) delete next[item.id];
                                  else next[item.id] = cIdx;
                                  return next;
                                })
                              }
                              data-choice-idx={cIdx + 1}
                            >
                              <span className="em-compact-bubble">{cIdx + 1}</span>
                              <span className="em-compact-choice-text" lang="en">
                                {choiceText}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  );
                }

                return (
                  <section
                    key={item.id}
                    className={`em-q-card ${Number.isInteger(picked) ? 'is-answered' : ''}`}
                    data-mock-q={qNo}
                    data-mock-item-id={item.id}
                  >
                    <div className="em-q-head">
                      <div className="em-q-title">
                        <span className="em-q-num">問 {qNo}</span>
                        <span className="em-q-sec">{SECTION_LABELS[item.section]}</span>
                      </div>
                      <button
                        type="button"
                        className={`em-flag-btn ${flagged ? 'is-active' : ''}`}
                        onClick={() => toggleFlag(item.id)}
                        aria-pressed={flagged}
                      >
                        <Flag size={14} aria-hidden="true" />
                        <span>{flagged ? '見直し中' : '見直し'}</span>
                      </button>
                    </div>

                    <p className="em-q-prompt">{item.prompt}</p>

                    {item.orderTokens && (
                      <div className="em-order-tokens" aria-label="並べ替え語群">
                        {item.orderTokens.map((tok, tIdx) => (
                          <span key={tIdx} className="em-order-chip" lang="en">
                            <strong>{tIdx + 1}.</strong> {tok}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="em-choice-list" role="radiogroup" aria-label={`問${qNo}の選択肢`}>
                      {item.choices!.map((choiceText, cIdx) => {
                        const selected = picked === cIdx;
                        return (
                          <button
                            key={cIdx}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={`em-choice-btn ${selected ? 'is-selected' : ''}`}
                            onClick={() =>
                              setAnswers(prev => {
                                const next = { ...prev };
                                if (next[item.id] === cIdx) delete next[item.id];
                                else next[item.id] = cIdx;
                                return next;
                              })
                            }
                            data-choice-idx={cIdx + 1}
                          >
                            <span className="em-choice-no">{cIdx + 1}</span>
                            <span className="em-choice-text" lang="en">
                              {choiceText}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              }

              // Writing item inside Mock Exam
              const wEntry = writing[item.id] ?? { text: '', checked: [] };
              const words = countEnglishWords(wEntry.text);
              const [minW, maxW] = item.wordRange ?? [25, 35];
              const inRange = words >= minW && words <= maxW;
              const gaugePct = Math.min(100, Math.round((words / Math.max(1, maxW)) * 100));

              return (
                <section
                  key={item.id}
                  className="em-q-card is-writing"
                  data-mock-writing={item.id}
                  data-mock-item-id={item.id}
                >
                  <div className="em-q-head">
                    <div className="em-q-title">
                      <span className="em-q-num">ライティング</span>
                      <span className="em-q-sec">{SECTION_LABELS[item.section]}</span>
                    </div>
                    <button
                      type="button"
                      className={`em-flag-btn ${flagged ? 'is-active' : ''}`}
                      onClick={() => toggleFlag(item.id)}
                      aria-pressed={flagged}
                    >
                      <Flag size={14} aria-hidden="true" />
                      <span>{flagged ? '見直し中' : '見直し'}</span>
                    </button>
                  </div>

                  <p className="em-q-prompt">{item.prompt}</p>
                  <div className="em-writing-meta">
                    <span>目安語数：{minW}〜{maxW}語</span>
                    <strong className={inRange ? 'is-ok' : words > maxW ? 'is-over' : ''}>
                      現在 {words} 語{' '}
                      {inRange ? '✓ 適正語数クリア' : words > maxW ? `（上限 +${words - maxW}語）` : ''}
                    </strong>
                  </div>
                  <div className="em-word-gauge" aria-hidden="true">
                    <div
                      className={`em-word-gauge-fill ${inRange ? 'is-ok' : words > maxW ? 'is-over' : ''}`}
                      style={{ width: `${gaugePct}%` }}
                    />
                  </div>

                  <textarea
                    rows={8}
                    className="em-writing-box"
                    value={wEntry.text}
                    onChange={e =>
                      setWriting(prev => ({
                        ...prev,
                        [item.id]: { ...(prev[item.id] ?? { checked: [] }), text: e.target.value },
                      }))
                    }
                    placeholder="ここに英語の解答を入力してください（提出後に模範解答・自己点検ルーブリックと比較できます）"
                  />
                </section>
              );
            })}
          </div>
        </div>

        {/* Bottom Navigation Bar */}
        <footer className="em-runner-footer">
          <button
            type="button"
            className="em-nav-btn"
            disabled={unitIndex === 0}
            onClick={() => {
              setUnitIndex(i => Math.max(0, i - 1));
              window.scrollTo(0, 0);
            }}
          >
            <ChevronLeft size={18} aria-hidden="true" />
            <span>前のページ</span>
          </button>

          <div className="em-footer-status">
            <span className="em-unit-counter">
              {unitIndex + 1} / {units.length} ページ（{currentRangeLabel}）
            </span>
            <span className={`em-unit-substatus ${unansweredInUnit === 0 ? 'is-done' : ''}`}>
              {unansweredInUnit === 0 ? 'このページ回答済み' : `このページ未回答 ${unansweredInUnit}`}
            </span>
          </div>

          {unitIndex < units.length - 1 ? (
            <button
              type="button"
              className="em-nav-btn is-primary"
              onClick={() => {
                setUnitIndex(i => Math.min(units.length - 1, i + 1));
                window.scrollTo(0, 0);
              }}
            >
              <span>次のページ</span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="em-nav-btn is-submit"
              onClick={() => setConfirmSubmit(true)}
            >
              <Send size={16} aria-hidden="true" />
              <span>採点・提出する</span>
            </button>
          )}
        </footer>
      </main>
    );
  }

  // =========================================================================
  // 3A. LISTENING RESULT & SCRIPT REVIEW SCREEN
  // =========================================================================
  if (examKind === 'listening' && activeListeningExam) {
    const summary = scoreListeningMockExam(activeListeningExam, answers, scopePart);
    const usedSec = submittedRecord?.elapsedSec ?? elapsedSec;
    const bp = LISTENING_BLUEPRINTS[activeListeningExam.grade];
    const allListeningQuestions = listeningUnits.flatMap(u => u.questions);

    const reviewUnits = listeningUnits.filter(unit =>
      unit.questions.some(q => {
        if (resultFilter === 'wrong') return answers[q.id] !== q.answer;
        if (resultFilter === 'flagged') return flags.includes(q.id);
        return true;
      }),
    );

    const jumpToListeningReview = (qId: string) => {
      if (resultFilter !== 'all') {
        const visible = reviewUnits.some(u => u.questions.some(q => q.id === qId));
        if (!visible) {
          setResultFilter('all');
          window.requestAnimationFrame(() => {
            document.getElementById(`em-rev-${qId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          });
          return;
        }
      }
      document.getElementById(`em-rev-${qId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };

    return (
      <main
        className="em-page em-result-page"
        data-mock-result
        data-mock-kind="listening"
        style={theme.accent ? ({ '--unit-accent': theme.accent } as React.CSSProperties) : undefined}
      >
        <div className="em-result-inner">
          <header className="em-header">
            <button type="button" className="unit-head-back em-result-back" onClick={() => setPhase('select')}>
              <ArrowLeft size={16} aria-hidden="true" />
              <span>一覧へ戻る</span>
            </button>
            <div className="em-header-title">
              <h1>
                {gradeLabel} リスニング 第{activeListeningExam.round}回
                {activePartSpec ? `（${activePartSpec.tabTitle}）` : ''} 採点結果
              </h1>
              <p>全音源の英語スクリプト・日本語訳・選択肢別の根拠を確認できます（誤答は復習リストへ自動登録）</p>
            </div>
            <button
              type="button"
              className="em-ghost-btn"
              onClick={() => startListeningExam(activeListeningExam, false, scopePart)}
            >
              <RotateCcw size={15} aria-hidden="true" />
              <span>もう一度解く</span>
            </button>
          </header>

          <section className="em-score-hero" aria-label="リスニング総合スコア">
            <div className="em-score-main">
              <span className="em-score-kicker">リスニング 正答数</span>
              <div className="em-score-number">
                <strong>{summary.correct}</strong>
                <span>/ {summary.total} 問</span>
                <em className="em-score-pct">{summary.accuracyPct}%</em>
              </div>
              <p className="em-score-sub">
                所要時間：{formatDuration(usedSec)}（目安 {scopedMinutes}分） ／ テーマ：{activeListeningExam.theme}
              </p>
            </div>

            <div className="em-breakdown-list">
              {summary.parts.map(pt => {
                const pct = pt.total > 0 ? Math.round((pt.correct / pt.total) * 100) : 0;
                return (
                  <div key={pt.part} className="em-breakdown-row">
                    <div className="em-breakdown-label">
                      <span>{pt.label}</span>
                      <strong>
                        {pt.correct}/{pt.total} 問 ({pct}%)
                      </strong>
                    </div>
                    <div className="em-breakdown-bar">
                      <div className="em-breakdown-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>

            {allListeningQuestions.length > 0 && (
              <div className="em-result-marks-wrap">
                <ol className="em-result-marks-grid" aria-label="設問ごとの正誤（押すと解説へ移動）">
                  {allListeningQuestions.map(q => {
                    const picked = answers[q.id];
                    const state = !Number.isInteger(picked)
                      ? 'blank'
                      : picked === q.answer
                      ? 'correct'
                      : 'wrong';
                    return (
                      <li key={q.id}>
                        <button
                          type="button"
                          className="em-result-mark-cell"
                          data-result={state}
                          onClick={() => jumpToListeningReview(q.id)}
                          title={`No.${q.questionNumber}（${
                            state === 'correct' ? '正解' : state === 'wrong' ? '不正解' : '未解答'
                          }）へ移動`}
                        >
                          <span className="em-rm-no">{q.questionNumber}</span>
                          <span className="em-rm-sym" aria-hidden="true">
                            {state === 'correct' ? '○' : state === 'wrong' ? '×' : '−'}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </section>

          <section className="em-choice-review-section" aria-label="リスニング問題の答え合わせ・台本">
            <div className="em-review-toolbar">
              <h2 className="em-sub-heading">
                <Headphones size={18} aria-hidden="true" />
                <span>音源別 スクリプト・和訳・解説</span>
              </h2>
              <div className="em-filter-pills" role="tablist" aria-label="表示フィルタ">
                <button
                  type="button"
                  role="tab"
                  aria-selected={resultFilter === 'all'}
                  className={resultFilter === 'all' ? 'is-active' : ''}
                  onClick={() => setResultFilter('all')}
                >
                  全問 ({summary.total})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={resultFilter === 'wrong'}
                  className={resultFilter === 'wrong' ? 'is-active' : ''}
                  onClick={() => setResultFilter('wrong')}
                >
                  誤答・未解答 ({summary.total - summary.correct})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={resultFilter === 'flagged'}
                  className={resultFilter === 'flagged' ? 'is-active' : ''}
                  onClick={() => setResultFilter('flagged')}
                >
                  見直し ({flags.length})
                </button>
              </div>
            </div>

            {reviewUnits.length === 0 ? (
              <p className="em-empty-review">該当する問題はありません。素晴らしい結果です！</p>
            ) : (
              <div className="em-review-list">
                {reviewUnits.map(unit => {
                  const problem = listeningUnitToProblem(activeListeningExam, unit);
                  const partLabel = bp.parts.find(p => p.id === unit.part)?.label ?? unit.part;
                  const imgUrl = LISTENING_IMAGE_URLS[unit.audioId];
                  const allUnitCorrect = unit.questions.every(q => answers[q.id] === q.answer);

                  return (
                    <article
                      key={unit.audioId}
                      className={`em-review-card ${allUnitCorrect ? 'is-correct' : 'is-wrong'}`}
                    >
                      <div className="em-rev-audio-bar">
                        <ListeningAudioPlayer
                          tracks={problem.audioTracks ?? []}
                          mode="practice"
                          tone="light"
                          variant="inline"
                          orientation="horizontal"
                          readCount={unit.readCount}
                        />
                      </div>

                      {imgUrl && (
                        <div className="em-rev-figure">
                          <img
                            src={imgUrl}
                            alt={unit.image?.sceneSummaryJa || unit.audioId}
                            className="em-rev-thumb"
                          />
                        </div>
                      )}

                      <div className="em-rev-script-box">
                        <div className="em-rev-script-en" lang="en">
                          {unit.turns.map((turn, tIdx) => (
                            <p key={tIdx}>
                              {turn.roleLabel !== 'Narrator' && <strong>{turn.roleLabel}: </strong>}
                              <span>{turn.text}</span>
                            </p>
                          ))}
                        </div>
                        <p className="em-rev-ja">【和訳】{unit.translation}</p>
                      </div>

                      {unit.questions.map(q => {
                        const picked = answers[q.id];
                        const hasPicked = Number.isInteger(picked);
                        const isCorrect = picked === q.answer;
                        const singleCol = q.choices.some(c => c.length > 22);
                        return (
                          <div key={q.id} id={`em-rev-${q.id}`} className="em-rev-subq">
                            <div className="em-rev-head">
                              <span className={`em-rev-badge ${isCorrect ? 'is-correct' : 'is-wrong'}`}>
                                {isCorrect ? (
                                  <CheckCircle2 size={14} aria-hidden="true" />
                                ) : hasPicked ? (
                                  <XCircle size={14} aria-hidden="true" />
                                ) : (
                                  <MinusCircle size={14} aria-hidden="true" />
                                )}
                                <span>{isCorrect ? '正解' : hasPicked ? '不正解' : '未解答'}</span>
                              </span>
                              <strong className="em-rev-qno">No. {q.questionNumber}</strong>
                              <span className="em-rev-sec">{partLabel}</span>
                            </div>
                            {q.questionPrompt && (
                              <p className="em-rev-prompt" lang="en">
                                {q.questionPrompt}
                              </p>
                            )}
                            <div className={`em-rev-choice-cards ${singleCol ? 'is-single' : ''}`}>
                              {q.choices.map((cText, cIdx) => {
                                const isAns = cIdx === q.answer;
                                const isUser = cIdx === picked;
                                const tone = isAns ? 'right' : isUser ? 'wrong' : undefined;
                                return (
                                  <div key={cIdx} className="em-rev-choice-box" data-result={tone}>
                                    <span className="em-rev-bubble">{cIdx + 1}</span>
                                    <span className="em-rev-choice-label" lang="en">
                                      {cText}
                                    </span>
                                    {(isAns || isUser) && (
                                      <span className="em-rev-pill-badge" data-tone={isAns ? 'right' : 'wrong'}>
                                        {isAns && isUser ? 'あなた・正解' : isAns ? '正解' : 'あなた'}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            <div className="em-rev-ex-box">
                              <div className="em-rev-key">
                                <span className="em-rev-lbl" data-role="key">
                                  <KeyRound size={12} aria-hidden="true" />
                                  <span>正解の理由・根拠</span>
                                </span>
                                <p>
                                  {q.evidence} — {q.explanation}
                                </p>
                              </div>
                              <div className="em-rev-reasons">
                                <span className="em-rev-lbl" data-role="choices">
                                  <ListChecks size={12} aria-hidden="true" />
                                  <span>選択肢の確認</span>
                                </span>
                                <ul className="em-rev-choices">
                                  {q.choices.map((cText, cIdx) => {
                                    const isAns = cIdx === q.answer;
                                    const isUser = cIdx === picked;
                                    return (
                                      <li
                                        key={cIdx}
                                        className={`${isAns ? 'is-ans' : ''} ${
                                          isUser && !isAns ? 'is-user-wrong' : ''
                                        }`}
                                      >
                                        <span className="em-rev-mark" aria-hidden="true">
                                          {isAns ? '○' : '×'}
                                        </span>
                                        <span>
                                          <strong lang="en">
                                            {cIdx + 1}. {cText}
                                          </strong>
                                          {q.distractorReasons?.[cIdx] ? ` — ${q.distractorReasons[cIdx]}` : ''}
                                        </span>
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </main>
    );
  }

  // =========================================================================
  // 3B. WRITTEN RESULT & REVIEW SCREEN（EikenClozePageQuiz / ToeicPageQuiz と同じ高品質な解説体験）
  // =========================================================================
  const activeWritten = activeWrittenExam!;
  const summary = scoreMockExam(activeWritten, answers, writing, scopeSection);
  const usedSec = submittedRecord?.elapsedSec ?? elapsedSec;

  const allScopedChoiceEntries = activeWritten.items
    .map((item, idx) => ({ item, qNo: idx + 1 }))
    .filter(entry => (scopeSection === 'all' || entry.item.section === scopeSection) && entry.item.kind === 'choice');

  const choiceReviewItems = allScopedChoiceEntries.filter(({ item }) => {
    if (resultFilter === 'wrong') return answers[item.id] !== item.answer;
    if (resultFilter === 'flagged') return flags.includes(item.id);
    return true;
  });

  const writingReviewItems = activeWritten.items.filter(
    item => (scopeSection === 'all' || item.section === scopeSection) && item.kind === 'writing',
  );

  const jumpToReviewCard = (itemId: string) => {
    const target = allScopedChoiceEntries.find(e => e.item.id === itemId);
    if (!target) return;
    if (resultFilter !== 'all') {
      const visible = choiceReviewItems.some(e => e.item.id === itemId);
      if (!visible) {
        setResultFilter('all');
        window.requestAnimationFrame(() => {
          document.getElementById(`em-rev-${itemId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
        return;
      }
    }
    document.getElementById(`em-rev-${itemId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <main
      className="em-page em-result-page"
      data-mock-result
      style={theme.accent ? ({ '--unit-accent': theme.accent } as React.CSSProperties) : undefined}
    >
      <div className="em-result-inner">
        <header className="em-header">
          <button type="button" className="unit-head-back em-result-back" onClick={() => setPhase('select')}>
            <ArrowLeft size={16} aria-hidden="true" />
            <span>一覧へ戻る</span>
          </button>
          <div className="em-header-title">
            <h1>
              {gradeLabel} 第{activeWritten.round}回
              {activeDaimonSpec ? `（${activeDaimonSpec.tabTitle}）` : ''} 採点結果
            </h1>
            <p>間違えた問題は「復習」リストに自動登録されました</p>
          </div>
          <button
            type="button"
            className="em-ghost-btn"
            onClick={() => startExam(activeWritten, false, scopeSection)}
          >
            <RotateCcw size={15} aria-hidden="true" />
            <span>もう一度解く</span>
          </button>
        </header>

        {/* Score Hero */}
        <section className="em-score-hero" aria-label="総合スコア">
          <div className="em-score-main">
            <span className="em-score-kicker">
              {summary.total > 0 ? '4択問題 正答数' : 'ライティング提出状況'}
            </span>
            <div className="em-score-number">
              {summary.total > 0 ? (
                <>
                  <strong>{summary.correct}</strong>
                  <span>/ {summary.total} 問</span>
                  <em className="em-score-pct">{summary.accuracyPct}%</em>
                </>
              ) : (
                <>
                  <strong>{summary.writingDone}</strong>
                  <span>/ {summary.writingTotal} 題 記入済み</span>
                </>
              )}
            </div>
            <p className="em-score-sub">
              所要時間：{formatDuration(usedSec)}（目安 {scopedMinutes}分）
              {summary.total > 0 &&
                summary.writingTotal > 0 &&
                ` ／ ライティング提出 ${summary.writingDone}/${summary.writingTotal}題`}
            </p>
          </div>

          <div className="em-breakdown-list">
            {summary.sections.map(sec => {
              const pct = sec.total > 0 ? Math.round((sec.correct / sec.total) * 100) : 0;
              return (
                <div key={sec.section} className="em-breakdown-row">
                  <div className="em-breakdown-label">
                    <span>{sec.label}</span>
                    <strong>
                      {sec.kind === 'writing'
                        ? `${sec.answered}/${sec.total} 題記入`
                        : `${sec.correct}/${sec.total} 問 (${pct}%)`}
                    </strong>
                  </div>
                  <div className="em-breakdown-bar">
                    <div
                      className="em-breakdown-fill"
                      style={{
                        width: `${
                          sec.kind === 'writing'
                            ? Math.round((sec.answered / Math.max(1, sec.total)) * 100)
                            : pct
                        }%`,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* 4択問題の正誤クイックジャンプ帯（○ / × / − を押してその設問へ移動） */}
          {allScopedChoiceEntries.length > 0 && (
            <div className="em-result-marks-wrap">
              <ol className="em-result-marks-grid" aria-label="設問ごとの正誤（押すと解説へ移動）">
                {allScopedChoiceEntries.map(({ item, qNo }) => {
                  const picked = answers[item.id];
                  const state = !Number.isInteger(picked)
                    ? 'blank'
                    : picked === item.answer
                    ? 'correct'
                    : 'wrong';
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="em-result-mark-cell"
                        data-result={state}
                        onClick={() => jumpToReviewCard(item.id)}
                        title={`問${qNo}（${
                          state === 'correct' ? '正解' : state === 'wrong' ? '不正解' : '未解答'
                        }）へ移動`}
                      >
                        <span className="em-rm-no">{qNo}</span>
                        <span className="em-rm-sym" aria-hidden="true">
                          {state === 'correct' ? '○' : state === 'wrong' ? '×' : '−'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </section>

        {/* Writing Self-Review Section */}
        {writingReviewItems.length > 0 && (
          <section className="em-writing-review-section" aria-label="ライティング振り返り">
            <h2 className="em-sub-heading">
              <Sparkles size={18} aria-hidden="true" />
              <span>ライティング 自己点検・模範解答</span>
            </h2>
            {writingReviewItems.map(item => {
              const entry = writing[item.id] ?? { text: '', checked: [] };
              const words = countEnglishWords(entry.text);
              return (
                <article key={item.id} className="em-writing-review-card">
                  <div className="em-wr-head">
                    <strong>{SECTION_LABELS[item.section]}</strong>
                    <span>
                      あなたの語数：{words}語（目安 {item.wordRange?.[0]}〜{item.wordRange?.[1]}語）
                    </span>
                  </div>
                  <p className="em-wr-prompt">{item.prompt}</p>
                  {item.passage && (
                    <details className="em-wr-source">
                      <summary>
                        <BookOpen size={14} aria-hidden="true" />
                        <span>課題の英文・和訳を確認する</span>
                      </summary>
                      <p className="em-wr-en" lang="en">
                        {item.passage.text.replace(/__/g, '')}
                      </p>
                      {item.passage.translation && <p className="em-wr-ja">{item.passage.translation}</p>}
                    </details>
                  )}
                  <div className="em-wr-columns">
                    <div className="em-wr-col">
                      <h3>あなたの解答</h3>
                      <p className="em-wr-user">{entry.text.trim() || '（未入力）'}</p>
                      <div className="em-wr-rubric">
                        {(item.rubric ?? []).map((criterion, cIdx) => {
                          const checked = entry.checked.includes(cIdx);
                          return (
                            <label key={cIdx} className="em-rubric-item">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={e => {
                                  const nextChecked = e.target.checked
                                    ? [...entry.checked, cIdx]
                                    : entry.checked.filter(n => n !== cIdx);
                                  const nextWriting = {
                                    ...writing,
                                    [item.id]: { ...entry, checked: nextChecked },
                                  };
                                  setWriting(nextWriting);
                                  syncSubmittedMockToStudyLedger(uid, activeWritten, answers, nextWriting, scopeSection);
                                }}
                              />
                              <span>{criterion}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                    <div className="em-wr-col is-model">
                      <h3>模範解答（{countEnglishWords(item.model!)}語）</h3>
                      <p className="em-wr-model" lang="en">
                        {item.model}
                      </p>
                      {item.translation && <p className="em-wr-ja">{item.translation}</p>}
                      {item.explanation && <p className="em-wr-exp">{item.explanation}</p>}
                    </div>
                  </div>
                </article>
              );
            })}
          </section>
        )}

        {/* Choice Questions Review */}
        {summary.total > 0 && (
          <section className="em-choice-review-section" aria-label="4択問題の答え合わせ">
            <div className="em-review-toolbar">
              <h2 className="em-sub-heading">
                <CheckCircle2 size={18} aria-hidden="true" />
                <span>4択問題の答え合わせ・解説</span>
              </h2>
              <div className="em-filter-pills" role="tablist" aria-label="表示フィルタ">
                <button
                  type="button"
                  role="tab"
                  aria-selected={resultFilter === 'all'}
                  className={resultFilter === 'all' ? 'is-active' : ''}
                  onClick={() => setResultFilter('all')}
                >
                  全問 ({summary.total})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={resultFilter === 'wrong'}
                  className={resultFilter === 'wrong' ? 'is-active' : ''}
                  onClick={() => setResultFilter('wrong')}
                >
                  誤答・未解答 ({summary.total - summary.correct})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={resultFilter === 'flagged'}
                  className={resultFilter === 'flagged' ? 'is-active' : ''}
                  onClick={() => setResultFilter('flagged')}
                >
                  見直し ({flags.length})
                </button>
              </div>
            </div>

            {choiceReviewItems.length === 0 ? (
              <p className="em-empty-review">該当する問題はありません。素晴らしい結果です！</p>
            ) : (
              <div className="em-review-list">
                {choiceReviewItems.map(({ item, qNo }) => {
                  const picked = answers[item.id];
                  const hasPicked = Number.isInteger(picked);
                  const isCorrect = picked === item.answer;
                  const correctWord = item.choices?.[item.answer!] ?? '';
                  const pickedWord = hasPicked ? item.choices?.[picked!] ?? '' : '';
                  const singleCol = (item.choices ?? []).some(c => c.length > 22);
                  const autoCompleted =
                    item.completedSentence ||
                    (/\(\s*_{0,6}\s*\)/.test(item.prompt)
                      ? item.prompt.replace(/\(\s*_{0,6}\s*\)/, correctWord)
                      : '');

                  return (
                    <article
                      key={item.id}
                      id={`em-rev-${item.id}`}
                      className={`em-review-card ${isCorrect ? 'is-correct' : 'is-wrong'}`}
                    >
                      <div className="em-rev-head">
                        <span className={`em-rev-badge ${isCorrect ? 'is-correct' : 'is-wrong'}`}>
                          {isCorrect ? (
                            <CheckCircle2 size={14} aria-hidden="true" />
                          ) : hasPicked ? (
                            <XCircle size={14} aria-hidden="true" />
                          ) : (
                            <MinusCircle size={14} aria-hidden="true" />
                          )}
                          <span>{isCorrect ? '正解' : hasPicked ? '不正解' : '未解答'}</span>
                        </span>
                        <strong className="em-rev-qno">問 {qNo}</strong>
                        <span className="em-rev-sec">{SECTION_LABELS[item.section]}</span>

                        <button
                          type="button"
                          className="em-rev-save-btn"
                          data-saved={savedNotes[item.id] || undefined}
                          disabled={Boolean(savedNotes[item.id])}
                          onClick={() => handleSaveMockItemNote(activeWritten, item, qNo)}
                        >
                          {savedNotes[item.id] ? (
                            <BookmarkCheck size={14} aria-hidden="true" />
                          ) : (
                            <Bookmark size={14} aria-hidden="true" />
                          )}
                          <span>{savedNotes[item.id] ? '保存済み' : 'ノートに保存'}</span>
                        </button>
                      </div>

                      {item.passage && (
                        <details className="em-wr-source">
                          <summary>
                            <BookOpen size={14} aria-hidden="true" />
                            <span>本文・和訳を開く（{item.passage.title}）</span>
                          </summary>
                          <p className="em-wr-en" lang="en">
                            {item.passage.text}
                          </p>
                          {item.passage.translation && <p className="em-wr-ja">{item.passage.translation}</p>}
                        </details>
                      )}

                      <p className="em-rev-prompt" lang="en">
                        <PromptWithInlineBlank
                          prompt={item.prompt}
                          filled={hasPicked ? pickedWord : correctWord}
                          tone={isCorrect || !hasPicked ? 'right' : 'wrong'}
                        />
                      </p>

                      {item.orderTokens && (
                        <div className="em-order-tokens" aria-label="並べ替え語群">
                          {item.orderTokens.map((tok, tIdx) => (
                            <span key={tIdx} className="em-order-chip" lang="en">
                              <strong>{tIdx + 1}.</strong> {tok}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* 選択肢カード（正解／あなたの誤答が一目でわかるバッジ付き） */}
                      <div className={`em-rev-choice-cards ${singleCol ? 'is-single' : ''}`}>
                        {item.choices!.map((cText, cIdx) => {
                          const isAns = cIdx === item.answer;
                          const isUser = cIdx === picked;
                          const tone = isAns ? 'right' : isUser ? 'wrong' : undefined;
                          return (
                            <div key={cIdx} className="em-rev-choice-box" data-result={tone}>
                              <span className="em-rev-bubble">{cIdx + 1}</span>
                              <span className="em-rev-choice-label" lang="en">
                                {cText}
                              </span>
                              {(isAns || isUser) && (
                                <span className="em-rev-pill-badge" data-tone={isAns ? 'right' : 'wrong'}>
                                  {isAns && isUser ? 'あなた・正解' : isAns ? '正解' : 'あなた'}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* 構造化解説パネル（完成文・正解の根拠・各選択肢の理由・和訳） */}
                      <div className="em-rev-ex-box">
                        {autoCompleted && (!isCorrect || Boolean(item.completedSentence)) && (
                          <div className="em-rev-recap" lang="en">
                            <span className="em-rev-lbl" data-role="recap" lang="ja">
                              完成文
                            </span>
                            <span>{autoCompleted.replace(/\n+/g, '  ')}</span>
                          </div>
                        )}

                        {item.explanation && (
                          <div className="em-rev-key">
                            <span className="em-rev-lbl" data-role="key">
                              <KeyRound size={12} aria-hidden="true" />
                              <span>正解の理由・根拠</span>
                            </span>
                            <p>{item.explanation}</p>
                          </div>
                        )}

                        <div className="em-rev-reasons">
                          <span className="em-rev-lbl" data-role="choices">
                            <ListChecks size={12} aria-hidden="true" />
                            <span>選択肢の確認</span>
                          </span>
                          <ul className="em-rev-choices">
                            {item.choices!.map((cText, cIdx) => {
                              const isAns = cIdx === item.answer;
                              const isUser = cIdx === picked;
                              return (
                                <li
                                  key={cIdx}
                                  className={`${isAns ? 'is-ans' : ''} ${isUser && !isAns ? 'is-user-wrong' : ''}`}
                                >
                                  <span className="em-rev-mark" aria-hidden="true">
                                    {isAns ? '○' : '×'}
                                  </span>
                                  <span>
                                    <strong lang="en">
                                      {cIdx + 1}. {cText}
                                    </strong>
                                    {item.distractorReasons?.[cIdx] ? ` — ${item.distractorReasons[cIdx]}` : ''}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>

                        {item.translation && (
                          <div className="em-rev-tr">
                            <span className="em-rev-lbl" data-role="tr">
                              <Languages size={12} aria-hidden="true" />
                              <span>和訳</span>
                            </span>
                            <p className="em-rev-ja">{item.translation}</p>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
