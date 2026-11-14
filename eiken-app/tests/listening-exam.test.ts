import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { EIKEN_GRADES } from '../src/eiken/config';
import {
  LISTENING_BLUEPRINTS,
  normalizeEnglishWords,
  validateListeningGradeSeries,
} from '../src/eiken/listeningExamCore';
import { LISTENING_IMAGE_URLS } from '../src/eiken/listeningImages.generated';
import {
  ALL_LISTENING_EXAMS,
  LISTENING_EXAMS_BY_GRADE,
} from '../src/eiken/materials/listening-booklets';
import { scoreListeningMockExam } from '../src/eiken/mockProgress';
import { partsForGrade } from '../src/eiken/questions';

describe('Eiken Listening 120-Round Mock Exam Bank', () => {
  it('validates all 8 grades x 15 rounds (120 rounds, 3465 questions, 3285 audio units, 750 image prompts)', () => {
    expect(ALL_LISTENING_EXAMS).toHaveLength(120);
    let totalQuestions = 0;
    let totalAudio = 0;
    let totalImages = 0;

    for (const grade of EIKEN_GRADES) {
      const exams = LISTENING_EXAMS_BY_GRADE[grade.id];
      const bp = LISTENING_BLUEPRINTS[grade.id];
      expect(exams).toHaveLength(15);
      validateListeningGradeSeries(exams, grade.id);

      for (const exam of exams) {
        totalAudio += exam.units.length;
        for (const unit of exam.units) {
          totalQuestions += unit.questions.length;
          if (unit.image) totalImages++;
        }
      }

      const listeningPart = partsForGrade(grade.id).find(p => p.section === 'listening');
      expect(listeningPart).toBeTruthy();
      const roundChapters = listeningPart!.chapters.filter(c => c.id.includes('_listening_r'));
      expect(roundChapters).toHaveLength(15 * bp.parts.length);
      for (const pSpec of bp.parts) {
        const partChs = roundChapters.filter(c => c.id.endsWith(`_${pSpec.id}`));
        expect(partChs).toHaveLength(15);
        for (const ch of partChs) {
          expect(ch.marks).toBe(pSpec.questionCount);
          expect(ch.practiceProblems).toHaveLength(pSpec.audioUnitCount);
        }
      }
      expect(roundChapters.reduce((sum, ch) => sum + ch.marks, 0)).toBe(bp.totalQuestions * 15);
      expect(roundChapters.reduce((sum, ch) => sum + ch.practiceProblems.length, 0)).toBe(bp.totalAudioFiles * 15);
    }

    expect(totalQuestions).toBe(3465);
    expect(totalAudio).toBe(3285);
    expect(totalImages).toBe(750);
  });

  it('has zero 8-gram overlap with retired legacy fingerprints', () => {
    const legacy = JSON.parse(readFileSync('../assets/legacy-fingerprints.json', 'utf8')) as {
      ngram: number;
      hashes: string[];
    };
    const hashSet = new Set(legacy.hashes);
    for (const exam of ALL_LISTENING_EXAMS) {
      for (const unit of exam.units) {
        const texts = [
          ...unit.turns.map(t => t.text),
          ...unit.questions.flatMap(q => [q.questionPrompt, ...q.choices]),
        ];
        for (const txt of texts) {
          const words = normalizeEnglishWords(txt);
          for (let i = 0; i + legacy.ngram <= words.length; i++) {
            const gram = words.slice(i, i + legacy.ngram).join(' ');
            const digest = createHash('sha256').update(gram).digest('hex').slice(0, 20);
            expect(hashSet.has(digest)).toBe(false);
          }
        }
      }
    }
  });

  it('audits all 712 integrated WebP listening illustrations (Grade 3/Pre-1/1 100% + Grade 5/4)', () => {
    const entries = Object.entries(LISTENING_IMAGE_URLS);
    expect(entries).toHaveLength(712);

    const byPrefix = {
      eiken_5: 0,
      eiken_4: 0,
      eiken_3: 0,
      eiken_pre1: 0,
      eiken_1: 0,
    };

    for (const [audioId, webUrl] of entries) {
      expect(webUrl.startsWith('/eiken_images/')).toBe(true);
      expect(webUrl.endsWith('.webp')).toBe(true);
      const diskPath = resolve(process.cwd(), 'public', webUrl.slice(1));
      expect(existsSync(diskPath)).toBe(true);

      const st = statSync(diskPath);
      expect(st.size).toBeGreaterThan(800);
      expect(st.size).toBeLessThan(200_000);

      const head = readFileSync(diskPath).subarray(0, 12);
      expect(head.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(head.subarray(8, 12).toString('ascii')).toBe('WEBP');

      if (audioId.startsWith('eiken_5_')) byPrefix.eiken_5 += 1;
      else if (audioId.startsWith('eiken_4_')) byPrefix.eiken_4 += 1;
      else if (audioId.startsWith('eiken_3_')) byPrefix.eiken_3 += 1;
      else if (audioId.startsWith('eiken_pre1_')) byPrefix.eiken_pre1 += 1;
      else if (audioId.startsWith('eiken_1_')) byPrefix.eiken_1 += 1;
    }

    expect(byPrefix).toEqual({
      eiken_5: 268,
      eiken_4: 144,
      eiken_3: 150,
      eiken_pre1: 75,
      eiken_1: 75,
    });
  });

  it('scores full and part-scoped Listening Mock Exams accurately across all 8 grades', () => {
    for (const grade of EIKEN_GRADES) {
      const round1 = LISTENING_EXAMS_BY_GRADE[grade.id][0];
      const bp = LISTENING_BLUEPRINTS[grade.id];

      // Perfect score check
      const allCorrectAnswers: Record<string, number> = {};
      for (const u of round1.units) {
        for (const q of u.questions) {
          allCorrectAnswers[q.id] = q.answer;
        }
      }
      const fullPerfect = scoreListeningMockExam(round1, allCorrectAnswers, 'all');
      expect(fullPerfect.total).toBe(bp.totalQuestions);
      expect(fullPerfect.correct).toBe(bp.totalQuestions);
      expect(fullPerfect.unanswered).toBe(0);
      expect(fullPerfect.accuracyPct).toBe(100);
      expect(fullPerfect.sections).toHaveLength(bp.parts.length);

      // Part-scoped partial answer check
      const firstPart = bp.parts[0];
      const partialAnswers: Record<string, number> = {};
      const partQuestions = round1.units.filter(u => u.part === firstPart.id).flatMap(u => u.questions);
      partQuestions.forEach((q, idx) => {
        if (idx === 0) partialAnswers[q.id] = q.answer;
        else if (idx === 1) partialAnswers[q.id] = (q.answer + 1) % q.choices.length;
      });
      const scopedSummary = scoreListeningMockExam(round1, partialAnswers, firstPart.id);
      expect(scopedSummary.total).toBe(firstPart.questionCount);
      expect(scopedSummary.correct).toBe(1);
      expect(scopedSummary.answered).toBe(2);
      expect(scopedSummary.unanswered).toBe(firstPart.questionCount - 2);
      expect(scopedSummary.sections).toHaveLength(1);
      expect(scopedSummary.sections[0].section).toBe(firstPart.id);
    }
  });
});
