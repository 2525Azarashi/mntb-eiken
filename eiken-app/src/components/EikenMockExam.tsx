import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flag,
  Headphones,
  LayoutGrid,
  Pause,
  PenLine,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  Trophy,
} from 'lucide-react';
import { EIKEN_GRADES, type EikenGrade } from '../eiken/config';
import {
  LISTENING_BLUEPRINTS,
  type ListeningAudioUnit,
  type ListeningExamRound,
  type ListeningPartId,
  type ListeningQuestionItem,
} from '../eiken/listeningExamCore';
import { getGradeListeningPartSpecs, listeningUnitToProblem } from '../eiken/listeningPractice';
import { ALL_LISTENING_EXAMS, LISTENING_EXAMS_BY_GRADE } from '../eiken/materials/listening-booklets';
import { WRITTEN_BOOKLETS } from '../eiken/materials/written-booklets';
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
import {
  countEnglishWords,
  WRITTEN_BLUEPRINTS,
  type WrittenExam,
  type WrittenItem,
  type WrittenSection,
} from '../eiken/writtenExamCore';
import { getGradeDaimonSpecs, WRITTEN_SECTION_LABELS } from '../eiken/writtenPractice';
import { parseWriting, writingKey, type WritingDraft } from '../eiken/writingProgress';
import { markProblemSolved } from '../utils/progress';
import { captureWrongAnswers, type WrongAnswerInput } from '../utils/reviewList';
import { safeLocalStorage } from '../utils/safeLocalStorage';
import { stopSpeech } from '../utils/listeningSpeech';
import { ListeningAudioPlayer } from './ListeningAudioPlayer';
import { ListeningMaterials } from './ListeningMaterials';
import './eiken-mock-exam.css';

export type MockExamCategory = 'written' | 'listening';

interface ExamUnit {
  id: string;
  section: WrittenSection;
  kind: 'choice' | 'writing';
  passage?: WrittenItem['passage'];
  items: { item: WrittenItem; qNo: number }[];
}

function buildExamUnits(exam: WrittenExam, sectionFilter: 'all' | WrittenSection = 'all'): ExamUnit[] {
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
  const partSpec = bp.parts.find(p => p.id === partFilter);
  if (!partSpec) return 10;
  return Math.max(6, Math.round((bp.minutes * partSpec.questionCount) / Math.max(1, bp.totalQuestions)));
}

function sessionRecordKey(examId: string, scopeFilter: 'all' | WrittenSection | ListeningPartId): string {
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
  const partLabels = new Map<ListeningPartId, string>(blueprint.parts.map(p => [p.id, p.label]));

  for (const unit of exam.units) {
    if (partFilter !== 'all' && unit.part !== partFilter) continue;
    const chapterId = `${exam.id}_${unit.part}`;
    const partLabel = partLabels.get(unit.part) ?? unit.part;
    const partUnits = exam.units.filter(u => u.part === unit.part);
    const questionIndex = Math.max(0, partUnits.findIndex(u => u.audioId === unit.audioId));

    let unitScore = 0;
    for (const q of unit.questions) {
      const picked = answers[q.id];
      if (picked === q.answer) {
        unitScore += 1;
      } else if (Number.isInteger(picked) && picked >= 0 && picked < q.choices.length) {
        wrongInputs.push({
          chapterId,
          chapterTitle: `${gradeLabel} リスニング 第${exam.round}回｜${partLabel}`,
          questionIndex,
          questionId: unit.audioId,
          subQuestionId: `${q.id}_answer`,
          subLabel: `No.${q.questionNumber}`,
          questionText:
            q.choicePresentation === 'read-aloud'
              ? `No.${q.questionNumber}（${unit.turns.map(t => t.text).join(' / ')}）`
              : `No.${q.questionNumber} ${q.questionPrompt}`,
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
  initialCategory,
  onGrade,
  onBack,
  onRunningChange,
}: {
  uid: string;
  grade: EikenGrade;
  initialCategory?: MockExamCategory;
  onGrade: (grade: EikenGrade) => void;
  onBack: () => void;
  onRunningChange?: (running: boolean) => void;
}) {
  const [examCategory, setExamCategory] = useState<MockExamCategory>(() =>
    initialCategory ?? (initialGrade === 'eiken_1' ? 'listening' : 'written'),
  );

  useEffect(() => {
    if (initialCategory) {
      setExamCategory(initialCategory);
    }
  }, [initialCategory]);

  useEffect(() => {
    if (initialGrade === 'eiken_1') {
      setExamCategory('listening');
    }
  }, [initialGrade]);

  const availableGrades = useMemo(
    () =>
      examCategory === 'listening'
        ? EIKEN_GRADES.filter(g => g.available && (LISTENING_EXAMS_BY_GRADE[g.id]?.length ?? 0) > 0)
        : EIKEN_GRADES.filter(g => g.available && WRITTEN_BOOKLETS.some(b => b.grade === g.id)),
    [examCategory],
  );

  const grade: EikenGrade = availableGrades.some(g => g.id === initialGrade) ? initialGrade : 'eiken_3';
  const gradeLabel = availableGrades.find(g => g.id === grade)?.label ?? '英検3級';

  // Written specs
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

  // Listening specs
  const listeningBlueprint = LISTENING_BLUEPRINTS[grade];
  const gradeListeningExams = useMemo(
    () =>
      (LISTENING_EXAMS_BY_GRADE[grade] ?? [])
        .filter(e => e.review === 'approved')
        .slice()
        .sort((a, b) => a.round - b.round),
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
  const [zoomedIllustration, setZoomedIllustration] = useState<{ src: string; caption: string } | null>(null);

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

  const activeWrittenExam = useMemo(
    () => (examCategory === 'written' ? WRITTEN_BOOKLETS.find(b => b.id === activeExamId) ?? null : null),
    [examCategory, activeExamId],
  );
  const activeListeningExam = useMemo(
    () => (examCategory === 'listening' ? ALL_LISTENING_EXAMS.find(e => e.id === activeExamId) ?? null : null),
    [examCategory, activeExamId],
  );

  const writtenUnits = useMemo(
    () => (activeWrittenExam ? buildExamUnits(activeWrittenExam, scopeSection) : []),
    [activeWrittenExam, scopeSection],
  );
  const listeningUnits = useMemo(
    () =>
      activeListeningExam
        ? scopePart === 'all'
          ? activeListeningExam.units
          : activeListeningExam.units.filter(u => u.part === scopePart)
        : [],
    [activeListeningExam, scopePart],
  );

  const scopedMinutes =
    examCategory === 'listening'
      ? estimateListeningMinutes(activeListeningExam ? activeListeningExam.grade : grade, scopePart)
      : estimateSectionMinutes(activeWrittenExam ? activeWrittenExam.grade : grade, scopeSection);
  const limitSec = scopedMinutes * 60;

  const activeStorageSlot =
    examCategory === 'listening'
      ? activeListeningExam
        ? sessionRecordKey(activeListeningExam.id, scopePart)
        : ''
      : activeWrittenExam
      ? sessionRecordKey(activeWrittenExam.id, scopeSection)
      : '';

  const hasActiveExam = Boolean(activeWrittenExam || activeListeningExam);

  useEffect(() => {
    onRunningChange?.(phase === 'running');
    return () => {
      stopSpeech();
      onRunningChange?.(false);
    };
  }, [phase, onRunningChange]);

  // Stop speech whenever question unit changes or phase exits running
  useEffect(() => {
    stopSpeech();
    setZoomedIllustration(null);
  }, [unitIndex, phase, examCategory]);

  useEffect(() => {
    if (!zoomedIllustration) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoomedIllustration(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomedIllustration]);

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

  // Save elapsedSec every 5s
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

  const startWrittenExam = (exam: WrittenExam, resume: boolean, targetScope: 'all' | WrittenSection = scopeSection) => {
    stopSpeech();
    const slot = sessionRecordKey(exam.id, targetScope);
    const savedSession = resume ? mockState.sessions[slot] : undefined;
    setExamCategory('written');
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
    targetPart: 'all' | ListeningPartId = scopePart,
  ) => {
    stopSpeech();
    const slot = sessionRecordKey(exam.id, targetPart);
    const savedSession = resume ? mockState.sessions[slot] : undefined;
    const targetUnits = targetPart === 'all' ? exam.units : exam.units.filter(u => u.part === targetPart);
    setExamCategory('listening');
    setScopePart(targetPart);
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

  const openLatestResult = (examId: string, targetScope: 'all' | WrittenSection | ListeningPartId) => {
    stopSpeech();
    const slot = sessionRecordKey(examId, targetScope);
    const last = mockState.history[slot]?.[0];
    if (!last) return;
    if (examCategory === 'listening') {
      setScopePart(targetScope as 'all' | ListeningPartId);
    } else {
      setScopeSection(targetScope as 'all' | WrittenSection);
    }
    setActiveExamId(examId);
    setAnswers(last.answers);
    setWriting(last.writing ?? {});
    setFlags(last.flags ?? []);
    setSubmittedRecord(last);
    setResultFilter('all');
    setPhase('result');
    window.scrollTo(0, 0);
  };

  const submitExam = () => {
    stopSpeech();
    if (!hasActiveExam || !activeStorageSlot) return;
    const summary =
      examCategory === 'listening' && activeListeningExam
        ? scoreListeningMockExam(activeListeningExam, answers, scopePart)
        : scoreMockExam(activeWrittenExam!, answers, writing, scopeSection);

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
    if (examCategory === 'listening' && activeListeningExam) {
      syncSubmittedListeningMockToStudyLedger(uid, activeListeningExam, answers, scopePart);
    } else if (activeWrittenExam) {
      syncSubmittedMockToStudyLedger(uid, activeWrittenExam, answers, writing, scopeSection);
    }
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

  // =========================================================================
  // 1. SELECT SCREEN
  // =========================================================================
  if (phase === 'select' || !hasActiveExam) {
    return (
      <main className="em-page" data-mock-select data-mock-category={examCategory}>
        <header className="em-header">
          <button type="button" className="em-back-btn" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" />
            <span>学習へ</span>
          </button>
          <div className="em-header-title">
            <h1>一次試験 通し演習（筆記・リスニング）</h1>
            <p>
              {examCategory === 'listening'
                ? '音声・図版・Real-Life条件表つきのリスニング本番通し模試（全8級×15回＝120回）'
                : '全大問フル模試も、大問1・大問2…ごとの通し演習も選べます（7級・全29回）'}
            </p>
          </div>
        </header>

        <section className="em-control-card" aria-label="模試の種別と級・時間設定">
          {/* Exam Category Switcher */}
          <div className="em-category-switch" role="tablist" aria-label="試験区分を選択" data-mock-category-tabs>
            <button
              type="button"
              role="tab"
              aria-selected={examCategory === 'written'}
              className={`em-category-tab ${examCategory === 'written' ? 'is-active' : ''}`}
              onClick={() => {
                setExamCategory('written');
                if (initialGrade === 'eiken_1') {
                  onGrade('eiken_pre1');
                }
              }}
              data-mock-category-btn="written"
            >
              <PenLine size={16} aria-hidden="true" />
              <div>
                <strong>一次筆記（リーディング・英作文）</strong>
                <small>5級〜準1級・全{WRITTEN_BOOKLETS.length}回</small>
              </div>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={examCategory === 'listening'}
              className={`em-category-tab ${examCategory === 'listening' ? 'is-active' : ''}`}
              onClick={() => setExamCategory('listening')}
              data-mock-category-btn="listening"
            >
              <Headphones size={16} aria-hidden="true" />
              <div>
                <strong>リスニング通し模試（音声・図版付）</strong>
                <small>5級〜1級・全{ALL_LISTENING_EXAMS.length}回（各級15回）</small>
              </div>
            </button>
          </div>

          <div className="em-grade-row">
            <span className="em-row-label">受験する級</span>
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
                  examCategory === 'listening'
                    ? (LISTENING_EXAMS_BY_GRADE[g.id]?.length ?? 0)
                    : WRITTEN_BOOKLETS.filter(b => b.grade === g.id && b.review === 'approved').length;
                return (
                  <button
                    key={g.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`em-grade-pill ${active ? 'is-active' : ''}`}
                    onClick={() => onGrade(g.id)}
                  >
                    <span>{g.shortLabel}</span>
                    <small>{count}回</small>
                  </button>
                );
              })}
            </div>
          </div>

          {examCategory === 'written' ? (
            <div className="em-grade-row em-scope-row">
              <span className="em-row-label">出題範囲（全大問通し ／ 大問別に分けて解く）</span>
              <div className="em-scope-pills" role="tablist" aria-label="出題する大問を選択" data-mock-scope-tabs>
                <button
                  type="button"
                  role="tab"
                  aria-selected={scopeSection === 'all'}
                  className={`em-scope-pill ${scopeSection === 'all' ? 'is-active' : ''}`}
                  onClick={() => setScopeSection('all')}
                  data-mock-scope="all"
                >
                  <span className="em-scope-kicker">本番形式</span>
                  <strong>全大問通し</strong>
                </button>
                {gradeDaimons.map(d => {
                  const active = scopeSection === d.section;
                  return (
                    <button
                      key={d.section}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className={`em-scope-pill ${active ? 'is-active' : ''}`}
                      onClick={() => setScopeSection(d.section)}
                      data-mock-scope={d.section}
                    >
                      <span className="em-scope-kicker">
                        大問{d.daimonNo}・{d.countPerRound}
                        {d.kind === 'writing' ? '題' : '問'}
                      </span>
                      <strong>{d.shortLabel}</strong>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="em-grade-row em-scope-row">
              <span className="em-row-label">出題範囲（全パート本番通し ／ 部ごとに分けて解く）</span>
              <div className="em-scope-pills" role="tablist" aria-label="出題するリスニング部を選択" data-mock-scope-tabs>
                <button
                  type="button"
                  role="tab"
                  aria-selected={scopePart === 'all'}
                  className={`em-scope-pill ${scopePart === 'all' ? 'is-active' : ''}`}
                  onClick={() => setScopePart('all')}
                  data-mock-scope="all"
                >
                  <span className="em-scope-kicker">
                    本番フル・全{listeningBlueprint.totalQuestions}問
                  </span>
                  <strong>全パート通し</strong>
                </button>
                {gradeListeningParts.map(pt => {
                  const active = scopePart === pt.partId;
                  return (
                    <button
                      key={pt.partId}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className={`em-scope-pill ${active ? 'is-active' : ''}`}
                      onClick={() => setScopePart(pt.partId)}
                      data-mock-scope={pt.partId}
                    >
                      <span className="em-scope-kicker">
                        第{pt.partNo}部・{pt.questionCount}問
                      </span>
                      <strong>{pt.shortLabel}</strong>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="em-spec-bar">
            <div className="em-spec-info">
              {examCategory === 'written' ? (
                <>
                  <strong>
                    {activeDaimonSpec
                      ? `${gradeLabel}｜${activeDaimonSpec.tabTitle}`
                      : `${gradeLabel} 一次筆記の構成（全大問通し）`}
                  </strong>
                  <span>
                    {activeDaimonSpec
                      ? `目安時間 ${scopedMinutes}分 ／ 1回あたり ${activeDaimonSpec.countPerRound}${
                          activeDaimonSpec.kind === 'writing' ? '題' : '問'
                        } を通して演習`
                      : `目安時間 ${blueprint?.minutes ?? 60}分 ／ ${blueprint?.sections
                          .map(s => `${SECTION_LABELS[s.id]} ${s.count}${s.kind === 'writing' ? '題' : '問'}`)
                          .join(' ＋ ')}`}
                  </span>
                </>
              ) : (
                <>
                  <strong>
                    {activePartSpec
                      ? `${gradeLabel}｜${activePartSpec.tabTitle}`
                      : `${gradeLabel} リスニング本試験構成（全パート通し）`}
                  </strong>
                  <span>
                    {activePartSpec
                      ? `目安時間 ${scopedMinutes}分 ／ 1回あたり ${activePartSpec.questionCount}問（${activePartSpec.audioUnitCount}音源）を通して演習`
                      : `目安時間 ${listeningBlueprint.minutes}分 ／ 全${listeningBlueprint.totalQuestions}問（${listeningBlueprint.parts
                          .map(p => `${p.label} ${p.questionCount}問`)
                          .join(' ＋ ')}）`}
                  </span>
                </>
              )}
            </div>
            <div className="em-timer-toggle" role="group" aria-label="タイマー設定">
              <button
                type="button"
                className={timedMode ? 'is-active' : ''}
                aria-pressed={timedMode}
                onClick={() => setTimedMode(true)}
              >
                <Clock size={14} aria-hidden="true" />
                本番タイマー（{scopedMinutes}分）
              </button>
              <button
                type="button"
                className={!timedMode ? 'is-active' : ''}
                aria-pressed={!timedMode}
                onClick={() => setTimedMode(false)}
              >
                制限なし（経過計測）
              </button>
            </div>
          </div>
        </section>

        {examCategory === 'written' ? (
          <section className="em-round-grid" aria-label={`${gradeLabel}の筆記模試一覧`}>
            {gradeExams.map(exam => {
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

              return (
                <article key={exam.id} className="em-round-card" data-mock-round={exam.id}>
                  <div className="em-round-top">
                    <div>
                      <span className="em-round-badge">
                        {activeDaimonSpec
                          ? `大問${activeDaimonSpec.daimonNo} 通し`
                          : exam.scope === 'reading'
                          ? 'リーディング通し'
                          : '一次筆記 フル模試'}
                      </span>
                      <h2>
                        {gradeLabel} 第{exam.round}回
                        {activeDaimonSpec ? `｜${activeDaimonSpec.shortLabel}` : ''}
                      </h2>
                    </div>
                    {best && (
                      <div className="em-best-chip" title="自己ベスト得点">
                        <Trophy size={14} aria-hidden="true" />
                        <span>
                          {best.total > 0
                            ? `最高 ${best.correct}/${best.total}（${Math.round((best.correct / best.total) * 100)}%）`
                            : `提出済 ${best.writingDone}/${best.writingTotal}題`}
                        </span>
                      </div>
                    )}
                  </div>

                  <p className="em-round-meta">
                    {choiceCount > 0 ? `4択 ${choiceCount}問` : ''}
                    {choiceCount > 0 && writingCount > 0 ? ` ＋ ` : ''}
                    {writingCount > 0 ? `ライティング ${writingCount}題` : ''}
                    {choiceCount > 0 && writingCount === 0 && !activeDaimonSpec ? '（リーディング範囲）' : ''} ／ 目安{' '}
                    {scopedMinutes}分
                  </p>

                  {session && (
                    <p className="em-session-banner">
                      中断データあり：{answeredInSession}/{targetItems.length} 解答済み（経過{' '}
                      {formatDuration(session.elapsedSec)}）
                    </p>
                  )}

                  <div className="em-round-actions">
                    {session ? (
                      <>
                        <button
                          type="button"
                          className="em-primary-btn"
                          onClick={() => startWrittenExam(exam, true, scopeSection)}
                        >
                          続きから再開する
                        </button>
                        <button
                          type="button"
                          className="em-ghost-btn"
                          onClick={() => startWrittenExam(exam, false, scopeSection)}
                        >
                          最初から解き直す
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="em-primary-btn"
                        onClick={() => startWrittenExam(exam, false, scopeSection)}
                        data-start-mock={exam.id}
                      >
                        {activeDaimonSpec
                          ? `第${exam.round}回・大問${activeDaimonSpec.daimonNo} を通しで解く`
                          : `第${exam.round}回 模試をはじめる`}
                      </button>
                    )}
                    {history.length > 0 && (
                      <button
                        type="button"
                        className="em-link-btn"
                        onClick={() => openLatestResult(exam.id, scopeSection)}
                      >
                        前回の結果・解説を見る
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        ) : (
          <section className="em-round-grid" aria-label={`${gradeLabel}のリスニング模試一覧`}>
            {gradeListeningExams.map(exam => {
              const targetUnits = scopePart === 'all' ? exam.units : exam.units.filter(u => u.part === scopePart);
              const targetQuestions = targetUnits.flatMap(u => u.questions);
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

              return (
                <article key={exam.id} className="em-round-card" data-mock-round={exam.id}>
                  <div className="em-round-top">
                    <div>
                      <span className="em-round-badge is-listening">
                        {activePartSpec ? `第${activePartSpec.partNo}部 通し` : 'リスニング フル模試'}
                      </span>
                      <h2>
                        {gradeLabel} 第{exam.round}回
                        {activePartSpec ? `｜${activePartSpec.shortLabel}` : `｜${exam.theme}`}
                      </h2>
                    </div>
                    {best && (
                      <div className="em-best-chip" title="自己ベスト得点">
                        <Trophy size={14} aria-hidden="true" />
                        <span>
                          最高 {best.correct}/{best.total}（{Math.round((best.correct / best.total) * 100)}%）
                        </span>
                      </div>
                    )}
                  </div>

                  <p className="em-round-meta">
                    全{targetQuestions.length}問（{targetUnits.length}音源） ／ 目安 {scopedMinutes}分 ／ 重点：
                    {exam.focusSkill}
                  </p>

                  {session && (
                    <p className="em-session-banner">
                      中断データあり：{answeredInSession}/{targetQuestions.length} 問解答済み（経過{' '}
                      {formatDuration(session.elapsedSec)}）
                    </p>
                  )}

                  <div className="em-round-actions">
                    {session ? (
                      <>
                        <button
                          type="button"
                          className="em-primary-btn"
                          onClick={() => startListeningExam(exam, true, scopePart)}
                        >
                          続きから再開する
                        </button>
                        <button
                          type="button"
                          className="em-ghost-btn"
                          onClick={() => startListeningExam(exam, false, scopePart)}
                        >
                          最初から解き直す
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="em-primary-btn"
                        onClick={() => startListeningExam(exam, false, scopePart)}
                        data-start-mock={exam.id}
                      >
                        {activePartSpec
                          ? `第${exam.round}回・第${activePartSpec.partNo}部 を通しで解く`
                          : `第${exam.round}回 リスニング模試をはじめる`}
                      </button>
                    )}
                    {history.length > 0 && (
                      <button
                        type="button"
                        className="em-link-btn"
                        onClick={() => openLatestResult(exam.id, scopePart)}
                      >
                        前回の結果・スクリプト解説を見る
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </main>
    );
  }

  // =========================================================================
  // 2A. RUNNING LISTENING EXAM SCREEN
  // =========================================================================
  if (phase === 'running' && examCategory === 'listening' && activeListeningExam) {
    const currentAudioUnit = listeningUnits[unitIndex] ?? listeningUnits[0];
    const currentProblem = listeningUnitToProblem(activeListeningExam, currentAudioUnit);
    const track = currentProblem.audioTracks?.[0];
    const firstSub = currentProblem.subQuestions[0];
    const illustrationUrl = !track?.material ? firstSub?.imageUrl : undefined;
    const illustrationCaption = firstSub?.imageCaption || currentAudioUnit.image?.sceneSummaryJa || '';
    const hasLeftMedia = Boolean(track?.material || illustrationUrl);

    const remainingSec = limitSec - elapsedSec;
    const isOvertime = timedMode && remainingSec < 0;
    const scopedQuestions = listeningUnits.flatMap(u => u.questions.map(q => ({ q, unit: u })));
    const answeredCount = scopedQuestions.filter(({ q }) => Number.isInteger(answers[q.id])).length;

    const bp = LISTENING_BLUEPRINTS[activeListeningExam.grade];
    const partFirstUnit: { part: ListeningPartId; label: string; unitIdx: number }[] = [];
    listeningUnits.forEach((u, idx) => {
      if (!partFirstUnit.some(p => p.part === u.part)) {
        const pSpec = bp.parts.find(p => p.id === u.part);
        partFirstUnit.push({ part: u.part, label: pSpec?.label ?? u.part, unitIdx: idx });
      }
    });

    const currentPartLabel = bp.parts.find(p => p.id === currentAudioUnit.part)?.label ?? currentAudioUnit.part;

    const jumpToQuestionId = (qId: string) => {
      const targetIdx = listeningUnits.findIndex(u => u.questions.some(q => q.id === qId));
      if (targetIdx >= 0) {
        setUnitIndex(targetIdx);
        setPaletteOpen(false);
        window.scrollTo(0, 0);
      }
    };

    return (
      <main className="em-runner" data-mock-runner data-mock-category="listening">
        <header className="em-runner-bar">
          <button
            type="button"
            className="em-runner-exit"
            onClick={() => {
              stopSpeech();
              setPhase('select');
            }}
            title="解答は自動保存されます。あとで続きから再開できます"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>中断して保存</span>
          </button>

          <div className="em-runner-center">
            <strong className="em-runner-title">
              {gradeLabel} リスニング 第{activeListeningExam.round}回
              {activePartSpec ? `・第${activePartSpec.partNo}部` : ''}
            </strong>
            <span className="em-runner-progress">
              解答 {answeredCount}/{scopedQuestions.length}
            </span>
          </div>

          <div className="em-runner-right">
            <div className={`em-timer-chip ${isOvertime ? 'is-overtime' : ''}`} data-mock-timer>
              <Clock size={15} aria-hidden="true" />
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
                aria-label={paused ? 'タイマーを再開' : 'タイマーを一時停止'}
              >
                {paused ? <Play size={13} /> : <Pause size={13} />}
              </button>
            </div>

            <button
              type="button"
              className="em-palette-toggle"
              onClick={() => setPaletteOpen(o => !o)}
              aria-expanded={paletteOpen}
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
              <span>採点・提出</span>
            </button>
          </div>
        </header>

        {/* Part Quick Jump Tabs */}
        <nav className="em-section-tabs" aria-label="リスニング部移動">
          {partFirstUnit.map(pt => {
            const active = currentAudioUnit.part === pt.part;
            return (
              <button
                key={pt.part}
                type="button"
                className={`em-section-tab ${active ? 'is-active' : ''}`}
                onClick={() => {
                  setUnitIndex(pt.unitIdx);
                  window.scrollTo(0, 0);
                }}
              >
                {pt.label}
              </button>
            );
          })}
        </nav>

        {/* Question Palette */}
        {paletteOpen && (
          <section className="em-palette-drawer" aria-label="設問番号パレット">
            <div className="em-palette-legend">
              <span>設問番号（No.）をタップして直接移動できます</span>
              <div className="em-legend-items">
                <span className="is-answered">解答済</span>
                <span className="is-flagged">見直し</span>
                <span>未解答</span>
              </div>
            </div>
            <div className="em-palette-grid">
              {scopedQuestions.map(({ q }) => {
                const isAnswered = Number.isInteger(answers[q.id]);
                const isFlagged = flags.includes(q.id);
                const isCurrent = currentAudioUnit.questions.some(cq => cq.id === q.id);
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

        {/* Submit Confirmation Modal */}
        {confirmSubmit && (
          <div className="em-modal-backdrop" role="dialog" aria-modal="true" aria-label="提出確認">
            <div className="em-modal">
              <h2>リスニング模試を終了して採点しますか？</h2>
              <p>
                選択問題：<strong>{answeredCount} / {scopedQuestions.length} 問</strong> 解答済み
                {flags.length > 0 && (
                  <>
                    <br />
                    見直しチェック：<strong>{flags.length} 件</strong> 残っています
                  </>
                )}
              </p>
              {answeredCount < scopedQuestions.length && (
                <p className="em-modal-warn">
                  未解答の問題が {scopedQuestions.length - answeredCount} 問あります。そのまま採点すると未解答は不正解扱いになります。
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
                  採点してスクリプト・解説を見る
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Illustration Zoom Lightbox */}
        {zoomedIllustration && (
          <div
            className="em-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label="イラスト拡大表示"
            onClick={() => setZoomedIllustration(null)}
          >
            <div className="em-zoom-dialog" onClick={e => e.stopPropagation()}>
              <img src={zoomedIllustration.src} alt={zoomedIllustration.caption} />
              <div className="em-zoom-bar">
                <span>{zoomedIllustration.caption}</span>
                <button type="button" className="em-ghost-btn" onClick={() => setZoomedIllustration(null)}>
                  閉じる
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Main Listening Workspace */}
        <div className={`em-workspace ${hasLeftMedia ? 'has-passage' : ''}`}>
          {hasLeftMedia && (
            <article className="em-passage-pane em-listening-media-pane">
              <div className="em-passage-head">
                <span className="em-section-badge">{currentPartLabel}</span>
                <h2>
                  {track?.material
                    ? `No.${currentAudioUnit.questions[0].questionNumber} 印刷資料（Real-Life形式）`
                    : `No.${currentAudioUnit.questions[0].questionNumber} 問題イラスト`}
                </h2>
              </div>
              {track?.material ? (
                <ListeningMaterials material={track.material} activeSubId={firstSub?.id} />
              ) : illustrationUrl ? (
                <figure className="em-illustration-figure">
                  <img
                    src={illustrationUrl}
                    alt={illustrationCaption}
                    onClick={() => setZoomedIllustration({ src: illustrationUrl, caption: illustrationCaption })}
                  />
                  <figcaption>
                    <span>イラストをタップすると拡大表示できます</span>
                    <button
                      type="button"
                      className="em-zoom-trigger"
                      onClick={() => setZoomedIllustration({ src: illustrationUrl, caption: illustrationCaption })}
                    >
                      拡大する
                    </button>
                  </figcaption>
                </figure>
              ) : null}
            </article>
          )}

          <div className="em-questions-pane">
            {/* Audio Player Card */}
            {track && (
              <section className="em-audio-card" data-mock-audio-unit={currentAudioUnit.audioId}>
                <div className="em-audio-card-head">
                  <span className="em-audio-badge">
                    <Headphones size={14} aria-hidden="true" />
                    <span>
                      音源 {unitIndex + 1} / {listeningUnits.length}（本試験 {currentAudioUnit.readCount}回読み）
                    </span>
                  </span>
                  <span className="em-audio-note">
                    {timedMode && currentAudioUnit.readCount === 1
                      ? '本番タイマー中：1回読み制限'
                      : '音声を聞いて下の選択肢から選んでください'}
                  </span>
                </div>
                <ListeningAudioPlayer
                  key={currentAudioUnit.audioId}
                  tracks={[track]}
                  mode="practice"
                  tone="light"
                  variant="inline"
                  orientation="horizontal"
                  readCount={currentAudioUnit.readCount}
                  playOnce={timedMode && currentAudioUnit.readCount === 1}
                />
              </section>
            )}

            {currentAudioUnit.questions.map(q => {
              const flagged = flags.includes(q.id);
              const picked = answers[q.id];
              const isReadAloud = q.choicePresentation === 'read-aloud';

              return (
                <section key={q.id} className="em-q-card" data-mock-q={q.questionNumber}>
                  <div className="em-q-head">
                    <div className="em-q-title">
                      <span className="em-q-num">No. {q.questionNumber}</span>
                      <span className="em-q-sec">{currentPartLabel}</span>
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
                    {isReadAloud
                      ? `音声で読み上げられる選択肢 1〜${q.choices.length} の中から、最も適切なものを1つ選んでください。`
                      : q.questionPrompt}
                  </p>

                  <div className="em-choice-list" role="radiogroup" aria-label={`No.${q.questionNumber}の選択肢`}>
                    {q.choices.map((choiceText, cIdx) => {
                      const selected = picked === cIdx;
                      const displayLabel = isReadAloud
                        ? `選択肢 ${cIdx + 1}（音声で読み上げ）`
                        : choiceText;
                      return (
                        <button
                          key={cIdx}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={`em-choice-btn ${selected ? 'is-selected' : ''}`}
                          onClick={() => setAnswers(prev => ({ ...prev, [q.id]: cIdx }))}
                          data-choice-idx={cIdx + 1}
                        >
                          <span className="em-choice-no">{cIdx + 1}</span>
                          <span className="em-choice-text">{displayLabel}</span>
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

          <span className="em-unit-counter">
            音源 {unitIndex + 1} / {listeningUnits.length}
          </span>

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
  if (phase === 'running' && activeWrittenExam) {
    const units = writtenUnits;
    const currentUnit = units[unitIndex] ?? units[0];
    const remainingSec = limitSec - elapsedSec;
    const isOvertime = timedMode && remainingSec < 0;
    const scopedExamItems = activeWrittenExam.items
      .map((item, fullIdx) => ({ item, qNo: fullIdx + 1 }))
      .filter(({ item }) => scopeSection === 'all' || item.section === scopeSection);
    const choiceItems = scopedExamItems.map(x => x.item).filter(i => i.kind === 'choice');
    const writingItems = scopedExamItems.map(x => x.item).filter(i => i.kind === 'writing');
    const answeredChoiceCount = choiceItems.filter(i => Number.isInteger(answers[i.id])).length;
    const answeredWritingCount = writingItems.filter(i => countEnglishWords(writing[i.id]?.text ?? '') > 0).length;
    const totalAnswered = answeredChoiceCount + answeredWritingCount;

    const examDaimonSpecs = getGradeDaimonSpecs(activeWrittenExam.grade);
    const sectionFirstUnit: { section: WrittenSection; label: string; unitIdx: number }[] = [];
    units.forEach((u, idx) => {
      if (!sectionFirstUnit.some(s => s.section === u.section)) {
        const dSpec = examDaimonSpecs.find(d => d.section === u.section);
        const label = dSpec ? `大問${dSpec.daimonNo} ${WRITTEN_SECTION_LABELS[u.section]}` : SECTION_LABELS[u.section];
        sectionFirstUnit.push({ section: u.section, label, unitIdx: idx });
      }
    });

    const jumpToItemId = (itemId: string) => {
      const targetUnitIdx = units.findIndex(u => u.items.some(entry => entry.item.id === itemId));
      if (targetUnitIdx >= 0) {
        setUnitIndex(targetUnitIdx);
        setPaletteOpen(false);
        window.scrollTo(0, 0);
      }
    };

    return (
      <main className="em-runner" data-mock-runner data-mock-category="written">
        <header className="em-runner-bar">
          <button
            type="button"
            className="em-runner-exit"
            onClick={() => setPhase('select')}
            title="解答は自動保存されます。あとで続きから再開できます"
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>中断して保存</span>
          </button>

          <div className="em-runner-center">
            <strong className="em-runner-title">
              {gradeLabel} 第{activeWrittenExam.round}回
              {activeDaimonSpec ? `・大問${activeDaimonSpec.daimonNo}` : ''}
            </strong>
            <span className="em-runner-progress">
              解答 {totalAnswered}/{scopedExamItems.length}
            </span>
          </div>

          <div className="em-runner-right">
            <div className={`em-timer-chip ${isOvertime ? 'is-overtime' : ''}`} data-mock-timer>
              <Clock size={15} aria-hidden="true" />
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
                aria-label={paused ? 'タイマーを再開' : 'タイマーを一時停止'}
              >
                {paused ? <Play size={13} /> : <Pause size={13} />}
              </button>
            </div>

            <button
              type="button"
              className="em-palette-toggle"
              onClick={() => setPaletteOpen(o => !o)}
              aria-expanded={paletteOpen}
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
              <span>採点・提出</span>
            </button>
          </div>
        </header>

        {/* Section Tabs */}
        <nav className="em-section-tabs" aria-label="大問セクション移動">
          {sectionFirstUnit.map(sec => {
            const active = currentUnit.section === sec.section;
            return (
              <button
                key={sec.section}
                type="button"
                className={`em-section-tab ${active ? 'is-active' : ''}`}
                onClick={() => {
                  setUnitIndex(sec.unitIdx);
                  window.scrollTo(0, 0);
                }}
              >
                {sec.label}
              </button>
            );
          })}
        </nav>

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
              <h2>模試を終了して採点しますか？</h2>
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
        <div className={`em-workspace ${currentUnit.passage ? 'has-passage' : ''}`}>
          {currentUnit.passage && (
            <article className="em-passage-pane" data-passage-format={currentUnit.passage.format || 'article'}>
              <div className="em-passage-head">
                <span className="em-section-badge">{SECTION_LABELS[currentUnit.section]}</span>
                <h2>{currentUnit.passage.title}</h2>
              </div>
              <div className="em-passage-body">{currentUnit.passage.text}</div>
            </article>
          )}

          <div className="em-questions-pane">
            {currentUnit.items.map(({ item, qNo }) => {
              const flagged = flags.includes(item.id);
              if (item.kind === 'choice') {
                const picked = answers[item.id];
                return (
                  <section key={item.id} className="em-q-card" data-mock-q={qNo}>
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
                          <span key={tIdx} className="em-order-chip">
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
                            onClick={() => setAnswers(prev => ({ ...prev, [item.id]: cIdx }))}
                            data-choice-idx={cIdx + 1}
                          >
                            <span className="em-choice-no">{cIdx + 1}</span>
                            <span className="em-choice-text">{choiceText}</span>
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

              return (
                <section key={item.id} className="em-q-card is-writing" data-mock-writing={item.id}>
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
                    <strong className={inRange ? 'is-ok' : ''}>現在 {words} 語</strong>
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
            <span>前の問題</span>
          </button>

          <span className="em-unit-counter">
            ページ {unitIndex + 1} / {units.length}
          </span>

          {unitIndex < units.length - 1 ? (
            <button
              type="button"
              className="em-nav-btn is-primary"
              onClick={() => {
                setUnitIndex(i => Math.min(units.length - 1, i + 1));
                window.scrollTo(0, 0);
              }}
            >
              <span>次の問題</span>
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
  if (examCategory === 'listening' && activeListeningExam) {
    const summary = scoreListeningMockExam(activeListeningExam, answers, scopePart);
    const usedSec = submittedRecord?.elapsedSec ?? elapsedSec;
    const bp = LISTENING_BLUEPRINTS[activeListeningExam.grade];
    const partLabels = new Map<ListeningPartId, string>(bp.parts.map(p => [p.id, p.label]));

    const reviewEntries: {
      q: ListeningQuestionItem;
      unit: ListeningAudioUnit;
      partLabel: string;
    }[] = listeningUnits
      .flatMap(unit =>
        unit.questions.map(q => ({
          q,
          unit,
          partLabel: partLabels.get(unit.part) ?? unit.part,
        })),
      )
      .filter(({ q }) => {
        if (resultFilter === 'wrong') return answers[q.id] !== q.answer;
        if (resultFilter === 'flagged') return flags.includes(q.id);
        return true;
      });

    return (
      <main className="em-page em-result-page" data-mock-result data-mock-category="listening">
        <header className="em-header">
          <button
            type="button"
            className="em-back-btn"
            onClick={() => {
              stopSpeech();
              setPhase('select');
            }}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>模試一覧へ</span>
          </button>
          <div className="em-header-title">
            <h1>
              {gradeLabel} リスニング 第{activeListeningExam.round}回
              {activePartSpec ? `（${activePartSpec.tabTitle}）` : ''} 採点結果
            </h1>
            <p>音声の聞き直し・全文スクリプト・和訳・全選択肢解説を確認できます（誤答は復習リストへ自動登録済み）</p>
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
            {summary.sections.map(sec => {
              const pct = sec.total > 0 ? Math.round((sec.correct / sec.total) * 100) : 0;
              return (
                <div key={sec.section} className="em-breakdown-row">
                  <div className="em-breakdown-label">
                    <span>{sec.label}</span>
                    <strong>
                      {sec.correct}/{sec.total} 問 ({pct}%)
                    </strong>
                  </div>
                  <div className="em-breakdown-bar">
                    <div className="em-breakdown-fill" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="em-choice-review-section" aria-label="リスニング問題の答え合わせ・スクリプト解説">
          <div className="em-review-toolbar">
            <h2 className="em-sub-heading">
              <CheckCircle2 size={18} aria-hidden="true" />
              <span>リスニング答え合わせ・音声スクリプト・全選択肢解説</span>
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

          {reviewEntries.length === 0 ? (
            <p className="em-empty-review">該当する問題はありません。素晴らしい結果です！</p>
          ) : (
            <div className="em-review-list">
              {reviewEntries.map(({ q, unit, partLabel }) => {
                const picked = answers[q.id];
                const isCorrect = picked === q.answer;
                const prob = listeningUnitToProblem(activeListeningExam, unit);
                const reviewTrack = prob.audioTracks?.[0];
                const subImg = prob.subQuestions[0]?.imageUrl;

                return (
                  <article
                    key={q.id}
                    className={`em-review-card ${isCorrect ? 'is-correct' : 'is-wrong'}`}
                  >
                    <div className="em-rev-head">
                      <span className={`em-rev-badge ${isCorrect ? 'is-correct' : 'is-wrong'}`}>
                        {isCorrect ? '正解' : Number.isInteger(picked) ? '不正解' : '未解答'}
                      </span>
                      <strong>No. {q.questionNumber}</strong>
                      <span className="em-rev-sec">{partLabel}</span>
                      <span className="em-rev-ans">
                        あなたの解答：{Number.isInteger(picked) ? `${picked + 1}` : '未選択'} ／ 正解：
                        <strong>{q.answer + 1}</strong>
                      </span>
                    </div>

                    {reviewTrack && (
                      <div className="em-rev-audio-row">
                        <ListeningAudioPlayer
                          tracks={[reviewTrack]}
                          mode="review"
                          tone="light"
                          variant="inline"
                          orientation="horizontal"
                          readCount={unit.readCount}
                        />
                      </div>
                    )}

                    {subImg && (
                      <div className="em-rev-thumb-row">
                        <img
                          src={subImg}
                          alt={`No.${q.questionNumber} イラスト`}
                          className="em-rev-thumb"
                        />
                        {unit.image && <span className="em-rev-ja">場面：{unit.image.sceneSummaryJa}</span>}
                      </div>
                    )}

                    <div className="em-rev-script-box">
                      <div className="em-rev-script-title">放送スクリプト・和訳</div>
                      <p className="em-wr-en">
                        {unit.turns
                          .map(t => (t.roleLabel === 'Narrator' ? t.text : `${t.roleLabel}: ${t.text}`))
                          .join('\n')}
                      </p>
                      <p className="em-wr-ja">{unit.translation}</p>
                    </div>

                    <p className="em-rev-prompt">設問：{q.questionPrompt}</p>
                    <p className="em-rev-completed">根拠フレーズ：{q.evidence}</p>
                    <p className="em-rev-exp">{q.explanation}</p>

                    <ul className="em-rev-choices">
                      {q.choices.map((cText, cIdx) => {
                        const isAns = cIdx === q.answer;
                        const isUser = cIdx === picked;
                        return (
                          <li
                            key={cIdx}
                            className={`${isAns ? 'is-ans' : ''} ${isUser && !isAns ? 'is-user-wrong' : ''}`}
                          >
                            <strong>
                              {cIdx + 1}. {cText}
                            </strong>
                            <span> — {q.distractorReasons[cIdx]}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>
    );
  }

  // =========================================================================
  // 3B. WRITTEN RESULT & REVIEW SCREEN
  // =========================================================================
  const activeExam = activeWrittenExam!;
  const summary = scoreMockExam(activeExam, answers, writing, scopeSection);
  const usedSec = submittedRecord?.elapsedSec ?? elapsedSec;

  const choiceReviewItems = activeExam.items
    .map((item, idx) => ({ item, qNo: idx + 1 }))
    .filter(entry => (scopeSection === 'all' || entry.item.section === scopeSection) && entry.item.kind === 'choice')
    .filter(({ item }) => {
      if (resultFilter === 'wrong') return answers[item.id] !== item.answer;
      if (resultFilter === 'flagged') return flags.includes(item.id);
      return true;
    });

  const writingReviewItems = activeExam.items.filter(
    item => (scopeSection === 'all' || item.section === scopeSection) && item.kind === 'writing',
  );

  return (
    <main className="em-page em-result-page" data-mock-result data-mock-category="written">
      <header className="em-header">
        <button type="button" className="em-back-btn" onClick={() => setPhase('select')}>
          <ArrowLeft size={16} aria-hidden="true" />
          <span>模試一覧へ</span>
        </button>
        <div className="em-header-title">
          <h1>
            {gradeLabel} 第{activeExam.round}回
            {activeDaimonSpec ? `（${activeDaimonSpec.tabTitle}）` : ''} 採点結果
          </h1>
          <p>間違えた問題は「復習」リストに自動登録されました</p>
        </div>
        <button
          type="button"
          className="em-ghost-btn"
          onClick={() => startWrittenExam(activeExam, false, scopeSection)}
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
            {summary.total > 0 && summary.writingTotal > 0 && ` ／ ライティング提出 ${summary.writingDone}/${summary.writingTotal}題`}
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
                    <summary>課題の英文・和訳を確認する</summary>
                    <p className="em-wr-en">{item.passage.text}</p>
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
                                syncSubmittedMockToStudyLedger(uid, activeExam, answers, nextWriting, scopeSection);
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
                    <p className="em-wr-model">{item.model}</p>
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
                const isCorrect = picked === item.answer;
                return (
                  <article
                    key={item.id}
                    className={`em-review-card ${isCorrect ? 'is-correct' : 'is-wrong'}`}
                  >
                    <div className="em-rev-head">
                      <span className={`em-rev-badge ${isCorrect ? 'is-correct' : 'is-wrong'}`}>
                        {isCorrect ? '正解' : Number.isInteger(picked) ? '不正解' : '未解答'}
                      </span>
                      <strong>問 {qNo}</strong>
                      <span className="em-rev-sec">{SECTION_LABELS[item.section]}</span>
                      <span className="em-rev-ans">
                        あなたの解答：{Number.isInteger(picked) ? `${picked + 1}` : '未選択'} ／ 正解：
                        <strong>{item.answer! + 1}</strong>
                      </span>
                    </div>

                    {item.passage && (
                      <details className="em-wr-source">
                        <summary>本文・和訳を開く（{item.passage.title}）</summary>
                        <p className="em-wr-en">{item.passage.text}</p>
                        {item.passage.translation && <p className="em-wr-ja">{item.passage.translation}</p>}
                      </details>
                    )}

                    <p className="em-rev-prompt">{item.prompt}</p>
                    {item.completedSentence && (
                      <p className="em-rev-completed">完成文：{item.completedSentence}</p>
                    )}
                    {item.translation && <p className="em-rev-ja">訳：{item.translation}</p>}
                    <p className="em-rev-exp">{item.explanation}</p>

                    <ul className="em-rev-choices">
                      {item.choices!.map((cText, cIdx) => {
                        const isAns = cIdx === item.answer;
                        const isUser = cIdx === picked;
                        return (
                          <li
                            key={cIdx}
                            className={`${isAns ? 'is-ans' : ''} ${isUser && !isAns ? 'is-user-wrong' : ''}`}
                          >
                            <strong>
                              {cIdx + 1}. {cText}
                            </strong>
                            <span> — {item.distractorReasons?.[cIdx]}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
